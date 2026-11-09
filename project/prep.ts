/** What Prepare keeps in a project: `prep.json` (analysis, grid, cues, loop) and `prep-peaks.json` (the waveform). */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { camelot, keyName, type Mode, type MusicalKey, tonality } from "../audio/camelot";
import { isRecord } from "../engines/types";
import {
  type Cue,
  type Grid,
  isSlot,
  LOOP_BARS,
  type Loop,
  MAX_GRID_BPM,
  MIN_GRID_BPM,
  sortedCues,
} from "../prep/grid";
import type { AudioKind, AudioSource } from "./audio-source";

export type PrepKey = MusicalKey & { correlation: number };

export type Analysis = {
  /** The tempo found; null when the track has no clear tempo. */
  bpm: number | null;
  /** How clearly the beat stood out (see neededStrength in audio/tempo.ts). */
  strength: number;
  key: PrepKey | null;
  /** 1 to 10. */
  energy: number;
  lufs: number | null;
  truePeak: number | null;
  durationSec: number;
  analysedAt: string;
};

export type Prep = {
  source: AudioSource;
  analysis: Analysis;
  /** Null until there is a tempo (found or typed in). */
  grid: Grid | null;
  /** The tempo was typed in, not found. */
  manualBpm: boolean;
  cues: Cue[];
  loop: Loop | null;
};

export type KeyInfo = { name: string; camelot: string; tonality: string };

export const keyInfo = (key: MusicalKey): KeyInfo => ({
  name: keyName(key),
  camelot: camelot(key),
  tonality: tonality(key),
});

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const orNull = (value: unknown): number | null => (finite(value) ? value : null);
const KINDS: AudioKind[] = ["master", "mix", "version", "sketch"];

function parseSource(raw: unknown): AudioSource | null {
  if (!isRecord(raw)) return null;
  const { kind, id, label, file } = raw;
  if (!KINDS.some((each) => each === kind)) return null;
  if (typeof id !== "string" || typeof label !== "string" || typeof file !== "string") return null;
  return { kind: kind as AudioKind, id, label, file };
}

function parseKey(raw: unknown): PrepKey | null {
  if (!isRecord(raw) || !finite(raw["tonic"]) || !finite(raw["correlation"])) return null;
  const mode: Mode | null =
    raw["mode"] === "major" ? "major" : raw["mode"] === "minor" ? "minor" : null;
  const tonic = raw["tonic"];
  if (mode === null || !Number.isInteger(tonic) || tonic < 0 || tonic > 11) return null;
  return { tonic, mode, correlation: raw["correlation"] };
}

function parseAnalysis(raw: unknown): Analysis | null {
  if (!isRecord(raw) || !finite(raw["durationSec"])) return null;
  return {
    bpm: orNull(raw["bpm"]),
    strength: orNull(raw["strength"]) ?? 0,
    key: parseKey(raw["key"]),
    energy: Math.min(10, Math.max(1, Math.round(orNull(raw["energy"]) ?? 1))),
    lufs: orNull(raw["lufs"]),
    truePeak: orNull(raw["truePeak"]),
    durationSec: raw["durationSec"],
    analysedAt: typeof raw["analysedAt"] === "string" ? raw["analysedAt"] : "",
  };
}

export function parseGrid(raw: unknown): Grid | null {
  if (!isRecord(raw) || !finite(raw["bpm"]) || !finite(raw["firstBeatSec"])) return null;
  if (raw["bpm"] < MIN_GRID_BPM || raw["bpm"] > MAX_GRID_BPM || raw["firstBeatSec"] < 0)
    return null;
  return { bpm: raw["bpm"], firstBeatSec: raw["firstBeatSec"] };
}

function parseCues(raw: unknown): Cue[] {
  const out: Cue[] = [];
  for (const each of Array.isArray(raw) ? raw : []) {
    if (!isRecord(each) || !isSlot(each["slot"]) || !finite(each["sec"]) || each["sec"] < 0)
      continue;
    if (out.some((already) => already.slot === each["slot"])) continue;
    out.push({
      slot: each["slot"],
      sec: each["sec"],
      name: typeof each["name"] === "string" ? each["name"].slice(0, 40) : "",
    });
  }
  return sortedCues(out);
}

function parseLoop(raw: unknown): Loop | null {
  if (!isRecord(raw) || !finite(raw["startSec"]) || raw["startSec"] < 0) return null;
  const bars = raw["bars"];
  return LOOP_BARS.some((each) => each === bars) && finite(bars)
    ? { startSec: raw["startSec"], bars }
    : null;
}

export function parsePrep(raw: unknown): Prep | null {
  if (!isRecord(raw)) return null;
  const source = parseSource(raw["source"]);
  const analysis = parseAnalysis(raw["analysis"]);
  if (source === null || analysis === null) return null;
  return {
    source,
    analysis,
    grid: parseGrid(raw["grid"]),
    manualBpm: raw["manualBpm"] === true,
    cues: parseCues(raw["cues"]),
    loop: parseLoop(raw["loop"]),
  };
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

export async function readPrep(dir: string): Promise<Prep | null> {
  return parsePrep(await readJson(join(dir, "prep.json")));
}

export async function writePrep(dir: string, prep: Prep): Promise<void> {
  await writeFile(join(dir, "prep.json"), `${JSON.stringify(prep, null, 2)}\n`);
}

/** The waveform: peaks 0 to 255, `perSec` of them a second. */
export type Peaks = { perSec: number; peaks: number[] };

export async function readPeaks(dir: string): Promise<Peaks | null> {
  const raw = await readJson(join(dir, "prep-peaks.json"));
  if (!isRecord(raw) || !finite(raw["perSec"]) || !Array.isArray(raw["peaks"])) return null;
  return { perSec: raw["perSec"], peaks: raw["peaks"].filter(finite) };
}

export async function writePeaks(dir: string, peaks: Peaks): Promise<void> {
  await writeFile(join(dir, "prep-peaks.json"), JSON.stringify(peaks));
}

/** What the Library shows of a prepared track. */
export type PrepSummary = {
  bpm: number | null;
  camelot: string | null;
  tonality: string | null;
  lufs: number | null;
};

export async function prepSummary(dir: string): Promise<PrepSummary | null> {
  const prep = await readPrep(dir);
  if (prep === null) return null;
  const key = prep.analysis.key === null ? null : keyInfo(prep.analysis.key);
  return {
    bpm: prep.grid?.bpm ?? null,
    camelot: key?.camelot ?? null,
    tonality: key?.tonality ?? null,
    lufs: prep.analysis.lufs,
  };
}
