/**
 * The Edit stage's timeline drawn in bars: a ruler, a video lane (one block
 * per shot, with its still frame, its transition and speed, and a hatched
 * block where the shot has no clip), a captions lane and an audio lane. Plain
 * positioned boxes; widths are shares of the song's length.
 */

import type { EditView, SlotView } from "./api";
import { fill, h } from "./dom";
import { picture } from "./video";

const pct = (value: number, total: number): string =>
  `${Math.round((value / Math.max(total, 0.001)) * 10000) / 100}%`;

const TRANSITION_WORDS = { cut: "cut", flash: "flash", crossfade: "crossfade" } as const;

function ruler(view: EditView): HTMLElement {
  const first = view.slots[0];
  const bars =
    first === undefined ? 0 : Math.max(1, Math.round(view.totalSec / (view.beatSec * 4)));
  const every = Math.max(1, Math.ceil(bars / 16));
  const ticks: HTMLElement[] = [];
  for (let bar = 1; bar <= bars; bar += every) {
    ticks.push(
      h(
        "span",
        { class: "tick", style: `left:${pct((bar - 1) * view.beatSec * 4, view.totalSec)}` },
        String(bar),
      ),
    );
  }
  return h("div", { class: "ruler", "aria-label": "Bars" }, ...ticks);
}

function block(project: string, slot: SlotView, view: EditView): HTMLElement {
  const marks = [
    slot.number > 1 && slot.transition !== "cut" ? TRANSITION_WORDS[slot.transition] : null,
    slot.speed === "ramp" ? "ramp 50%" : null,
  ].filter((each): each is string => each !== null);
  return h(
    "div",
    {
      class: `block${slot.hasClip ? "" : " gap"}${slot.transition !== "cut" && slot.number > 1 ? ` t-${slot.transition}` : ""}`,
      style: `left:${pct(slot.startSec, view.totalSec)};width:${pct(slot.endSec - slot.startSec, view.totalSec)}`,
      "data-shot": slot.shot,
      title: `Shot ${slot.number}, ${slot.section}: bar ${slot.startBar}, ${slot.bars} bars${slot.hasClip ? "" : ", no clip: renders black"}`,
    },
    slot.frame === null || !slot.hasClip
      ? null
      : picture(project, "frame", slot.shot, slot.frame, ""),
    h("span", { class: "block-label" }, `${slot.number}`),
    slot.hasClip ? null : h("span", { class: "block-gap" }, "no clip"),
    marks.length === 0 ? null : h("span", { class: "block-mark" }, marks.join(", ")),
  );
}

function captionsLane(view: EditView): HTMLElement {
  const c = view.captions;
  const text = !c.on
    ? "Captions off"
    : c.words === 0
      ? "No captions: this song has no sung words"
      : `Karaoke captions from the word timestamps (${c.words} words)${c.burnable ? "" : ", but this ffmpeg cannot burn them in"}`;
  return h("div", { class: `lane-band captions${c.on && c.words > 0 ? " on" : ""}` }, text);
}

function audioLane(view: EditView): HTMLElement {
  return h(
    "div",
    { class: `lane-band audio${view.audio === null ? "" : " on"}` },
    view.audio === null ? "No soundtrack" : `Soundtrack: ${view.audio.label}. Clip sound is muted.`,
  );
}

/** Draws the lanes into `into`. */
export function drawTimeline(into: HTMLElement, project: string, view: EditView | null): void {
  if (view === null || view.slots.length === 0) {
    fill(
      into,
      h(
        "p",
        { class: "empty", "data-state": "no-timeline" },
        "No timeline yet: draft the shot list on the Storyboard stage.",
      ),
    );
    return;
  }
  const width = Math.max(100, Math.round(view.totalSec * 9));
  fill(
    into,
    h(
      "div",
      { class: "timeline-scroll" },
      h(
        "div",
        { class: "timeline", style: `min-width:${width}px` },
        h("div", { class: "lane-name" }, "Bars"),
        ruler(view),
        h("div", { class: "lane-name" }, "Video"),
        h("div", { class: "lane video" }, ...view.slots.map((slot) => block(project, slot, view))),
        h("div", { class: "lane-name" }, "Captions"),
        captionsLane(view),
        h("div", { class: "lane-name" }, "Audio"),
        audioLane(view),
      ),
    ),
  );
}
