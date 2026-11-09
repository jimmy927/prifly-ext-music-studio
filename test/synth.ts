/** Synthetic audio for the analysis tests: mono f32 PCM at 22050 Hz. */

import { SAMPLE_RATE } from "../audio/fft";

/** A kick-like click (a decaying 90 Hz sine over a short noise burst) on every beat from `offsetSec`. */
export function clickTrack(bpm: number, seconds: number, offsetSec = 0.3): Float32Array {
  const out = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  const beat = 60 / bpm;
  let seed = 7;
  const noise = (): number => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 2147483648 - 1;
  };
  for (let time = offsetSec; time < seconds; time += beat) {
    const start = Math.round(time * SAMPLE_RATE);
    for (let at = 0; at < 2200 && start + at < out.length; at += 1) {
      const t = at / SAMPLE_RATE;
      const value =
        Math.sin(2 * Math.PI * 90 * t) * Math.exp(-t * 40) + 0.5 * noise() * Math.exp(-t * 250);
      out[start + at] = (out[start + at] ?? 0) + value * 0.8;
    }
  }
  return out;
}

const hz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

/** Chords one after the other, each `each` seconds, as notes with four harmonics. */
export function chords(progression: number[][], each: number, rounds = 2): Float32Array {
  const per = Math.round(each * SAMPLE_RATE);
  const out = new Float32Array(per * progression.length * rounds);
  for (let chord = 0; chord < progression.length * rounds; chord += 1)
    for (const note of progression[chord % progression.length] ?? [])
      addNote(out, chord * per, per, hz(note));
  return out;
}

/** One note with four harmonics added into `out`. */
function addNote(out: Float32Array, base: number, length: number, frequency: number): void {
  for (let harmonic = 1; harmonic <= 4; harmonic += 1) {
    const step = (2 * Math.PI * frequency * harmonic) / SAMPLE_RATE;
    for (let at = 0; at < length; at += 1)
      out[base + at] = (out[base + at] ?? 0) + (0.12 / harmonic) * Math.sin(step * at);
  }
}

/** Midi numbers: A minor, D minor, E major (the dominant), A minor. */
export const A_MINOR = [
  [57, 60, 64],
  [50, 53, 57],
  [52, 56, 59],
  [57, 60, 64],
];
/** E♭ major, A♭ major, B♭ major, E♭ major. */
export const E_FLAT_MAJOR = [
  [51, 55, 58],
  [56, 60, 63],
  [58, 62, 65],
  [51, 55, 58],
];

export function noise(seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  let seed = 11;
  for (let at = 0; at < out.length; at += 1) {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    out[at] = (seed / 2147483648 - 1) * 0.3;
  }
  return out;
}

export const tone = (seconds: number, frequency = 220): Float32Array =>
  Float32Array.from(
    { length: Math.round(seconds * SAMPLE_RATE) },
    (_v, at) => 0.3 * Math.sin((2 * Math.PI * frequency * at) / SAMPLE_RATE),
  );

/** 16-bit mono WAV bytes of float PCM (clipped to ±1). */
export function pcmWav(pcm: Float32Array, rate = SAMPLE_RATE): Uint8Array<ArrayBuffer> {
  const bytes = Buffer.alloc(44 + pcm.length * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(36 + pcm.length * 2, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(pcm.length * 2, 40);
  for (const [at, sample] of pcm.entries())
    bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), 44 + at * 2);
  return new Uint8Array(bytes);
}
