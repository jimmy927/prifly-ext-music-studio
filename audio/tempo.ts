/**
 * Tempo and the first beat, in pure TypeScript over mono PCM at 22050 Hz:
 * an onset envelope (half-wave rectified spectral flux), an autocorrelation
 * with a tempo prior for the rough tempo, then a fine comb search over tempo
 * and phase on the envelope itself. No dependency; nothing here is AGPL.
 */

import { breathe, Fft, hann, loadFrame, SAMPLE_RATE } from "./fft";

const FRAME = 1024;
const HOP = 256;
export const FRAME_SEC = HOP / SAMPLE_RATE;
export const MIN_BPM = 60;
export const MAX_BPM = 200;
/** A flux peak shows up this long before the click it stands for (measured on synthetic clicks). */
const ONSET_LAG_SEC = -0.0065;
/**
 * How much stronger than the rest of the envelope the beat comb must be for
 * the track to have a clear tempo. Noise lands higher the fewer beats it is
 * judged on (the best of many tempo and phase guesses), so a short clip needs
 * more: measured on white noise, 3.5 over 5 s, 2.3 over 10 s, 1.6 over 30 s.
 */
export const neededStrength = (beats: number): number => 1.5 + 6 / Math.sqrt(Math.max(1, beats));
/** A steady tone or silence has almost no flux; the PCM is scaled so its loudest sample is about 1 first. */
const MIN_FLUX = 0.03;

/** The onset envelope: one value per hop, the time of frame k being `frameTime(k)`. */
export async function onsetEnvelope(
  pcm: Float32Array,
  signal?: AbortSignal,
): Promise<Float32Array> {
  const frames = pcm.length < FRAME ? 0 : Math.floor((pcm.length - FRAME) / HOP) + 1;
  const fft = new Fft(FRAME);
  const window = hann(FRAME);
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  const previous = new Float64Array(Math.min(FRAME / 2, Math.floor((8000 * FRAME) / SAMPLE_RATE)));
  const flux = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    loadFrame(pcm, frame * HOP, window, re, im);
    fft.transform(re, im);
    flux[frame] = risen(re, im, previous, frame === 0);
    if (frame % 400 === 399) await breathe(signal);
  }
  return withoutLocalMean(flux);
}

/** The summed rise in log magnitude since the last frame, over the bins up to 8 kHz; `previous` is updated. */
function risen(re: Float64Array, im: Float64Array, previous: Float64Array, first: boolean): number {
  let sum = 0;
  for (let bin = 1; bin < previous.length; bin += 1) {
    const level = Math.log1p(Math.hypot(re[bin] ?? 0, im[bin] ?? 0));
    const up = level - (previous[bin] ?? 0);
    if (up > 0 && !first) sum += up;
    previous[bin] = level;
  }
  return sum;
}

/** The flux minus its mean over about a second, keeping what rises above it. */
function withoutLocalMean(flux: Float32Array): Float32Array {
  const out = new Float32Array(flux.length);
  const radius = Math.round(0.5 / FRAME_SEC);
  const total = new Float64Array(flux.length + 1);
  for (let at = 0; at < flux.length; at += 1) total[at + 1] = (total[at] ?? 0) + (flux[at] ?? 0);
  for (let at = 0; at < flux.length; at += 1) {
    const from = Math.max(0, at - radius);
    const to = Math.min(flux.length, at + radius + 1);
    const mean = ((total[to] ?? 0) - (total[from] ?? 0)) / (to - from);
    out[at] = Math.max(0, (flux[at] ?? 0) - mean);
  }
  return out;
}

/** The time of an envelope frame, in seconds, as the grid counts it. */
export const frameTime = (frame: number): number =>
  Math.max(0, (frame * HOP + FRAME / 2) / SAMPLE_RATE - ONSET_LAG_SEC);

function interpolate(env: Float32Array, at: number): number {
  const low = Math.floor(at);
  if (low < 0 || low >= env.length - 1) return 0;
  const part = at - low;
  return (env[low] ?? 0) * (1 - part) + (env[low + 1] ?? 0) * part;
}

/** Autocorrelation of the envelope (mean removed), normalised so lag 0 is 1. */
function autocorrelation(env: Float32Array, maxLag: number): Float64Array {
  let mean = 0;
  for (const value of env) mean += value;
  mean /= Math.max(1, env.length);
  const centred = Float64Array.from(env, (value) => value - mean);
  const out = new Float64Array(maxLag + 2);
  for (let lag = 0; lag <= maxLag + 1; lag += 1) {
    let sum = 0;
    for (let at = 0; at + lag < centred.length; at += 1)
      sum += (centred[at] ?? 0) * (centred[at + lag] ?? 0);
    out[lag] = sum;
  }
  const zero = out[0] ?? 0;
  return zero > 0 ? out.map((value) => value / zero) : out;
}

function at(values: Float64Array, position: number): number {
  const low = Math.floor(position);
  const part = position - low;
  return (values[low] ?? 0) * (1 - part) + (values[low + 1] ?? 0) * part;
}

/** A gentle preference for tempi near 120, so 70 and 140 are not mixed up. */
const prior = (bpm: number): number => Math.exp(-0.5 * (Math.log2(bpm / 120) / 1.1) ** 2);

function roughTempo(env: Float32Array): number {
  const maxLag = Math.ceil((3 * 60) / MIN_BPM / FRAME_SEC) + 1;
  const ac = autocorrelation(env, maxLag);
  let best = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += 0.5) {
    const lag = 60 / bpm / FRAME_SEC;
    const score = (at(ac, lag) + 0.5 * at(ac, 2 * lag) + 0.25 * at(ac, 3 * lag)) * prior(bpm);
    if (score > bestScore) {
      bestScore = score;
      best = bpm;
    }
  }
  return best;
}

type Comb = { bpm: number; phase: number; mean: number };

/** The tempo near `around` and the phase (in frames) where beats land on the most envelope. */
function combSearch(env: Float32Array, around: number): Comb {
  let best: Comb = { bpm: around, phase: 0, mean: -1 };
  for (let bpm = around - 2.5; bpm <= around + 2.5 + 1e-9; bpm += 0.05) {
    const period = 60 / bpm / FRAME_SEC;
    for (let phase = 0; phase < period; phase += 0.25) {
      let sum = 0;
      let count = 0;
      for (let position = phase; position < env.length - 1; position += period) {
        sum += interpolate(env, position);
        count += 1;
      }
      const mean = count === 0 ? 0 : sum / count;
      if (mean > best.mean) best = { bpm, phase, mean };
    }
  }
  return best;
}

export type Tempo = {
  /** Null when the track has no clear tempo. */
  bpm: number | null;
  /** The first beat of the grid, in seconds. */
  firstBeatSec: number;
  /** How much stronger the envelope is on the grid than elsewhere; below `neededStrength` there is no tempo. */
  strength: number;
};

/** The first grid beat that carries a real onset, so a quiet or empty intro is skipped. */
function firstRealBeat(env: Float32Array, comb: Comb): number {
  const period = 60 / comb.bpm / FRAME_SEC;
  const beats: number[] = [];
  for (let position = comb.phase; position < env.length - 1; position += period)
    beats.push(position);
  const strengths = beats.map((position) =>
    Math.max(
      interpolate(env, position - 1),
      interpolate(env, position),
      interpolate(env, position + 1),
    ),
  );
  const sorted = [...strengths].sort((a, b) => a - b);
  const top = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
  const first = strengths.findIndex((value) => value >= top * 0.3);
  return beats[Math.max(0, first)] ?? comb.phase;
}

export function estimateTempo(env: Float32Array): Tempo {
  let mean = 0;
  for (const value of env) mean += value;
  mean /= Math.max(1, env.length);
  if (env.length < 200 || mean < MIN_FLUX) return { bpm: null, firstBeatSec: 0, strength: 0 };
  const comb = combSearch(env, roughTempo(env));
  const strength = comb.mean / mean;
  const bpm = Math.round(comb.bpm * 100) / 100;
  const firstBeatSec = Math.round(frameTime(firstRealBeat(env, comb)) * 1000) / 1000;
  const beats = (env.length * FRAME_SEC * comb.bpm) / 60;
  return { bpm: strength >= neededStrength(beats) ? bpm : null, firstBeatSec, strength };
}
