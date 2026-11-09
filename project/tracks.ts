/** The tracks of a project's mix: its stems, then its sound-effect layers, with the tempo that places the layers. */

import { tempoOf } from "../audio/bars";
import { baseOf } from "./source";
import { layers, readStems } from "./stage";
import type { IndexEntry, Store } from "./store";

export type TrackInfo = {
  /** "stem:vocals" or "layer:<id>": the key in mix.json. */
  key: string;
  kind: "stem" | "layer";
  label: string;
  /** Relative to the project's folder. */
  file: string;
  /** Layers only: the 1-based bar the layer starts on. */
  startBar: number | null;
  lengthSec: number | null;
};

export async function tempoFor(store: Store, entry: IndexEntry): Promise<number> {
  const base = await baseOf(store, entry);
  const brief = await store.readBrief(entry);
  const named = brief?.brief.tempo;
  return tempoOf(base.ok ? base.sections : [], typeof named === "number" ? named : null);
}

export async function tracksOf(
  store: Store,
  entry: IndexEntry,
): Promise<{ tempo: number; tracks: TrackInfo[]; stemSource: string | null }> {
  const dir = store.pathOf(entry);
  const set = await readStems(dir);
  const tracks: TrackInfo[] = (set?.stems ?? []).map((each) => ({
    key: `stem:${each.name}`,
    kind: "stem",
    label: each.name,
    file: each.file,
    startBar: null,
    lengthSec: null,
  }));
  for (const layer of await layers(dir)) {
    tracks.push({
      key: `layer:${layer.id}`,
      kind: "layer",
      label: layer.prompt.length > 28 ? `${layer.prompt.slice(0, 27)}…` : layer.prompt,
      file: layer.file,
      startBar: layer.startBar,
      lengthSec: layer.lengthSec,
    });
  }
  return { tempo: await tempoFor(store, entry), tracks, stemSource: set?.source ?? null };
}
