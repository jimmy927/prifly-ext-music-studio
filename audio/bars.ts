/** Bars and seconds. Music Studio counts 4/4: a bar is four beats, and bar 1 is the start of the song. */

import type { Section } from "../arrange/plan";

export const DEFAULT_TEMPO = 120;
export const BEATS_PER_BAR = 4;

/** The tempo a plan's styles name ("122 BPM"), else `fallback`, else 120. */
export function tempoOf(sections: Section[], fallback: number | null = null): number {
  for (const section of sections) {
    for (const style of section.positiveStyles) {
      const match = /(\d{2,3})\s*bpm/i.exec(style);
      const bpm = match?.[1] === undefined ? 0 : Number(match[1]);
      if (bpm >= 40 && bpm <= 240) return bpm;
    }
  }
  return fallback !== null && fallback >= 40 && fallback <= 240 ? fallback : DEFAULT_TEMPO;
}

export const barMs = (tempo: number): number => (BEATS_PER_BAR * 60000) / tempo;

/** Where a 1-based bar starts, in milliseconds. */
export const barStartMs = (bar: number, tempo: number): number =>
  Math.max(0, Math.round((bar - 1) * barMs(tempo)));

/** How many bars a length is, to one decimal. */
export const barsIn = (ms: number, tempo: number): number =>
  Math.round((ms / barMs(tempo)) * 10) / 10;
