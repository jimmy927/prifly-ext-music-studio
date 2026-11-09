/**
 * The session tools: `music_sketch` (paid, behind a confirm card) and
 * `music_library` (a read-only list with file paths).
 */

import { copyFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ExtensionTool, ExtensionToolContext } from "@prifly/extension-api";
import { ENGINES, formatLength, PRESETS, VOCALS } from "./project/brief";
import type { IndexEntry } from "./project/store";
import { type Job, type Studio, startSketch } from "./studio";

/** What a session is told when the reader said no: it must not try another way. */
export const CANCELLED = "Not done: you cancelled.";

/** `<scratchpad>/music-studio/<name>`, else `<extension folder>/scratch/<name>` when prifly cannot say. */
function scratchFolder(studio: Studio, ctx: ExtensionToolContext, name: string): string {
  try {
    return join(ctx.scratchpad, "music-studio", name);
  } catch {
    return join(studio.api().folder, "scratch", name);
  }
}

async function sketchPaths(studio: Studio, entry: IndexEntry): Promise<string[]> {
  const store = studio.store();
  return (await store.sketches(entry)).map((each) => join(store.pathOf(entry), each.file));
}

/** The first line of a sketch run's answer. */
function headline(job: Job): string {
  const of = `${job.done.length} of ${job.total} sketches`;
  if (job.status === "failed") {
    const hint = job.suggestion === null ? "" : ` Suggested prompt: ${job.suggestion}`;
    return `Stopped after ${of}: ${job.error ?? "failed"}.${hint}`;
  }
  return job.status === "cancelled"
    ? `Cancelled after ${of}.`
    : `Made ${job.done.length} sketches.`;
}

/** The lines naming the project and its files; with `copy`, the files are also copied to the scratchpad. */
async function files(studio: Studio, job: Job, ctx: ExtensionToolContext, copy: boolean) {
  const entry = job.project === null ? null : await studio.store().find(job.project);
  if (entry === null) return [];
  const paths = await sketchPaths(studio, entry);
  const lines = [
    `Project "${entry.title}" (${entry.id}) in ${studio.store().pathOf(entry)}`,
    ...paths.map((each) => `- ${each}`),
  ];
  if (copy && paths.length > 0) {
    const target = scratchFolder(studio, ctx, entry.dir);
    await mkdir(target, { recursive: true });
    for (const path of paths) await copyFile(path, join(target, basename(path)));
    lines.push(`Copied to ${target}`);
  }
  return lines;
}

export function sketchTool(studio: Studio): ExtensionTool {
  return {
    name: "music_sketch",
    description:
      "Makes three 30-second sketches of a song idea with ElevenLabs Music v2.5 or Lyria 3 Clip, saves them in the Music Studio library and returns their file paths. It costs money, so the reader confirms the cost on a card first; when they cancel, nothing is made and the tool says so. A run takes a minute or more.",
    inputSchema: {
      type: "object",
      properties: {
        brief: { type: "string", description: "What the music is: mood, instruments, use." },
        preset: {
          type: "string",
          enum: PRESETS.map((each) => each.id),
          description: "A style to start from.",
        },
        tempo: { type: "number", description: "BPM, 40 to 240." },
        key: { type: "string", description: 'For example "A minor".' },
        lengthSec: {
          type: "number",
          description: "Target length of the finished song in seconds; the sketches are 30 s.",
        },
        vocals: {
          type: "string",
          enum: [...VOCALS],
          description: "generated, mine (give lyrics) or instrumental.",
        },
        lyrics: { type: "string", description: "The lyrics to sing, when vocals is mine." },
        engine: {
          type: "string",
          enum: [...ENGINES],
          description: "elevenlabs (default) or lyria-clip.",
        },
        copyToScratchpad: {
          type: "boolean",
          description: "Also copy the MP3 files into this session's scratchpad.",
        },
      },
      required: ["brief"],
      additionalProperties: false,
    },
    call: async (args, ctx) => {
      const started = await startSketch(studio, { ...args, text: args["brief"] }, ctx.signal);
      if (!started.ok)
        return started.reason === "cancelled" ? CANCELLED : `Not done: ${started.message}`;
      const job = await started.finished;
      return [
        headline(job),
        ...(await files(studio, job, ctx, args["copyToScratchpad"] === true)),
      ].join("\n");
    },
  };
}

export function libraryTool(studio: Studio): ExtensionTool {
  return {
    name: "music_library",
    description:
      "Lists the projects in the Music Studio library, newest first, with the paths of their sketches. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words the title, engine or brief must contain." },
      },
      additionalProperties: false,
    },
    call: async (args) => {
      const query = typeof args["query"] === "string" ? args["query"] : "";
      const store = studio.store();
      const entries = await store.list(query);
      if (entries.length === 0)
        return query === "" ? "The library is empty." : `No project matches "${query}".`;
      const blocks: string[] = [];
      for (const entry of entries) {
        const paths = await sketchPaths(studio, entry);
        const chosen = entry.chosen === null ? "" : `, chosen ${entry.chosen}`;
        blocks.push(
          [
            `${entry.title} (${entry.id}): ${entry.engine}, ${formatLength(entry.lengthSec)}, created ${entry.created}${chosen}`,
            `  ${store.pathOf(entry)}`,
            ...paths.map((each) => `  - ${each}`),
          ].join("\n"),
        );
      }
      return blocks.join("\n");
    },
  };
}
