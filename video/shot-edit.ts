/** The reader's edits to the shot list: write a description, approve a frame, split a shot on a beat, join it with the next. Free. */

import { isRecord } from "../engines/types";
import { readShots, writeShots } from "../project/video";
import { mergeWithNext, type ShotList, splitShot } from "./shotlist";

export type ShotChange = {
  shot: string;
  text?: string;
  approved?: boolean;
  /** Split the shot at the beat nearest this second. */
  splitAt?: number;
  /** Join the shot with the next one. */
  merge?: boolean;
};

/** One change from untrusted data, or null. */
export function parseChange(raw: unknown): ShotChange | null {
  if (!isRecord(raw) || typeof raw["shot"] !== "string") return null;
  return {
    shot: raw["shot"],
    ...(typeof raw["text"] === "string" ? { text: raw["text"].trim().slice(0, 2000) } : {}),
    ...(typeof raw["approved"] === "boolean" ? { approved: raw["approved"] } : {}),
    ...(typeof raw["splitAt"] === "number" && Number.isFinite(raw["splitAt"])
      ? { splitAt: raw["splitAt"] }
      : {}),
    ...(raw["merge"] === true ? { merge: true } : {}),
  };
}

export type Changed = { ok: true; list: ShotList } | { ok: false; message: string };

function fields(list: ShotList, change: ShotChange): Changed {
  const at = list.shots.findIndex((each) => each.id === change.shot);
  const shot = list.shots[at];
  if (shot === undefined) return { ok: false, message: "There is no such shot." };
  if (change.approved === true && shot.frame === null)
    return { ok: false, message: `Shot ${at + 1} has no frame to approve yet. Draw it first.` };
  const next = {
    ...shot,
    ...(change.text === undefined ? {} : { text: change.text }),
    ...(change.approved === undefined ? {} : { approved: change.approved }),
  };
  return {
    ok: true,
    list: { ...list, shots: list.shots.map((each) => (each === shot ? next : each)) },
  };
}

/** One change applied to a list. Split and merge come after the field edits. */
export function applyChange(list: ShotList, change: ShotChange): Changed {
  let now = fields(list, change);
  if (!now.ok) return now;
  if (change.splitAt !== undefined) {
    const split = splitShot(now.list, change.shot, change.splitAt);
    if (!split.ok) return split;
    now = { ok: true, list: split.list };
  }
  if (change.merge === true) {
    const merged = mergeWithNext(now.list, change.shot);
    if (!merged.ok) return merged;
    now = { ok: true, list: merged.list };
  }
  return now;
}

/** Applies the changes in order and saves; nothing is saved if one of them cannot be made. */
export async function editShots(dir: string, changes: ShotChange[]): Promise<Changed> {
  const first = await readShots(dir);
  if (first === null) return { ok: false, message: "There is no shot list yet. Draft one first." };
  let list = first;
  for (const change of changes) {
    const done = applyChange(list, change);
    if (!done.ok) return done;
    list = done.list;
  }
  await writeShots(dir, list);
  return { ok: true, list };
}

/** Approves every shot that has a frame. */
export async function approveAll(dir: string): Promise<Changed> {
  const list = await readShots(dir);
  if (list === null) return { ok: false, message: "There is no shot list yet. Draft one first." };
  const next = {
    ...list,
    shots: list.shots.map((each) => (each.frame === null ? each : { ...each, approved: true })),
  };
  await writeShots(dir, next);
  return { ok: true, list: next };
}
