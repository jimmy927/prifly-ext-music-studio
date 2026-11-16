/**
 * "Draft shot list": cuts the song into shots on the beatgrid from its
 * sections (video/shotlist.ts), then asks the extension's model (`api.llm`,
 * declared in the manifest) for a first description of each shot. If there is
 * no model, or it refuses or fails, the descriptions are left blank for the
 * reader to write and the answer says why. Nothing here costs money.
 */

import { labelOf } from "../arrange/plan";
import { isRecord } from "../engines/types";
import { sectionStarts } from "../prep/run";
import { readPrep } from "../project/prep";
import { baseOf } from "../project/source";
import type { IndexEntry } from "../project/store";
import { readShots, readTreatment, type Treatment, writeShots } from "../project/video";
import { readTakes } from "../project/video-media";
import type { Studio } from "../studio";
import { draftShots, type Shot, type ShotList } from "./shotlist";

export const NO_TEMPO =
  "There is no tempo yet. Analyse the track on the Prepare stage (or type its BPM in) so the shots can sit on bars.";

export type Drafted =
  | { ok: true; list: ShotList; described: boolean; note: string | null }
  | { ok: false; message: string };

/** The lyrics of each section by name (the text after its `[tag]` line). */
async function lyricsBySection(studio: Studio, entry: IndexEntry): Promise<Map<string, string>> {
  const base = await baseOf(studio.store(), entry);
  const out = new Map<string, string>();
  if (!base.ok) return out;
  for (const section of base.sections) {
    const words = section.text.replace(/^\s*\[[^\]]*\]/, "").trim();
    out.set(labelOf(section.text), words.slice(0, 400));
  }
  return out;
}

function promptFor(treatment: Treatment, list: ShotList, lyrics: Map<string, string>): string {
  const lines = list.shots.map((shot, at) => {
    const words = lyrics.get(shot.section) ?? "";
    const seconds = Math.round(shot.endSec - shot.startSec);
    return `${at + 1}. ${shot.section}, ${seconds} s${words === "" ? "" : `. Lyrics of the section: ${words}`}`;
  });
  return [
    `Concept: ${treatment.concept === "" ? "(none given: invent something that fits the song)" : treatment.concept}`,
    `Look: ${treatment.look === "" ? "(none given)" : treatment.look}`,
    treatment.cast.length === 0
      ? "Cast: none"
      : `Cast: ${treatment.cast.map((each) => each.name || "unnamed").join(", ")}`,
    ...(treatment.references.length === 0
      ? []
      : [
          `Reference clips from the reader's own footage: ${treatment.references.map((each) => `${each.name}${each.note === "" ? "" : ` (${each.note})`}`).join("; ")}`,
        ]),
    "",
    "Shots, in order:",
    ...lines,
  ].join("\n");
}

const SYSTEM =
  'You write the shot list of a music video. For each numbered shot give one concrete visual description in 15 to 35 words: who or what is in frame, what they do, the setting and the camera. Make the shots follow the song\'s sections and build on each other. Describe only what the camera sees; no lyrics quoted, no on-screen text. Answer with JSON: {"shots": [one string per shot, in order]}.';

const SCHEMA = {
  type: "object",
  properties: { shots: { type: "array", items: { type: "string" } } },
  required: ["shots"],
};

/** The descriptions from the model's JSON, one per shot; null when the answer does not fit. */
export function parseDescriptions(text: string, count: number): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const shots = isRecord(parsed) ? parsed["shots"] : null;
  if (!Array.isArray(shots) || shots.length !== count) return null;
  if (!shots.every((each) => typeof each === "string")) return null;
  return shots.map((each) => String(each).trim().slice(0, 600));
}

/** Descriptions for the shots, or the reason there are none. */
async function describe(
  studio: Studio,
  treatment: Treatment,
  list: ShotList,
  lyrics: Map<string, string>,
): Promise<{ texts: string[] } | { note: string }> {
  const llm = studio.api().llm;
  if (llm === undefined)
    return {
      note: "This prifly has no model for extensions, so the descriptions are blank: write them yourself.",
    };
  const answer = await llm.ask({
    tier: "fast",
    system: SYSTEM,
    prompt: promptFor(treatment, list, lyrics),
    schema: SCHEMA,
    maxTokens: 4000,
  });
  if (!answer.ok)
    return {
      note: `No descriptions were written (${answer.reason}). They are blank: write them yourself.`,
    };
  const texts = parseDescriptions(answer.text, list.shots.length);
  if (texts === null)
    return {
      note: "The model's answer did not fit the shots, so the descriptions are blank: write them yourself.",
    };
  return { texts };
}

/** True when drafting again would throw away frames, takes or approvals. */
export async function hasWork(dir: string): Promise<boolean> {
  const list = await readShots(dir);
  if (list === null) return false;
  const takes = await readTakes(dir);
  return (
    takes.length > 0 ||
    list.shots.some((each) => each.approved || each.frame !== null || each.text !== "")
  );
}

/** Drafts and saves the shot list. */
export async function draftProject(studio: Studio, entry: IndexEntry): Promise<Drafted> {
  const dir = studio.store().pathOf(entry);
  const prep = await readPrep(dir);
  if (prep === null || prep.grid === null) return { ok: false, message: NO_TEMPO };
  const treatment = await readTreatment(dir);
  const sections = await sectionStarts(studio, entry);
  const list = draftShots({
    sections,
    grid: prep.grid,
    durationSec: prep.analysis.durationSec,
    bars: treatment.shotBars,
  });
  if (list.shots.length === 0)
    return { ok: false, message: "The song is too short to cut into shots." };
  const described = await describe(studio, treatment, list, await lyricsBySection(studio, entry));
  const shots: Shot[] =
    "texts" in described
      ? list.shots.map((each, at) => ({ ...each, text: described.texts[at] ?? "" }))
      : list.shots;
  const done: ShotList = { ...list, shots };
  await writeShots(dir, done);
  return {
    ok: true,
    list: done,
    described: "texts" in described,
    note: "note" in described ? described.note : null,
  };
}
