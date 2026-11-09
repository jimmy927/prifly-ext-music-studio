/**
 * Karaoke captions: the words ElevenLabs timestamped (`words_timestamps`,
 * `{ word, start_ms, end_ms }`) as an Advanced SubStation file with a `\k` tag
 * per word, which ffmpeg's `ass` filter burns in. The words fill from white
 * to yellow as they are sung. An instrumental song has no words, so there is
 * no file.
 */

import { isRecord } from "../engines/types";

export type Word = { word: string; startMs: number; endMs: number };

/** The words of a stored `words_timestamps`, in order; entries that are not words are skipped. */
export function parseWords(raw: unknown): Word[] {
  const out: Word[] = [];
  for (const each of Array.isArray(raw) ? raw : []) {
    if (!isRecord(each)) continue;
    const { word } = each;
    const start = each["start_ms"];
    const end = each["end_ms"];
    if (typeof word !== "string" || typeof start !== "number" || typeof end !== "number") continue;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    if (word.trim() === "") continue;
    out.push({ word, startMs: start, endMs: end });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** Text safe inside an ASS dialogue line: braces start override tags and a backslash starts a code. */
export function assText(word: string): string {
  return word
    .replace(/[\r\n]+/g, " ")
    .replace(/\\/g, "/")
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    .trim();
}

/** `h:mm:ss.cc` */
export function assTime(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const rest = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(rest).padStart(2, "0")}`;
}

const LINE_GAP_MS = 1200;
const LINE_WORDS = 7;
const LINE_CHARS = 42;
const LEAD_MS = 150;
const HOLD_MS = 400;

/** Splits the words into lines: a pause, seven words or 42 characters starts a new one. */
export function lineBreaks(words: Word[]): Word[][] {
  const lines: Word[][] = [];
  let line: Word[] = [];
  let chars = 0;
  for (const word of words) {
    const last = line.at(-1);
    const gap = last === undefined ? 0 : word.startMs - last.endMs;
    if (line.length > 0 && (gap > LINE_GAP_MS || line.length >= LINE_WORDS || chars > LINE_CHARS)) {
      lines.push(line);
      line = [];
      chars = 0;
    }
    line.push(word);
    chars += assText(word.word).length + 1;
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

const cs = (ms: number): number => Math.max(0, Math.round(ms / 10));

function dialogue(line: Word[], from: number, until: number): string {
  const first = line[0];
  const last = line.at(-1);
  if (first === undefined || last === undefined) return "";
  const start = Math.max(from, first.startMs - LEAD_MS);
  const end = Math.min(until, last.endMs + HOLD_MS);
  const parts = [`{\\k${cs(first.startMs - start)}}`];
  for (const [at, word] of line.entries()) {
    const next = line[at + 1];
    const stop = next === undefined ? word.endMs : next.startMs;
    parts.push(
      `{\\k${cs(stop - word.startMs)}}${assText(word.word)}${next === undefined ? "" : " "}`,
    );
  }
  return `Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${parts.join("")}`;
}

export type CaptionOptions = {
  width: number;
  height: number;
  /** Only the words from here on, moved to start at 0 (the vertical cut). */
  fromSec?: number;
  /** Only the words before here. */
  toSec?: number;
};

/** The `.ass` file for the words, or null when none falls in the range. */
export function assKaraoke(all: Word[], options: CaptionOptions): string | null {
  const from = (options.fromSec ?? 0) * 1000;
  const to = options.toSec === undefined ? Number.POSITIVE_INFINITY : options.toSec * 1000;
  const words = all
    .filter((each) => each.startMs >= from && each.endMs <= to)
    .map((each) => ({ ...each, startMs: each.startMs - from, endMs: each.endMs - from }));
  if (words.length === 0) return null;
  const lines = lineBreaks(words);
  const size = Math.round(options.height / 18);
  const margin = Math.round(options.height * 0.08);
  const events = lines.map((line, at) => {
    const next = lines[at + 1]?.[0];
    const until = next === undefined ? Number.POSITIVE_INFINITY : next.startMs - LEAD_MS;
    const before = lines[at - 1]?.at(-1)?.endMs ?? 0;
    return dialogue(line, Math.min(before, line[0]?.startMs ?? 0), until);
  });
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${options.width}`,
    `PlayResY: ${options.height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,Arial,${size},&H0000E5FF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,3,1,2,40,40,${margin},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}
