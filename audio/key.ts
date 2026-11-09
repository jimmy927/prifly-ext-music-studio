/**
 * The musical key: a chroma (energy per pitch class) from an FFT over the
 * PCM, matched against the Krumhansl–Schmuckler key profiles by correlation.
 */

import type { Mode, MusicalKey } from "./camelot";
import { breathe, Fft, hann, loadFrame, SAMPLE_RATE } from "./fft";

const FRAME = 8192;
const HOP = 4096;
const LOW_HZ = 70;
const HIGH_HZ = 2000;

/** Krumhansl & Kessler's probe-tone ratings, tonic first. */
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** Summed magnitude per pitch class (0 = C) over the loud frames. */
export async function chromaOf(pcm: Float32Array, signal?: AbortSignal): Promise<Float64Array> {
  const chroma = new Float64Array(12);
  const fft = new Fft(FRAME);
  const window = hann(FRAME);
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  const low = Math.ceil((LOW_HZ * FRAME) / SAMPLE_RATE);
  const high = Math.floor((HIGH_HZ * FRAME) / SAMPLE_RATE);
  const pitchClass = pitchClasses(low, high);
  const frames = pcm.length < FRAME ? 0 : Math.floor((pcm.length - FRAME) / HOP) + 1;
  for (let frame = 0; frame < frames; frame += 1) {
    const energy = loadFrame(pcm, frame * HOP, window, re, im);
    if (Math.sqrt(energy / FRAME) >= 0.003) {
      fft.transform(re, im);
      for (let bin = low; bin <= high; bin += 1) {
        const at = pitchClass[bin] ?? 0;
        chroma[at] = (chroma[at] ?? 0) + Math.sqrt(Math.hypot(re[bin] ?? 0, im[bin] ?? 0));
      }
    }
    if (frame % 40 === 39) await breathe(signal);
  }
  return chroma;
}

/** The pitch class (0 = C) of each FFT bin from `low` to `high`. */
function pitchClasses(low: number, high: number): Int8Array {
  const table = new Int8Array(high + 1);
  for (let bin = low; bin <= high; bin += 1) {
    const hz = (bin * SAMPLE_RATE) / FRAME;
    table[bin] = (((Math.round(12 * Math.log2(hz / 440)) + 9) % 12) + 12) % 12;
  }
  return table;
}

function correlation(chroma: Float64Array, profile: number[], shift: number): number {
  const mean = (values: ArrayLike<number>): number => {
    let sum = 0;
    for (let at = 0; at < 12; at += 1) sum += values[at] ?? 0;
    return sum / 12;
  };
  const cMean = mean(chroma);
  const pMean = mean(profile);
  let cross = 0;
  let cSpread = 0;
  let pSpread = 0;
  for (let at = 0; at < 12; at += 1) {
    const c = (chroma[(at + shift) % 12] ?? 0) - cMean;
    const p = (profile[at] ?? 0) - pMean;
    cross += c * p;
    cSpread += c * c;
    pSpread += p * p;
  }
  return cSpread === 0 || pSpread === 0 ? 0 : cross / Math.sqrt(cSpread * pSpread);
}

export type KeyEstimate = MusicalKey & { correlation: number };

/** The best of the 24 keys for a chroma; null for silence. */
export function keyFromChroma(chroma: Float64Array): KeyEstimate | null {
  if (!chroma.some((value) => value > 0)) return null;
  let best: KeyEstimate | null = null;
  for (const [mode, profile] of [
    ["major", MAJOR],
    ["minor", MINOR],
  ] as [Mode, number[]][]) {
    for (let tonic = 0; tonic < 12; tonic += 1) {
      const score = correlation(chroma, profile, tonic);
      if (best === null || score > best.correlation) best = { tonic, mode, correlation: score };
    }
  }
  return best;
}

export async function estimateKey(
  pcm: Float32Array,
  signal?: AbortSignal,
): Promise<KeyEstimate | null> {
  return keyFromChroma(await chromaOf(pcm, signal));
}
