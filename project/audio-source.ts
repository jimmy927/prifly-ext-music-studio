/**
 * Which audio Master and Prepare work on. Master takes the newest mix, else the
 * picked version, else the chosen sketch; Prepare takes the newest master first.
 * `file` is relative to the project's folder; `kind` and `id` are what
 * `api/media` is asked for.
 */

import { masters } from "./master";
import { activeVersion, mixes } from "./stage";
import type { IndexEntry, Store } from "./store";

export type AudioKind = "master" | "mix" | "version" | "sketch";
export type AudioSource = { kind: AudioKind; id: string; label: string; file: string };

/** The newest mix, else the picked version, else the chosen sketch; null when there is none. */
export async function sourceToMaster(store: Store, entry: IndexEntry): Promise<AudioSource | null> {
  const dir = store.pathOf(entry);
  const mix = (await mixes(dir)).at(-1);
  if (mix !== undefined)
    return { kind: "mix", id: String(mix.n), label: `Mix ${mix.n}`, file: mix.file };
  const version = await activeVersion(dir);
  if (version !== null)
    return { kind: "version", id: version.id, label: `Version ${version.n}`, file: version.file };
  const chosen = (await store.sketches(entry)).find((each) => each.id === entry.chosen);
  if (chosen === undefined) return null;
  return {
    kind: "sketch",
    id: chosen.id,
    label: `Sketch ${chosen.id.toUpperCase()}`,
    file: chosen.file,
  };
}

/** The newest master if one exists, else what Master would take. */
export async function sourceToPrepare(
  store: Store,
  entry: IndexEntry,
): Promise<AudioSource | null> {
  const master = (await masters(store.pathOf(entry))).at(-1);
  if (master !== undefined)
    return {
      kind: "master",
      id: String(master.n),
      label: `Master ${master.n}`,
      file: master.file,
    };
  return await sourceToMaster(store, entry);
}
