/**
 * The inpainting plan builder: from the sections of the version being edited
 * (`base`) and the reader's edited list (`draft`), the list of chunks
 * ElevenLabs' `music_v2_5` composes from. Kept sections become audio
 * reference chunks that slice the previous version's stored song (neighbouring
 * kept ranges merged into one), changed and inserted sections become
 * generation chunks, deleted ones simply are not in the plan. Pure: no I/O,
 * so the panel runs the same code to show the Changes list.
 */

import { isRecord } from "../engines/types";

export const MIN_CHUNK_MS = 3000;
export const MAX_CHUNK_MS = 120000;
export const MAX_CHUNKS = 30;
export const MAX_STYLES = 50;

export type Adherence = "low" | "medium" | "high";

/** One section of a song: what a generation chunk holds. */
export type Section = {
  /** The section name in square brackets, then the lyrics. */
  text: string;
  durationMs: number;
  positiveStyles: string[];
  negativeStyles: string[];
  contextAdherence: Adherence;
};

/** A section in the editor: `source` is its index in the base version, null when inserted. */
export type Draft = Section & { source: number | null };

export type ChangeKind = "kept" | "changed" | "inserted" | "deleted";

export type Change = {
  kind: ChangeKind;
  /** Index in the draft; null for a deleted section. */
  index: number | null;
  /** Index in the base version; null for an inserted section. */
  source: number | null;
  label: string;
  /** What differs, for a changed section: styles, negative styles, lyrics, length. */
  fields: string[];
};

export type GenerationChunk = {
  text: string;
  duration_ms: number;
  positive_styles: string[];
  negative_styles: string[];
  context_adherence: Adherence;
};

/** A slice of a stored song, kept as it is. It has no type tag: `song_id` and `range` are what mark it. */
export type AudioRefChunk = { song_id: string; range: { start_ms: number; end_ms: number } };

export type PlanChunk = GenerationChunk | AudioRefChunk;

export type Built =
  | { ok: true; chunks: PlanChunk[]; changes: Change[]; generated: number; kept: number }
  | { ok: false; message: string; changes: Change[] };

const ADHERENCE: readonly string[] = ["low", "medium", "high"];

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : [];

/** The sections a stored composition plan holds, or null when it is not a plan of generation chunks. */
export function parseSections(plan: unknown): Section[] | null {
  const chunks = isRecord(plan) ? plan["chunks"] : null;
  if (!Array.isArray(chunks) || chunks.length === 0) return null;
  const out: Section[] = [];
  for (const chunk of chunks) {
    if (!isRecord(chunk) || typeof chunk["text"] !== "string") return null;
    const ms = chunk["duration_ms"];
    if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
    const adherence = chunk["context_adherence"];
    out.push({
      text: chunk["text"],
      durationMs: Math.round(ms),
      positiveStyles: strings(chunk["positive_styles"]),
      negativeStyles: strings(chunk["negative_styles"]),
      contextAdherence: ADHERENCE.includes(String(adherence)) ? (adherence as Adherence) : "high",
    });
  }
  return out;
}

export const toDraft = (sections: Section[]): Draft[] =>
  sections.map((each, source) => ({ ...each, source }));

export const stripSource = (draft: Draft[]): Section[] =>
  draft.map(({ source: _source, ...section }) => section);

/** "[Verse 1]\nla la" is "Verse 1"; without a tag, the first words. */
export function labelOf(text: string): string {
  const tag = /^\s*\[([^\]]+)\]/.exec(text);
  if (tag?.[1] !== undefined) return tag[1].trim();
  const first = text.trim().split("\n")[0] ?? "";
  return first === "" ? "Section" : first.slice(0, 24);
}

const same = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((each, at) => each === b[at]);

/** The fields in which a section differs from the one it came from. */
export function fieldsChanged(before: Section, after: Section): string[] {
  const out: string[] = [];
  if (!same(before.positiveStyles, after.positiveStyles)) out.push("styles");
  if (!same(before.negativeStyles, after.negativeStyles)) out.push("negative styles");
  if (before.text !== after.text) out.push("lyrics");
  if (before.durationMs !== after.durationMs) out.push("length");
  if (before.contextAdherence !== after.contextAdherence) out.push("context");
  return out;
}

/** Kept, changed, inserted and deleted sections, in draft order with the deleted ones last. */
export function diff(base: Section[], draft: Draft[]): Change[] {
  const changes: Change[] = [];
  const used = new Set<number>();
  draft.forEach((each, index) => {
    const before = each.source === null ? undefined : base[each.source];
    if (each.source === null || before === undefined) {
      changes.push({
        kind: "inserted",
        index,
        source: null,
        label: labelOf(each.text),
        fields: [],
      });
      return;
    }
    used.add(each.source);
    const fields = fieldsChanged(before, each);
    changes.push({
      kind: fields.length === 0 ? "kept" : "changed",
      index,
      source: each.source,
      label: labelOf(each.text),
      fields,
    });
  });
  base.forEach((each, source) => {
    if (!used.has(source))
      changes.push({ kind: "deleted", index: null, source, label: labelOf(each.text), fields: [] });
  });
  return changes;
}

/** Why a section cannot be generated, or null. */
export function problemWith(section: Section): string | null {
  const name = labelOf(section.text);
  if (section.text.trim() === "")
    return "A section has no text. Give it a name in square brackets.";
  if (!Number.isFinite(section.durationMs)) return `${name}: the length is not a number.`;
  if (section.durationMs < MIN_CHUNK_MS || section.durationMs > MAX_CHUNK_MS)
    return `${name}: a section lasts 3 to 120 seconds.`;
  if (section.positiveStyles.length > MAX_STYLES || section.negativeStyles.length > MAX_STYLES)
    return `${name}: at most ${MAX_STYLES} styles.`;
  return null;
}

const chunkOf = (section: Section): GenerationChunk => ({
  text: section.text,
  duration_ms: Math.round(section.durationMs),
  positive_styles: section.positiveStyles,
  negative_styles: section.negativeStyles,
  context_adherence: section.contextAdherence,
});

/** Where each base section starts in the previous version's audio, from the chunk durations. */
export function offsetsOf(base: Section[]): number[] {
  const out: number[] = [];
  let at = 0;
  for (const each of base) {
    out.push(at);
    at += each.durationMs;
  }
  return out;
}

/** Adds a kept slice, joined to the one before it when that was the next section in the old song too. */
function keepSlice(
  chunks: PlanChunk[],
  songId: string,
  range: { start_ms: number; end_ms: number },
  joins: boolean,
): void {
  const previous = chunks[chunks.length - 1];
  if (joins && previous !== undefined && "range" in previous) previous.range.end_ms = range.end_ms;
  else chunks.push({ song_id: songId, range });
}

/** The chunks for the draft, or the message that says why they cannot be made. */
function chunksFor(songId: string, base: Section[], draft: Draft[], changes: Change[]) {
  const offsets = offsetsOf(base);
  const chunks: PlanChunk[] = [];
  let lastKept: number | null = null;
  for (const [index, each] of draft.entries()) {
    const start = each.source === null ? undefined : offsets[each.source];
    const length = each.source === null ? undefined : base[each.source]?.durationMs;
    if (changes[index]?.kind === "kept" && each.source !== null) {
      if (start === undefined || length === undefined) return "A kept section is missing.";
      const range = { start_ms: start, end_ms: start + length };
      keepSlice(chunks, songId, range, lastKept !== null && each.source === lastKept + 1);
      lastKept = each.source;
      continue;
    }
    lastKept = null;
    const problem = problemWith(each);
    if (problem !== null) return problem;
    chunks.push(chunkOf(each));
  }
  return chunks;
}

/**
 * The plan for `draft`. `songId` is the stored song of the version `base`
 * describes; the audio ranges are computed from the base sections' durations.
 */
export function buildPlan(songId: string, base: Section[], draft: Draft[]): Built {
  const changes = diff(base, draft);
  const refuse = (message: string): Built => ({ ok: false, message, changes });
  if (draft.length === 0) return refuse("A song needs at least one section.");
  const chunks = chunksFor(songId, base, draft, changes);
  if (typeof chunks === "string") return refuse(chunks);
  if (changes.every((each) => each.kind === "kept")) return refuse("Nothing changed.");
  if (chunks.length > MAX_CHUNKS)
    return refuse(`That makes ${chunks.length} chunks; ElevenLabs takes at most ${MAX_CHUNKS}.`);
  return {
    ok: true,
    chunks,
    changes,
    generated: chunks.filter((each) => "text" in each).length,
    kept: changes.filter((each) => each.kind === "kept").length,
  };
}

/** The sections' total length in milliseconds. */
export const totalMs = (sections: { durationMs: number }[]): number =>
  sections.reduce((sum, each) => sum + each.durationMs, 0);
