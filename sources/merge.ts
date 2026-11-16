/**
 * Putting what the source material suggested together with what a call
 * asked for: the brief (an explicit argument always wins), and the treatment
 * (concept, look, a cast picked from the pictures, the videos as references).
 */

import { VOCALS } from "../project/brief";
import type { SourceRecord } from "../project/sources";
import { MAX_CAST } from "../video/constants";
import type { CastIdea, Synthesis } from "./types";

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** True when `raw` names the brief's text: the arguments' `text` (the tool's `brief`). */
export const hasText = (raw: Record<string, unknown>): boolean => text(raw["text"]) !== "";

/** The words a brief stands for until the source material is read. */
export const PLACEHOLDER_TEXT = "A song from the shared pictures and videos";

/**
 * The brief's fields with the analysis filled in where the call left a field
 * out: text, tempo, key, vocals and lyrics. What the call did give is kept
 * as it is; given text only gets the material's brief added after it.
 */
export function mergeBrief(
  raw: Record<string, unknown>,
  synthesis: Synthesis,
): Record<string, unknown> {
  const song = synthesis.song;
  const explicit = text(raw["text"]);
  const context = `From the source material: ${song.brief}${song.story === "" ? "" : ` The story: ${song.story}`}`;
  const merged: Record<string, unknown> = {
    ...raw,
    text: (explicit === "" ? song.brief : `${explicit}\n${context}`).slice(0, 2000),
  };
  if (typeof raw["tempo"] !== "number" && song.tempo !== null) merged["tempo"] = song.tempo;
  if (text(raw["key"]) === "" && song.key !== "") merged["key"] = song.key;
  const vocals = VOCALS.find((each) => each === raw["vocals"]);
  const lyrics = text(raw["lyrics"]);
  // Vocals the call did not name, or "mine" with no lyrics, get the drafted lyrics to sing.
  if (vocals !== "instrumental" && vocals !== "generated" && lyrics === "") {
    if (song.lyrics !== "") {
      merged["lyrics"] = song.lyrics;
      merged["vocals"] = "mine";
    } else if (vocals === "mine") {
      // No lyrics of its own and none drafted: the engine writes them.
      merged["vocals"] = "generated";
    }
  }
  return merged;
}

/** A cast member and the source file whose picture stands for it. */
export type CastPick = { idea: CastIdea; source: SourceRecord };

/**
 * The cast to take from the sources: ideas whose `source` names a picture (a
 * video's first frame stands in when it names a video), one per source file,
 * in order, at most `room` (and never more than the cast's limit of 6).
 */
export function pickCast(
  synthesis: Synthesis,
  sources: SourceRecord[],
  room = MAX_CAST,
): CastPick[] {
  const byName = new Map(sources.map((each) => [each.name, each]));
  const used = new Set<string>();
  const picks: CastPick[] = [];
  for (const idea of synthesis.video.cast) {
    if (picks.length >= Math.min(room, MAX_CAST)) break;
    const source = byName.get(idea.source);
    if (source === undefined || used.has(source.id)) continue;
    const picture = source.kind === "image" ? (source.thumb ?? source.file) : source.frames[0];
    if (picture === null || picture === undefined) continue;
    used.add(source.id);
    picks.push({ idea, source });
  }
  return picks;
}
