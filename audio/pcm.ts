/** Decoding to analysis PCM (mono, 22050 Hz, f32le on stdout) and the small measures taken on it. */

import { SAMPLE_RATE } from "./fft";

/** The longest stretch analysed, from the start of the file. */
export const MAX_ANALYSED_SEC = 600;

export const decodeArgv = (file: string): string[] => [
  "-v",
  "error",
  "-nostdin",
  "-i",
  file,
  "-t",
  String(MAX_ANALYSED_SEC),
  "-ac",
  "1",
  "-ar",
  String(SAMPLE_RATE),
  "-f",
  "f32le",
  "pipe:1",
];

/** The samples in ffmpeg's f32le output (copied, so the view is aligned). */
export function toFloat32(bytes: Uint8Array): Float32Array {
  const count = Math.floor(bytes.byteLength / 4);
  const copy = new Uint8Array(count * 4);
  copy.set(bytes.subarray(0, count * 4));
  return new Float32Array(copy.buffer);
}

/** A copy scaled so the loudest sample is 1; silence stays silence. */
export function normalised(pcm: Float32Array): Float32Array {
  let peak = 0;
  for (const sample of pcm) peak = Math.max(peak, Math.abs(sample));
  return peak < 1e-6 ? pcm : pcm.map((sample) => sample / peak);
}

/** The waveform as `perSec` peaks a second, each 0 to 255 (the loudest sample of its slice, relative to the track's peak). */
export function waveformPeaks(pcm: Float32Array, perSec: number): number[] {
  const slice = Math.max(1, Math.round(SAMPLE_RATE / perSec));
  let top = 0;
  for (const sample of pcm) top = Math.max(top, Math.abs(sample));
  const out: number[] = [];
  for (let start = 0; start < pcm.length; start += slice) {
    let peak = 0;
    for (let at = start; at < Math.min(pcm.length, start + slice); at += 1)
      peak = Math.max(peak, Math.abs(pcm[at] ?? 0));
    out.push(top === 0 ? 0 : Math.round((peak / top) * 255));
  }
  return out;
}

/**
 * Energy from 1 to 10, a rough guide for ordering a set (not a standard):
 * how loud the loud parts are (60%) and how many onsets there are a second
 * (40%). `env` is the onset envelope from tempo.ts.
 */
export function energyOf(pcm: Float32Array, env: Float32Array, frameSec: number): number {
  const block = SAMPLE_RATE;
  const levels: number[] = [];
  for (let start = 0; start + block <= pcm.length; start += block) {
    let sum = 0;
    for (let at = start; at < start + block; at += 1) sum += (pcm[at] ?? 0) ** 2;
    levels.push(10 * Math.log10(Math.max(sum / block, 1e-10)));
  }
  levels.sort((a, b) => a - b);
  const loud = levels[Math.floor(levels.length * 0.9)] ?? -60;
  let mean = 0;
  for (const value of env) mean += value;
  mean /= Math.max(1, env.length);
  let onsets = 0;
  for (let at = 1; at < env.length - 1; at += 1) {
    const value = env[at] ?? 0;
    if (value > 2 * mean && value >= (env[at - 1] ?? 0) && value > (env[at + 1] ?? 0)) onsets += 1;
  }
  const density = Math.min(1, onsets / Math.max(1, env.length * frameSec) / 6);
  const loudness = Math.min(1, Math.max(0, (loud + 36) / 26));
  return Math.min(10, Math.max(1, Math.round(1 + 9 * (0.6 * loudness + 0.4 * density))));
}
