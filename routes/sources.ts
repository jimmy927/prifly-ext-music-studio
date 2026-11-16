/**
 * The source material's routes, shared by the Idea and Treatment stages:
 * what a project's sources hold and what was found in them, staging a file
 * the reader picks in the page (the page has no file paths), and reading the
 * sources (again). Reading is paid, behind a confirm card, as a job.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { probeFfmpeg } from "../audio/ffmpeg";
import { readSources } from "../project/sources";
import { kindOf, MAX_UPLOAD_BYTES } from "../sources/constants";
import { pathsOf } from "../sources/files";
import { startSources } from "../sources/run";
import { fillTreatment } from "../sources/treatment";
import { fail, type Studio } from "../studio";
import { bodyOf, entryOf, type Handler, startedAnswer } from "./common";
import { hasGeminiKey } from "./video-common";
import type { SourceItem, SourcesView } from "./video-views";

async function viewOf(studio: Studio, projectId: unknown): Promise<SourcesView> {
  const entry = await entryOf(studio, projectId);
  const dir = studio.store().pathOf(entry);
  const file = await readSources(dir);
  const items: SourceItem[] = file.sources.map((each) => ({
    id: each.id,
    name: each.name,
    kind: each.kind,
    durationSec: each.durationSec,
    hasPicture: each.thumb !== null,
    frames: each.frames.length,
    seen: each.seen,
    audio: each.audio,
    notes: each.notes,
  }));
  const read = file.synthesis !== null && items.every((each) => each.seen !== null);
  const running = [...studio.jobs.values()].find(
    (each) => each.status === "running" && each.project === entry.id && each.work === "sources",
  );
  const ffmpeg = items.some((each) => each.kind === "video")
    ? await probeFfmpeg(studio.ffmpeg())
    : null;
  return {
    geminiKey: await hasGeminiKey(studio),
    ffmpeg:
      ffmpeg === null
        ? null
        : { ok: ffmpeg.ok, message: ffmpeg.ok ? ffmpeg.output : ffmpeg.message },
    state: items.length === 0 ? "none" : file.error !== null ? "failed" : read ? "read" : "unread",
    error: file.error,
    notes: file.notes,
    analysedAt: file.analysedAt,
    items,
    synthesis: file.synthesis,
    running: running ?? null,
  };
}

const view: Handler = async (studio, request) => await viewOf(studio, request.query["project"]);

/** Keeps a file the reader picked in the page where the extension can read it, and says its path. */
const stage: Handler = async (studio, request) => {
  const body = bodyOf(request);
  const name = typeof body["name"] === "string" ? body["name"].replace(/[\\/]/g, "_") : "";
  if (kindOf(name) === null)
    return {
      ok: false as const,
      message: `${name === "" ? "That file" : name} is not a picture (PNG, JPEG, WebP) or a video (MP4, MOV, M4V, WebM, MKV, AVI).`,
    };
  const bytes =
    typeof body["base64"] === "string" ? Buffer.from(body["base64"], "base64") : Buffer.alloc(0);
  if (bytes.length === 0) return { ok: false as const, message: "That file is empty." };
  if (bytes.length > MAX_UPLOAD_BYTES)
    return {
      ok: false as const,
      message: `${name} is over ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB. Give its path in the box instead.`,
    };
  const folder = join(studio.libraryPath(), ".source-staging", crypto.randomUUID().slice(0, 8));
  await mkdir(folder, { recursive: true });
  const path = join(folder, name);
  await writeFile(path, bytes);
  return { ok: true as const, path };
};

/** Reads the project's sources, with `add` (paths) joining them: a job behind a confirm card. */
const analyse: Handler = async (studio, request) => {
  const body = bodyOf(request);
  const entry = await entryOf(studio, body["project"]);
  const dir = studio.store().pathOf(entry);
  const have = (await readSources(dir)).sources.map((each) => each.original);
  const paths = [...new Set([...have, ...pathsOf(body["add"])])];
  if (paths.length === 0) return startedAnswer(fail("invalid", "Add a picture or a video first."));
  return startedAnswer(await startSources(studio, entry, paths));
};

/** Fills the treatment from the project's read sources (free). */
const fill: Handler = async (studio, request) => {
  const body = bodyOf(request);
  const entry = await entryOf(studio, body["project"]);
  const filled = await fillTreatment(studio.store().pathOf(entry), { concept: false, look: false });
  return typeof filled === "string"
    ? { ok: false as const, message: filled }
    : { ok: true as const, filled };
};

export const sourcesRoutes: Record<string, Handler> = {
  sources: view,
  "sources-stage": stage,
  "sources-analyse": analyse,
  "treatment-from-sources": fill,
};
