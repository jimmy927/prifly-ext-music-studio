/**
 * The session tools of Master, Prepare and Deliver. All three run on this
 * computer and cost nothing. `music_deliver` writes files, so when it writes
 * outside the project's folder the reader confirms on a card first. Results
 * are file paths and facts.
 */

import { isAbsolute, join } from "node:path";
import type { ExtensionTool } from "@prifly/extension-api";
import {
  FORMAT_IDS,
  FORMATS,
  isFormatId,
  isLossy,
  isTargetId,
  LOSSY_NOTE,
  TARGET_IDS,
  TARGETS,
} from "./audio/loudness";
import { isRecord } from "./engines/types";
import {
  DELIVER_ITEMS,
  type Delivered,
  type DeliverItem,
  deliver,
  deliverFolder,
  isDeliverItem,
  isInside,
} from "./export/run";
import { renderMaster } from "./master/render";
import { autoCues, setCue, setLoop, withBpm } from "./prep/edit";
import { isSlot, loopEnd } from "./prep/grid";
import { analyseProject, sectionStarts } from "./prep/run";
import { sourceToMaster } from "./project/audio-source";
import type { MasterRecord } from "./project/master";
import { keyInfo, type Prep, writePrep } from "./project/prep";
import type { IndexEntry } from "./project/store";
import { projectOf } from "./stage-tools";
import type { Studio } from "./studio";
import { CANCELLED, scratchFolder } from "./tools";

const db = (value: number): string => value.toFixed(1);
const lufs = (l: { integrated: number; truePeak: number; range: number }): string =>
  `${db(l.integrated)} LUFS, true peak ${db(l.truePeak)} dBTP, range ${db(l.range)} LU`;

export function masterTool(studio: Studio): ExtensionTool {
  return {
    name: "music_master",
    description:
      "Masters a project's newest mix (else its version, else its chosen sketch) to a loudness target with ffmpeg, locally: no cost and no confirm card. Targets: club (-9 LUFS), streaming (-14), game (-16), true peak -1 dBTP. Formats: wav (24-bit), mp3 (320 kbps), ogg. Earlier masters are kept. Returns the file path with the loudness before and after.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "The project id; default the newest." },
        target: { type: "string", enum: [...TARGET_IDS], description: "Default streaming." },
        format: { type: "string", enum: [...FORMAT_IDS], description: "Default wav." },
      },
      additionalProperties: false,
    },
    call: async (args, ctx) => {
      const entry = await projectOf(studio, args);
      if (typeof entry === "string") return `Not done: ${entry}`;
      const target = args["target"] ?? "streaming";
      const format = args["format"] ?? "wav";
      if (!isTargetId(target)) return `Not done: target is one of ${TARGET_IDS.join(", ")}.`;
      if (!isFormatId(format)) return `Not done: format is one of ${FORMAT_IDS.join(", ")}.`;
      const done = await renderMaster(studio, entry, { target, format }, ctx.signal);
      if (!done.ok)
        return done.reason === "cancelled"
          ? "Cancelled. Nothing was added."
          : `Not done: ${done.message}`;
      const source = await sourceToMaster(studio.store(), entry);
      const lossy = format === "wav" && source !== null && isLossy(source.file);
      return masteredText(entry.title, entry.id, done.record, done.path, lossy);
    },
  };
}

function masteredText(
  title: string,
  id: string,
  record: MasterRecord,
  path: string,
  lossy: boolean,
): string {
  const target = TARGETS[record.target];
  return [
    `Mastered "${title}" (${id}) to ${target.label}, ${target.lufs} LUFS, as ${FORMATS[record.format].label}.`,
    `From ${record.from}: ${lufs(record.input)}`,
    record.output === null ? "After: not measured." : `After: ${lufs(record.output)}`,
    record.type === "dynamic"
      ? "The target could not be reached by gain alone, so the dynamics were compressed a little."
      : "",
    lossy ? LOSSY_NOTE : "",
    `- ${path}`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export function prepareTool(studio: Studio): ExtensionTool {
  return {
    name: "music_prepare",
    description:
      "Analyses a project's track for DJing, locally: BPM, key with its Camelot code, the first beat of the beatgrid and energy 1 to 10, saved in the project's prep.json. Optionally types in a BPM when none was found, sets cues A to H (snapped to beats) or cues from the song's sections, sets a loop, and adds the track to a crate (made if it does not exist). Returns the facts and the prep.json path.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "The project id; default the newest." },
        bpm: { type: "number", description: "Use this tempo instead of the analysed one." },
        autoCues: { type: "boolean", description: "Cues A to H at the section starts." },
        cues: {
          type: "array",
          description: "Cues to set, each snapped to the nearest beat.",
          items: {
            type: "object",
            properties: {
              slot: { type: "string", enum: ["A", "B", "C", "D", "E", "F", "G", "H"] },
              sec: { type: "number" },
            },
            required: ["slot", "sec"],
          },
        },
        loop: {
          type: "object",
          description: "One loop, snapped to beats.",
          properties: { startSec: { type: "number" }, bars: { type: "number" } },
          required: ["startSec", "bars"],
        },
        crate: { type: "string", description: "A crate name; the track is added to it." },
      },
      additionalProperties: false,
    },
    call: async (args, ctx) => {
      const entry = await projectOf(studio, args);
      if (typeof entry === "string") return `Not done: ${entry}`;
      const dir = studio.store().pathOf(entry);
      const analysed = await analyseProject(
        studio,
        entry,
        ctx.signal ?? new AbortController().signal,
      );
      if (!analysed.ok)
        return analysed.reason === "cancelled"
          ? "Cancelled. Nothing was changed."
          : `Not done: ${analysed.message}`;
      const notes: string[] = [];
      let prep = analysed.prep;
      for (const edit of await prepareEdits(studio, entry, args)) {
        const next = edit(prep);
        if (typeof next === "string") notes.push(`Not applied: ${next}`);
        else prep = next;
      }
      await writePrep(dir, prep);
      const crated = await intoCrate(studio, entry, args["crate"]);
      if (crated !== null) notes.push(crated);
      return factsOf(entry.title, entry.id, prep, notes, join(dir, "prep.json"));
    },
  };
}

/** Adds the track to the crate a call names (made when it does not exist); the sentence to report, or null when none was named. */
async function intoCrate(studio: Studio, entry: IndexEntry, name: unknown): Promise<string | null> {
  if (typeof name !== "string" || name.trim() === "") return null;
  const crates = studio.crates();
  const crate = (await crates.lookup(name)) ?? (await crates.create(name));
  await crates.add(crate.id, entry.id);
  return `In crate "${crate.name}".`;
}

type PrepEditStep = (prep: Prep) => Prep | string;

/** The edits a call asks for, in the order tempo, cues from sections, single cues, loop. */
async function prepareEdits(
  studio: Studio,
  entry: IndexEntry,
  args: Record<string, unknown>,
): Promise<PrepEditStep[]> {
  const edits: PrepEditStep[] = [];
  if (num(args["bpm"]) !== null) edits.push((prep) => withBpm(prep, args["bpm"]));
  if (args["autoCues"] === true) {
    const starts = await sectionStarts(studio, entry);
    edits.push((prep) => autoCues(prep, starts));
  }
  const cues: unknown[] = Array.isArray(args["cues"]) ? args["cues"] : [];
  for (const cue of cues) {
    if (isRecord(cue) && isSlot(cue["slot"])) {
      const slot = cue["slot"];
      edits.push((prep) => setCue(prep, slot, cue["sec"]));
    }
  }
  const loop = args["loop"];
  if (isRecord(loop)) edits.push((prep) => setLoop(prep, loop["startSec"], loop["bars"]));
  return edits;
}

function factsOf(title: string, id: string, prep: Prep, notes: string[], path: string): string {
  const a = prep.analysis;
  const key = a.key === null ? null : keyInfo(a.key);
  return [
    `Prepared "${title}" (${id}) from ${prep.source.label}.`,
    prep.grid === null
      ? "No clear tempo was found (the beat did not stand out). Give `bpm` to type one in."
      : `BPM ${prep.grid.bpm}${prep.manualBpm ? " (typed in)" : ""}, first beat at ${prep.grid.firstBeatSec} s.`,
    key === null ? "Key: not found." : `Key ${key.name}, Camelot ${key.camelot}.`,
    `Energy ${a.energy} of 10${a.lufs === null ? "" : `, ${db(a.lufs)} LUFS`}, length ${a.durationSec} s.`,
    prep.cues.length === 0
      ? "No cues."
      : `Cues: ${prep.cues.map((cue) => `${cue.slot} ${cue.sec} s${cue.name === "" ? "" : ` (${cue.name})`}`).join(", ")}.`,
    prep.loop === null || prep.grid === null
      ? "No loop."
      : `Loop: ${prep.loop.startSec} s to ${loopEnd(prep.grid, prep.loop)} s, ${prep.loop.bars} bars.`,
    ...notes,
    `- ${path}`,
  ].join("\n");
}

/** Where `music_deliver` writes: the project's deliver folder, the session scratchpad, or a path. */
function destinationOf(
  studio: Studio,
  entryDir: string,
  ctx: Parameters<ExtensionTool["call"]>[1],
  wanted: unknown,
): string | null {
  if (wanted === undefined || wanted === "" || wanted === "project") return null;
  if (wanted === "scratchpad") return scratchFolder(studio, ctx, entryDir);
  return typeof wanted === "string" ? wanted : null;
}

/** The reader's say before files are written outside the project; null when they said yes, else what the session is told. */
async function askOutside(
  studio: Studio,
  title: string,
  items: DeliverItem[],
  folder: string,
): Promise<string | null> {
  const api = studio.api();
  if (api.confirm === undefined)
    return "Not done: this prifly cannot ask you first. Update prifly.";
  const ok = await api.confirm({
    title: "Write files outside the project",
    summary: `Write ${items.join(", ")} for "${title}" into ${folder}`,
    content: `Files with the same name in ${folder} are replaced.`,
    details: `music_deliver items=${items.join(",")} folder=${folder}`,
  });
  return ok ? null : CANCELLED;
}

export function deliverTool(studio: Studio): ExtensionTool {
  return {
    name: "music_deliver",
    description:
      "Writes files for a DJ or a DAW, locally and free: `stems` (WAVs named like '122bpm 8A Vocals.wav'), `master` (the newest master with BPM/key tags where the format allows), `rekordbox` (a rekordbox XML for the track, or for a crate as a playlist) and `loops` (the prepared track with its cue and loop points as JSON). Default folder is <project>/deliver; `destination` can be 'scratchpad' or a full folder path. Writing outside the project folder asks the reader first. Returns the file paths.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "The project id; default the newest." },
        items: {
          type: "array",
          items: { type: "string", enum: [...DELIVER_ITEMS] },
          description: "What to write. Default all four.",
        },
        crate: {
          type: "string",
          description: "For rekordbox: a crate name or id, to write it as a playlist.",
        },
        destination: {
          type: "string",
          description: "'project' (default), 'scratchpad', or an absolute folder.",
        },
      },
      additionalProperties: false,
    },
    call: async (args, ctx) => {
      const entry = await projectOf(studio, args);
      if (typeof entry === "string") return `Not done: ${entry}`;
      const items: DeliverItem[] = Array.isArray(args["items"])
        ? args["items"].filter(isDeliverItem)
        : [...DELIVER_ITEMS];
      const dir = studio.store().pathOf(entry);
      const dest = destinationOf(studio, entry.dir, ctx, args["destination"]);
      if (dest !== null && !isAbsolute(dest))
        return "Not done: destination is project, scratchpad or a full folder path.";
      const folder = deliverFolder(studio, entry, dest);
      const answer = isInside(dir, folder)
        ? null
        : await askOutside(studio, entry.title, items, folder);
      if (answer !== null) return answer;
      const crate = typeof args["crate"] === "string" ? args["crate"] : null;
      const signal = ctx.signal ?? new AbortController().signal;
      const done = await deliver(studio, entry, { items, dest, crate }, signal);
      return deliveredText(entry, done);
    },
  };
}

function deliveredText(entry: IndexEntry, done: Delivered): string {
  if (!done.ok)
    return done.reason === "cancelled"
      ? "Cancelled. Files already written are kept."
      : `Not done: ${done.message}`;
  return [
    `Wrote ${done.files.length} files for "${entry.title}" (${entry.id}) in ${done.dir}`,
    ...done.files.map((file) => `- ${file}`),
    ...done.notes,
  ].join("\n");
}
