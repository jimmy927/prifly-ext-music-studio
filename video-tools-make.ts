/**
 * The session tools of the Shoot, Edit and Render steps: `video_shoot` (paid:
 * the reader confirms the dollars on a card first; when they cancel, nothing
 * is made and the tool answers with the plain cancel text), `video_edit`
 * (local, free) and `video_render` (`mode: "local"` asks on a card because it
 * loads the machine; `mode: "plan"` writes a job folder with the exact ffmpeg
 * argv). Results are file paths.
 */

import { join } from "node:path";
import type { ExtensionTool } from "@prifly/extension-api";
import { isRecord } from "./engines/types";
import type { IndexEntry } from "./project/store";
import { readShots, writeShots } from "./project/video";
import {
  latestRender,
  readEdit,
  readRenders,
  readTakes,
  takesOf,
  writeEdit,
} from "./project/video-media";
import { applyEdit } from "./routes/edit";
import { projectOf } from "./stage-tools";
import type { Job, Studio } from "./studio";
import { loadEdit } from "./video/edit-model";
import { planRender } from "./video/render";
import { startRender } from "./video/render-job";
import { parseShootRequest, startShoot } from "./video/shoot";
import type { ShotList } from "./video/shotlist";
import {
  budgetLine,
  clock,
  NO_LIST,
  outcomeOf,
  PROJECT,
  shotId,
  shotIds,
} from "./video-tools-common";

type Tool = ExtensionTool;

export function shootTool(studio: Studio): Tool {
  return {
    name: "video_shoot",
    description:
      "Shoots clips with Gemini Omni Flash from each approved shot's frame, the cast and its description (3 to 15 seconds, several takes per shot kept in video/takes/). It costs money, so the reader confirms the dollars on a card first; when they cancel, nothing is made and the tool says so. Shooting stops at the project's budget and says so. `shots` are numbers (from 1) or ids, default the approved shots with no clip; `takes` is 1 to 4 per shot; `choose` picks the take the edit cuts from, free. Returns the take files and what was spent.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT,
        shots: { type: "array", items: { type: ["number", "string"] } },
        takes: { type: "number", description: "Takes per shot, 1 to 4. Default 1." },
        choose: {
          type: "array",
          items: {
            type: "object",
            properties: { shot: { type: ["number", "string"] }, take: { type: "string" } },
            required: ["shot", "take"],
          },
        },
      },
      additionalProperties: false,
    },
    call: async (args, ctx) => {
      const entry = await projectOf(studio, args);
      if (typeof entry === "string") return `Not done: ${entry}`;
      const dir = studio.store().pathOf(entry);
      const list = await readShots(dir);
      if (list === null) return NO_LIST;
      const chosen = Array.isArray(args["choose"])
        ? await chooseTakes(dir, list, args["choose"])
        : null;
      if (chosen !== null) return chosen;
      if (Array.isArray(args["choose"]) && args["shots"] === undefined)
        return await describeTakes(studio, entry);
      return await shootStep(studio, entry, list, args, ctx.signal);
    },
  };
}

async function shootStep(
  studio: Studio,
  entry: IndexEntry,
  list: ShotList,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const ids = args["shots"] === undefined ? null : shotIds(list, args["shots"]);
  if (typeof ids === "string") return `Not done: ${ids}`;
  const request = parseShootRequest({ shots: ids, takes: args["takes"] });
  const done = await outcomeOf(await startShoot(studio, entry, request, signal));
  if ("text" in done) return done.text;
  return [shootHeadline(done.job), await describeTakes(studio, entry)].join("\n");
}

function shootHeadline(job: Job): string {
  try {
    const out: unknown = JSON.parse(job.result ?? "");
    if (!isRecord(out)) return "Shot.";
    const stop =
      out["stoppedBy"] === "budget"
        ? ` Stopped at the budget: ${String(out["left"])} take(s) were not shot.`
        : "";
    return `Made ${String(out["made"])} take(s), ${String(out["failed"])} failed.${stop}`;
  } catch {
    return "Shot.";
  }
}

async function chooseTakes(
  dir: string,
  list: ShotList,
  choices: unknown[],
): Promise<string | null> {
  const takes = await readTakes(dir);
  let next = list;
  for (const choice of choices) {
    const id = isRecord(choice) ? shotId(list, choice["shot"]) : null;
    const take = takes.find(
      (each) => isRecord(choice) && each.id === choice["take"] && each.shot === id,
    );
    if (id === null || take === undefined || take.status !== "done")
      return `Not done: ${isRecord(choice) ? String(choice["take"]) : "?"} is not a finished take of that shot.`;
    next = {
      ...next,
      shots: next.shots.map((each) => (each.id === id ? { ...each, take: take.id } : each)),
    };
  }
  await writeShots(dir, next);
  return null;
}

async function describeTakes(studio: Studio, entry: IndexEntry): Promise<string> {
  const dir = studio.store().pathOf(entry);
  const list = await readShots(dir);
  const takes = await readTakes(dir);
  const lines: string[] = [];
  for (const [at, shot] of (list?.shots ?? []).entries()) {
    for (const take of takesOf(takes, shot.id)) {
      const done = take.status === "done" && take.file !== null;
      const where = done ? join(dir, take.file ?? "") : `${take.status} - ${take.reason ?? ""}`;
      lines.push(`${at + 1}. take ${take.id}${shot.take === take.id ? " (chosen)" : ""}: ${where}`);
    }
  }
  return [...lines, await budgetLine(studio, dir)].join("\n");
}

export function editTool(studio: Studio): Tool {
  return {
    name: "video_edit",
    description:
      "Sets how the shots are cut together, locally (no cost, no card): per shot `transition` (cut, flash on the beat of the cut, crossfade of one beat) and `speed` (normal, or a ramp down to 50% at the end), karaoke `captions` on or off (from the song's word timestamps; an instrumental has none), and the vertical cut's `vertical` range. Cuts stay on beats and the soundtrack is the master (else the mix, else the version). A shot with no clip renders black and is reported. With `preview: true` it also renders the 540p preview. Returns the timeline, the warnings and the preview's file path.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT,
        captions: { type: "boolean" },
        shots: {
          type: "object",
          description:
            "Shot number or id to { transition: cut|flash|crossfade, speed: normal|ramp }.",
          additionalProperties: {
            type: "object",
            properties: {
              transition: { type: "string", enum: ["cut", "flash", "crossfade"] },
              speed: { type: "string", enum: ["normal", "ramp"] },
            },
          },
        },
        vertical: {
          type: ["object", "null"],
          description:
            "Start and end second of the vertical cut (snapped to shot boundaries); null for the chorus.",
          properties: { startSec: { type: "number" }, endSec: { type: "number" } },
        },
        preview: { type: "boolean", description: "Also render the 540p preview." },
      },
      additionalProperties: false,
    },
    call: async (args, ctx) => {
      const entry = await projectOf(studio, args);
      if (typeof entry === "string") return `Not done: ${entry}`;
      const dir = studio.store().pathOf(entry);
      const list = await readShots(dir);
      if (list === null) return NO_LIST;
      const byId = shotsById(list, args["shots"]);
      if (typeof byId === "string") return `Not done: ${byId}`;
      await writeEdit(dir, applyEdit(await readEdit(dir), { ...args, shots: byId }));
      const preview = args["preview"] === true ? await previewStep(studio, entry, ctx.signal) : "";
      return `${await describeEdit(studio, entry)}${preview}`;
    },
  };
}

/** The per-shot choices keyed by shot id; the message for a shot that is none. */
function shotsById(list: ShotList, given: unknown): Record<string, unknown> | string {
  const byId: Record<string, unknown> = {};
  for (const [ref, value] of Object.entries(isRecord(given) ? given : {})) {
    const id = shotId(list, ref);
    if (id === null) return `there is no shot ${ref}.`;
    byId[id] = value;
  }
  return byId;
}

async function previewStep(
  studio: Studio,
  entry: IndexEntry,
  signal: AbortSignal,
): Promise<string> {
  const done = await outcomeOf(await startRender(studio, entry, "preview", signal));
  if ("text" in done) return `\n${done.text}`;
  const dir = studio.store().pathOf(entry);
  const latest = latestRender(await readRenders(dir), "preview");
  return latest === null ? "" : `\nPreview: ${join(dir, latest.file)}`;
}

async function describeEdit(studio: Studio, entry: IndexEntry): Promise<string> {
  const state = await loadEdit(studio, entry);
  const lines = state.slots.map(
    (slot, at) =>
      `${at + 1}. ${clock(slot.startSec)}-${clock(slot.endSec)} ${slot.transition}, ${slot.speed === "ramp" ? "ramp to 50%" : "100%"}, ${slot.clip === null ? "NO CLIP (black)" : slot.clip}`,
  );
  let captions = "Captions off.";
  if (state.settings.captions)
    captions =
      state.words.length > 0
        ? `Captions on (${state.words.length} words).`
        : "Captions on, but this song has no sung words, so there are none.";
  return [
    `Edit of "${entry.title}" (${entry.id}); soundtrack ${state.audio === null ? "none" : state.audio.label}. ${captions}`,
    ...lines,
    ...state.warnings.map((each) => `Warning: ${each}`),
  ].join("\n");
}

export function renderTool(studio: Studio): Tool {
  return {
    name: "video_render",
    description:
      'Renders the edit with ffmpeg. `mode: "local"` renders on this computer after the reader confirms on a card that says how long it will take and that it will load the machine (when they cancel, nothing is made and the tool says so); `kind` is final (1080p, H.264, the master as sound; default), vertical (9:16, about 30 seconds of the chorus or the chosen range, captions on, centre crop) or preview (540p, no card). `mode: "plan"` renders nothing: it writes a job folder with the inputs and job.json, which holds the exact ffmpeg argv to run from that folder (for a rented box), and returns its path.',
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT,
        mode: { type: "string", enum: ["local", "plan"] },
        kind: { type: "string", enum: ["final", "vertical", "preview"] },
      },
      required: ["mode"],
      additionalProperties: false,
    },
    call: async (args, ctx) => {
      const entry = await projectOf(studio, args);
      if (typeof entry === "string") return `Not done: ${entry}`;
      const kind =
        args["kind"] === "vertical" || args["kind"] === "preview" ? args["kind"] : "final";
      if (args["mode"] === "plan") return await planStep(studio, entry, kind);
      if (args["mode"] !== "local") return 'Not done: mode is "local" or "plan".';
      const done = await outcomeOf(await startRender(studio, entry, kind, ctx.signal));
      if ("text" in done) return done.text;
      const dir = studio.store().pathOf(entry);
      const latest = latestRender(await readRenders(dir), kind);
      if (latest === null) return "Rendered.";
      const black = latest.gaps > 0 ? `, ${latest.gaps} black shot(s)` : "";
      return `Rendered ${kind} (${Math.round(latest.seconds)} s${black}).\n- ${join(dir, latest.file)}`;
    },
  };
}

async function planStep(
  studio: Studio,
  entry: IndexEntry,
  kind: "final" | "vertical" | "preview",
): Promise<string> {
  const planned = await planRender(studio, entry, kind);
  if (!planned.ok) return `Not done: ${planned.message}`;
  return `Job folder: ${planned.folder}\nRun the ffmpeg argv in job.json from that folder: ${join(planned.folder, "job.json")}`;
}
