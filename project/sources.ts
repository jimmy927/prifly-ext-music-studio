/**
 * A project's source material: `sources.json` (the files, what was found in
 * each, and the song and video ideas written from them) and the `sources/`
 * folder (a link or copy of each file, a picture's small copy, a video's
 * sampled frames).
 */

import { copyFile, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isRecord } from "../engines/types";
import { cacheFolder } from "../sources/analyse";
import type { SourceKind } from "../sources/constants";
import type { SourceFile } from "../sources/files";
import type { AudioFound, Described, Seen, Synthesis } from "../sources/types";
import type { Studio } from "../studio";
import { json, readJson } from "./video";

export type SourceRecord = {
  /** `s1`, `s2`… */
  id: string;
  name: string;
  kind: SourceKind;
  /** Where the file was when it was added. */
  original: string;
  /** The link or copy under the project's folder; null when neither could be made. */
  file: string | null;
  /** A picture's small copy, relative to the project's folder. */
  thumb: string | null;
  frames: string[];
  durationSec: number | null;
  /** Null until the file is read. */
  seen: Seen | null;
  audio: AudioFound | null;
  notes: string[];
};

export type SourcesFile = {
  sources: SourceRecord[];
  synthesis: Synthesis | null;
  analysedAt: string | null;
  /** Why the last read failed, until a read works. */
  error: string | null;
  /** Files that were left out, as sentences. */
  notes: string[];
};

export const EMPTY_SOURCES: SourcesFile = {
  sources: [],
  synthesis: null,
  analysedAt: null,
  error: null,
  notes: [],
};

export const isSourceId = (value: unknown): value is string =>
  typeof value === "string" && /^s\d{1,3}$/.test(value);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : [];

function parseRecord(raw: unknown): SourceRecord | null {
  if (!isRecord(raw) || !isSourceId(raw["id"]) || typeof raw["name"] !== "string") return null;
  if (raw["kind"] !== "image" && raw["kind"] !== "video") return null;
  return {
    id: raw["id"],
    name: raw["name"],
    kind: raw["kind"],
    original: typeof raw["original"] === "string" ? raw["original"] : "",
    file: typeof raw["file"] === "string" ? raw["file"] : null,
    thumb: typeof raw["thumb"] === "string" ? raw["thumb"] : null,
    frames: strings(raw["frames"]),
    durationSec: typeof raw["durationSec"] === "number" ? raw["durationSec"] : null,
    seen: isRecord(raw["seen"]) ? (raw["seen"] as Seen) : null,
    audio: isRecord(raw["audio"]) ? (raw["audio"] as AudioFound) : null,
    notes: strings(raw["notes"]),
  };
}

export async function readSources(dir: string): Promise<SourcesFile> {
  const raw = await readJson(join(dir, "sources.json"));
  if (!isRecord(raw)) return { ...EMPTY_SOURCES, sources: [], notes: [] };
  return {
    sources: (Array.isArray(raw["sources"]) ? raw["sources"] : [])
      .map(parseRecord)
      .filter((each): each is SourceRecord => each !== null),
    synthesis: isRecord(raw["synthesis"]) ? (raw["synthesis"] as Synthesis) : null,
    analysedAt: typeof raw["analysedAt"] === "string" ? raw["analysedAt"] : null,
    error: typeof raw["error"] === "string" ? raw["error"] : null,
    notes: strings(raw["notes"]),
  };
}

export async function writeSources(dir: string, file: SourcesFile): Promise<void> {
  await writeFile(join(dir, "sources.json"), json(file));
}

const safe = (name: string): string => name.replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 80);

/** A link to the file (a copy of a small picture where links are not allowed); the path relative to `dir`, or null. */
async function linkFile(dir: string, id: string, file: SourceFile): Promise<string | null> {
  const relative = `sources/${id}-${safe(file.name)}`;
  try {
    await symlink(file.path, join(dir, relative));
    return relative;
  } catch {
    if (file.kind !== "image" || file.size > 8 * 1024 * 1024) return null;
    try {
      await copyFile(file.path, join(dir, relative));
      return relative;
    } catch {
      return null;
    }
  }
}

/** Puts the cached picture copy and frames of `described` in the project's `sources/` folder. */
async function bring(
  studio: Studio,
  dir: string,
  id: string,
  described: Described,
): Promise<Pick<SourceRecord, "thumb" | "frames">> {
  const from = join(cacheFolder(studio), described.key);
  let thumb: string | null = null;
  if (described.thumb !== null) {
    thumb = `sources/${id}-${basename(described.thumb)}`;
    await copyFile(join(from, described.thumb), join(dir, thumb));
  }
  const frames: string[] = [];
  for (const name of described.frames) {
    const to = `sources/${id}-${name}`;
    await copyFile(join(from, name), join(dir, to));
    frames.push(to);
  }
  return { thumb, frames };
}

/**
 * Makes `files` the project's source material, with what was read from each
 * (null where a read has not happened) and the ideas written from them.
 */
export async function saveSources(
  studio: Studio,
  dir: string,
  files: SourceFile[],
  described: (Described | null)[],
  synthesis: Synthesis | null,
  notes: string[],
  error: string | null = null,
): Promise<SourcesFile> {
  // The folder only holds links and copies: it is made again from the cache.
  await rm(join(dir, "sources"), { recursive: true, force: true });
  await mkdir(join(dir, "sources"), { recursive: true });
  const sources: SourceRecord[] = [];
  for (const [at, file] of files.entries()) {
    const id = `s${at + 1}`;
    const found = described[at] ?? null;
    const brought =
      found === null ? { thumb: null, frames: [] } : await bring(studio, dir, id, found);
    sources.push({
      id,
      name: file.name,
      kind: file.kind,
      original: file.path,
      file: await linkFile(dir, id, file),
      thumb: brought.thumb,
      frames: brought.frames,
      durationSec: found?.durationSec ?? null,
      seen: found?.seen ?? null,
      audio: found?.audio ?? null,
      notes: found?.notes ?? [],
    });
  }
  const saved: SourcesFile = {
    sources,
    synthesis,
    analysedAt: found(described) ? new Date().toISOString() : null,
    error,
    notes,
  };
  await writeSources(dir, saved);
  return saved;
}

const found = (described: (Described | null)[]): boolean =>
  described.length > 0 && described.every((each) => each !== null);
