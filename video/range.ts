/**
 * Which shots the vertical cut takes. It starts and ends on shot boundaries
 * (so no clip is cut part-way) and lasts about 30 seconds: the chorus when a
 * section is called one, else the stretch a third of the way in, or the range
 * the reader chose, snapped to the nearest boundaries.
 */

import { VERTICAL_TARGET_SEC } from "./constants";
import { lengthOf, type Shot } from "./shotlist";

export type Range = { startSec: number; endSec: number };

const CHORUS = /chorus|hook|drop|refrain/i;

/** The shots from index `from` on, as many as bring the length closest to `target`. */
function run(shots: Shot[], from: number, target: number): Range | null {
  const first = shots[from];
  if (first === undefined) return null;
  let end = first.endSec;
  for (const shot of shots.slice(from + 1)) {
    const now = end - first.startSec;
    if (now >= target || Math.abs(now + lengthOf(shot) - target) > Math.abs(now - target)) break;
    end = shot.endSec;
  }
  return { startSec: first.startSec, endSec: end };
}

const nearest = (values: number[], wanted: number): number =>
  values.reduce(
    (best, each) => (Math.abs(each - wanted) < Math.abs(best - wanted) ? each : best),
    values[0] ?? wanted,
  );

/** The vertical cut's range, or null when there are no shots. `chosen` is the reader's range, if any. */
export function pickRange(
  shots: Shot[],
  chosen: Range | null,
  target = VERTICAL_TARGET_SEC,
): Range | null {
  if (shots.length === 0) return null;
  if (chosen !== null) {
    const starts = shots.map((each) => each.startSec);
    const ends = shots.map((each) => each.endSec);
    const startSec = nearest(starts, chosen.startSec);
    const endSec = nearest(
      ends.filter((each) => each > startSec),
      chosen.endSec,
    );
    if (endSec > startSec) return { startSec, endSec };
  }
  const chorus = shots.findIndex((each) => CHORUS.test(each.section));
  const from = chorus >= 0 ? chorus : Math.floor(shots.length / 3);
  const found = run(shots, from, target) ?? run(shots, 0, target);
  return found === null ? null : widened(shots, found, target);
}

/** A range that stopped short because the song ended takes earlier shots too, while that brings it closer to the target. */
function widened(shots: Shot[], range: Range, target: number): Range {
  let startSec = range.startSec;
  for (const shot of shots.toReversed()) {
    if (shot.endSec > startSec + 1e-3) continue;
    const now = range.endSec - startSec;
    if (Math.abs(now + lengthOf(shot) - target) >= Math.abs(now - target)) break;
    startSec = shot.startSec;
  }
  return { startSec, endSec: range.endSec };
}

/** The shots inside a range. */
export const shotsIn = (shots: Shot[], range: Range): Shot[] =>
  shots.filter(
    (each) => each.startSec >= range.startSec - 1e-3 && each.endSec <= range.endSec + 1e-3,
  );
