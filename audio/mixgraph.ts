/**
 * The mix as data (`mix.json`) and as an ffmpeg command. The panel's live
 * preview uses the same level and mute/solo rules through WebAudio nodes (its pan is a StereoPannerNode, close to but not the same as the ffmpeg pan law).
 */

import { isRecord } from "../engines/types";

export const MIN_DB = -60;
export const MAX_DB = 12;

/** One track's settings in `mix.json`. */
export type TrackMix = { db: number; pan: number; mute: boolean; solo: boolean };
export type MixSettings = { tracks: Record<string, TrackMix> };

export const DEFAULT_TRACK: TrackMix = { db: 0, pan: 0, mute: false, solo: false };

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

/** One track's settings from untrusted data; anything off is the default. */
export function parseTrack(raw: unknown): TrackMix {
  if (!isRecord(raw)) return { ...DEFAULT_TRACK };
  const db = typeof raw["db"] === "number" && Number.isFinite(raw["db"]) ? raw["db"] : 0;
  const pan = typeof raw["pan"] === "number" && Number.isFinite(raw["pan"]) ? raw["pan"] : 0;
  return {
    db: clamp(db, MIN_DB, MAX_DB),
    pan: clamp(pan, -1, 1),
    mute: raw["mute"] === true,
    solo: raw["solo"] === true,
  };
}

export function parseMix(raw: unknown): MixSettings {
  const tracks: Record<string, TrackMix> = {};
  const given = isRecord(raw) ? raw["tracks"] : null;
  if (isRecord(given))
    for (const [key, value] of Object.entries(given)) tracks[key] = parseTrack(value);
  return { tracks };
}

/** What is rendered: a track's file and where it starts, with its settings. */
export type MixInput = TrackMix & { key: string; file: string; startMs: number };

/** The tracks that are heard: with any solo set, only the soloed ones; muted ones never. */
export function audible<T extends TrackMix>(tracks: T[]): T[] {
  const soloing = tracks.some((each) => each.solo);
  return tracks.filter((each) => !each.mute && (!soloing || each.solo));
}

/** The gain a decibel value stands for. */
export const gainOf = (db: number): number => 10 ** (db / 20);

/** Equal-power pan, scaled so the centre is unity: [left, right] gains for a pan of -1 (left) to 1 (right). */
export function panGains(pan: number): [number, number] {
  const angle = ((clamp(pan, -1, 1) + 1) * Math.PI) / 4;
  return [Math.SQRT2 * Math.cos(angle), Math.SQRT2 * Math.sin(angle)];
}

const num = (value: number): string => String(Math.round(value * 10000) / 10000);

/** The filter chain of one input. */
function chain(each: MixInput, at: number): string {
  const [left, right] = panGains(each.pan);
  const parts = [
    "aformat=channel_layouts=stereo",
    `volume=${num(each.db)}dB`,
    `pan=stereo|c0=${num(left)}*c0|c1=${num(right)}*c1`,
  ];
  if (each.startMs > 0)
    parts.push(`adelay=${Math.round(each.startMs)}|${Math.round(each.startMs)}`);
  return `[${at}:a]${parts.join(",")}[t${at}]`;
}

/**
 * The arguments (after the program name) that mix `inputs` into a 16-bit WAV
 * at `out`, or null when nothing is audible. The sum is not normalised by
 * amix (older ffmpeg has no switch for it, so it is scaled back up by the
 * input count) and a limiter catches peaks.
 */
export function mixArgv(inputs: MixInput[], out: string): string[] | null {
  const heard = audible(inputs);
  if (heard.length === 0) return null;
  const graph = heard.map(chain);
  const labels = heard.map((_each, at) => `[t${at}]`).join("");
  const sum =
    heard.length === 1
      ? "[t0]alimiter=limit=0.97[out]"
      : `${labels}amix=inputs=${heard.length}:duration=longest:dropout_transition=3600,volume=${heard.length},alimiter=limit=0.97[out]`;
  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    ...heard.flatMap((each) => ["-i", each.file]),
    "-filter_complex",
    [...graph, sum].join(";"),
    "-map",
    "[out]",
    "-ar",
    "44100",
    "-c:a",
    "pcm_s16le",
    out,
  ];
}
