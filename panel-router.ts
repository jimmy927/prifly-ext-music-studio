/**
 * What the Music Studio page asks for at `api/<path>`, answered as JSON. The
 * host serves no audio types, so a sketch's audio goes to the page as base64
 * in JSON (`api/media`) and the page plays it from a Blob URL.
 */

import type { PanelRequest } from "@prifly/extension-api";
import { isRecord } from "./engines/types";
import { type IndexEntry, isProjectId, isSketchId } from "./project/store";
import { type Studio, startSketch, statusOf } from "./studio";

const bodyOf = (request: PanelRequest): Record<string, unknown> =>
  isRecord(request.body) ? request.body : {};

function listItem(entry: IndexEntry) {
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

async function entryOf(studio: Studio, id: unknown): Promise<IndexEntry> {
  const entry = isProjectId(id) ? await studio.store().find(id) : null;
  if (entry === null) throw new Error("No such project.");
  return entry;
}

async function projectView(studio: Studio, id: unknown) {
  const entry = await entryOf(studio, id);
  const store = studio.store();
  const record = await store.readBrief(entry);
  const sketches = await store.sketches(entry);
  return {
    ...listItem(entry),
    folder: store.pathOf(entry),
    brief: record?.brief ?? null,
    chosen: record?.chosen ?? entry.chosen,
    sketchList: sketches.map((each) => ({
      id: each.id,
      engine: each.engine,
      songId: each.songId,
      lyrics: each.lyrics,
      title: each.title ?? null,
      created: each.created,
    })),
  };
}

async function media(studio: Studio, query: Record<string, string>) {
  const entry = await entryOf(studio, query["project"]);
  const store = studio.store();
  const sketch = (await store.sketches(entry)).find((each) => each.id === query["sketch"]);
  if (sketch === undefined) throw new Error("No such sketch.");
  const bytes = await store.audio(entry, sketch);
  return {
    mime: sketch.file.endsWith(".wav") ? "audio/wav" : "audio/mpeg",
    base64: bytes.toString("base64"),
  };
}

async function sketch(studio: Studio, request: PanelRequest) {
  const started = await startSketch(studio, request.body);
  if (!started.ok) return { ok: false, reason: started.reason, message: started.message };
  return { ok: true, job: started.job };
}

/** The module's `panel` export for the Music Studio window. */
export async function route(studio: Studio, request: PanelRequest): Promise<unknown> {
  const { path, query } = request;
  switch (path) {
    case "status":
      return await statusOf(studio);
    case "library":
      return { projects: (await studio.store().list(query["q"] ?? "")).map(listItem) };
    case "project":
      return await projectView(studio, query["id"]);
    case "media":
      return await media(studio, query);
    case "job": {
      const job = studio.jobs.get(query["id"] ?? "");
      if (job === undefined) throw new Error("No such job.");
      return job;
    }
    case "sketch":
      return await sketch(studio, request);
    case "cancel":
      return { ok: studio.cancel(String(bodyOf(request)["job"] ?? "")) };
    case "choose": {
      const body = bodyOf(request);
      if (!isSketchId(body["sketch"])) throw new Error("Pick sketch a, b or c.");
      await studio.store().choose(await entryOf(studio, body["project"]), body["sketch"]);
      return await projectView(studio, body["project"]);
    }
    default:
      throw new Error(`No such route: ${path}`);
  }
}

export type ListItem = ReturnType<typeof listItem>;
export type ProjectView = Awaited<ReturnType<typeof projectView>>;
