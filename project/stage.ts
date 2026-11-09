/**
 * What the Arrange, Produce and Mix stages keep inside a project's folder:
 * `versions/vN.mp3` with `vN.json` (its sections and stored song id),
 * `stems/<name>.mp3` with `stems.json`, `layers/<id>.mp3` with `<id>.json`,
 * `mix.json` and `mix/mix-N.wav`. All take the project's folder; names that
 * come from outside are checked before they reach a path.
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Change, parseSections, type Section } from "../arrange/plan";
import { type MixSettings, parseMix } from "../audio/mixgraph";
import type { Stem } from "../engines/stems";
import type { Sketched } from "../engines/types";
import { isRecord } from "../engines/types";

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function names(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

export const isVersionName = (value: unknown): value is string =>
  typeof value === "string" && /^v[1-9]\d{0,3}$/.test(value);
export const isLayerId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}$/.test(value);
export const isStemName = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9-]{1,40}$/.test(value);

/** Where a version came from: the sketch it was edited from, or an earlier version. */
export type VersionRecord = {
  n: number;
  /** "v1" … */
  id: string;
  file: string;
  songId: string;
  sections: Section[];
  from: string;
  /** How many sections were kept, changed, inserted and deleted to make it. */
  counts: Record<Change["kind"], number>;
  created: string;
  /** ElevenLabs' word timestamps of this version's audio (the Edit stage's karaoke captions); absent on versions made before they were kept. */
  timestamps?: unknown;
};

export type Source = { id: string; label: string; file: string };

const COUNT_KINDS = ["kept", "changed", "inserted", "deleted"] as const;

function parseVersion(raw: unknown): VersionRecord | null {
  if (!isRecord(raw) || typeof raw["n"] !== "number" || typeof raw["file"] !== "string")
    return null;
  const sections = parseSections({ chunks: raw["sections"] });
  const counts = isRecord(raw["counts"]) ? raw["counts"] : {};
  if (sections === null || typeof raw["songId"] !== "string") return null;
  return {
    n: raw["n"],
    id: `v${raw["n"]}`,
    file: raw["file"],
    songId: raw["songId"],
    sections,
    from: typeof raw["from"] === "string" ? raw["from"] : "",
    counts: Object.fromEntries(
      COUNT_KINDS.map((kind) => [kind, typeof counts[kind] === "number" ? counts[kind] : 0]),
    ) as VersionRecord["counts"],
    created: typeof raw["created"] === "string" ? raw["created"] : "",
    ...(Array.isArray(raw["timestamps"]) ? { timestamps: raw["timestamps"] } : {}),
  };
}

export async function versions(dir: string): Promise<VersionRecord[]> {
  const out: VersionRecord[] = [];
  for (const name of await names(join(dir, "versions"))) {
    if (!/^v\d+\.json$/.test(name)) continue;
    const parsed = parseVersion(await readJson(join(dir, "versions", name)));
    if (parsed !== null) out.push(parsed);
  }
  return out.sort((a, b) => a.n - b.n);
}

/** Saves the next version: its audio, then its record, and makes it the active one. */
export async function saveVersion(
  dir: string,
  made: Sketched,
  sections: Section[],
  from: string,
  changes: Change[],
): Promise<VersionRecord> {
  if (made.songId === null)
    throw new Error("ElevenLabs gave no song id, so this version cannot be edited again.");
  const all = await versions(dir);
  const n = (all[all.length - 1]?.n ?? 0) + 1;
  await mkdir(join(dir, "versions"), { recursive: true });
  const file = `versions/v${n}.mp3`;
  await writeFile(join(dir, file), made.audio);
  const counts = Object.fromEntries(
    COUNT_KINDS.map((kind) => [kind, changes.filter((each) => each.kind === kind).length]),
  );
  const record = {
    n,
    file,
    songId: made.songId,
    sections: sections.map((each) => ({
      text: each.text,
      duration_ms: each.durationMs,
      positive_styles: each.positiveStyles,
      negative_styles: each.negativeStyles,
      context_adherence: each.contextAdherence,
    })),
    from,
    counts,
    created: new Date().toISOString(),
    timestamps: Array.isArray(made.timestamps) ? made.timestamps : null,
  };
  await writeFile(join(dir, "versions", `v${n}.json`), json(record));
  await setActive(dir, n);
  const saved = parseVersion(record);
  if (saved === null) throw new Error("The version record is not valid.");
  return saved;
}

/** The version picked as the current one, or null when none was made or picked. */
export async function activeVersion(dir: string): Promise<VersionRecord | null> {
  const all = await versions(dir);
  const raw = await readJson(join(dir, "stage.json"));
  const picked = isRecord(raw) ? raw["activeVersion"] : null;
  return all.find((each) => each.n === picked) ?? all[all.length - 1] ?? null;
}

export async function setActive(dir: string, n: number): Promise<void> {
  await writeFile(join(dir, "stage.json"), json({ activeVersion: n }));
}

/** One stem on disk. */
export type StemRecord = { name: string; file: string };
export type StemSet = { source: string; created: string; stems: StemRecord[] };

export async function readStems(dir: string): Promise<StemSet | null> {
  const raw = await readJson(join(dir, "stems", "stems.json"));
  if (!isRecord(raw) || !Array.isArray(raw["stems"]) || typeof raw["source"] !== "string")
    return null;
  const stems: StemRecord[] = [];
  for (const each of raw["stems"]) {
    if (isRecord(each) && isStemName(each["name"]) && typeof each["file"] === "string")
      stems.push({ name: each["name"], file: each["file"] });
  }
  return { source: raw["source"], created: String(raw["created"] ?? ""), stems };
}

/** Replaces the stems with a new split of `source`. */
export async function saveStems(dir: string, source: string, stems: Stem[]): Promise<StemSet> {
  await rm(join(dir, "stems"), { recursive: true, force: true });
  await mkdir(join(dir, "stems"), { recursive: true });
  const records: StemRecord[] = [];
  const seen = new Set<string>();
  for (const stem of stems) {
    let name = stem.name;
    for (let again = 2; seen.has(name); again += 1) name = `${stem.name}-${again}`;
    seen.add(name);
    const file = `stems/${name}.${stem.ext}`;
    await writeFile(join(dir, file), stem.audio);
    records.push({ name, file });
  }
  const set: StemSet = { source, created: new Date().toISOString(), stems: records };
  await writeFile(join(dir, "stems", "stems.json"), json(set));
  return set;
}

/** A sound-effect layer: where it starts (a 1-based bar) and how long it lasts. */
export type LayerRecord = {
  id: string;
  prompt: string;
  startBar: number;
  lengthSec: number;
  loop: boolean;
  file: string;
  created: string;
};

function parseLayer(raw: unknown): LayerRecord | null {
  if (!isRecord(raw) || !isLayerId(raw["id"])) return null;
  const { prompt, startBar, lengthSec, file } = raw;
  if (typeof prompt !== "string" || typeof startBar !== "number") return null;
  if (typeof lengthSec !== "number" || typeof file !== "string") return null;
  return {
    id: raw["id"],
    prompt,
    startBar,
    lengthSec,
    loop: raw["loop"] === true,
    file,
    created: String(raw["created"] ?? ""),
  };
}

export async function layers(dir: string): Promise<LayerRecord[]> {
  const out: LayerRecord[] = [];
  for (const name of await names(join(dir, "layers"))) {
    if (!name.endsWith(".json")) continue;
    const parsed = parseLayer(await readJson(join(dir, "layers", name)));
    if (parsed !== null) out.push(parsed);
  }
  return out.sort((a, b) => a.created.localeCompare(b.created));
}

/** Saves a layer; an existing id gets new audio (regenerate). */
export async function saveLayer(
  dir: string,
  layer: Omit<LayerRecord, "file" | "created">,
  audio: Uint8Array,
): Promise<LayerRecord> {
  await mkdir(join(dir, "layers"), { recursive: true });
  const before = (await layers(dir)).find((each) => each.id === layer.id);
  const record: LayerRecord = {
    ...layer,
    file: `layers/${layer.id}.mp3`,
    created: before?.created ?? new Date().toISOString(),
  };
  await writeFile(join(dir, record.file), audio);
  await writeFile(join(dir, "layers", `${layer.id}.json`), json(record));
  return record;
}

export async function removeLayer(dir: string, id: string): Promise<boolean> {
  if (!isLayerId(id)) return false;
  const found = (await layers(dir)).some((each) => each.id === id);
  await rm(join(dir, "layers", `${id}.json`), { force: true });
  await rm(join(dir, "layers", `${id}.mp3`), { force: true });
  return found;
}

export async function readMix(dir: string): Promise<MixSettings> {
  return parseMix(await readJson(join(dir, "mix.json")));
}

export async function writeMix(dir: string, mix: MixSettings): Promise<void> {
  await writeFile(join(dir, "mix.json"), json(mix));
}

/** The rendered mixes, `mix/mix-N.wav`, oldest first. */
export async function mixes(dir: string): Promise<{ n: number; file: string }[]> {
  return (await names(join(dir, "mix")))
    .map((name) => /^mix-(\d+)\.wav$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ n: Number(match[1]), file: `mix/${match[0]}` }))
    .sort((a, b) => a.n - b.n);
}

/** The path the next mix is rendered to; its folder exists. */
export async function nextMix(dir: string): Promise<{ n: number; file: string }> {
  await mkdir(join(dir, "mix"), { recursive: true });
  const all = await mixes(dir);
  const n = (all[all.length - 1]?.n ?? 0) + 1;
  return { n, file: `mix/mix-${n}.wav` };
}
