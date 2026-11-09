/** Which audio the later stages work on: the picked version, else the chosen sketch. */

import { join } from "node:path";
import { parseSections, type Section } from "../arrange/plan";
import { LYRIA_REASON } from "./reasons";
import { activeVersion, type Source } from "./stage";
import type { IndexEntry, Store } from "./store";

/** The song an Arrange render edits, or why none can be. */
export type Base =
  | { ok: true; songId: string; sections: Section[]; from: string; label: string }
  | { ok: false; reason: string };

export async function sourceOf(store: Store, entry: IndexEntry): Promise<Source | null> {
  const dir = store.pathOf(entry);
  const version = await activeVersion(dir);
  if (version !== null)
    return { id: version.id, label: `Version ${version.n}`, file: join(dir, version.file) };
  const chosen = (await store.sketches(entry)).find((each) => each.id === entry.chosen);
  if (chosen === undefined) return null;
  return {
    id: chosen.id,
    label: `Sketch ${chosen.id.toUpperCase()}`,
    file: join(dir, chosen.file),
  };
}

export async function baseOf(store: Store, entry: IndexEntry): Promise<Base> {
  const version = await activeVersion(store.pathOf(entry));
  if (version !== null)
    return {
      ok: true,
      songId: version.songId,
      sections: version.sections,
      from: version.id,
      label: `Version ${version.n}`,
    };
  const chosen = (await store.sketches(entry)).find((each) => each.id === entry.chosen);
  if (chosen === undefined)
    return { ok: false, reason: "Choose a sketch on the Idea stage first." };
  if (chosen.engine !== "elevenlabs") return { ok: false, reason: LYRIA_REASON };
  const sections = parseSections(chosen.plan);
  if (sections === null || chosen.songId === null)
    return {
      ok: false,
      reason: "This sketch has no stored section plan, so it cannot be arranged. Sketch again.",
    };
  const letter = chosen.id.toUpperCase();
  return { ok: true, songId: chosen.songId, sections, from: chosen.id, label: `Sketch ${letter}` };
}
