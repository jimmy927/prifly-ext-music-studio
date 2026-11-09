/** The masters a project keeps: `master/master-N.<ext>` with `master-N.json` (what it was made from and its loudness). */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FORMATS,
  type FormatId,
  isFormatId,
  isTargetId,
  type Loudness,
  type TargetId,
} from "../audio/loudness";
import { isRecord } from "../engines/types";

export type MasterRecord = {
  n: number;
  /** Relative to the project's folder. */
  file: string;
  target: TargetId;
  format: FormatId;
  /** What it was made from, e.g. "Mix 2". */
  from: string;
  input: Loudness;
  /** Measured on the written file; null when that measurement failed. */
  output: Loudness | null;
  /** loudnorm's own word: "linear" or "dynamic" (it had to compress to reach the target). */
  type: string;
  created: string;
};

function parseLoudness(raw: unknown): Loudness | null {
  if (!isRecord(raw)) return null;
  const { integrated, truePeak, range } = raw;
  if (typeof integrated !== "number" || typeof truePeak !== "number") return null;
  if (typeof range !== "number") return null;
  return { integrated, truePeak, range };
}

function parseMaster(raw: unknown): MasterRecord | null {
  if (!isRecord(raw) || typeof raw["n"] !== "number" || typeof raw["file"] !== "string")
    return null;
  const input = parseLoudness(raw["input"]);
  const { target, format } = raw;
  if (input === null || !isTargetId(target) || !isFormatId(format)) return null;
  return {
    n: raw["n"],
    file: raw["file"],
    target,
    format,
    from: typeof raw["from"] === "string" ? raw["from"] : "",
    input,
    output: parseLoudness(raw["output"]),
    type: typeof raw["type"] === "string" ? raw["type"] : "",
    created: typeof raw["created"] === "string" ? raw["created"] : "",
  };
}

/** The masters, oldest first. */
export async function masters(dir: string): Promise<MasterRecord[]> {
  let names: string[] = [];
  try {
    names = await readdir(join(dir, "master"));
  } catch {
    return [];
  }
  const out: MasterRecord[] = [];
  for (const name of names) {
    if (!/^master-\d+\.json$/.test(name)) continue;
    try {
      const parsed = parseMaster(JSON.parse(await readFile(join(dir, "master", name), "utf8")));
      if (parsed !== null) out.push(parsed);
    } catch {
      // A half-written record is skipped; the master shows once its record is whole.
    }
  }
  return out.sort((a, b) => a.n - b.n);
}

/** The file the next master is written to; its folder exists. */
export async function nextMaster(
  dir: string,
  format: FormatId,
): Promise<{ n: number; file: string }> {
  await mkdir(join(dir, "master"), { recursive: true });
  const n = ((await masters(dir)).at(-1)?.n ?? 0) + 1;
  return { n, file: `master/master-${n}.${FORMATS[format].ext}` };
}

export async function saveMaster(dir: string, record: MasterRecord): Promise<void> {
  await writeFile(
    join(dir, "master", `master-${record.n}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}
