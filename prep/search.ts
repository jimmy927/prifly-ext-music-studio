/**
 * The Library's search box. Plain words match the title, engine and brief as
 * before; `key 8A` (or `key Am`) and `bpm 120-128` (or `bpm 124`) match the
 * prepared tracks' key and tempo. A track that is not prepared matches none
 * of the key or tempo filters.
 */

import { camelot, keyFromTonality, parseCamelot } from "../audio/camelot";
import type { PrepSummary } from "../project/prep";

export type Query = {
  /** What is left for the title / engine / brief search. */
  text: string;
  /** A Camelot code, or "?" when the key typed is none we know (matches nothing). */
  key: string | null;
  bpm: { min: number; max: number } | null;
};

const KEY = /\bkey\s*[:=]?\s*(\S+)/i;
const BPM = /\bbpm\s*[:=]?\s*(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?/i;

function codeOf(token: string): string {
  const code = parseCamelot(token);
  if (code !== null) return code;
  const key = keyFromTonality(token);
  return key === null ? "?" : camelot(key);
}

export function parseQuery(raw: string): Query {
  let text = raw;
  let key: string | null = null;
  let bpm: Query["bpm"] = null;
  const keyMatch = KEY.exec(text);
  if (keyMatch?.[1] !== undefined) {
    key = codeOf(keyMatch[1]);
    text = text.replace(KEY, " ");
  }
  const bpmMatch = BPM.exec(text);
  if (bpmMatch?.[1] !== undefined) {
    const low = Number(bpmMatch[1]);
    const high = bpmMatch[2] === undefined ? low : Number(bpmMatch[2]);
    bpm = { min: Math.min(low, high), max: Math.max(low, high) };
    text = text.replace(BPM, " ");
  }
  return { text: text.replace(/\s+/g, " ").trim(), key, bpm };
}

/** Whether a track's key and tempo satisfy the filters of `query`. */
export function matchesPrep(summary: PrepSummary | null, query: Query): boolean {
  if (query.key === null && query.bpm === null) return true;
  if (summary === null) return false;
  if (query.key !== null && summary.camelot !== query.key) return false;
  if (query.bpm !== null) {
    if (summary.bpm === null) return false;
    // Half a BPM of slack at the edges, since a range typed as 120-128 means those tempi.
    if (summary.bpm < query.bpm.min - 0.5 || summary.bpm > query.bpm.max + 0.5) return false;
  }
  return true;
}
