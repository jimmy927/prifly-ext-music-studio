/** What the Video session tools share: how a run's end is told to the session, and shots named by number or id. */

import { join } from "node:path";
import { readTreatment } from "./project/video";
import { moneyOf } from "./routes/video-common";
import type { Job, Started, Studio } from "./studio";
import { CANCELLED } from "./tools";
import { money } from "./video/constants";
import type { Shot, ShotList } from "./video/shotlist";

export const PROJECT = {
  type: "string",
  description: "The project id; default the newest.",
} as const;

/** A run that did not start, or ended badly, as the session is told; else the finished job. */
export async function outcomeOf(started: Started): Promise<{ text: string } | { job: Job }> {
  if (!started.ok)
    return { text: started.reason === "cancelled" ? CANCELLED : `Not done: ${started.message}` };
  const job = await started.finished;
  if (job.status === "cancelled") return { text: "Cancelled. Anything already made is kept." };
  if (job.status === "failed") return { text: `Stopped: ${job.error ?? "failed"}` };
  return { job };
}

/** A shot by its 1-based number or its id. */
export function shotId(list: ShotList, ref: unknown): string | null {
  if (typeof ref === "number") return list.shots[Math.round(ref) - 1]?.id ?? null;
  if (typeof ref !== "string") return null;
  if (/^\d+$/.test(ref)) return list.shots[Number(ref) - 1]?.id ?? null;
  return list.shots.find((each) => each.id === ref)?.id ?? null;
}

/** The ids of the shots a call names (numbers or ids); the message for one that is none. */
export function shotIds(list: ShotList, refs: unknown): string[] | string {
  const out: string[] = [];
  for (const ref of Array.isArray(refs) ? refs : []) {
    const id = shotId(list, ref);
    if (id === null)
      return `There is no shot ${String(ref)}; the song has ${list.shots.length} (numbered from 1).`;
    out.push(id);
  }
  return out;
}

export const clock = (sec: number): string => {
  const whole = Math.floor(sec);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

export function shotLine(shot: Shot, at: number, dir: string): string {
  const frame = shot.frame === null ? "no frame" : `frame ${join(dir, shot.frame)}`;
  const state = shot.approved ? "approved" : "not approved";
  const text = shot.text === "" ? "(no description)" : shot.text;
  return `${at + 1}. [${shot.id}] ${shot.section} ${clock(shot.startSec)}-${clock(shot.endSec)}: ${text} (${frame}, ${state})`;
}

export async function budgetLine(studio: Studio, dir: string): Promise<string> {
  const m = await moneyOf(studio, dir, await readTreatment(dir));
  return `Budget: ${money(m.spentUsd)} spent of ${money(m.budgetUsd)} (estimates).`;
}

export const NO_LIST = "Not done: there is no shot list yet. Draft one with video_storyboard.";
