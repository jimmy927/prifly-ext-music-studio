/**
 * The Mix stage: a level (dB), pan, mute and solo for every stem and layer,
 * saved to mix.json as they change; a live preview through WebAudio; and
 * "Render mix", which ffmpeg does locally (free, no confirm card) into a WAV.
 */

import { audible, DEFAULT_TRACK, MAX_DB, MIN_DB, type TrackMix } from "../../audio/mixgraph";
import { call, errorText, type MixAnswer, type MixTrack, type MixView } from "./api";
import { fill, h, icon } from "./dom";
import { go } from "./header";
import { player, stopPlayers } from "./player";
import { Preview } from "./preview";
import { app, redraw } from "./state";
import { busy } from "./work";

let view: MixView | null = null;
let loadError: string | null = null;
let loadedFor: string | null = null;
let dirty = false;
let mix: Record<string, TrackMix> = {};
const preview = new Preview();

async function load(): Promise<void> {
  const project = app.project;
  if (project === null) return;
  loadedFor = project.id;
  try {
    view = await call<MixView>(`mix?project=${encodeURIComponent(project.id)}`);
    mix = Object.fromEntries(view.tracks.map((each) => [each.key, { ...each.mix }]));
    loadError = null;
  } catch (caught) {
    view = null;
    loadError = errorText(caught);
  }
  dirty = true;
  redraw("stage");
}

const dbText = (db: number): string => `${db > 0 ? "+" : ""}${db.toFixed(1)} dB`;
const panText = (pan: number): string =>
  Math.abs(pan) < 0.025 ? "C" : `${pan < 0 ? "L" : "R"}${Math.round(Math.abs(pan) * 100)}`;

const heading = h("h2", null);
const banner = h("div", { class: "notice warn", role: "alert", "data-state": "no-ffmpeg" });
const tracksBox = h("div", { class: "tracks", "data-part": "tracks" });
const rendersBox = h("div", { class: "renders", "data-part": "renders" });
const status = h("p", { class: "why", role: "status" });
let previewState: "idle" | "loading" | "playing" = "idle";
let rendering = false;
let renderNote: { tone: "info" | "error"; text: string } | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

const play = h(
  "button",
  { type: "button", class: "btn", id: "play-preview", onclick: () => void startPreview() },
  icon("play", 14),
  "Play preview",
);
const stop = h(
  "button",
  { type: "button", class: "btn", id: "stop-preview", onclick: () => stopPreview() },
  icon("pause", 14),
  "Stop",
);
const render = h(
  "button",
  { type: "button", class: "btn primary big", id: "render-mix", onclick: () => void renderNow() },
  icon("wave"),
  "Render mix",
);
const note = h("div", { class: "notices", "data-part": "mix-note" });

const hasTracks = (): boolean => (view?.tracks.length ?? 0) > 0;

function renderBlocker(): string | null {
  if (view === null) return loadError ?? "Loading the tracks…";
  if (!hasTracks()) return "There are no stems yet. Split stems on the Produce stage first.";
  if (!view.ffmpeg.ok) return view.ffmpeg.message;
  if (rendering) return "Rendering…";
  if (audible(Object.values(mix)).length === 0)
    return "Every track is muted, or others are soloed.";
  return null;
}

function buttons(): void {
  const reason = renderBlocker();
  render.disabled = reason !== null || busy();
  play.disabled = !hasTracks() || previewState !== "idle";
  stop.disabled = previewState !== "playing";
  status.textContent =
    previewState === "loading" ? "Loading the tracks for the preview…" : (reason ?? "");
  banner.hidden = view === null || view.ffmpeg.ok;
  const shown = view?.ffmpeg.ok === false ? view.ffmpeg.message : "";
  fill(
    banner,
    icon("alert"),
    h(
      "div",
      { class: "notice-body" },
      h("strong", null, "Mix cannot be rendered. "),
      shown,
      " Playing the preview still works.",
    ),
  );
  fill(
    note,
    renderNote === null
      ? null
      : h(
          "div",
          { class: `notice ${renderNote.tone}`, role: "status" },
          icon(renderNote.tone === "info" ? "check" : "alert"),
          h("div", { class: "notice-body" }, renderNote.text),
        ),
  );
}

function changed(): void {
  preview.apply(mix);
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), 400);
  dimRows();
  buttons();
}

async function save(): Promise<void> {
  const project = app.project;
  if (project === null) return;
  try {
    await call("mix-save", { project: project.id, mix: { tracks: mix } });
  } catch (caught) {
    renderNote = { tone: "error", text: errorText(caught) };
    buttons();
  }
}

/** Greys the rows that are not heard (muted, or not soloed while another is). */
function dimRows(): void {
  const heard = new Set(
    audible(Object.entries(mix).map(([key, each]) => ({ key, ...each }))).map((each) => each.key),
  );
  for (const row of tracksBox.querySelectorAll<HTMLElement>("[data-track]"))
    row.classList.toggle("silent", !heard.has(row.dataset["track"] ?? ""));
}

async function startPreview(): Promise<void> {
  const project = app.project;
  if (project === null || view === null) return;
  previewState = "loading";
  buttons();
  try {
    await preview.load(project.id, view.tracks, view.tempo);
    stopPlayers();
    await preview.play(mix, () => {
      previewState = "idle";
      buttons();
    });
    previewState = "playing";
  } catch (caught) {
    previewState = "idle";
    renderNote = { tone: "error", text: `The preview could not play: ${errorText(caught)}` };
  }
  buttons();
}

function stopPreview(): void {
  preview.stop();
  previewState = "idle";
  buttons();
}

async function renderNow(): Promise<void> {
  const project = app.project;
  if (project === null) return;
  rendering = true;
  renderNote = null;
  buttons();
  try {
    const answer = await call<MixAnswer>("mix-render", {
      project: project.id,
      mix: { tracks: mix },
    });
    renderNote = answer.ok
      ? { tone: "info", text: `Rendered ${answer.file}.` }
      : { tone: "error", text: answer.message };
  } catch (caught) {
    renderNote = { tone: "error", text: errorText(caught) };
  }
  rendering = false;
  await load();
}

function row(track: MixTrack): HTMLElement {
  const settings = mix[track.key] ?? { ...DEFAULT_TRACK };
  mix[track.key] = settings;
  const dbOut = h("output", { class: "readout" }, dbText(settings.db));
  const panOut = h("output", { class: "readout" }, panText(settings.pan));
  const toggle = (name: "mute" | "solo", label: string) => {
    const button = h(
      "button",
      {
        type: "button",
        class: `btn small toggle ${name}`,
        "aria-pressed": String(settings[name]),
        "aria-label": `${label} ${track.label}`,
        onclick: () => {
          settings[name] = !settings[name];
          button.setAttribute("aria-pressed", String(settings[name]));
          changed();
        },
      },
      label,
    );
    return button;
  };
  return h(
    "div",
    { class: "mixrow", "data-track": track.key },
    h(
      "div",
      { class: "track-name" },
      track.label,
      track.startBar === null ? null : h("span", { class: "meta" }, ` bar ${track.startBar}`),
    ),
    h(
      "label",
      { class: "knob" },
      h("span", { class: "field-label" }, "Level"),
      h("input", {
        type: "range",
        name: "level",
        min: MIN_DB,
        max: MAX_DB,
        step: 0.5,
        value: String(settings.db),
        "aria-label": `Level of ${track.label}`,
        oninput: (event: Event) => {
          settings.db = Number((event.target as HTMLInputElement).value);
          dbOut.textContent = dbText(settings.db);
          changed();
        },
      }),
      dbOut,
    ),
    h(
      "label",
      { class: "knob" },
      h("span", { class: "field-label" }, "Pan"),
      h("input", {
        type: "range",
        name: "pan",
        min: -1,
        max: 1,
        step: 0.05,
        value: String(settings.pan),
        "aria-label": `Pan of ${track.label}`,
        oninput: (event: Event) => {
          settings.pan = Number((event.target as HTMLInputElement).value);
          panOut.textContent = panText(settings.pan);
          changed();
        },
      }),
      panOut,
    ),
    toggle("mute", "Mute"),
    toggle("solo", "Solo"),
  );
}

function draw(): void {
  const project = app.project;
  if (project === null || view === null) {
    fill(
      tracksBox,
      h("p", { class: "empty" }, loadError ?? "Open a project from the Library first."),
    );
    fill(rendersBox);
    return;
  }
  if (view.tracks.length === 0) {
    fill(
      tracksBox,
      h(
        "div",
        { class: "empty-state", "data-state": "no-stems" },
        h(
          "p",
          null,
          "No stems yet. Split the song into stems on the Produce stage, then mix them here.",
        ),
        h(
          "button",
          { type: "button", class: "btn", onclick: () => go("produce") },
          "Go to Produce",
        ),
      ),
    );
  } else {
    fill(tracksBox, ...view.tracks.map(row));
    dimRows();
  }
  const list = [...view.renders].reverse();
  fill(
    rendersBox,
    h("h3", null, "Rendered mixes"),
    list.length === 0
      ? h("p", { class: "empty" }, "No mix rendered yet.")
      : h(
          "ul",
          { class: "version-list" },
          ...list.map((each) =>
            h(
              "li",
              { class: "version", "data-mix": String(each.n) },
              h("div", { class: "card-title" }, `mix-${each.n}.wav`),
              player(project.id, String(each.n), "mix", `mix ${each.n}`),
            ),
          ),
        ),
  );
}

function update(): void {
  heading.textContent = app.project === null ? "Mix" : `Mix — ${app.project.title}`;
  if (dirty) {
    dirty = false;
    draw();
  }
  buttons();
}

export function mountMix(): { root: HTMLElement; update: () => void; sync: () => void } {
  const root = h(
    "div",
    { class: "stage mix", "data-stage": "mix" },
    h(
      "section",
      { class: "main wide" },
      heading,
      banner,
      tracksBox,
      h(
        "div",
        { class: "actions" },
        play,
        stop,
        render,
        h("p", { class: "cost" }, "Rendered on this computer with ffmpeg. Free, no confirm."),
      ),
      status,
      note,
      rendersBox,
    ),
  );

  return {
    root,
    update,
    sync: () => {
      if (loadedFor !== app.project?.id) view = null;
      preview.reset();
      previewState = "idle";
      void load();
      dirty = true;
      update();
    },
  };
}
