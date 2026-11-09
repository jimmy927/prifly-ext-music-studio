/**
 * The Master stage: the source's loudness (integrated LUFS, true peak, range),
 * a target (Club, Streaming, Game) and a format (WAV 24-bit, MP3, OGG), and
 * "Master", which ffmpeg does on this computer (free, no card) into
 * `master/`. Earlier masters are kept, and an A/B switch plays the source
 * against any of them.
 */

import type { FormatId, Loudness, TargetId } from "../../audio/loudness";
import { call, errorText, type MasterItem, type MasterView } from "./api";
import { clock, Deck } from "./deck";
import { fill, h, icon } from "./dom";
import { cancelLocal, local, localBusy, localNotice, localProgress, startLocal } from "./local";
import { app, redraw } from "./state";

let view: MasterView | null = null;
let loadError: string | null = null;
let loadedFor: string | null = null;
let target: TargetId = "streaming";
let format: FormatId = "wav";
let dirty = false;

const db = (value: number | null | undefined, unit: string): string =>
  value === null || value === undefined ? "—" : `${value.toFixed(1)} ${unit}`;

async function load(): Promise<void> {
  const project = app.project;
  if (project === null) return;
  loadedFor = project.id;
  try {
    view = await call<MasterView>(`master?project=${encodeURIComponent(project.id)}`);
    loadError = null;
  } catch (caught) {
    view = null;
    loadError = errorText(caught);
  }
  dirty = true;
  redraw("stage");
}

/* The A/B switch */
type Side = "a" | "b";
const ab: {
  source: Deck | null;
  master: Deck | null;
  side: Side;
  compare: number | null;
  match: boolean;
} = {
  source: null,
  master: null,
  side: "a",
  compare: null,
  match: true,
};

const current = (): Deck | null => (ab.side === "a" ? ab.source : ab.master);
const masterOf = (n: number | null): MasterItem | undefined =>
  view?.masters.find((each) => each.n === n);

function resetDecks(): void {
  ab.source?.dispose();
  ab.master?.dispose();
  ab.source = null;
  ab.master = null;
  const project = app.project;
  const compared = masterOf(ab.compare);
  if (project === null || view === null || view.source === null || compared === undefined) return;
  ab.source = new Deck(project.id, view.source.kind, view.source.id);
  ab.master = new Deck(project.id, "master", String(compared.n));
  for (const deck of [ab.source, ab.master]) {
    deck.audio.addEventListener("timeupdate", abTime);
    deck.audio.addEventListener("pause", abButtons);
    deck.audio.addEventListener("play", abButtons);
  }
  applyMatch();
}

/** With "Match loudness" on, the louder of the two is turned down to the quieter one's level, so louder does not sound better. */
function applyMatch(): void {
  const compared = masterOf(ab.compare);
  const source = view?.loudness?.integrated;
  const mastered = compared?.output?.integrated;
  const lowest = source === undefined || mastered === undefined ? null : Math.min(source, mastered);
  const volume = (own: number | undefined): number =>
    !ab.match || lowest === null || own === undefined
      ? 1
      : Math.min(1, 10 ** ((lowest - own) / 20));
  if (ab.source !== null) ab.source.audio.volume = volume(source);
  if (ab.master !== null) ab.master.audio.volume = volume(mastered);
}

async function switchTo(side: Side): Promise<void> {
  const from = current();
  if (side === ab.side || from === null) return;
  const at = from.audio.currentTime;
  const wasPlaying = from.playing;
  from.pause();
  ab.side = side;
  const to = current();
  if (to === null) return;
  try {
    await to.load();
    to.seek(at);
    if (wasPlaying) await to.play();
  } catch (caught) {
    note.textContent = errorText(caught);
  }
  abButtons();
}

async function togglePlay(): Promise<void> {
  const deck = current();
  if (deck === null) return;
  try {
    if (deck.playing) deck.pause();
    else await deck.play();
    note.textContent = "";
  } catch (caught) {
    note.textContent = errorText(caught);
  }
  abButtons();
}

const heading = h("h2", null);
const slot = h("div", { class: "slot", "data-part": "run-status" });
const banner = h("div", { class: "notice warn", role: "alert", "data-state": "no-ffmpeg" });
const facts = h("div", { class: "facts", "data-part": "source-loudness" });
const lossy = h("p", { class: "why lossy-note", role: "note" });
const why = h("p", { class: "why", role: "status" });
const list = h("div", { class: "masters", "data-part": "masters" });
const note = h("span", { class: "player-note", role: "status" });
const seek = h("input", {
  type: "range",
  min: 0,
  max: 1000,
  value: 0,
  class: "seek",
  "aria-label": "Position",
});
const time = h("span", { class: "time" }, "0:00.0");
const sideA = h(
  "button",
  { type: "button", class: "btn toggle", id: "ab-source", onclick: () => void switchTo("a") },
  "A  Source",
);
const sideB = h(
  "button",
  { type: "button", class: "btn toggle", id: "ab-master", onclick: () => void switchTo("b") },
  "B  Master",
);
const playButton = h(
  "button",
  { type: "button", class: "btn", id: "ab-play", onclick: () => void togglePlay() },
  icon("play", 14),
  "Play",
);
const matchBox = h("input", { type: "checkbox", id: "ab-match", checked: true });
const masterButton = h(
  "button",
  { type: "button", class: "btn primary big", id: "master", onclick: () => void run() },
  icon("wave"),
  "Master",
);
const cancelButton = h(
  "button",
  { type: "button", class: "btn", id: "master-cancel", onclick: () => void cancelLocal() },
  "Cancel",
);
const targets = h("div", {
  class: "segs",
  role: "radiogroup",
  "aria-label": "Target",
  "data-part": "targets",
});
const formats = h("div", {
  class: "segs",
  role: "radiogroup",
  "aria-label": "Format",
  "data-part": "formats",
});

matchBox.addEventListener("change", () => {
  ab.match = matchBox.checked;
  applyMatch();
});
seek.addEventListener("input", () => {
  const deck = current();
  if (deck !== null && deck.audio.duration > 0)
    deck.seek((Number(seek.value) / 1000) * deck.audio.duration);
});

function abTime(): void {
  const audio = current()?.audio;
  if (audio === undefined) return;
  if (audio.duration > 0)
    seek.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
  time.textContent = `${clock(audio.currentTime)} / ${clock(audio.duration || 0)}`;
}

function abButtons(): void {
  const ready = ab.source !== null && ab.master !== null;
  sideA.disabled = !ready;
  sideB.disabled = !ready;
  sideA.setAttribute("aria-pressed", String(ab.side === "a"));
  sideB.setAttribute("aria-pressed", String(ab.side === "b"));
  playButton.disabled = !ready;
  seek.disabled = !ready;
  matchBox.disabled = !ready;
  playButton.replaceChildren(
    icon(current()?.playing === true ? "pause" : "play", 14),
    current()?.playing === true ? "Pause" : "Play",
  );
}

function radios<T extends string>(
  holder: HTMLElement,
  name: string,
  options: { id: T; label: string }[],
  picked: () => T,
  pick: (id: T) => void,
): void {
  fill(
    holder,
    ...options.map((option) => {
      const input = h("input", {
        type: "radio",
        name,
        value: option.id,
        checked: picked() === option.id,
      });
      input.addEventListener("change", () => {
        pick(option.id);
        buttons();
      });
      return h("label", { class: "seg" }, input, option.label);
    }),
  );
}

function blocker(): string | null {
  if (view === null) return loadError ?? "Loading…";
  if (!view.ffmpeg.ok) return view.ffmpeg.message;
  if (view.source === null)
    return "There is nothing to master yet. Choose a sketch on the Idea stage first.";
  if (view.loudness === null) return view.measureError ?? "Measuring the source…";
  return null;
}

function buttons(): void {
  const reason = blocker();
  const busy = localBusy() || local.starting;
  masterButton.disabled = reason !== null || busy;
  cancelButton.disabled =
    !(local.job?.status === "running" && local.job.work === "master") || local.cancelling;
  cancelButton.textContent = local.cancelling ? "Cancelling…" : "Cancel";
  why.textContent =
    reason ?? (busy ? "" : "Rendered on this computer with ffmpeg. Free, no confirm.");
  const bad = view !== null && !view.ffmpeg.ok;
  banner.hidden = !bad;
  fill(
    banner,
    icon("alert"),
    h(
      "div",
      { class: "notice-body" },
      h("strong", null, "Mastering needs ffmpeg. "),
      view?.ffmpeg.message ?? "",
    ),
  );
  lossy.textContent = format === "wav" && view?.source?.lossy === true ? view.lossyNote : "";
}

function loudnessTile(label: string, value: string): HTMLElement {
  return h(
    "div",
    { class: "fact" },
    h("span", { class: "field-label" }, label),
    h("span", { class: "big-number" }, value),
  );
}

function drawFacts(): void {
  const loudness: Loudness | null = view?.loudness ?? null;
  const measuring =
    view !== null && view.source !== null && loudness === null && view.measureError === null;
  fill(
    facts,
    h(
      "div",
      { class: "fact wide" },
      h("span", { class: "field-label" }, "Source"),
      h("span", null, view?.source?.label ?? (view === null ? "…" : "none")),
    ),
    loudnessTile("Integrated", measuring ? "Measuring…" : db(loudness?.integrated, "LUFS")),
    loudnessTile("True peak", measuring ? "…" : db(loudness?.truePeak, "dBTP")),
    loudnessTile("Loudness range", measuring ? "…" : db(loudness?.range, "LU")),
  );
}

const targetLine = (item: MasterItem): string => {
  const wanted = view?.targets.find((each) => each.id === item.target);
  return `${wanted?.label ?? item.target} ${wanted?.lufs ?? ""} LUFS`;
};

function drawMasters(): void {
  const items = [...(view?.masters ?? [])].reverse();
  fill(
    list,
    h("h3", null, "Masters"),
    items.length === 0
      ? h(
          "p",
          { class: "empty", "data-state": "no-masters" },
          "Nothing mastered yet. Pick a target and a format, then press Master.",
        )
      : h(
          "ul",
          { class: "version-list" },
          ...items.map((item) => {
            const radio = h("input", {
              type: "radio",
              name: "compare",
              checked: item.n === ab.compare,
            });
            radio.addEventListener("change", () => {
              ab.compare = item.n;
              ab.side = "a";
              resetDecks();
              abButtons();
            });
            return h(
              "li",
              {
                class: `version${item.n === ab.compare ? " current" : ""}`,
                "data-master": String(item.n),
              },
              h(
                "label",
                { class: "master-row" },
                radio,
                h("span", { class: "card-title" }, `master-${item.n}.${item.format}`),
                h("span", { class: "meta" }, `${targetLine(item)}, from ${item.from}`),
              ),
              h(
                "div",
                { class: "meta" },
                item.output === null
                  ? "Result not measured."
                  : `Result ${db(item.output.integrated, "LUFS")}, true peak ${db(item.output.truePeak, "dBTP")}, range ${db(item.output.range, "LU")}.${item.type === "dynamic" ? " The target could not be reached by gain alone, so the dynamics were compressed a little." : ""}`,
              ),
            );
          }),
        ),
  );
}

async function run(): Promise<void> {
  const project = app.project;
  if (project === null) return;
  await startLocal("master", "master-render", { project: project.id, target, format }, async () => {
    await load();
    ab.compare = view?.masters.at(-1)?.n ?? null;
    ab.side = "a";
    dirty = true;
    const latest = masterOf(ab.compare);
    return latest === undefined ? "Mastered." : `Made master-${latest.n}.${latest.format}.`;
  });
}

function draw(): void {
  if (view !== null && (ab.compare === null || masterOf(ab.compare) === undefined))
    ab.compare = view.masters.at(-1)?.n ?? null;
  resetDecks();
  drawFacts();
  drawMasters();
  if (view !== null) {
    radios(
      targets,
      "target",
      view.targets.map((each) => ({ id: each.id, label: `${each.label}  ${each.lufs} LUFS` })),
      () => target,
      (id) => {
        target = id;
      },
    );
    radios(
      formats,
      "format",
      view.formats,
      () => format,
      (id) => {
        format = id;
      },
    );
  }
  abButtons();
}

function update(): void {
  heading.textContent = app.project === null ? "Master" : `Master — ${app.project.title}`;
  if (dirty) {
    dirty = false;
    draw();
  }
  drawFacts();
  buttons();
  fill(slot, localProgress("master"), localNotice("master"));
}

export function mountMaster(): { root: HTMLElement; update: () => void; sync: () => void } {
  const root = h(
    "div",
    { class: "stage master", "data-stage": "master" },
    h(
      "section",
      { class: "main wide" },
      heading,
      banner,
      facts,
      h(
        "div",
        { class: "choice-row" },
        h("div", { class: "field" }, h("span", { class: "field-label" }, "Target"), targets),
        h("div", { class: "field" }, h("span", { class: "field-label" }, "Format"), formats),
      ),
      lossy,
      h("div", { class: "actions" }, masterButton, cancelButton, why),
      slot,
      list,
      h(
        "div",
        { class: "ab", "data-part": "ab" },
        h("h3", null, "A/B against the source"),
        h(
          "div",
          { class: "player" },
          sideA,
          sideB,
          playButton,
          seek,
          time,
          h("label", { class: "check" }, matchBox, "Match loudness"),
        ),
        note,
      ),
    ),
  );
  return {
    root,
    update,
    sync: () => {
      if (loadedFor !== app.project?.id) {
        view = null;
        ab.compare = null;
      }
      const deck = current();
      deck?.pause();
      void load();
      dirty = true;
      update();
    },
  };
}
