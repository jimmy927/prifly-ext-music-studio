/** A radix-2 FFT and what the analysers around it share: the sample rate, windows, and a yield point. */

/** Analysis runs on mono f32le PCM at this rate (see `decodeArgv` in pcm.ts). */
export const SAMPLE_RATE = 22050;

/** Where each index goes in the bit-reversed order the in-place transform starts from. */
function bitReversal(size: number): Uint32Array {
  const rev = new Uint32Array(size);
  const bits = Math.log2(size);
  for (let at = 0; at < size; at += 1) {
    let value = 0;
    for (let bit = 0; bit < bits; bit += 1) value |= ((at >> bit) & 1) << (bits - 1 - bit);
    rev[at] = value;
  }
  return rev;
}

export class Fft {
  readonly size: number;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly rev: Uint32Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) throw new Error("The FFT size is a power of two.");
    this.size = size;
    this.cos = Float64Array.from({ length: size / 2 }, (_v, at) =>
      Math.cos((2 * Math.PI * at) / size),
    );
    this.sin = Float64Array.from(
      { length: size / 2 },
      (_v, at) => -Math.sin((2 * Math.PI * at) / size),
    );
    this.rev = bitReversal(size);
  }

  /** In place. */
  transform(re: Float64Array, im: Float64Array): void {
    this.reorder(re, im);
    this.butterflies(re, im);
  }

  private reorder(re: Float64Array, im: Float64Array): void {
    for (let at = 0; at < this.size; at += 1) {
      const to = this.rev[at] ?? 0;
      if (to > at) {
        const r = re[at] ?? 0;
        re[at] = re[to] ?? 0;
        re[to] = r;
        const i = im[at] ?? 0;
        im[at] = im[to] ?? 0;
        im[to] = i;
      }
    }
  }

  private butterflies(re: Float64Array, im: Float64Array): void {
    const n = this.size;
    for (let half = 1; half < n; half *= 2) {
      const step = n / (half * 2);
      for (let start = 0; start < n; start += half * 2) {
        for (let k = 0; k < half; k += 1)
          butterfly(re, im, start + k, start + k + half, this.cos[k * step], this.sin[k * step]);
      }
    }
  }
}

/** One radix-2 butterfly on positions `a` and `b`, with the twiddle factor `c + si`. */
function butterfly(re: Float64Array, im: Float64Array, a: number, b: number, c = 0, s = 0): void {
  const tr = (re[b] ?? 0) * c - (im[b] ?? 0) * s;
  const ti = (re[b] ?? 0) * s + (im[b] ?? 0) * c;
  re[b] = (re[a] ?? 0) - tr;
  im[b] = (im[a] ?? 0) - ti;
  re[a] = (re[a] ?? 0) + tr;
  im[a] = (im[a] ?? 0) + ti;
}

export function hann(size: number): Float64Array {
  const out = new Float64Array(size);
  for (let at = 0; at < size; at += 1) out[at] = 0.5 - 0.5 * Math.cos((2 * Math.PI * at) / size);
  return out;
}

/** Fills `re` with the windowed samples from `start` (and zeroes `im`); answers the frame's energy. */
export function loadFrame(
  pcm: Float32Array,
  start: number,
  window: Float64Array,
  re: Float64Array,
  im: Float64Array,
): number {
  let energy = 0;
  for (let at = 0; at < window.length; at += 1) {
    const sample = pcm[start + at] ?? 0;
    energy += sample * sample;
    re[at] = sample * (window[at] ?? 0);
    im[at] = 0;
  }
  return energy;
}

export const CANCELLED_MESSAGE = "Cancelled.";

/** Lets the event loop breathe during a long loop, and stops it when the run was cancelled. */
export async function breathe(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw new Error(CANCELLED_MESSAGE);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
