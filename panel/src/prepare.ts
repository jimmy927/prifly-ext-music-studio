/**
 * The Prepare stage (DJ): "Analyse" finds BPM, key with its Camelot code, the
 * first beat and energy 1 to 10; the waveform shows the beatgrid, cues A to H
 * and the loop; everything snaps to beats. The result is kept in the project's
 * `prep.json`, and the Library shows it as BPM, Key and LUFS.
 */

import { clockText } from "../../prep/grid";
import { Deck } from "./deck";
import { fill, h, icon } from "./dom";
import { cancelLocal, local, localBusy, localNotice, localProgress, startLocal } from "./local";
import {
  bpmInput,
  compatibleRow,
  crateControls,
  cuesBox,
  gridControls,
  hooks,
  loopControls,
} from "./prep-controls";
import { load, prep, ps } from "./prep-state";
import { app } from "./state";
import { type WaveData, Waveform } from "./waveform";

const ZOOMS: { span: number; label: string }[] = [
  { span: 0, label: "Whole track" },
  { span: 60, label: "60 seconds" },
  { span: 30, label: "30 seconds" },
  { span: 15, label: "15 seconds" },
  { span: 8, label: "8 seconds" },
];

let deck: Deck | null = null;
let frame = 0;
let drawnFor = "";

const heading = h("h2", null);
const banner = h("div", { class: "notice warn", role: "alert", "data-state": "no-ffmpeg" });
const stale = h("p", { class: "why", role: "status", "data-part": "stale" });
const facts = h("div", { class: "facts", "data-part": "facts" });
const why = h("p", { class: "why", role: "status" });
const slot = h("div", { class: "slot", "data-part": "run-status" });
const tempoNote = h("p", { class: "why tempo-note", role: "status", "data-part": "tempo-note" });
const editNote = h("p", { class: "why", role: "status", "data-part": "edit-note" });
const controls = h("div", { class: "prep-controls" });
const time = h("span", { class: "time" }, "0:00.00");
const playNote = h("span", { class: "player-note", role: "status" });
const wave = new Waveform((sec) => seek(sec));
const analyseButton = h(
  "button",
  { type: "button", class: "btn primary big", id: "analyse", onclick: () => void analyse() },
  icon("wave"),
  "Analyse",
);
const cancelButton = h(
  "button",
  { type: "button", class: "btn", id: "analyse-cancel", onclick: () => void cancelLocal() },
  "Cancel",
);
const playButton = h(
  "button",
  { type: "button", class: "btn", id: "prep-play", onclick: () => void toggle() },
  icon("play", 14),
  "Play",
);
const zoom = h(
  "select",
  { id: "wave-zoom", "aria-label": "Zoom" },
  ...ZOOMS.map((each) => h("option", { value: String(each.span) }, each.label)),
);
const scroll = h("input", {
  type: "range",
  min: 0,
  max: 1000,
  value: 0,
  id: "wave-scroll",
  class: "seek",
  "aria-label": "Position in the track",
});

function seek(sec: number): void {
  ps.playhead = Math.max(0, sec);
  if (deck !== null && deck.audio.readyState > 0) deck.seek(ps.playhead);
  headMoved();
}

hooks.seek = seek;

function headMoved(): void {
  wave.setPlayhead(ps.playhead);
  time.textContent = `${clockText(ps.playhead)} / ${clockText(prep()?.analysis.durationSec ?? 0)}`;
  const { from, to } = wave.window;
  if (zoomSpan() > 0 && (ps.playhead < from || ps.playhead > to)) {
    wave.setWindow(zoomSpan(), Math.max(0, ps.playhead - zoomSpan() * 0.1));
    syncScroll();
  }
}

const zoomSpan = (): number => Number(zoom.value);

function syncScroll(): void {
  const duration = prep()?.analysis.durationSec ?? 0;
  const span = zoomSpan();
  scroll.disabled = span === 0 || duration <= span;
  scroll.value =
    span === 0 || duration <= span
      ? "0"
      : String(Math.round((wave.window.from / (duration - span)) * 1000));
}

zoom.addEventListener("change", () => {
  wave.setWindow(zoomSpan(), Math.max(0, ps.playhead - zoomSpan() / 2));
  syncScroll();
});
scroll.addEventListener("input", () => {
  const duration = prep()?.analysis.durationSec ?? 0;
  const span = zoomSpan();
  wave.setWindow(span, (Number(scroll.value) / 1000) * Math.max(0, duration - span));
});

function follow(): void {
  const playing = deck;
  if (playing?.playing === true) {
    ps.playhead = playing.audio.currentTime;
    headMoved();
    frame = requestAnimationFrame(follow);
  }
}

async function toggle(): Promise<void> {
  const source = prep()?.source;
  const project = app.project;
  if (source === undefined || project === null) return;
  if (deck === null || deck.id !== source.id || deck.kind !== source.kind) {
    deck?.dispose();
    deck = new Deck(project.id, source.kind, source.id);
    deck.audio.addEventListener("pause", () => buttons());
    deck.audio.addEventListener("ended", () => buttons());
  }
  try {
    if (deck.playing) deck.pause();
    else {
      await deck.play();
      deck.seek(ps.playhead);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(follow);
    }
    playNote.textContent = "";
  } catch (caught) {
    playNote.textContent = caught instanceof Error ? caught.message : String(caught);
  }
  buttons();
}

async function analyse(): Promise<void> {
  const project = app.project;
  if (project === null) return;
  await startLocal("analyse", "prepare-analyse", { project: project.id }, async () => {
    deck?.dispose();
    deck = null;
    await load();
    const found = prep();
    drawnFor = "";
    if (found === null) return "Analysed.";
    return found.analysis.bpm === null
      ? "Analysed. No clear tempo was found; type a BPM to make a grid."
      : `Analysed: ${found.grid?.bpm ?? found.analysis.bpm} BPM${found.analysis.key === null ? "" : `, ${found.analysis.key.camelot}`}.`;
  });
}

function blocker(): string | null {
  const view = ps.view;
  if (view === null) return ps.error ?? "Loading…";
  if (!view.ffmpeg.ok) return view.ffmpeg.message;
  if (view.source === null)
    return "There is nothing to analyse yet. Choose a sketch on the Idea stage first.";
  return null;
}

function buttons(): void {
  const reason = blocker();
  const busy = localBusy();
  analyseButton.disabled = reason !== null || busy;
  cancelButton.disabled =
    !(local.job?.status === "running" && local.job.work === "analyse") || local.cancelling;
  cancelButton.textContent = local.cancelling ? "Cancelling…" : "Cancel";
  playButton.disabled = prep() === null;
  playButton.replaceChildren(
    icon(deck?.playing === true ? "pause" : "play", 14),
    deck?.playing === true ? "Pause" : "Play",
  );
  zoom.disabled = prep() === null;
  const view = ps.view;
  why.textContent =
    reason ??
    (busy ? "" : prep() === null ? "Analysing takes a few seconds and runs on this computer." : "");
  banner.hidden = view === null || view.ffmpeg.ok;
  fill(
    banner,
    icon("alert"),
    h(
      "div",
      { class: "notice-body" },
      h("strong", null, "Preparing needs ffmpeg. "),
      view?.ffmpeg.message ?? "",
    ),
  );
  stale.textContent =
    view?.stale === true
      ? `There is a newer ${view.source?.label ?? "file"} than the one analysed. Analyse again to use it.`
      : "";
}

function tile(label: string, value: string, sub = ""): HTMLElement {
  return h(
    "div",
    { class: "fact" },
    h("span", { class: "field-label" }, label),
    h("span", { class: "big-number" }, value),
    h("span", { class: "meta" }, sub),
  );
}

/** Where the BPM came from, in a word. */
function bpmSource(): string {
  const found = prep();
  if (found === null) return "";
  if (found.manualBpm) return "typed in";
  return found.analysis.bpm === null ? "none found" : "found";
}

const orDash = (value: number | null | undefined, make: (value: number) => string): string =>
  value === null || value === undefined ? "—" : make(value);

function drawFacts(): void {
  const found = prep();
  const analysis = found?.analysis;
  const grid = found?.grid ?? null;
  fill(
    facts,
    tile("BPM", orDash(grid?.bpm, String), bpmSource()),
    tile("Key", analysis?.key?.camelot ?? "—", analysis?.key?.name ?? ""),
    tile(
      "First beat",
      orDash(grid?.firstBeatSec, (sec) => `${sec.toFixed(3)} s`),
    ),
    tile(
      "Energy",
      orDash(analysis?.energy, (energy) => `${energy} / 10`),
    ),
    tile(
      "Loudness",
      orDash(analysis?.lufs, (lufs) => `${lufs.toFixed(1)} LUFS`),
      orDash(analysis?.truePeak, (peak) => `peak ${peak.toFixed(1)} dBTP`).replace("—", ""),
    ),
  );
  tempoNote.textContent =
    found !== null && grid === null
      ? "No clear tempo was found in this track, so there is no grid. Type a BPM below to make one."
      : "";
  editNote.textContent = ps.message ?? "";
  if (grid !== null && document.activeElement !== bpmInput) bpmInput.value = String(grid.bpm);
}

function waveData(): WaveData | null {
  const found = prep();
  const peaks = ps.view?.peaks;
  if (found === null || peaks == null) return null;
  return {
    peaks: peaks.peaks,
    perSec: peaks.perSec,
    durationSec: found.analysis.durationSec,
    grid: found.grid,
    cues: found.cues,
    loop: found.loop,
  };
}

function update(): void {
  heading.textContent = app.project === null ? "Prepare" : `Prepare — ${app.project.title}`;
  drawFacts();
  buttons();
  fill(controls, gridControls(), cuesBox(), loopControls(), compatibleRow(), crateControls());
  wave.setData(waveData());
  syncScroll();
  headMoved();
  const key = `${app.project?.id}:${prep()?.analysis.analysedAt}`;
  if (key !== drawnFor) {
    drawnFor = key;
    ps.playhead = 0;
    headMoved();
  }
  fill(slot, localProgress("analyse"), localNotice("analyse"));
}

export function mountPrepare(): { root: HTMLElement; update: () => void; sync: () => void } {
  const root = h(
    "div",
    { class: "stage prepare", "data-stage": "prepare" },
    h(
      "section",
      { class: "main wide" },
      heading,
      banner,
      h("div", { class: "actions" }, analyseButton, cancelButton, why),
      stale,
      slot,
      facts,
      tempoNote,
      wave.root,
      h(
        "div",
        { class: "player wave-bar" },
        playButton,
        time,
        h("span", { class: "grow" }),
        h("label", { class: "field-inline" }, h("span", { class: "field-label" }, "Zoom"), zoom),
        scroll,
      ),
      playNote,
      editNote,
      controls,
    ),
  );
  return {
    root,
    update,
    sync: () => {
      if (ps.loadedFor !== app.project?.id) {
        ps.view = null;
        deck?.dispose();
        deck = null;
        ps.playhead = 0;
      }
      ps.message = null;
      void load();
      update();
    },
  };
}
