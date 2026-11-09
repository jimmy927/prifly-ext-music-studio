/**
 * `api/media`: one audio file of a project as base64 JSON, since the host
 * serves no audio types. `kind` is sketch, version, stem, layer or mix; `id`
 * names the one (a, v2, vocals, a layer id, a mix number). The older
 * `sketch=<x>` query still means kind sketch.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { layers, mixes, readStems, versions } from "../project/stage";
import { entryOf, type Handler } from "./common";

const MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  m4a: "audio/mp4",
};

/** The file (relative to the project's folder) a kind and id name, or null. */
async function fileOf(
  studio: Parameters<Handler>[0],
  dir: string,
  entryId: string,
  kind: string,
  id: string,
): Promise<string | null> {
  switch (kind) {
    case "sketch": {
      const entry = await entryOf(studio, entryId);
      return (await studio.store().sketches(entry)).find((each) => each.id === id)?.file ?? null;
    }
    case "version":
      return (await versions(dir)).find((each) => each.id === id)?.file ?? null;
    case "stem":
      return (await readStems(dir))?.stems.find((each) => each.name === id)?.file ?? null;
    case "layer":
      return (await layers(dir)).find((each) => each.id === id)?.file ?? null;
    case "mix":
      return (await mixes(dir)).find((each) => String(each.n) === id)?.file ?? null;
    default:
      return null;
  }
}

export const media: Handler = async (studio, request) => {
  const { query } = request;
  const entry = await entryOf(studio, query["project"]);
  const dir = studio.store().pathOf(entry);
  const kind = query["kind"] ?? "sketch";
  const id = query["id"] ?? query["sketch"] ?? "";
  const file = await fileOf(studio, dir, entry.id, kind, id);
  if (file === null) throw new Error(`No such ${kind}.`);
  const bytes = await readFile(join(dir, file));
  return {
    mime: MIME[file.slice(file.lastIndexOf(".") + 1)] ?? "audio/mpeg",
    base64: bytes.toString("base64"),
  };
};
