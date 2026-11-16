/**
 * What the Treatment and Storyboard stages keep in a project's `video/`
 * folder: `treatment.json` and `cast/`, `shots.json` and `frames/`, and
 * `spend.json`, the ledger of what the video stages cost. The takes, the edit
 * and the renders are in project/video-media.ts.
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Picture } from "../engines/gemini-video";
import { isRecord } from "../engines/types";
import { MAX_REFERENCES_KEPT } from "../sources/constants";
import { type Ledger, parseBudget, type SpendEntry, type SpendKind } from "../video/budget";
import { DEFAULT_SHOT_BARS, MAX_CAST, SHOT_BARS, type ShotBars } from "../video/constants";
import { isShotId, type Shot, type ShotList } from "../video/shotlist";

export const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

export const videoDir = (dir: string): string => join(dir, "video");

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};
const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** The file extension for an image type, or null when it is not one Gemini takes. */
export const imageExt = (mime: string): string | null => EXT_BY_MIME[mime.toLowerCase()] ?? null;
export const imageMime = (file: string): string =>
  MIME_BY_EXT[file.slice(file.lastIndexOf(".") + 1).toLowerCase()] ?? "image/png";

export const isCastId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}$/.test(value);

export type CastMember = {
  id: string;
  name: string;
  /** The prompt a generated picture was made from; empty for a file. */
  prompt: string;
  /** Relative to the project's folder. */
  file: string;
  source: "generated" | "file";
};

export type Treatment = {
  concept: string;
  look: string;
  /** Also make a 9:16 vertical cut: frames keep their subject in the middle. */
  vertical: boolean;
  shotBars: ShotBars;
  /** The project's own budget; null means the extension's setting. */
  budgetUsd: number | null;
  cast: CastMember[];
  /** Video clips from the project's source material, kept as references for the shots. */
  references: ShotReference[];
};

/** A source video kept in the treatment: what it shows, as the shots may echo it. */
export type ShotReference = {
  /** The source's id in the project's sources.json (`s2`). */
  id: string;
  name: string;
  /** What the clip shows, in a line. */
  note: string;
  /** The link or copy in the project's folder, when there is one. */
  file: string | null;
};

export const EMPTY_TREATMENT: Treatment = {
  concept: "",
  look: "",
  vertical: false,
  shotBars: DEFAULT_SHOT_BARS,
  budgetUsd: null,
  cast: [],
  references: [],
};

function parseReferences(raw: unknown): ShotReference[] {
  const out: ShotReference[] = [];
  for (const each of Array.isArray(raw) ? raw : []) {
    if (!isRecord(each) || typeof each["id"] !== "string" || typeof each["name"] !== "string")
      continue;
    out.push({
      id: each["id"].slice(0, 8),
      name: each["name"].slice(0, 120),
      note: typeof each["note"] === "string" ? each["note"].slice(0, 600) : "",
      file: typeof each["file"] === "string" ? each["file"] : null,
    });
  }
  return out.slice(0, MAX_REFERENCES_KEPT);
}

function parseCast(raw: unknown): CastMember[] {
  const out: CastMember[] = [];
  for (const each of Array.isArray(raw) ? raw : []) {
    if (!isRecord(each) || !isCastId(each["id"]) || typeof each["file"] !== "string") continue;
    out.push({
      id: each["id"],
      name: typeof each["name"] === "string" ? each["name"].slice(0, 60) : "",
      prompt: typeof each["prompt"] === "string" ? each["prompt"] : "",
      file: each["file"],
      source: each["source"] === "generated" ? "generated" : "file",
    });
  }
  return out.slice(0, MAX_CAST);
}

const text = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

/** A treatment from untrusted data; anything off is the default. */
export function parseTreatment(raw: unknown): Treatment {
  if (!isRecord(raw)) return { ...EMPTY_TREATMENT, cast: [], references: [] };
  const bars = SHOT_BARS.find((each) => each === raw["shotBars"]);
  const budget = raw["budgetUsd"];
  return {
    concept: text(raw["concept"], 4000),
    look: text(raw["look"], 1000),
    vertical: raw["vertical"] === true,
    shotBars: bars ?? DEFAULT_SHOT_BARS,
    budgetUsd: typeof budget === "number" && budget >= 0 ? parseBudget(budget) : null,
    cast: parseCast(raw["cast"]),
    references: parseReferences(raw["references"]),
  };
}

export async function readTreatment(dir: string): Promise<Treatment> {
  return parseTreatment(await readJson(join(videoDir(dir), "treatment.json")));
}

export async function writeTreatment(dir: string, treatment: Treatment): Promise<void> {
  await mkdir(videoDir(dir), { recursive: true });
  await writeFile(join(videoDir(dir), "treatment.json"), json(treatment));
}

/** The project's budget: its own, else the extension setting, else the default. */
export const budgetOf = (treatment: Treatment, setting: unknown): number =>
  treatment.budgetUsd ?? parseBudget(setting);

/** Saves a picture and returns its path relative to the project's folder. */
export async function savePicture(
  dir: string,
  folder: "cast" | "frames",
  name: string,
  picture: Picture,
): Promise<string> {
  const ext = imageExt(picture.mime);
  if (ext === null) throw new Error("Use a PNG, JPEG or WebP picture.");
  await mkdir(join(videoDir(dir), folder), { recursive: true });
  const file = `video/${folder}/${name}.${ext}`;
  await writeFile(join(dir, file), picture.bytes);
  return file;
}

export async function readPicture(dir: string, file: string): Promise<Picture> {
  return { bytes: new Uint8Array(await readFile(join(dir, file))), mime: imageMime(file) };
}

/** Removes a file the project's folder holds; quietly, as it may already be gone. */
export async function removeFile(dir: string, file: string | null): Promise<void> {
  if (file !== null) await rm(join(dir, file), { force: true });
}

function parseShot(raw: unknown): Shot | null {
  if (!isRecord(raw) || !isShotId(raw["id"])) return null;
  const { startSec, endSec } = raw;
  if (typeof startSec !== "number" || typeof endSec !== "number" || endSec <= startSec) return null;
  return {
    id: raw["id"],
    section: text(raw["section"], 60),
    startSec,
    endSec,
    text: text(raw["text"], 2000),
    approved: raw["approved"] === true,
    frame: typeof raw["frame"] === "string" ? raw["frame"] : null,
    frameError: typeof raw["frameError"] === "string" ? raw["frameError"] : null,
    take: typeof raw["take"] === "string" ? raw["take"] : null,
  };
}

export function parseShots(raw: unknown): ShotList | null {
  if (!isRecord(raw) || !Array.isArray(raw["shots"])) return null;
  const { bpm, firstBeatSec, durationSec } = raw;
  if (typeof bpm !== "number" || typeof firstBeatSec !== "number") return null;
  if (typeof durationSec !== "number") return null;
  const shots = raw["shots"].map(parseShot);
  if (shots.some((each) => each === null)) return null;
  return { bpm, firstBeatSec, durationSec, shots: shots.filter((each) => each !== null) };
}

export async function readShots(dir: string): Promise<ShotList | null> {
  return parseShots(await readJson(join(videoDir(dir), "shots.json")));
}

export async function writeShots(dir: string, list: ShotList): Promise<void> {
  await mkdir(videoDir(dir), { recursive: true });
  await writeFile(join(videoDir(dir), "shots.json"), json(list));
}

function parseEntry(raw: unknown): SpendEntry | null {
  if (!isRecord(raw) || typeof raw["usd"] !== "number" || !Number.isFinite(raw["usd"])) return null;
  const kind: SpendKind | null =
    raw["kind"] === "cast" || raw["kind"] === "frame" || raw["kind"] === "take"
      ? raw["kind"]
      : null;
  if (kind === null || typeof raw["ref"] !== "string") return null;
  return { at: String(raw["at"] ?? ""), kind, ref: raw["ref"], usd: raw["usd"] };
}

export async function readLedger(dir: string): Promise<Ledger> {
  const raw = await readJson(join(videoDir(dir), "spend.json"));
  const entries = isRecord(raw) && Array.isArray(raw["entries"]) ? raw["entries"] : [];
  return { entries: entries.map(parseEntry).filter((each) => each !== null) };
}

/** Adds one purchase to the ledger. */
export async function addSpend(
  dir: string,
  kind: SpendKind,
  ref: string,
  usd: number,
): Promise<Ledger> {
  const ledger = await readLedger(dir);
  ledger.entries.push({ at: new Date().toISOString(), kind, ref, usd });
  await mkdir(videoDir(dir), { recursive: true });
  await writeFile(join(videoDir(dir), "spend.json"), json(ledger));
  return ledger;
}

/** The names in a folder; empty when it is not there. */
export async function names(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}
