/**
 * Reading the source material: a plan (which files, what is cached, what a
 * read would cost) and the read itself (Gemini describes pictures and video
 * frames and the audio, tempo and key are measured here, one more call writes
 * the song and video ideas). Every file's result and the final ideas are
 * cached in the library folder, so asking again for the same files calls
 * nothing and costs nothing.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { keyName } from "../audio/camelot";
import { runFfmpeg, runFfmpegBytes } from "../audio/ffmpeg";
import { SAMPLE_RATE } from "../audio/fft";
import { estimateKey } from "../audio/key";
import { decodeArgv, normalised, toFloat32 } from "../audio/pcm";
import { estimateTempo, onsetEnvelope } from "../audio/tempo";
import { askGemini, jsonIn } from "../engines/gemini-text";
import { EngineError, isRecord } from "../engines/types";
import type { Studio } from "../studio";
import {
  ANALYSIS_MODEL,
  AUDIO_MINUTE_USD,
  AUDIO_TEMPO_SEC,
  CALL_USD,
  imageMimeOf,
  MAX_FRAMES,
  PICTURE_RAW_MAX_BYTES,
  PICTURE_USD,
  PICTURES_PER_CALL,
  SYNTHESIS_USD,
} from "./constants";
import { expandSources, type Skipped, type SourceFile } from "./files";
import { audioArgv, frameArgv, probeDuration, samplingOf, shrinkArgv } from "./frames";
import {
  AUDIO_PROMPT,
  framesPrompt,
  noAudio,
  parseAudioMood,
  parseSeen,
  parseSynthesis,
  picturesPrompt,
  synthesisPrompt,
} from "./read";
import type { AudioFound, Described, Seen, Synthesis } from "./types";

/** Changes when what is cached would read differently. */
const VERSION = 1;

const hash = (text: string): string => {
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(text);
  return hasher.digest("hex").slice(0, 16);
};

/** The cache key of one file: its place, size and time, and the model that read it. */
export const keyOf = (file: SourceFile): string =>
  hash(`${VERSION}|${ANALYSIS_MODEL}|${file.path}|${file.size}|${file.mtimeMs}`);

export const cacheFolder = (studio: Studio): string => join(studio.libraryPath(), ".source-cache");

const isDescribed = (value: unknown): value is Described =>
  isRecord(value) && value["version"] === VERSION && isRecord(value["seen"]);

async function readCached<T>(
  path: string,
  fits: (value: unknown) => value is T,
): Promise<T | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return fits(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const isSynthesis = (value: unknown): value is Synthesis =>
  isRecord(value) && isRecord(value["song"]) && isRecord(value["video"]);

const synthesisKey = (keys: string[]): string =>
  hash(`${VERSION}|synthesis|${[...keys].sort().join(",")}`);

/** What a call will read, what the cache already holds, and what the rest costs. */
export type Plan = {
  files: SourceFile[];
  skipped: Skipped[];
  keys: string[];
  /** Per file, in order: what the cache holds, or null. */
  cached: (Described | null)[];
  synthesisKey: string;
  synthesis: Synthesis | null;
  /** Estimated dollars of what is not cached. */
  usd: number;
  /** Gemini calls that would be made. */
  calls: number;
};

export type Planned =
  | { ok: true; plan: Plan }
  | { ok: false; reason: "invalid" | "no_key" | "no_ffmpeg"; message: string };

/** Estimated dollars and calls for the files not cached, and the synthesis when it is not. */
export function costOf(
  todo: { images: number; videos: number },
  synthesisNeeded: boolean,
): { usd: number; calls: number } {
  const pictureCalls = Math.ceil(todo.images / PICTURES_PER_CALL);
  const calls = pictureCalls + todo.videos * 2 + (synthesisNeeded ? 1 : 0);
  const usd =
    todo.images * PICTURE_USD +
    todo.videos * (MAX_FRAMES * PICTURE_USD + AUDIO_MINUTE_USD) +
    calls * CALL_USD +
    (synthesisNeeded ? SYNTHESIS_USD : 0);
  return { usd: Math.round(usd * 10000) / 10000, calls };
}

/** Expands `input`, looks in the cache and prices what is left. Nothing is called. */
export async function planSources(studio: Studio, input: unknown): Promise<Planned> {
  const { files, skipped } = await expandSources(input);
  if (files.length === 0) {
    const why = skipped.map((each) => `${each.path}: ${each.reason}`).join("; ");
    return {
      ok: false,
      reason: "invalid",
      message: `No pictures or videos to read in the sources${why === "" ? "" : ` (${why})`}.`,
    };
  }
  const dir = cacheFolder(studio);
  const keys = files.map(keyOf);
  const cached = await Promise.all(
    keys.map((key) => readCached(join(dir, key, "analysis.json"), isDescribed)),
  );
  const sKey = synthesisKey(keys);
  const synthesis = await readCached(join(dir, `synthesis-${sKey}.json`), isSynthesis);
  const todo = files.filter((_, at) => cached[at] === null);
  const { usd, calls } = costOf(
    {
      images: todo.filter((each) => each.kind === "image").length,
      videos: todo.filter((each) => each.kind === "video").length,
    },
    synthesis === null,
  );
  if (
    todo.some((each) => each.kind === "video") ||
    todo.some((each) => each.size > PICTURE_RAW_MAX_BYTES)
  ) {
    const ran = await runFfmpeg(studio.ffmpeg(), ["-version"]);
    if (!ran.ok) return { ok: false, reason: "no_ffmpeg", message: ran.message };
  }
  if (usd > 0 && (await studio.key("lyria-clip")) === null) {
    return {
      ok: false,
      reason: "no_key",
      message:
        "There is no Gemini key to read the source material with. Add it in Settings → Extensions → Music Studio.",
    };
  }
  return {
    ok: true,
    plan: { files, skipped, keys, cached, synthesisKey: sKey, synthesis, usd, calls },
  };
}

/** The line a confirm card gives for reading the source material; "" when nothing needs reading. */
export function cardLine(plan: Plan): string {
  if (plan.usd === 0) return "";
  const todo = plan.files.filter((_, at) => plan.cached[at] === null);
  const images = todo.filter((each) => each.kind === "image").length;
  const videos = todo.filter((each) => each.kind === "video").length;
  const what = [
    images === 0 ? "" : `${images} picture${images === 1 ? "" : "s"}`,
    videos === 0 ? "" : `${videos} video${videos === 1 ? "" : "s"}`,
  ].filter((each) => each !== "");
  const reading = what.length === 0 ? "the descriptions" : what.join(" and ");
  return `Read ${reading} with Gemini (${ANALYSIS_MODEL}), up to ${plan.calls} calls, about $${plan.usd.toFixed(3)} (an estimate; the bill is Google's). What is read once is kept, so the same files cost nothing again.`;
}

export type Read = {
  described: Described[];
  synthesis: Synthesis;
  /** Files left out and what could not be done, as sentences. */
  notes: string[];
};

type Context = {
  studio: Studio;
  key: string | null;
  signal: AbortSignal;
  step: (text: string) => void;
};

async function ask(context: Context, parts: Parameters<typeof askGemini>[2]): Promise<string> {
  if (context.key === null)
    throw new EngineError(
      "no_key",
      "There is no Gemini key. Add it in Settings → Extensions → Music Studio.",
    );
  return await askGemini(context.studio.deps.fetch, context.key, parts, context.signal);
}

type PictureBytes = { bytes: Uint8Array; mime: string };

/** A picture's bytes for the model: the file itself when it is small, else scaled down by ffmpeg. */
async function pictureBytes(context: Context, file: SourceFile): Promise<PictureBytes> {
  if (file.size <= PICTURE_RAW_MAX_BYTES)
    return { bytes: new Uint8Array(await readFile(file.path)), mime: imageMimeOf(file.name) };
  const shrunk = await runFfmpegBytes(
    context.studio.ffmpeg(),
    shrinkArgv(file.path),
    context.signal,
  );
  if (!shrunk.ok) throw new Error(`${file.name}: ${shrunk.message}`);
  return { bytes: shrunk.bytes, mime: "image/jpeg" };
}

/** Gemini's descriptions of one batch of pictures, in order. */
async function describeBatch(
  context: Context,
  batch: { file: SourceFile; key: string }[],
  pictures: PictureBytes[],
): Promise<Seen[]> {
  const parts: Parameters<typeof askGemini>[2] = [
    { kind: "text", text: picturesPrompt(batch.map((each) => each.file.name)) },
  ];
  for (const [at, each] of batch.entries()) {
    const picture = pictures[at];
    if (picture === undefined) continue;
    parts.push({ kind: "text", text: `Picture: ${each.file.name}` });
    parts.push({ kind: "image", bytes: picture.bytes, mime: picture.mime });
  }
  const seen = parseSeen(jsonIn(await ask(context, parts)), batch.length);
  if (seen === null)
    throw new EngineError(
      "bad_response",
      "Gemini's description of the pictures did not fit. Try again.",
    );
  return seen;
}

const THUMB_EXT: Record<string, string> = { "image/png": "png", "image/webp": "webp" };

/** Keeps a read picture in the cache: its small copy and what was found. */
async function keepPicture(
  cache: string,
  entry: { file: SourceFile; key: string },
  picture: PictureBytes,
  seen: Seen,
): Promise<Described> {
  const thumb = `thumb.${THUMB_EXT[picture.mime] ?? "jpg"}`;
  await mkdir(join(cache, entry.key), { recursive: true });
  await writeFile(join(cache, entry.key, thumb), picture.bytes);
  const described: Described = {
    version: VERSION,
    key: entry.key,
    name: entry.file.name,
    kind: "image",
    durationSec: null,
    seen,
    thumb,
    frames: [],
    audio: null,
    notes: [],
  };
  await writeDescribed(cache, described);
  return described;
}

async function readPictures(
  context: Context,
  files: { file: SourceFile; key: string }[],
  cache: string,
): Promise<Described[]> {
  const out: Described[] = [];
  for (let from = 0; from < files.length; from += PICTURES_PER_CALL) {
    const batch = files.slice(from, from + PICTURES_PER_CALL);
    context.step(`Reading pictures ${from + 1} to ${from + batch.length} of ${files.length}`);
    const pictures = await Promise.all(batch.map((each) => pictureBytes(context, each.file)));
    const seen = await describeBatch(context, batch, pictures);
    for (const [at, each] of batch.entries()) {
      const picture = pictures[at];
      const found = seen[at];
      if (picture !== undefined && found !== undefined)
        out.push(await keepPicture(cache, each, picture, found));
    }
  }
  return out;
}

async function writeDescribed(cache: string, described: Described): Promise<void> {
  await mkdir(join(cache, described.key), { recursive: true });
  await writeFile(
    join(cache, described.key, "analysis.json"),
    `${JSON.stringify(described, null, 2)}\n`,
  );
}

/** Tempo and key measured on a video's audio, and mood and genre from Gemini; a note where a part could not be done. */
async function audioOf(context: Context, file: SourceFile): Promise<AudioFound> {
  const binary = context.studio.ffmpeg();
  const decoded = await runFfmpegBytes(
    binary,
    decodeArgv(file.path, AUDIO_TEMPO_SEC),
    context.signal,
  );
  if (!decoded.ok) {
    if (decoded.message.startsWith("ffmpeg stopped"))
      return noAudio("This video has no audio track.");
    throw new Error(decoded.message);
  }
  const raw = toFloat32(decoded.bytes);
  if (raw.length < SAMPLE_RATE) return noAudio("The audio is shorter than a second.");
  const pcm = normalised(raw);
  const tempo = estimateTempo(await onsetEnvelope(pcm, context.signal));
  const key = await estimateKey(pcm, context.signal);
  const found: AudioFound = {
    ...noAudio(""),
    bpm: tempo.bpm,
    key: key === null ? null : keyName(key),
    note: null,
  };
  const mp3 = await runFfmpegBytes(binary, audioArgv(file.path), context.signal);
  if (!mp3.ok) return { ...found, note: `The audio could not be sent to Gemini: ${mp3.message}` };
  try {
    const answer = await ask(context, [
      { kind: "text", text: AUDIO_PROMPT },
      { kind: "audio", bytes: mp3.bytes, mime: "audio/mpeg" },
    ]);
    const mood = parseAudioMood(jsonIn(answer));
    return mood === null
      ? {
          ...found,
          note: "Gemini's answer about the audio did not fit, so its mood and genre are left out.",
        }
      : { ...found, ...mood };
  } catch (caught) {
    // A key, billing or credit problem would hit the next call too; anything else only skips the audio's mood.
    if (context.signal.aborted) throw caught;
    if (
      caught instanceof EngineError &&
      ["auth", "billing", "credits", "no_key"].includes(caught.kind)
    )
      throw caught;
    return {
      ...found,
      note: `Gemini did not take the audio (${caught instanceof Error ? caught.message : String(caught)}), so its mood and genre are left out.`,
    };
  }
}

const FRAME_FILE = /^frame-\d+\.jpg$/;

async function readVideo(
  context: Context,
  entry: { file: SourceFile; key: string },
  cache: string,
  at: number,
  of: number,
): Promise<Described> {
  const { file, key } = entry;
  context.step(`Reading video ${at} of ${of}: ${file.name}`);
  const folder = join(cache, key);
  await mkdir(folder, { recursive: true });
  const binary = context.studio.ffmpeg();
  const duration = await probeDuration(binary, file.path, context.signal);
  const sampling = samplingOf(duration);
  const made = await runFfmpeg(binary, frameArgv(file.path, folder, sampling), context.signal);
  if (!made.ok) throw new Error(`${file.name}: ${made.message}`);
  const frames = (await readdir(folder)).filter((name) => FRAME_FILE.test(name)).sort();
  if (frames.length === 0) throw new Error(`${file.name}: ffmpeg found no picture in this file.`);
  const parts: Parameters<typeof askGemini>[2] = [
    { kind: "text", text: framesPrompt(file.name, frames.length, sampling.intervalSec) },
  ];
  for (const name of frames)
    parts.push({
      kind: "image",
      bytes: new Uint8Array(await readFile(join(folder, name))),
      mime: "image/jpeg",
    });
  const seen = parseSeen(jsonIn(await ask(context, parts)), 1)?.[0];
  if (seen === undefined)
    throw new EngineError(
      "bad_response",
      `Gemini's description of ${file.name} did not fit. Try again.`,
    );
  const audio = await audioOf(context, file);
  const described: Described = {
    version: VERSION,
    key,
    name: file.name,
    kind: "video",
    durationSec: duration === null ? null : Math.round(duration * 10) / 10,
    seen,
    thumb: null,
    frames,
    audio,
    notes: audio.note === null ? [] : [audio.note],
  };
  await writeDescribed(cache, described);
  return described;
}

/**
 * Reads what the cache does not hold, then writes the song and video ideas
 * (unless they are cached too). `step` is told what is going on. A cancel
 * (`signal`) stops between calls; what was read is already kept.
 */
export async function readSources(
  studio: Studio,
  plan: Plan,
  signal: AbortSignal,
  step: (text: string) => void = () => undefined,
): Promise<Read> {
  const cache = cacheFolder(studio);
  const needsKey = plan.usd > 0;
  const context: Context = {
    studio,
    key: needsKey ? await studio.key("lyria-clip") : null,
    signal,
    step,
  };
  const described: (Described | null)[] = [...plan.cached];
  const todo = plan.files.flatMap((file, at) =>
    plan.cached[at] === null ? [{ file, key: plan.keys[at] ?? "", at }] : [],
  );
  const pictures = todo.filter((each) => each.file.kind === "image");
  const readPics = await readPictures(context, pictures, cache);
  pictures.forEach((each, at) => {
    described[each.at] = readPics[at] ?? null;
  });
  const videos = todo.filter((each) => each.file.kind === "video");
  for (const [at, each] of videos.entries()) {
    if (signal.aborted) throw new Error("Cancelled.");
    described[each.at] = await readVideo(context, each, cache, at + 1, videos.length);
  }
  const all = described.filter((each): each is Described => each !== null);
  let synthesis = plan.synthesis;
  if (synthesis === null) {
    step("Writing the song and video ideas");
    const answer = await ask(context, [{ kind: "text", text: synthesisPrompt(all) }]);
    synthesis = parseSynthesis(jsonIn(answer));
    if (synthesis === null)
      throw new EngineError("bad_response", "Gemini's song ideas did not fit. Try again.");
    await writeFile(
      join(cache, `synthesis-${plan.synthesisKey}.json`),
      `${JSON.stringify(synthesis, null, 2)}\n`,
    );
  }
  const notes = [
    ...plan.skipped.map((each) => `${each.path} was left out: ${each.reason}.`),
    ...all.flatMap((each) => each.notes.map((note) => `${each.name}: ${note}`)),
  ];
  return { described: all, synthesis, notes };
}
