/**
 * Edits to a prepared track: tempo, grid, cues, loop. Each takes the track's
 * `Prep` and answers a new one, or the sentence saying why it cannot. Cues
 * and the loop are always on beats of the current grid; when the grid
 * changes they move with it.
 */

import type { Prep } from "../project/prep";
import {
  cuesFromSections,
  type Grid,
  LOOP_BARS,
  MAX_GRID_BPM,
  MIN_GRID_BPM,
  nudged,
  resnapped,
  type SectionStart,
  type Slot,
  snapToBeat,
  withCue,
  withoutCue,
} from "./grid";

const NEED_TEMPO = "There is no tempo yet. Analyse the track, or type a BPM in.";

const round = (value: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/** The same track on a new grid, its cues and loop put back on that grid's beats. */
function onGrid(prep: Prep, grid: Grid, manualBpm: boolean): Prep {
  const moved = resnapped(prep.cues, prep.loop, grid);
  return { ...prep, grid, manualBpm, cues: moved.cues, loop: moved.loop };
}

/** A tempo typed in; the first beat stays where it was (0 when there was no grid). */
export function withBpm(prep: Prep, bpm: unknown): Prep | string {
  if (typeof bpm !== "number" || !Number.isFinite(bpm) || bpm < MIN_GRID_BPM || bpm > MAX_GRID_BPM)
    return `A tempo is between ${MIN_GRID_BPM} and ${MAX_GRID_BPM} BPM.`;
  return onGrid(prep, { bpm: round(bpm, 2), firstBeatSec: prep.grid?.firstBeatSec ?? 0 }, true);
}

/** The grid moved by `deltaMs`. */
export function withNudge(prep: Prep, deltaMs: unknown): Prep | string {
  if (prep.grid === null) return NEED_TEMPO;
  if (typeof deltaMs !== "number" || !Number.isFinite(deltaMs) || Math.abs(deltaMs) > 1000)
    return "Nudge the grid by up to a second.";
  return onGrid(prep, nudged(prep.grid, deltaMs), prep.manualBpm);
}

/** The first beat put at `sec` (where the playhead is). */
export function withFirstBeat(prep: Prep, sec: unknown): Prep | string {
  if (prep.grid === null) return NEED_TEMPO;
  if (typeof sec !== "number" || !Number.isFinite(sec) || sec < 0)
    return "The first beat is a time in the track.";
  return onGrid(prep, { bpm: prep.grid.bpm, firstBeatSec: round(sec, 3) }, prep.manualBpm);
}

/** A cue at the beat nearest `sec`; `name` is kept from the cue it replaces unless one is given. */
export function setCue(prep: Prep, slot: Slot, sec: unknown, name?: unknown): Prep | string {
  if (prep.grid === null) return NEED_TEMPO;
  if (typeof sec !== "number" || !Number.isFinite(sec) || sec < 0)
    return "A cue is a time in the track.";
  if (sec > prep.analysis.durationSec) return "That is past the end of the track.";
  return {
    ...prep,
    cues: withCue(
      prep.cues,
      slot,
      sec,
      prep.grid,
      typeof name === "string" ? name.trim().slice(0, 40) : undefined,
    ),
  };
}

export const deleteCue = (prep: Prep, slot: Slot): Prep => ({
  ...prep,
  cues: withoutCue(prep.cues, slot),
});

/** The sections that start inside the track (a plan can be longer than the audio it made). */
export const startingInside = (sections: SectionStart[], durationSec: number): SectionStart[] =>
  sections.filter((each) => each.startSec < durationSec);

/** Replaces the cues with one per section start. */
export function autoCues(prep: Prep, all: SectionStart[]): Prep | string {
  if (prep.grid === null) return NEED_TEMPO;
  const sections = startingInside(all, prep.analysis.durationSec);
  if (sections.length === 0)
    return "This song has no section plan (a Lyria sketch has none), so there is nothing to cue from.";
  return { ...prep, cues: cuesFromSections(sections, prep.grid) };
}

export function setLoop(prep: Prep, startSec: unknown, bars: unknown): Prep | string {
  if (prep.grid === null) return NEED_TEMPO;
  if (typeof startSec !== "number" || !Number.isFinite(startSec) || startSec < 0)
    return "A loop starts at a time in the track.";
  if (typeof bars !== "number" || !LOOP_BARS.some((each) => each === bars))
    return `A loop is ${LOOP_BARS.join(", ")} bars long.`;
  const start = snapToBeat(startSec, prep.grid);
  const end = start + (bars * 4 * 60) / prep.grid.bpm;
  if (end > prep.analysis.durationSec + 0.05) return "That loop runs past the end of the track.";
  return { ...prep, loop: { startSec: start, bars } };
}

export const clearLoop = (prep: Prep): Prep => ({ ...prep, loop: null });
