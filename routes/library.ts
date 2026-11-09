/** The Library list: projects with their key, tempo and loudness once prepared, filtered by search and by crate. */

import { matchesPrep, parseQuery } from "../prep/search";
import { type PrepSummary, prepSummary } from "../project/prep";
import type { IndexEntry } from "../project/store";
import type { Studio } from "../studio";

export function listItem(entry: IndexEntry) {
  return {
    id: entry.id,
    title: entry.title,
    engine: entry.engine,
    lengthSec: entry.lengthSec,
    created: entry.created,
    sketches: entry.sketches,
    chosen: entry.chosen,
  };
}

export type ListItem = ReturnType<typeof listItem> & {
  /** Null until the track is analysed on the Prepare stage. */
  prep: PrepSummary | null;
  /** The ids of the crates the track is in. */
  crates: string[];
};

/** `query` may hold `key 8A` and `bpm 120-128` next to plain words; `crate` is a crate id. */
export async function libraryRoute(
  studio: Studio,
  query: string,
  crate: string,
): Promise<{ projects: ListItem[] }> {
  const parsed = parseQuery(query);
  const store = studio.store();
  const all = await studio.crates().list();
  const chosen = crate === "" ? null : (all.find((each) => each.id === crate) ?? null);
  if (crate !== "" && chosen === null) throw new Error("No such crate.");
  const projects: ListItem[] = [];
  for (const entry of await store.list(parsed.text)) {
    if (chosen !== null && !chosen.tracks.includes(entry.id)) continue;
    const prep = await prepSummary(store.pathOf(entry));
    if (!matchesPrep(prep, parsed)) continue;
    projects.push({
      ...listItem(entry),
      prep,
      crates: all.filter((each) => each.tracks.includes(entry.id)).map((each) => each.id),
    });
  }
  return { projects };
}
