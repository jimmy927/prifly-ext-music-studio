/**
 * The session tools of the Treatment and Storyboard stages:
 * `video_treatment` and `video_storyboard`. Drawing a cast picture and drawing
 * frames cost money, so the reader confirms the dollars on a card first, and
 * when they cancel nothing is made and the tool answers with the plain cancel
 * text. Results are file paths. (`video_shoot`, `video_edit` and
 * `video_render` are in video-tools-make.ts.)
 */

import { join } from "node:path";
import type { ExtensionTool } from "@prifly/extension-api";
import { isRecord } from "./engines/types";
import type { IndexEntry } from "./project/store";
import { readShots, readTreatment, writeTreatment } from "./project/video";
import { applyTreatment } from "./routes/treatment";
import { tempoOf } from "./routes/video-common";
import { projectOf } from "./stage-tools";
import type { Studio } from "./studio";
import { addCastFile, readPictureFile } from "./video/cast";
import { SHOT_BARS } from "./video/constants";
import { draftProject, hasWork, NO_TEMPO } from "./video/draft";
import { removeCast, startCastDraw, startFrames } from "./video/frames";
import { editShots, parseChange } from "./video/shot-edit";
import { budgetLine, outcomeOf, PROJECT, shotId, shotIds, shotLine } from "./video-tools-common";

type Tool = ExtensionTool;

export function treatmentTool(studio: Studio): Tool {
  return {
    name: "video_treatment",
    description:
      "Reads or sets a project's music-video treatment: the concept, the look, whether a 9:16 vertical cut is wanted, the shot length rule (2, 4 or 8 bars) and the dollar budget; adds cast pictures from files (up to 6, free) or draws one from a prompt (costs money, so the reader confirms the dollars on a card first; when they cancel, nothing is made and the tool says so). The treatment is kept in the project's video/treatment.json and the pictures in video/cast/. Needs the song to be prepared first (a tempo). Returns the treatment and the file paths.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT,
        concept: { type: "string", description: "What the video is about." },
        look: { type: "string", description: "The visual style." },
        vertical: { type: "boolean", description: "Also make a 9:16 vertical cut." },
        shotBars: { type: "number", enum: [...SHOT_BARS], description: "Bars per shot." },
        budgetUsd: {
          type: ["number", "null"],
          description: "Dollars for the whole video; null for the extension's setting.",
        },
        castFiles: {
          type: "array",
          items: { type: "string" },
          description: "Full paths of PNG, JPEG or WebP pictures to add to the cast.",
        },
        castDraw: {
          type: "object",
          description: "Draw one cast picture from a prompt (paid).",
          properties: { name: { type: "string" }, prompt: { type: "string" } },
          required: ["prompt"],
        },
        removeCast: { type: "string", description: "The id of a cast picture to remove." },
      },
      additionalProperties: false,
    },
    call: async (args, ctx) => {
      const entry = await projectOf(studio, args);
      if (typeof entry === "string") return `Not done: ${entry}`;
      const dir = studio.store().pathOf(entry);
      if ((await tempoOf(dir)) === null) return `Not done: ${NO_TEMPO}`;
      const problem = await changeTreatment(dir, args);
      if (problem !== null) return `Not done: ${problem}`;
      const drawn = await drawCast(studio, entry, args["castDraw"], ctx.signal);
      return drawn ?? (await describeTreatment(studio, entry));
    },
  };
}

/** Draws the cast picture a call asks for; the sentence for the session when it did not go well, else null. */
async function drawCast(
  studio: Studio,
  entry: IndexEntry,
  draw: unknown,
  signal: AbortSignal,
): Promise<string | null> {
  if (!isRecord(draw)) return null;
  const input = { name: String(draw["name"] ?? ""), prompt: String(draw["prompt"] ?? "") };
  const done = await outcomeOf(await startCastDraw(studio, entry, input, signal));
  return "text" in done ? done.text : null;
}

/** Adds the cast pictures named by file; the message when one cannot be added. */
async function addFiles(dir: string, paths: unknown): Promise<string | null> {
  for (const path of Array.isArray(paths) ? paths : []) {
    const bytes =
      typeof path === "string" ? await readPictureFile(path) : "A cast file is a full path.";
    if (typeof bytes === "string") return bytes;
    const added = await addCastFile(dir, String(path).split(/[\\/]/).pop() ?? "", bytes);
    if (!added.ok) return added.message;
  }
  return null;
}

/** Applies the free changes of a call; the message when one cannot be made. */
async function changeTreatment(dir: string, args: Record<string, unknown>): Promise<string | null> {
  if (typeof args["removeCast"] === "string") {
    try {
      await removeCast(dir, args["removeCast"]);
    } catch (caught) {
      return caught instanceof Error ? caught.message : String(caught);
    }
  }
  await writeTreatment(dir, applyTreatment(await readTreatment(dir), args));
  return await addFiles(dir, args["castFiles"]);
}

async function describeTreatment(studio: Studio, entry: IndexEntry): Promise<string> {
  const dir = studio.store().pathOf(entry);
  const t = await readTreatment(dir);
  return [
    `Treatment of "${entry.title}" (${entry.id}): ${join(dir, "video", "treatment.json")}`,
    `Concept: ${t.concept === "" ? "(none)" : t.concept}`,
    `Look: ${t.look === "" ? "(none)" : t.look}`,
    `Vertical cut: ${t.vertical ? "yes" : "no"}; shots of ${t.shotBars} bars.`,
    await budgetLine(studio, dir),
    ...t.cast.map((each) => `- cast ${each.id} ${each.name}: ${join(dir, each.file)}`),
  ].join("\n");
}

export function storyboardTool(studio: Studio): Tool {
  return {
    name: "video_storyboard",
    description:
      "Works on a project's shot list. `draft` cuts the song into shots on the beatgrid from its sections (2, 4 or 8 bars each, every cut on a beat) and asks a model for a first description of each (left blank where none is available); `replace` is needed to draft again over existing work. `edits` change shots by number (from 1) or id: text, approved, splitAt (a second; split on the nearest beat), merge (join with the next). `draw` makes still frames (costs money, so the reader confirms the dollars on a card first; when they cancel, nothing is made and the tool says so): \"missing\" or a list of shot numbers to draw again. Returns the shot list with the frames' file paths; the list is in video/shots.json.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT,
        draft: { type: "boolean" },
        replace: { type: "boolean", description: "Allow drafting over an existing shot list." },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              shot: { type: ["number", "string"] },
              text: { type: "string" },
              approved: { type: "boolean" },
              splitAt: { type: "number" },
              merge: { type: "boolean" },
            },
            required: ["shot"],
          },
        },
        draw: {
          description:
            '"missing" for every shot without a frame, or a list of shot numbers or ids.',
          anyOf: [
            { type: "string", enum: ["missing"] },
            { type: "array", items: { type: ["number", "string"] } },
          ],
        },
      },
      additionalProperties: false,
    },
    call: async (args, ctx) => {
      const entry = await projectOf(studio, args);
      if (typeof entry === "string") return `Not done: ${entry}`;
      const dir = studio.store().pathOf(entry);
      const stopped =
        (await draftStep(studio, entry, args)) ??
        (await editStep(dir, args["edits"])) ??
        (await drawStep(studio, entry, args["draw"], ctx.signal));
      return stopped ?? (await describeShots(studio, entry));
    },
  };
}

async function draftStep(
  studio: Studio,
  entry: IndexEntry,
  args: Record<string, unknown>,
): Promise<string | null> {
  if (args["draft"] !== true) return null;
  const dir = studio.store().pathOf(entry);
  if ((await hasWork(dir)) && args["replace"] !== true)
    return "Not done: there is a shot list with work in it. Pass replace: true to draft over it.";
  const done = await draftProject(studio, entry);
  return done.ok ? null : `Not done: ${done.message}`;
}

async function editStep(dir: string, edits: unknown): Promise<string | null> {
  if (!Array.isArray(edits) || edits.length === 0) return null;
  const list = await readShots(dir);
  if (list === null) return "Not done: there is no shot list yet. Draft one first.";
  const changes = [];
  for (const raw of edits) {
    const id = isRecord(raw) ? shotId(list, raw["shot"]) : null;
    const change = parseChange(isRecord(raw) ? { ...raw, shot: id } : null);
    if (change === null)
      return `Not done: there is no shot ${isRecord(raw) ? String(raw["shot"]) : "?"}.`;
    changes.push(change);
  }
  const done = await editShots(dir, changes);
  return done.ok ? null : `Not done: ${done.message}`;
}

async function drawStep(
  studio: Studio,
  entry: IndexEntry,
  draw: unknown,
  signal: AbortSignal,
): Promise<string | null> {
  if (draw === undefined) return null;
  const list = await readShots(studio.store().pathOf(entry));
  if (list === null) return "Not done: there is no shot list yet. Draft one first.";
  const ids = draw === "missing" ? null : shotIds(list, draw);
  if (typeof ids === "string") return `Not done: ${ids}`;
  const done = await outcomeOf(await startFrames(studio, entry, ids, signal));
  return "text" in done ? done.text : null;
}

async function describeShots(studio: Studio, entry: IndexEntry): Promise<string> {
  const dir = studio.store().pathOf(entry);
  const list = await readShots(dir);
  if (list === null) return "There is no shot list yet. Pass draft: true.";
  return [
    `Shot list of "${entry.title}" (${entry.id}), ${list.shots.length} shots at ${list.bpm} BPM: ${join(dir, "video", "shots.json")}`,
    ...list.shots.map((each, at) => shotLine(each, at, dir)),
    await budgetLine(studio, dir),
  ].join("\n");
}
