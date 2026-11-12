/**
 * The session tools of the later stages: `music_arrange`, `music_stems` and
 * `music_sfx` (paid, each behind a confirm card; a cancel answers with the
 * plain cancel text) and `music_mix` (local, no card). Results are file paths.
 */

import { join } from "node:path";
import type { ExtensionTool } from "@prifly/extension-api";
import { type Draft, type Section, toDraft } from "./arrange/plan";
import { startArrange } from "./arrange/render";
import { DEFAULT_TRACK, type MixSettings, parseTrack } from "./audio/mixgraph";
import { isRecord } from "./engines/types";
import { renderMix } from "./mix/render";
import { startSfx, startStems } from "./produce/run";
import { baseOf } from "./project/source";
import { activeVersion, layers, readMix, readStems, versions, writeMix } from "./project/stage";
import { type IndexEntry, isSketchId } from "./project/store";
import { tracksOf } from "./project/tracks";
import { noteProject, sessionProject } from "./session";
import type { Job, Started, Studio } from "./studio";
import { CANCELLED } from "./tools";

type Tool = ExtensionTool;

/**
 * The project a call names (`project` is its id), else the calling session's
 * own, else the newest. The project it finds is linked to the calling session.
 */
export async function projectOf(
  studio: Studio,
  args: Record<string, unknown>,
): Promise<IndexEntry | string> {
  const store = studio.store();
  const named = typeof args["project"] === "string" ? args["project"] : null;
  const entry =
    named === null
      ? ((await sessionProject(studio)) ?? (await store.list())[0] ?? null)
      : await store.find(named);
  if (entry === null)
    return named === null
      ? "The library is empty. Make sketches first."
      : `No project has the id ${named}.`;
  await noteProject(studio, entry.id);
  return entry;
}

const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** A refused or failed run as the session is told. */
function stopped(started: Started): string | null {
  if (started.ok) return null;
  return started.reason === "cancelled" ? CANCELLED : `Not done: ${started.message}`;
}

function failure(job: Job): string | null {
  if (job.status === "cancelled") return "Cancelled. Nothing was added.";
  if (job.status !== "failed") return null;
  const hint = job.suggestion === null ? "" : ` Suggested prompt: ${job.suggestion}`;
  return `Stopped: ${job.error ?? "failed"}.${hint}`;
}

type Item = Record<string, unknown>;

const ms = (item: Item, fallback: number): number =>
  number(item["durationMs"]) ?? (number(item["durationSec"]) ?? fallback / 1000) * 1000;

const strings = (value: unknown, fallback: string[]): string[] =>
  Array.isArray(value)
    ? value.filter((each): each is string => typeof each === "string")
    : fallback;

/** One entry of a full `sections` list; `before` is the old section it comes from (`from`, else the same position). */
function draftFrom(item: Item, before: Section | undefined, origin: number | null): Draft {
  return {
    text: String(item["text"] ?? before?.text ?? ""),
    durationMs: ms(item, before?.durationMs ?? 0),
    positiveStyles: strings(item["positiveStyles"], before?.positiveStyles ?? []),
    negativeStyles: strings(item["negativeStyles"], before?.negativeStyles ?? []),
    contextAdherence: before?.contextAdherence ?? "high",
    source: before === undefined ? null : origin,
  };
}

function fromSections(base: Section[], list: unknown[]): Draft[] | string {
  const out: Draft[] = [];
  for (const [at, item] of list.entries()) {
    if (!isRecord(item)) return "Each section is an object.";
    const origin = "from" in item ? number(item["from"]) : at;
    out.push(draftFrom(item, origin === null ? undefined : base[origin], origin));
  }
  return out;
}

/** Applies one edit to the drafts; the message when its index is no section. */
function applyEdit(drafts: Draft[], item: unknown): string | null {
  const index = isRecord(item) ? number(item["index"]) : null;
  const target = index === null ? undefined : drafts[index];
  if (!isRecord(item) || target === undefined)
    return `There is no such section; the song has ${drafts.length} (0 to ${drafts.length - 1}).`;
  if (typeof item["text"] === "string") target.text = item["text"];
  target.positiveStyles = strings(item["positiveStyles"], target.positiveStyles);
  target.negativeStyles = strings(item["negativeStyles"], target.negativeStyles);
  target.durationMs = ms(item, target.durationMs);
  return null;
}

function fromEdits(base: Section[], edits: unknown[]): Draft[] | string {
  const drafts = toDraft(base);
  for (const item of edits) {
    const problem = applyEdit(drafts, item);
    if (problem !== null) return problem;
  }
  const removed = edits.flatMap((item) =>
    isRecord(item) && item["delete"] === true ? [number(item["index"])] : [],
  );
  return drafts.filter((_each, at) => !removed.includes(at));
}

/** A sketch chosen through a tool: the project as it now is, the sketch's title and path, and what Arrange now works from. */
type Chosen = { entry: IndexEntry; title: string; file: string; note: string };

/**
 * Marks a sketch as the chosen one, the way the panel's click does (the store's
 * `choose`); the message when the sketch or the project's sketches say no.
 */
async function chooseSketch(
  studio: Studio,
  entry: IndexEntry,
  sketch: unknown,
): Promise<Chosen | string> {
  const store = studio.store();
  const have = await store.sketches(entry);
  const exist =
    have.length === 0 ? "it has no sketches" : `it has ${have.map((each) => each.id).join(", ")}`;
  if (!isSketchId(sketch)) return `Pick sketch a, b or c; ${entry.title} (${entry.id}): ${exist}.`;
  const record = have.find((each) => each.id === sketch);
  if (record === undefined)
    return `Sketch ${sketch} does not exist in ${entry.title} (${entry.id}); ${exist}.`;
  await store.choose(entry, sketch);
  const dir = store.pathOf(entry);
  const version = await activeVersion(dir);
  const letter = sketch.toUpperCase();
  const note =
    version !== null && entry.chosen !== sketch
      ? `Arrange still works from Version ${version.n}, not Sketch ${letter}: a project that has a version always arranges from its picked (else newest) version, and the chosen sketch only counts until the first version exists.`
      : "";
  return {
    entry: (await store.find(entry.id)) ?? entry,
    title: record.title ?? `Sketch ${letter}`,
    file: join(dir, record.file),
    note,
  };
}

/** The project a call names; when it also gives `sketch`, that sketch is chosen first (the project comes back as it now is). */
async function projectAndSketch(
  studio: Studio,
  args: Record<string, unknown>,
): Promise<{ entry: IndexEntry; note: string } | string> {
  const entry = await projectOf(studio, args);
  if (typeof entry === "string") return entry;
  if (args["sketch"] === undefined) return { entry, note: "" };
  return await chooseSketch(studio, entry, args["sketch"]);
}

export function chooseTool(studio: Studio): Tool {
  return {
    name: "music_choose",
    description:
      "Marks one of a project's sketches (a, b or c) as the chosen one, exactly as the panel's \"Mark as chosen\" does; Arrange, Stems and the later stages continue from it. Free, no confirm card. Returns the project, the chosen sketch's title and its file path; says plainly when the project already has a version, because Arrange then keeps working from that version.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "The project id; default the newest." },
        sketch: {
          type: "string",
          enum: ["a", "b", "c"],
          description: "Which sketch to continue with.",
        },
      },
      required: ["sketch"],
      additionalProperties: false,
    },
    call: async (args) => {
      const entry = await projectOf(studio, args);
      if (typeof entry === "string") return `Not done: ${entry}`;
      const chosen = await chooseSketch(studio, entry, args["sketch"]);
      if (typeof chosen === "string") return `Not done: ${chosen}`;
      return [
        `Chose sketch ${String(args["sketch"]).toUpperCase()} of "${chosen.entry.title}" (${chosen.entry.id}): ${chosen.title}.`,
        `- ${chosen.file}`,
        chosen.note,
      ]
        .filter((line) => line !== "")
        .join("\n");
    },
  };
}

/** Edits to sections by index, or a whole new list; the drafts the render is built from. */
async function draftsOf(
  studio: Studio,
  entry: IndexEntry,
  args: Record<string, unknown>,
): Promise<Draft[] | string> {
  const base = await baseOf(studio.store(), entry);
  if (!base.ok) return base.reason;
  const { sections, edits } = args;
  if (Array.isArray(sections)) return fromSections(base.sections, sections);
  return fromEdits(base.sections, Array.isArray(edits) ? edits : []);
}

export function arrangeTool(studio: Studio): Tool {
  return {
    name: "music_arrange",
    description:
      "Edits the sections of a project's song (ElevenLabs sketches and versions only) and renders a new version: only changed sections are generated, kept ones are reused as audio. Give `edits` (by section index, starting at 0) or a full `sections` list (insert or delete by what you leave in or out; `from` names the old section a new one came from). It costs money, so the reader confirms on a card first; when they cancel, nothing is made and the tool says so. Works from the project's current version, else its chosen sketch; give `sketch` (a, b or c) to choose that sketch first, as music_choose does (a project that already has a version keeps arranging from that version). Returns the new version's file path.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "The project id; default the newest." },
        sketch: {
          type: "string",
          enum: ["a", "b", "c"],
          description: "Choose this sketch first, then arrange from it.",
        },
        edits: {
          type: "array",
          description: "Changes to existing sections.",
          items: {
            type: "object",
            properties: {
              index: { type: "number", description: "Section number, from 0." },
              text: { type: "string", description: "[Name] then the lyrics." },
              positiveStyles: { type: "array", items: { type: "string" } },
              negativeStyles: { type: "array", items: { type: "string" } },
              durationSec: { type: "number", description: "3 to 120." },
              delete: { type: "boolean", description: "Remove this section." },
            },
            required: ["index"],
          },
        },
        sections: {
          type: "array",
          description: "The whole new section list; use instead of edits to insert sections.",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              positiveStyles: { type: "array", items: { type: "string" } },
              negativeStyles: { type: "array", items: { type: "string" } },
              durationSec: { type: "number" },
              from: {
                type: ["number", "null"],
                description: "Index of the old section; null for a new one.",
              },
            },
            required: ["text"],
          },
        },
      },
      additionalProperties: false,
    },
    call: async (args, ctx) => {
      const found = await projectAndSketch(studio, args);
      if (typeof found === "string") return `Not done: ${found}`;
      const { entry, note } = found;
      const drafts = await draftsOf(studio, entry, args);
      if (typeof drafts === "string") return `Not done: ${drafts}`;
      const started = await startArrange(studio, entry.id, drafts, ctx.signal);
      const refused = stopped(started);
      if (refused !== null || !started.ok) return refused ?? "";
      const job = await started.finished;
      const bad = failure(job);
      if (bad !== null) return bad;
      const made = (await versions(studio.store().pathOf(entry))).find(
        (each) => each.id === job.result,
      );
      const dir = studio.store().pathOf(entry);
      return [
        note,
        `Made version ${made?.n ?? job.result} of "${entry.title}" (${entry.id}).`,
        made === undefined ? "" : `- ${join(dir, made.file)}`,
        made === undefined ? "" : `- ${join(dir, "versions", `${made.id}.json`)} (its sections)`,
      ]
        .filter((line) => line !== "")
        .join("\n");
    },
  };
}

export function stemsTool(studio: Studio): Tool {
  return {
    name: "music_stems",
    description:
      "Splits a project's current version (or chosen sketch) into stems with ElevenLabs (vocals, drums, bass, other, or whatever the API returns) and saves them under the project's stems folder. It costs money, so the reader confirms on a card first; when they cancel, nothing is made and the tool says so. Returns the stem file paths.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "The project id; default the newest." },
      },
      additionalProperties: false,
    },
    call: async (args, ctx) => {
      const entry = await projectOf(studio, args);
      if (typeof entry === "string") return `Not done: ${entry}`;
      const started = await startStems(studio, entry.id, ctx.signal);
      const refused = stopped(started);
      if (refused !== null || !started.ok) return refused ?? "";
      const bad = failure(await started.finished);
      if (bad !== null) return bad;
      const dir = studio.store().pathOf(entry);
      const set = await readStems(dir);
      return [
        `Split into ${set?.stems.length ?? 0} stems.`,
        ...(set?.stems ?? []).map((each) => `- ${join(dir, each.file)}`),
      ].join("\n");
    },
  };
}

export function sfxTool(studio: Studio): Tool {
  return {
    name: "music_sfx",
    description:
      "Makes a sound-effect layer from a text prompt with ElevenLabs and places it at a bar of the song (4/4, bar 1 is the start). It costs money, so the reader confirms on a card first; when they cancel, nothing is made and the tool says so. Returns the layer's file path.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "The project id; default the newest." },
        prompt: { type: "string", description: "The sound, for example 'cymbal swell'." },
        startBar: { type: "number", description: "Bar to start on, from 1. Default 1." },
        lengthSec: { type: "number", description: "0.5 to 30 seconds. Default 3." },
        loop: { type: "boolean", description: "A sound that loops smoothly." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    call: async (args, ctx) => {
      const entry = await projectOf(studio, args);
      if (typeof entry === "string") return `Not done: ${entry}`;
      const started = await startSfx(studio, entry.id, args, ctx.signal);
      const refused = stopped(started);
      if (refused !== null || !started.ok) return refused ?? "";
      const job = await started.finished;
      const bad = failure(job);
      if (bad !== null) return bad;
      const layer = (await layers(studio.store().pathOf(entry))).find(
        (each) => each.id === job.result,
      );
      return layer === undefined
        ? "Made the layer."
        : `Made layer ${layer.id} at bar ${layer.startBar}.\n- ${join(studio.store().pathOf(entry), layer.file)}`;
    },
  };
}

/** Sets the named tracks' levels in `settings`; the message when a name is no track. */
function applyLevels(settings: MixSettings, known: string[], levels: unknown): string | null {
  for (const [name, value] of Object.entries(isRecord(levels) ? levels : {})) {
    const key = known.find((each) => [name, `stem:${name}`, `layer:${name}`].includes(each));
    if (key === undefined)
      return `there is no track "${name}". Tracks: ${known.join(", ") || "none yet"}.`;
    settings.tracks[key] = parseTrack({
      ...(settings.tracks[key] ?? DEFAULT_TRACK),
      ...(isRecord(value) ? value : {}),
    });
  }
  return null;
}

export function mixTool(studio: Studio): Tool {
  return {
    name: "music_mix",
    description:
      "Mixes a project's stems and sound-effect layers into a WAV with ffmpeg, locally: no cost and no confirm card. `levels` sets tracks by name (for example vocals, or layer:<id>): db, pan (-1 to 1), mute, solo. Returns the mix file path.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "The project id; default the newest." },
        levels: {
          type: "object",
          description:
            "Track name to { db, pan, mute, solo }; tracks not named keep their saved settings.",
          additionalProperties: {
            type: "object",
            properties: {
              db: { type: "number" },
              pan: { type: "number" },
              mute: { type: "boolean" },
              solo: { type: "boolean" },
            },
          },
        },
      },
      additionalProperties: false,
    },
    call: async (args) => {
      const entry = await projectOf(studio, args);
      if (typeof entry === "string") return `Not done: ${entry}`;
      const store = studio.store();
      const dir = store.pathOf(entry);
      const settings = await readMix(dir);
      const known = (await tracksOf(store, entry)).tracks.map((each) => each.key);
      const problem = applyLevels(settings, known, args["levels"]);
      if (problem !== null) return `Not done: ${problem}`;
      await writeMix(dir, settings);
      const done = await renderMix(studio, entry, settings);
      return done.ok ? `Mixed to ${done.path}` : `Not done: ${done.message}`;
    },
  };
}
