/**
 * `api/media`: one file of a project as base64 JSON, since the host serves no
 * audio, video or picture types. `kind` is sketch, version, stem, layer, mix
 * or master (audio); cast or frame (pictures); take or preview (video).
 * `id` names the one (a, v2, vocals, a layer id, a mix or master number, a cast
 * id, a shot id, a take id, a preview number). The older `sketch=<x>` query
 * still means kind sketch.
 *
 * Video goes as small proxies only: a take as the 360p copy video/proxy.ts
 * makes, the 540p preview as it is. The 1080p renders and the vertical cut are
 * never sent. Nothing over 12 MB is sent.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { masters } from "../project/master";
import { layers, mixes, readStems, versions } from "../project/stage";
import { imageMime, readShots, readTreatment } from "../project/video";
import { readRenders, readTakes } from "../project/video-media";
import type { Studio } from "../studio";
import { MAX_MEDIA_BYTES } from "../video/constants";
import { proxyOf } from "../video/proxy";
import { entryOf, type Handler } from "./common";

const MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp4: "video/mp4",
};

/** Where a video kind's file is (relative to the project's folder): the proxy of a take, a preview render. */
async function videoFile(
  studio: Studio,
  dir: string,
  kind: string,
  id: string,
): Promise<string | null> {
  if (kind === "take") {
    const take = (await readTakes(dir)).find((each) => each.id === id);
    if (take?.file == null) return null;
    const proxy = await proxyOf(studio, dir, take.file);
    if (!proxy.ok) throw new Error(proxy.message);
    return proxy.file;
  }
  const render = (await readRenders(dir)).find(
    (each) => each.kind === "preview" && String(each.n) === id,
  );
  return render?.file ?? null;
}

/** The file (relative to the project's folder) a kind and id name, or null. */
async function fileOf(
  studio: Studio,
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
    case "master":
      return (await masters(dir)).find((each) => String(each.n) === id)?.file ?? null;
    case "cast":
      return (await readTreatment(dir)).cast.find((each) => each.id === id)?.file ?? null;
    case "frame":
      return (await readShots(dir))?.shots.find((each) => each.id === id)?.frame ?? null;
    case "take":
    case "preview":
      return await videoFile(studio, dir, kind, id);
    default:
      return null;
  }
}

const mimeOf = (file: string): string => {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  const known = MIME[ext];
  if (known !== undefined) return known;
  return ["png", "jpg", "jpeg", "webp"].includes(ext) ? imageMime(file) : "audio/mpeg";
};

export const media: Handler = async (studio, request) => {
  const { query } = request;
  const entry = await entryOf(studio, query["project"]);
  const dir = studio.store().pathOf(entry);
  const kind = query["kind"] ?? "sketch";
  const id = query["id"] ?? query["sketch"] ?? "";
  const file = await fileOf(studio, dir, entry.id, kind, id);
  if (file === null) throw new Error(`No such ${kind}.`);
  const bytes = await readFile(join(dir, file));
  if (bytes.length > MAX_MEDIA_BYTES)
    throw new Error(
      `That ${kind} is ${Math.round(bytes.length / 1048576)} MB, too big to show here. Open the file from the project's folder.`,
    );
  return { mime: mimeOf(file), base64: bytes.toString("base64") };
};
