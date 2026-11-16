/** Filling a project's treatment from its source material: concept, look, a cast of pictures from the sources, the videos as references. */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readSources, type SourceRecord } from "../project/sources";
import {
  type CastMember,
  readTreatment,
  removeFile,
  type ShotReference,
  savePicture,
  type Treatment,
  writeTreatment,
} from "../project/video";
import { sniffImage } from "../video/cast";
import { MAX_CAST } from "../video/constants";
import { MAX_REFERENCES_KEPT } from "./constants";
import { pickCast } from "./merge";

/** What a cast member taken from the sources says in its `prompt`, so a later fill replaces it and nothing else. */
export const FROM_SOURCE = "from source: ";

/** A one-line note of what a video shows. */
function noteOf(source: SourceRecord): string {
  const seen = source.seen;
  if (seen === null) return "";
  return [seen.actions, seen.place, seen.mood]
    .filter((each) => each !== "")
    .join("; ")
    .slice(0, 400);
}

export type Filled = {
  concept: boolean;
  look: boolean;
  cast: string[];
  references: string[];
  /** Why something was not done, as sentences. */
  notes: string[];
};

/**
 * Fills the treatment from the project's analysed sources. The concept and
 * the look are only written where they are empty and the call gave none (a
 * reader's or session's words stay); the cast gets the sources' picks in the
 * room the cast has left (up to 6 in all, earlier picks from sources are
 * replaced); every source video is kept as a shot reference.
 */
export async function fillTreatment(
  dir: string,
  given: { concept: boolean; look: boolean },
): Promise<Filled | string> {
  const sources = await readSources(dir);
  const synthesis = sources.synthesis;
  if (synthesis === null) return "The source material has not been read yet.";
  const done: Filled = { concept: false, look: false, cast: [], references: [], notes: [] };
  let treatment: Treatment = await readTreatment(dir);
  if (!given.concept && treatment.concept === "" && synthesis.video.concept !== "") {
    treatment = { ...treatment, concept: synthesis.video.concept };
    done.concept = true;
  }
  if (!given.look && treatment.look === "" && synthesis.video.look !== "") {
    treatment = { ...treatment, look: synthesis.video.look };
    done.look = true;
  }
  const earlier = treatment.cast.filter((each) => each.prompt.startsWith(FROM_SOURCE));
  for (const each of earlier) await removeFile(dir, each.file);
  const kept = treatment.cast.filter((each) => !each.prompt.startsWith(FROM_SOURCE));
  const added: CastMember[] = [];
  for (const pick of pickCast(synthesis, sources.sources, MAX_CAST - kept.length)) {
    const path =
      pick.source.kind === "image"
        ? (pick.source.thumb ?? pick.source.file)
        : pick.source.frames[0];
    if (path === null || path === undefined) continue;
    const bytes = new Uint8Array(await readFile(join(dir, path)));
    const mime = sniffImage(bytes);
    if (mime === null) {
      done.notes.push(
        `${pick.source.name} is not a PNG, JPEG or WebP picture, so it is not in the cast.`,
      );
      continue;
    }
    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
    const file = await savePicture(dir, "cast", id, { bytes, mime });
    added.push({
      id,
      name: pick.idea.name.slice(0, 60),
      prompt: `${FROM_SOURCE}${pick.source.name}`,
      file,
      source: "file",
    });
    done.cast.push(pick.idea.name);
  }
  const references: ShotReference[] = sources.sources
    .filter((each) => each.kind === "video")
    .slice(0, MAX_REFERENCES_KEPT)
    .map((each) => ({ id: each.id, name: each.name, note: noteOf(each), file: each.file }));
  done.references = references.map((each) => each.name);
  await writeTreatment(dir, {
    ...treatment,
    cast: [...kept, ...added].slice(0, MAX_CAST),
    references,
  });
  return done;
}

/** The sentence a session is told of what was filled. */
export function describeFilled(filled: Filled): string {
  const parts = [
    filled.concept ? "concept" : "",
    filled.look ? "look" : "",
    filled.cast.length === 0 ? "" : `cast (${filled.cast.join(", ")})`,
    filled.references.length === 0 ? "" : `${filled.references.length} video reference(s)`,
  ].filter((each) => each !== "");
  const said =
    parts.length === 0
      ? "Nothing needed filling from the source material."
      : `From the source material: ${parts.join(", ")}.`;
  return [said, ...filled.notes].join(" ");
}
