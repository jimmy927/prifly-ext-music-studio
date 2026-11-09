/**
 * The shot list: the song cut into shots that tile it with no gap and no
 * overlap, every cut on a beat of the grid. Pure, so the page runs the same
 * code to split and merge; it imports only the grid's maths.
 *
 * The rule: a section is cut into shots of the treatment's bar count (2, 4
 * or 8), counted from the section's first beat; what is left at its end, if
 * it is a bar or more, becomes a shot of its own, and if it is less than a
 * bar it joins the shot before. The first shot starts at 0 (the song's
 * start, which may be a little before the first beat), the last ends where
 * the song ends. A shot is at most 15 seconds, the longest clip Omni makes;
 * a bar rule that would give a longer shot is halved until it fits.
 */

import { BEATS_PER_BAR, beatSeconds, type Grid, type SectionStart, snapToBeat } from "../prep/grid";
import { MAX_CLIP_SEC, MIN_CLIP_SEC, type ShotBars } from "./constants";

export type Shot = {
  id: string;
  /** The song section it starts in: "Verse 1". */
  section: string;
  startSec: number;
  endSec: number;
  /** What the shot shows; may be blank until the reader writes it. */
  text: string;
  approved: boolean;
  /** The still frame, relative to the project's folder. */
  frame: string | null;
  frameError: string | null;
  /** The id of the chosen take. */
  take: string | null;
};

export type ShotList = { bpm: number; firstBeatSec: number; durationSec: number; shots: Shot[] };

export const isShotId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}$/.test(value);

export const newShotId = (): string => crypto.randomUUID().replaceAll("-", "").slice(0, 8);

const round = (value: number): number => Math.round(value * 1000) / 1000;

export const gridOf = (list: ShotList): Grid => ({
  bpm: list.bpm,
  firstBeatSec: list.firstBeatSec,
});
export const barSeconds = (grid: Grid): number => BEATS_PER_BAR * beatSeconds(grid);
export const lengthOf = (shot: Pick<Shot, "startSec" | "endSec">): number =>
  round(shot.endSec - shot.startSec);

/** How many bars a shot is, to one decimal. */
export const barsOf = (shot: Pick<Shot, "startSec" | "endSec">, grid: Grid): number =>
  Math.round((lengthOf(shot) / barSeconds(grid)) * 10) / 10;

/** Whole seconds of video to ask Omni for: the shot's length rounded up, between 3 and 15. */
export const clipSeconds = (shot: Pick<Shot, "startSec" | "endSec">): number =>
  Math.min(MAX_CLIP_SEC, Math.max(MIN_CLIP_SEC, Math.ceil(lengthOf(shot) - 1e-6)));

/** The bar count the rule gives at this tempo: halved until a shot of it fits in 15 seconds. */
export function effectiveBars(bars: ShotBars, grid: Grid): number {
  let each: number = bars;
  while (each > 1 && each * barSeconds(grid) > MAX_CLIP_SEC) each = Math.floor(each / 2);
  return each;
}

/** Cuts inside [from, to]: every `bars` bars from `from`, stopping while a full bar or more remains. */
function cutsWithin(from: number, to: number, bars: number, grid: Grid): number[] {
  const step = bars * barSeconds(grid);
  const bar = barSeconds(grid);
  const cuts: number[] = [];
  for (let at = from + step; to - at >= bar - 1e-6; at += step) cuts.push(snapToBeat(at, grid));
  return cuts;
}

/** The section starts as cut points: snapped to beats, increasing, inside the song. */
function sectionCuts(starts: SectionStart[], grid: Grid, durationSec: number): number[] {
  const cuts: number[] = [];
  for (const start of starts.slice(1)) {
    const at = snapToBeat(start.startSec, grid);
    const last = cuts.at(-1) ?? 0;
    if (at > last + 1e-6 && at < durationSec - 1e-6) cuts.push(at);
  }
  return cuts;
}

/** Every boundary of the song, in order, 0 and the song's end included. */
function boundaries(
  starts: SectionStart[],
  grid: Grid,
  durationSec: number,
  bars: number,
): number[] {
  const inner = sectionCuts(starts, grid, durationSec);
  const edges = [0, ...inner, durationSec];
  const out: number[] = [0];
  for (const [at, from] of edges.slice(0, -1).entries()) {
    const to = edges[at + 1] ?? durationSec;
    const origin = at === 0 ? snapToBeat(0, grid) : from;
    out.push(...cutsWithin(origin, to, bars, grid).filter((cut) => cut > from + 1e-6), to);
  }
  return out;
}

/** Splits any shot longer than the clip limit at the beat nearest its middle, until none is. */
function capped(edges: number[], grid: Grid): number[] {
  const out: number[] = [];
  for (const [at, from] of edges.slice(0, -1).entries()) {
    const to = edges[at + 1] ?? from;
    out.push(from, ...evenCuts(from, to, grid));
  }
  out.push(edges.at(-1) ?? 0);
  return out;
}

function evenCuts(from: number, to: number, grid: Grid): number[] {
  if (to - from <= MAX_CLIP_SEC + 1e-6) return [];
  const middle = snapToBeat((from + to) / 2, grid);
  if (middle <= from + 1e-6 || middle >= to - 1e-6) return [];
  return [...evenCuts(from, middle, grid), middle, ...evenCuts(middle, to, grid)];
}

/** Drops a last shot shorter than a bar into the one before it, when that stays within the limit. */
function withoutRunt(edges: number[], grid: Grid): number[] {
  const n = edges.length;
  if (n < 3) return edges;
  const last = (edges[n - 1] ?? 0) - (edges[n - 2] ?? 0);
  const joined = (edges[n - 1] ?? 0) - (edges[n - 3] ?? 0);
  if (last >= barSeconds(grid) - 1e-6 || joined > MAX_CLIP_SEC + 1e-6) return edges;
  return [...edges.slice(0, n - 2), edges[n - 1] ?? 0];
}

/** The section that holds `sec`: the last start at or before it. */
function sectionAt(starts: SectionStart[], sec: number): string {
  let name = starts[0]?.name ?? "Song";
  for (const each of starts) if (each.startSec <= sec + 1e-6) name = each.name;
  return name;
}

export type DraftInput = {
  sections: SectionStart[];
  grid: Grid;
  durationSec: number;
  bars: ShotBars;
  /** For tests: the ids to give, in order. */
  makeId?: () => string;
};

/** The shot list for a song. Descriptions are blank; frames and takes none. */
export function draftShots(input: DraftInput): ShotList {
  const { grid, durationSec } = input;
  const bars = effectiveBars(input.bars, grid);
  const starts = input.sections.map((each) => ({
    ...each,
    startSec: snapToBeat(each.startSec, grid),
  }));
  const first = starts[0];
  if (first !== undefined) first.startSec = 0;
  const edges = withoutRunt(capped(boundaries(starts, grid, durationSec, bars), grid), grid);
  const makeId = input.makeId ?? newShotId;
  const shots: Shot[] = [];
  for (const [at, from] of edges.slice(0, -1).entries()) {
    shots.push({
      id: makeId(),
      section: sectionAt(starts, from),
      startSec: round(from),
      endSec: round(edges[at + 1] ?? from),
      text: "",
      approved: false,
      frame: null,
      frameError: null,
      take: null,
    });
  }
  return { bpm: grid.bpm, firstBeatSec: grid.firstBeatSec, durationSec, shots };
}

/** What is wrong with how the shots tile the song, in words; empty when they tile it. */
export function tilingProblems(list: ShotList): string[] {
  const problems: string[] = [];
  const grid = gridOf(list);
  const beat = beatSeconds(grid);
  let expected = 0;
  for (const [at, shot] of list.shots.entries()) {
    const name = `Shot ${at + 1}`;
    if (Math.abs(shot.startSec - expected) > 1e-3)
      problems.push(
        `${name} starts at ${shot.startSec}s but the one before ends at ${expected}s (${shot.startSec > expected ? "a gap" : "an overlap"}).`,
      );
    if (shot.endSec <= shot.startSec) problems.push(`${name} has no length.`);
    if (
      at > 0 &&
      Math.abs(snapToBeat(shot.startSec, grid) - shot.startSec) > Math.min(1e-3, beat / 10)
    )
      problems.push(`${name} does not start on a beat.`);
    if (lengthOf(shot) > MAX_CLIP_SEC + 1e-3)
      problems.push(`${name} is longer than ${MAX_CLIP_SEC} seconds.`);
    expected = shot.endSec;
  }
  if (list.shots.length > 0 && Math.abs(expected - list.durationSec) > 1e-3)
    problems.push(`The shots end at ${expected}s but the song lasts ${list.durationSec}s.`);
  return problems;
}

export type Edited = { ok: true; list: ShotList; added?: string } | { ok: false; message: string };

/** Splits a shot at the beat nearest `atSec`; each half must be at least a beat long. */
export function splitShot(
  list: ShotList,
  id: string,
  atSec: number,
  makeId: () => string = newShotId,
): Edited {
  const at = list.shots.findIndex((each) => each.id === id);
  const shot = list.shots[at];
  if (shot === undefined) return { ok: false, message: "There is no such shot." };
  const grid = gridOf(list);
  const cut = snapToBeat(atSec, grid);
  const beat = beatSeconds(grid);
  if (cut < shot.startSec + beat - 1e-3 || cut > shot.endSec - beat + 1e-3)
    return { ok: false, message: "Split on a beat at least one beat from either end of the shot." };
  const added = makeId();
  const head: Shot = { ...shot, endSec: round(cut) };
  const tail: Shot = {
    ...shot,
    id: added,
    startSec: round(cut),
    text: "",
    approved: false,
    frame: null,
    frameError: null,
    take: null,
  };
  const shots = [...list.shots.slice(0, at), head, tail, ...list.shots.slice(at + 1)];
  return { ok: true, list: { ...list, shots }, added };
}

/** Joins a shot with the one after it; the first keeps its frame, the clip is to be shot again. */
export function mergeWithNext(list: ShotList, id: string): Edited {
  const at = list.shots.findIndex((each) => each.id === id);
  const shot = list.shots[at];
  const next = list.shots[at + 1];
  if (shot === undefined) return { ok: false, message: "There is no such shot." };
  if (next === undefined)
    return { ok: false, message: "This is the last shot; there is none to join." };
  if (next.endSec - shot.startSec > MAX_CLIP_SEC + 1e-3)
    return {
      ok: false,
      message: `Joined they would last over ${MAX_CLIP_SEC} seconds, the longest clip Omni makes.`,
    };
  const text = [shot.text.trim(), next.text.trim()].filter((each) => each !== "").join(" ");
  const merged: Shot = { ...shot, endSec: next.endSec, text, take: null };
  return {
    ok: true,
    list: { ...list, shots: [...list.shots.slice(0, at), merged, ...list.shots.slice(at + 2)] },
  };
}
