/** Sampling a video: how long it is, which frames to take, and its audio track. */

import { runFfmpeg } from "../audio/ffmpeg";
import {
  AUDIO_SEND_SEC,
  FRAME_EVERY_SEC,
  FRAME_WIDTH,
  MAX_FRAMES,
  PICTURE_EDGE,
} from "./constants";

/** The length in seconds in ffmpeg's `Duration: 00:00:12.34` line; null when it has none. */
export function durationFrom(log: string): number | null {
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);
  if (match === null) return null;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(seconds) ? seconds : null;
}

/** How a video is sampled: a frame every `intervalSec`, `count` frames. */
export type Sampling = { intervalSec: number; count: number };

/** One frame every 3 s, spread wider over a long clip so the count stays at the cap; the cap's worth at 3 s when the length is unknown. */
export function samplingOf(durationSec: number | null): Sampling {
  if (durationSec === null || durationSec <= 0)
    return { intervalSec: FRAME_EVERY_SEC, count: MAX_FRAMES };
  const intervalSec = Math.max(FRAME_EVERY_SEC, durationSec / MAX_FRAMES);
  const count = Math.max(1, Math.min(MAX_FRAMES, Math.floor(durationSec / intervalSec) + 1));
  return { intervalSec, count };
}

/** The ffmpeg arguments that write the sampled frames as `<outDir>/frame-01.jpg`, `frame-02.jpg`… */
export function frameArgv(file: string, outDir: string, sampling: Sampling): string[] {
  return [
    "-v",
    "error",
    "-nostdin",
    "-y",
    "-i",
    file,
    "-vf",
    `fps=1/${Math.round(sampling.intervalSec * 1000) / 1000},scale='min(${FRAME_WIDTH},iw)':-2`,
    "-frames:v",
    String(sampling.count),
    "-q:v",
    "4",
    `${outDir}/frame-%02d.jpg`,
  ];
}

/** The ffmpeg arguments that write a small mono MP3 of the audio track's first minute to stdout. */
export const audioArgv = (file: string): string[] => [
  "-v",
  "error",
  "-nostdin",
  "-i",
  file,
  "-vn",
  "-t",
  String(AUDIO_SEND_SEC),
  "-ac",
  "1",
  "-ar",
  "16000",
  "-c:a",
  "libmp3lame",
  "-b:a",
  "48k",
  "-f",
  "mp3",
  "pipe:1",
];

/** The ffmpeg arguments that scale a picture to at most `PICTURE_EDGE` px on its long side, as a JPEG on stdout. */
export const shrinkArgv = (file: string): string[] => [
  "-v",
  "error",
  "-nostdin",
  "-i",
  file,
  "-frames:v",
  "1",
  "-vf",
  `scale='min(${PICTURE_EDGE},iw)':'min(${PICTURE_EDGE},ih)':force_original_aspect_ratio=decrease`,
  "-q:v",
  "4",
  "-f",
  "image2pipe",
  "-c:v",
  "mjpeg",
  "pipe:1",
];

/** The length of a video, from ffmpeg's header line; null when ffmpeg cannot say. */
export async function probeDuration(
  binary: string,
  file: string,
  signal?: AbortSignal,
): Promise<number | null> {
  const ran = await runFfmpeg(
    binary,
    ["-nostdin", "-i", file, "-t", "0.1", "-f", "null", "-"],
    signal,
  );
  return ran.ok ? durationFrom(ran.log) : null;
}
