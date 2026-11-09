/**
 * What the Shoot and Edit stages keep in `video/`: the takes (`takes/<shot>-<n>.mp4`
 * with a `.json` record beside it, also for a take that failed), `edit.json`
 * (the reader's choices; the clips and the cuts come from the shot list), and
 * the renders (`renders/<kind>-<n>.mp4` with a record). Ids that come from
 * outside are checked before they reach a path.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../engines/types";
import { isShotId } from "../video/shotlist";
import { json, names, readJson, videoDir } from "./video";

/** One take of one shot. `pending` is a call Google accepted whose clip has not been fetched yet. */
export type TakeRecord = {
  /** "<shot id>-<n>". */
  id: string;
  shot: string;
  n: number;
  status: "pending" | "done" | "failed";
  /** Relative to the project's folder; null unless done. */
  file: string | null;
  /** Why it failed, in words. */
  reason: string | null;
  /** The kind of failure ("billing", "blocked", …) so the page can say what to do. */
  failure: string | null;
  seconds: number;
  /** The estimated price, counted in the ledger once the clip is saved. */
  usd: number;
  /** Google's interaction id, kept so a clip can be fetched after a restart. */
  interaction: string | null;
  created: string;
};

export const isTakeId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-\d{1,3}$/.test(value);

function parseTake(raw: unknown): TakeRecord | null {
  if (!isRecord(raw) || !isTakeId(raw["id"]) || !isShotId(raw["shot"])) return null;
  const { n, seconds, usd } = raw;
  if (typeof n !== "number" || typeof seconds !== "number" || typeof usd !== "number") return null;
  const status = raw["status"];
  if (status !== "pending" && status !== "done" && status !== "failed") return null;
  const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
  return {
    id: raw["id"],
    shot: raw["shot"],
    n,
    status,
    file: str(raw["file"]),
    reason: str(raw["reason"]),
    failure: str(raw["failure"]),
    seconds,
    usd,
    interaction: str(raw["interaction"]),
    created: str(raw["created"]) ?? "",
  };
}

/** Every take on disk, oldest first. */
export async function readTakes(dir: string): Promise<TakeRecord[]> {
  const folder = join(videoDir(dir), "takes");
  const out: TakeRecord[] = [];
  for (const name of await names(folder)) {
    if (!name.endsWith(".json")) continue;
    const take = parseTake(await readJson(join(folder, name)));
    if (take !== null) out.push(take);
  }
  return out.sort((a, b) => a.created.localeCompare(b.created) || a.n - b.n);
}

export const takesOf = (takes: TakeRecord[], shot: string): TakeRecord[] =>
  takes.filter((each) => each.shot === shot);

/** The next free take number of a shot. */
export const nextTakeN = (takes: TakeRecord[], shot: string): number =>
  Math.max(0, ...takesOf(takes, shot).map((each) => each.n)) + 1;

export const takeFile = (shot: string, n: number): string => `video/takes/${shot}-${n}.mp4`;

export async function writeTake(dir: string, take: TakeRecord): Promise<void> {
  await mkdir(join(videoDir(dir), "takes"), { recursive: true });
  await writeFile(join(videoDir(dir), "takes", `${take.id}.json`), json(take));
}

export type Transition = "cut" | "flash" | "crossfade";
export type Speed = "normal" | "ramp";
export const TRANSITIONS: readonly Transition[] = ["cut", "flash", "crossfade"];
export const SPEEDS: readonly Speed[] = ["normal", "ramp"];

export type ShotEdit = { transition: Transition; speed: Speed };
export const DEFAULT_SHOT_EDIT: ShotEdit = { transition: "cut", speed: "normal" };

export type EditSettings = {
  captions: boolean;
  shots: Record<string, ShotEdit>;
  /** The vertical cut's range, in seconds on shot boundaries; null for the chorus. */
  vertical: { startSec: number; endSec: number } | null;
};

export const EMPTY_EDIT: EditSettings = { captions: true, shots: {}, vertical: null };

export function parseShotEdit(raw: unknown): ShotEdit {
  if (!isRecord(raw)) return { ...DEFAULT_SHOT_EDIT };
  return {
    transition: TRANSITIONS.find((each) => each === raw["transition"]) ?? "cut",
    speed: SPEEDS.find((each) => each === raw["speed"]) ?? "normal",
  };
}

export function parseEdit(raw: unknown): EditSettings {
  if (!isRecord(raw)) return { captions: true, shots: {}, vertical: null };
  const shots: Record<string, ShotEdit> = {};
  const given = raw["shots"];
  if (isRecord(given))
    for (const [id, value] of Object.entries(given))
      if (isShotId(id)) shots[id] = parseShotEdit(value);
  const range = raw["vertical"];
  const vertical =
    isRecord(range) &&
    typeof range["startSec"] === "number" &&
    typeof range["endSec"] === "number" &&
    range["endSec"] > range["startSec"]
      ? { startSec: range["startSec"], endSec: range["endSec"] }
      : null;
  return { captions: raw["captions"] !== false, shots, vertical };
}

export async function readEdit(dir: string): Promise<EditSettings> {
  return parseEdit(await readJson(join(videoDir(dir), "edit.json")));
}

export async function writeEdit(dir: string, edit: EditSettings): Promise<void> {
  await mkdir(videoDir(dir), { recursive: true });
  await writeFile(join(videoDir(dir), "edit.json"), json(edit));
}

export const shotEditOf = (edit: EditSettings, shot: string): ShotEdit =>
  edit.shots[shot] ?? { ...DEFAULT_SHOT_EDIT };

export type RenderKind = "preview" | "final" | "vertical";
export const RENDER_KINDS: readonly RenderKind[] = ["preview", "final", "vertical"];

export type RenderRecord = {
  n: number;
  kind: RenderKind;
  /** Relative to the project's folder. */
  file: string;
  /** A fingerprint of the edit it was made from, to tell when the edit has changed since. */
  signature: string;
  seconds: number;
  captions: boolean;
  /** Shots that had no clip and rendered black. */
  gaps: number;
  created: string;
};

function parseRender(raw: unknown): RenderRecord | null {
  if (!isRecord(raw) || typeof raw["n"] !== "number" || typeof raw["file"] !== "string")
    return null;
  const kind = RENDER_KINDS.find((each) => each === raw["kind"]);
  if (kind === undefined) return null;
  return {
    n: raw["n"],
    kind,
    file: raw["file"],
    signature: typeof raw["signature"] === "string" ? raw["signature"] : "",
    seconds: typeof raw["seconds"] === "number" ? raw["seconds"] : 0,
    captions: raw["captions"] === true,
    gaps: typeof raw["gaps"] === "number" ? raw["gaps"] : 0,
    created: typeof raw["created"] === "string" ? raw["created"] : "",
  };
}

/** The renders on disk, oldest first. */
export async function readRenders(dir: string): Promise<RenderRecord[]> {
  const folder = join(videoDir(dir), "renders");
  const out: RenderRecord[] = [];
  for (const name of await names(folder)) {
    if (!name.endsWith(".json")) continue;
    const parsed = parseRender(await readJson(join(folder, name)));
    if (parsed !== null) out.push(parsed);
  }
  return out.sort((a, b) => a.created.localeCompare(b.created) || a.n - b.n);
}

export const latestRender = (renders: RenderRecord[], kind: RenderKind): RenderRecord | null =>
  renders.filter((each) => each.kind === kind).at(-1) ?? null;

/** The path the next render of a kind is written to; its folder exists. */
export async function nextRender(
  dir: string,
  kind: RenderKind,
): Promise<{ n: number; file: string }> {
  await mkdir(join(videoDir(dir), "renders"), { recursive: true });
  const n =
    Math.max(
      0,
      ...(await readRenders(dir)).filter((each) => each.kind === kind).map((each) => each.n),
    ) + 1;
  return { n, file: `video/renders/${kind}-${n}.mp4` };
}

export async function writeRender(dir: string, record: RenderRecord): Promise<void> {
  await writeFile(join(videoDir(dir), "renders", `${record.kind}-${record.n}.json`), json(record));
}
