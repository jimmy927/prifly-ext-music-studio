/**
 * The beatgrid, cues and loop of a prepared track, as plain data and the maths
 * on it. The page bundles this file too, so it imports nothing of the server's.
 * A grid is a tempo and the time of its first beat; every beat is `first + n *
 * 60 / bpm`, and a bar is four beats.
 */

export type Grid = { bpm: number; firstBeatSec: number };

export const SLOTS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;
export type Slot = (typeof SLOTS)[number];
export const isSlot = (value: unknown): value is Slot => SLOTS.some((each) => each === value);

export type Cue = { slot: Slot; sec: number; name: string };

export const LOOP_BARS = [1, 2, 4, 8, 16, 32] as const;
export type Loop = { startSec: number; bars: number };

export const BEATS_PER_BAR = 4;
export const MIN_GRID_BPM = 40;
export const MAX_GRID_BPM = 240;

const ms = (value: number): number => Math.round(value * 1000) / 1000;

export const beatSeconds = (grid: Grid): number => 60 / grid.bpm;

/** The beat nearest to `sec`; never before 0. */
export function snapToBeat(sec: number, grid: Grid): number {
  const beat = beatSeconds(grid);
  const first = Math.ceil(-grid.firstBeatSec / beat - 1e-9);
  const index = Math.max(first, Math.round((sec - grid.firstBeatSec) / beat));
  return ms(grid.firstBeatSec + index * beat);
}

/** Every beat from `from` to `to` seconds, as `{ sec, bar, beat }` with bar 1 and beat 1 at the first beat. */
export function beatsBetween(
  grid: Grid,
  from: number,
  to: number,
): { sec: number; bar: number; beat: number }[] {
  const beat = beatSeconds(grid);
  const out: { sec: number; bar: number; beat: number }[] = [];
  const start = Math.ceil((Math.max(from, 0) - grid.firstBeatSec) / beat - 1e-9);
  for (let index = start; ; index += 1) {
    const sec = grid.firstBeatSec + index * beat;
    if (sec > to) break;
    const inBar = ((index % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR;
    out.push({ sec: ms(sec), bar: Math.floor(index / BEATS_PER_BAR) + 1, beat: inBar + 1 });
  }
  return out;
}

/** The grid moved by `deltaMs` (negative earlier); the first beat stays at or after 0. */
export const nudged = (grid: Grid, deltaMs: number): Grid => ({
  bpm: grid.bpm,
  firstBeatSec: ms(Math.max(0, grid.firstBeatSec + deltaMs / 1000)),
});

export const loopSeconds = (grid: Grid, bars: number): number =>
  ms(bars * BEATS_PER_BAR * beatSeconds(grid));

export const loopEnd = (grid: Grid, loop: Loop): number =>
  ms(loop.startSec + loopSeconds(grid, loop.bars));

/** Cue and loop times put back on the beats of a new grid, so they move with it. */
export function resnapped(
  cues: Cue[],
  loop: Loop | null,
  grid: Grid,
): { cues: Cue[]; loop: Loop | null } {
  return {
    cues: cues.map((each) => ({ ...each, sec: snapToBeat(each.sec, grid) })),
    loop: loop === null ? null : { ...loop, startSec: snapToBeat(loop.startSec, grid) },
  };
}

/** A cue in `slot` at the beat nearest `sec`; an existing cue of that slot moves (keeping its name). */
export function withCue(cues: Cue[], slot: Slot, sec: number, grid: Grid, name?: string): Cue[] {
  const before = cues.find((each) => each.slot === slot);
  const cue: Cue = {
    slot,
    sec: snapToBeat(sec, grid),
    name: name ?? before?.name ?? "",
  };
  return sortedCues([...cues.filter((each) => each.slot !== slot), cue]);
}

export const withoutCue = (cues: Cue[], slot: Slot): Cue[] =>
  cues.filter((each) => each.slot !== slot);

export const sortedCues = (cues: Cue[]): Cue[] =>
  [...cues].sort((a, b) => SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot));

/** A section of the song's plan: its name and where it starts. */
export type SectionStart = { name: string; startSec: number };

/** One cue per section start, A to H, on the nearest beat; later sections beyond the eighth are left out. */
export function cuesFromSections(sections: SectionStart[], grid: Grid): Cue[] {
  const out: Cue[] = [];
  for (const [at, section] of sections.slice(0, SLOTS.length).entries()) {
    const slot = SLOTS[at];
    if (slot === undefined) break;
    out.push({ slot, sec: snapToBeat(section.startSec, grid), name: section.name });
  }
  return out;
}

export const clockText = (sec: number): string => {
  const whole = Math.max(0, sec);
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${(whole - minutes * 60).toFixed(2).padStart(5, "0")}`;
};
