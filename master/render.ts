/**
 * "Master": measure the source (cached), render it to a target loudness with
 * two-pass loudnorm and a limiter, and measure the result. Local and free: no
 * key, no confirm card. Every master is kept as `master/master-N.<ext>`.
 */

import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { probeFfmpeg, runFfmpeg } from "../audio/ffmpeg";
import {
  type FormatId,
  type Loudness,
  loudnormMeasureArgv,
  masterArgv,
  measureArgv,
  parseEbur128,
  parseLoudnorm,
  TARGETS,
  type TargetId,
} from "../audio/loudness";
import { isRecord } from "../engines/types";
import type { AudioSource } from "../project/audio-source";
import { sourceToMaster } from "../project/audio-source";
import { type MasterRecord, nextMaster, saveMaster } from "../project/master";
import type { IndexEntry } from "../project/store";
import type { Studio } from "../studio";

export type Refusal = {
  ok: false;
  reason: "no_source" | "no_ffmpeg" | "silent" | "failed" | "cancelled";
  message: string;
};

export type Measured = { ok: true; loudness: Loudness } | Refusal;

const CACHE = "loudness-cache.json";

type CacheEntry = { size: number; mtimeMs: number; loudness: Loudness };

async function readCache(dir: string): Promise<Record<string, CacheEntry>> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(dir, CACHE), "utf8"));
    if (!isRecord(raw)) return {};
    const out: Record<string, CacheEntry> = {};
    for (const [file, value] of Object.entries(raw)) {
      if (!isRecord(value) || !isRecord(value["loudness"])) continue;
      const { size, mtimeMs } = value;
      const { integrated, truePeak, range } = value["loudness"];
      if (typeof size === "number" && typeof mtimeMs === "number")
        if (
          typeof integrated === "number" &&
          typeof truePeak === "number" &&
          typeof range === "number"
        )
          out[file] = { size, mtimeMs, loudness: { integrated, truePeak, range } };
    }
    return out;
  } catch {
    return {};
  }
}

/** ebur128 over one file of the project (relative path); the answer is kept until the file changes. */
export async function measureFile(
  studio: Studio,
  dir: string,
  file: string,
  signal?: AbortSignal,
): Promise<Measured> {
  const binary = studio.ffmpeg();
  const probe = await probeFfmpeg(binary);
  if (!probe.ok) return { ok: false, reason: "no_ffmpeg", message: probe.message };
  const path = join(dir, file);
  const info = await stat(path);
  const cache = await readCache(dir);
  const hit = cache[file];
  if (hit !== undefined && hit.size === info.size && hit.mtimeMs === info.mtimeMs)
    return { ok: true, loudness: hit.loudness };
  const ran = await runFfmpeg(binary, measureArgv(path), signal);
  if (!ran.ok) return fault(ran.message, signal);
  const loudness = parseEbur128(ran.log);
  if (loudness === null)
    return { ok: false, reason: "silent", message: "This audio is silent, so it has no loudness." };
  cache[file] = { size: info.size, mtimeMs: info.mtimeMs, loudness };
  await writeFile(join(dir, CACHE), JSON.stringify(cache));
  return { ok: true, loudness };
}

const fault = (message: string, signal?: AbortSignal): Refusal =>
  signal?.aborted === true
    ? { ok: false, reason: "cancelled", message: "Cancelled. The master was not made." }
    : { ok: false, reason: "failed", message };

export type Mastered = { ok: true; record: MasterRecord; path: string } | Refusal;

export type MasterOptions = { target: TargetId; format: FormatId };

/** Renders the project's mix (else version, else chosen sketch) to `options.target`. `step` hears each stage done. */
export async function renderMaster(
  studio: Studio,
  entry: IndexEntry,
  options: MasterOptions,
  signal?: AbortSignal,
  step: (name: string) => void = () => undefined,
): Promise<Mastered> {
  const store = studio.store();
  const dir = store.pathOf(entry);
  const source: AudioSource | null = await sourceToMaster(store, entry);
  if (source === null)
    return {
      ok: false,
      reason: "no_source",
      message: "There is nothing to master yet. Choose a sketch on the Idea stage first.",
    };
  const binary = studio.ffmpeg();
  const probe = await probeFfmpeg(binary);
  if (!probe.ok) return { ok: false, reason: "no_ffmpeg", message: probe.message };
  const target = TARGETS[options.target];
  const input = join(dir, source.file);
  const first = await runFfmpeg(binary, loudnormMeasureArgv(input, target), signal);
  if (!first.ok) return fault(first.message, signal);
  const measured = parseLoudnorm(first.log);
  if (measured === null)
    return {
      ok: false,
      reason: "failed",
      message: "ffmpeg did not report a loudness for this audio, so it cannot be mastered.",
    };
  step("measured");
  const next = await nextMaster(dir, options.format);
  const out = join(dir, next.file);
  const second = await runFfmpeg(
    binary,
    masterArgv(input, out, target, options.format, measured),
    signal,
  );
  if (!second.ok) {
    await rm(out, { force: true });
    return fault(second.message, signal);
  }
  step("rendered");
  const after = await runFfmpeg(binary, measureArgv(out), signal);
  const output = after.ok ? parseEbur128(after.log) : null;
  if (signal?.aborted === true) {
    await rm(out, { force: true });
    return fault("", signal);
  }
  step("checked");
  const record: MasterRecord = {
    n: next.n,
    file: next.file,
    target: options.target,
    format: options.format,
    from: source.label,
    input: { integrated: measured.inputI, truePeak: measured.inputTp, range: measured.inputLra },
    output,
    type: parseLoudnorm(second.log)?.type ?? "",
    created: new Date().toISOString(),
  };
  await saveMaster(dir, record);
  return { ok: true, record, path: out };
}
