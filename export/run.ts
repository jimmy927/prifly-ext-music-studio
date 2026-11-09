/**
 * "Deliver": write what a DJ or a DAW takes into a folder: stems named
 * `122bpm 8A Vocals.wav`, the master with BPM and key tags, a rekordbox XML
 * (one track, or a crate as a playlist), and the prepared track with its cue
 * and loop points as JSON. The folder is `<project>/deliver` unless another
 * is given. Nothing here costs anything; files of the same name are replaced.
 */

import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { probeFfmpeg, runFfmpeg } from "../audio/ffmpeg";
import { loopEnd } from "../prep/grid";
import { masters } from "../project/master";
import { keyInfo, type Prep, readPrep } from "../project/prep";
import { readStems } from "../project/stage";
import type { IndexEntry } from "../project/store";
import type { Studio } from "../studio";
import { sanitiseFileName, stemFileNames } from "./names";
import { type RekordboxTrack, rekordboxXml } from "./rekordbox";
import { tagArgv } from "./tags";

export const DELIVER_ITEMS = ["stems", "master", "rekordbox", "loops"] as const;
export type DeliverItem = (typeof DELIVER_ITEMS)[number];
export const isDeliverItem = (value: unknown): value is DeliverItem =>
  DELIVER_ITEMS.some((each) => each === value);

export type DeliverRequest = {
  items: DeliverItem[];
  /** An absolute folder; null for `<project>/deliver`. */
  dest: string | null;
  /** A crate (id or name) for the rekordbox file; null for this project's track alone. */
  crate: string | null;
};

export type Delivered =
  | { ok: true; dir: string; files: string[]; notes: string[] }
  | {
      ok: false;
      reason: "invalid" | "no_ffmpeg" | "nothing" | "failed" | "cancelled";
      message: string;
    };

/** Whether `path` is the project's folder or inside it. */
export function isInside(folder: string, path: string): boolean {
  const from = relative(resolve(folder), resolve(path));
  return from === "" || (!from.startsWith("..") && !isAbsolute(from) && !from.startsWith(sep));
}

type Run = {
  studio: Studio;
  entry: IndexEntry;
  dir: string;
  out: string;
  binary: string;
  signal: AbortSignal;
  files: string[];
  notes: string[];
  prep: Prep | null;
};

const ext = (file: string): string => extname(file).slice(1).toLowerCase();

async function stems(run: Run): Promise<void> {
  const set = await readStems(run.dir);
  if (set === null || set.stems.length === 0) {
    run.notes.push("Stems: there are none yet. Split stems on the Produce stage first.");
    return;
  }
  const brief = await run.studio.store().readBrief(run.entry);
  const named = brief?.brief.tempo;
  const bpm = run.prep?.grid?.bpm ?? (typeof named === "number" ? named : null);
  const key = run.prep?.analysis.key;
  const names = stemFileNames(
    set.stems.map((each) => each.name),
    bpm,
    key === null || key === undefined ? null : keyInfo(key).camelot,
  );
  await mkdir(join(run.out, "stems"), { recursive: true });
  for (const [at, stem] of set.stems.entries()) {
    const target = join(run.out, "stems", names[at] ?? `${stem.name}.wav`);
    const ran = await runFfmpeg(
      run.binary,
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        join(run.dir, stem.file),
        "-c:a",
        "pcm_s24le",
        target,
      ],
      run.signal,
    );
    if (!ran.ok) throw new Error(ran.message);
    run.files.push(target);
  }
  if ((run.prep?.grid ?? null) === null)
    run.notes.push(
      "Stems: the track is not analysed, so the names carry no tempo or key from analysis.",
    );
}

async function master(run: Run): Promise<void> {
  const latest = (await masters(run.dir)).at(-1);
  if (latest === undefined) {
    run.notes.push("Master: none yet. Master the song first.");
    return;
  }
  const format = ext(latest.file);
  const source = join(run.dir, latest.file);
  const target = join(run.out, `${sanitiseFileName(run.entry.title)} master.${format}`);
  const bpm = run.prep?.grid?.bpm;
  const key = run.prep?.analysis.key;
  const tagged =
    bpm === undefined
      ? null
      : tagArgv(
          source,
          target,
          format,
          bpm,
          key === null || key === undefined ? null : keyInfo(key).tonality,
        );
  if (tagged === null) {
    await copyFile(source, target);
    run.notes.push(
      bpm === undefined
        ? "Master: copied without BPM and key tags, because the track is not analysed yet."
        : "Master: a WAV from ffmpeg 4.2 carries no BPM or key tag, so none was written (the tempo and key are in the stem names and the loops JSON).",
    );
  } else {
    const ran = await runFfmpeg(run.binary, tagged.argv, run.signal);
    if (!ran.ok) throw new Error(ran.message);
    run.notes.push(`Master: tagged ${tagged.tags}.`);
  }
  run.files.push(target);
}

async function trackOf(run: Run, entry: IndexEntry, id: number): Promise<RekordboxTrack | string> {
  const dir = run.studio.store().pathOf(entry);
  const prep = await readPrep(dir);
  if (prep === null || prep.grid === null)
    return `"${entry.title}" is not analysed yet, so it is not in the rekordbox file.`;
  const file = join(dir, prep.source.file);
  let size = 0;
  try {
    size = (await stat(file)).size;
  } catch {
    return `"${entry.title}" has lost its audio file, so it is not in the rekordbox file.`;
  }
  return {
    id,
    name: entry.title,
    file,
    ext: ext(file),
    size,
    totalSec: prep.analysis.durationSec,
    grid: prep.grid,
    tonality: prep.analysis.key === null ? null : keyInfo(prep.analysis.key).tonality,
    cues: prep.cues,
    loop: prep.loop,
  };
}

async function rekordbox(run: Run, crateRef: string | null): Promise<void> {
  const crate = crateRef === null ? null : await run.studio.crates().lookup(crateRef);
  if (crateRef !== null && crate === null) throw new Error(`There is no crate "${crateRef}".`);
  const store = run.studio.store();
  const entries =
    crate === null
      ? [run.entry]
      : (await Promise.all(crate.tracks.map((id) => store.find(id)))).filter(
          (each) => each !== null,
        );
  const tracks: RekordboxTrack[] = [];
  for (const entry of entries) {
    const made = await trackOf(run, entry, tracks.length + 1);
    if (typeof made === "string") run.notes.push(`Rekordbox: ${made}`);
    else tracks.push(made);
  }
  if (tracks.length === 0) {
    run.notes.push("Rekordbox: no analysed track to write. Analyse on the Prepare stage first.");
    return;
  }
  const name = crate?.name ?? run.entry.title;
  const target = join(run.out, `rekordbox ${sanitiseFileName(name)}.xml`);
  await writeFile(
    target,
    rekordboxXml(tracks, [{ name, trackIds: tracks.map((each) => each.id) }]),
  );
  run.files.push(target);
}

/** The cue and loop points as JSON, next to a copy of the audio they belong to. */
async function loops(run: Run): Promise<void> {
  const prep = run.prep;
  if (prep === null || prep.grid === null) {
    run.notes.push("Loops: the track is not analysed yet. Analyse on the Prepare stage first.");
    return;
  }
  const base = sanitiseFileName(run.entry.title);
  const audio = join(run.out, `${base}.${ext(prep.source.file)}`);
  await copyFile(join(run.dir, prep.source.file), audio);
  const key = prep.analysis.key === null ? null : keyInfo(prep.analysis.key);
  const json = {
    file: basename(audio),
    from: prep.source.label,
    bpm: prep.grid.bpm,
    firstBeatSec: prep.grid.firstBeatSec,
    key: key?.name ?? null,
    camelot: key?.camelot ?? null,
    energy: prep.analysis.energy,
    lufs: prep.analysis.lufs,
    durationSec: prep.analysis.durationSec,
    cues: prep.cues.map((cue) => ({ slot: cue.slot, name: cue.name, sec: cue.sec })),
    loop:
      prep.loop === null
        ? null
        : {
            startSec: prep.loop.startSec,
            endSec: loopEnd(prep.grid, prep.loop),
            bars: prep.loop.bars,
          },
  };
  const target = join(run.out, `${base}.loops.json`);
  await writeFile(target, `${JSON.stringify(json, null, 2)}\n`);
  run.files.push(audio, target);
}

/** The folder a request writes to. */
export const deliverFolder = (studio: Studio, entry: IndexEntry, dest: string | null): string =>
  dest ?? join(studio.store().pathOf(entry), "deliver");

/** Writes each item in turn; throws on the first failure or when cancelled. */
async function writeItems(
  run: Run,
  request: DeliverRequest,
  step: (name: string) => void,
): Promise<void> {
  await mkdir(run.out, { recursive: true });
  for (const item of request.items) {
    if (run.signal.aborted) throw new Error("Cancelled.");
    if (item === "stems") await stems(run);
    else if (item === "master") await master(run);
    else if (item === "rekordbox") await rekordbox(run, request.crate);
    else await loops(run);
    step(item);
  }
}

const refused = (request: DeliverRequest): Delivered | null => {
  if (request.dest !== null && !isAbsolute(request.dest))
    return {
      ok: false,
      reason: "invalid",
      message: "The folder is a full path, such as C:\\Music\\deliver or /home/me/deliver.",
    };
  return request.items.length === 0
    ? { ok: false, reason: "invalid", message: "Tick at least one thing to deliver." }
    : null;
};

export async function deliver(
  studio: Studio,
  entry: IndexEntry,
  request: DeliverRequest,
  signal: AbortSignal,
  step: (name: string) => void = () => undefined,
): Promise<Delivered> {
  const bad = refused(request);
  if (bad !== null) return bad;
  const binary = studio.ffmpeg();
  const probe = await probeFfmpeg(binary);
  if (!probe.ok) return { ok: false, reason: "no_ffmpeg", message: probe.message };
  const dir = studio.store().pathOf(entry);
  const out = deliverFolder(studio, entry, request.dest);
  const prep = await readPrep(dir);
  const run: Run = { studio, entry, dir, out, binary, signal, files: [], notes: [], prep };
  try {
    await writeItems(run, request, step);
  } catch (caught) {
    const message = signal.aborted
      ? "Cancelled. Files already written are kept."
      : caught instanceof Error
        ? caught.message
        : String(caught);
    return { ok: false, reason: signal.aborted ? "cancelled" : "failed", message };
  }
  if (run.files.length === 0) return { ok: false, reason: "nothing", message: run.notes.join(" ") };
  return { ok: true, dir: out, files: run.files, notes: run.notes };
}
