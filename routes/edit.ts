/** The Edit stage's routes: the timeline in bars, the per-shot choices, and the preview and final renders as local jobs. */

import { probeFfmpeg } from "../audio/ffmpeg";
import { isRecord } from "../engines/types";
import { beatSeconds } from "../prep/grid";
import {
  type EditSettings,
  latestRender,
  parseShotEdit,
  type RenderRecord,
  readEdit,
  readRenders,
  writeEdit,
} from "../project/video-media";
import { probeCaps } from "../video/caps";
import { type EditState, loadEdit, signatureOf } from "../video/edit-model";
import { estimateSeconds } from "../video/render";
import { startRender } from "../video/render-job";
import { barSeconds, isShotId, lengthOf } from "../video/shotlist";
import { bodyOf, entryOf, type Handler, startedAnswer } from "./common";
import { tempoOf } from "./video-common";
import type { EditView, RenderView, SlotView } from "./video-views";

const renderView = (record: RenderRecord | null, state: EditState): RenderView | null =>
  record === null
    ? null
    : {
        n: record.n,
        kind: record.kind,
        seconds: record.seconds,
        captions: record.captions,
        gaps: record.gaps,
        stale: record.signature !== signatureOf(state, state.settings.captions),
        created: record.created,
      };

function slotViews(state: EditState): SlotView[] {
  const list = state.list;
  if (list === null) return [];
  const grid = { bpm: list.bpm, firstBeatSec: list.firstBeatSec };
  const bar = barSeconds(grid);
  return state.slots.map((slot, at) => {
    const shot = list.shots[at];
    return {
      shot: slot.shot,
      number: at + 1,
      section: shot?.section ?? "",
      startSec: slot.startSec,
      endSec: slot.endSec,
      startBar: Math.round(((slot.startSec - grid.firstBeatSec) / bar + 1) * 10) / 10,
      bars: Math.round((lengthOf(slot) / bar) * 10) / 10,
      hasClip: slot.clip !== null,
      transition: slot.transition,
      speed: slot.speed,
      frame: shot?.frame ?? null,
    };
  });
}

/** Why there are no captions, or null when there are. */
function captionReason(state: EditState): string | null {
  return state.words.length > 0
    ? null
    : "This song has no sung words (an instrumental has none), so there is nothing to caption.";
}

async function viewOf(studio: Parameters<Handler>[0], projectId: unknown): Promise<EditView> {
  const entry = await entryOf(studio, projectId);
  const state = await loadEdit(studio, entry);
  const probe = await probeFfmpeg(studio.ffmpeg());
  const caps = await probeCaps(studio.ffmpeg());
  const renders = await readRenders(state.dir);
  const list = state.list;
  const total = state.slots.at(-1)?.endSec ?? 0;
  const range = state.vertical;
  return {
    ffmpeg: probe.ok ? { ok: true, message: probe.output } : { ok: false, message: probe.message },
    tempo: await tempoOf(state.dir),
    slots: slotViews(state),
    totalSec: total,
    beatSec: list === null ? 0.5 : beatSeconds({ bpm: list.bpm, firstBeatSec: list.firstBeatSec }),
    gaps: state.gaps,
    warnings: state.warnings,
    audio:
      state.audio === null
        ? null
        : { label: state.audio.label, kind: state.audio.kind, id: state.audio.id },
    captions: {
      on: state.settings.captions,
      words: state.words.length,
      reason: captionReason(state),
      burnable: caps.ok && caps.ass,
    },
    join: caps.ok && caps.xfade ? "xfade" : "overlay",
    vertical:
      range === null || list === null
        ? null
        : {
            ...range,
            shots: list.shots.filter(
              (each) =>
                each.startSec >= range.startSec - 1e-3 && each.endSec <= range.endSec + 1e-3,
            ).length,
          },
    renders: {
      preview: renderView(latestRender(renders, "preview"), state),
      final: renderView(latestRender(renders, "final"), state),
      vertical: renderView(latestRender(renders, "vertical"), state),
    },
    estimate: {
      finalSec: estimateSeconds("final", total),
      verticalSec: estimateSeconds("vertical", range === null ? 30 : range.endSec - range.startSec),
    },
  };
}

const view: Handler = async (studio, request) => await viewOf(studio, request.query["project"]);

/** The edit with the fields of `body` applied: captions, per-shot choices, the vertical range. */
export function applyEdit(now: EditSettings, body: Record<string, unknown>): EditSettings {
  const shots = { ...now.shots };
  const given = body["shots"];
  if (isRecord(given))
    for (const [id, value] of Object.entries(given))
      if (isShotId(id))
        shots[id] = parseShotEdit({ ...shots[id], ...(isRecord(value) ? value : {}) });
  const range = body["vertical"];
  let vertical = now.vertical;
  if (range === null) vertical = null;
  else if (
    isRecord(range) &&
    typeof range["startSec"] === "number" &&
    typeof range["endSec"] === "number"
  )
    vertical = { startSec: range["startSec"], endSec: range["endSec"] };
  return {
    captions: typeof body["captions"] === "boolean" ? body["captions"] : now.captions,
    shots,
    vertical,
  };
}

const save: Handler = async (studio, request) => {
  const body = bodyOf(request);
  const entry = await entryOf(studio, body["project"]);
  const dir = studio.store().pathOf(entry);
  await writeEdit(dir, applyEdit(await readEdit(dir), body));
  return await viewOf(studio, entry.id);
};

const render =
  (kind: "preview" | "final" | "vertical"): Handler =>
  async (studio, request) => {
    const entry = await entryOf(studio, bodyOf(request)["project"]);
    return startedAnswer(await startRender(studio, entry, kind));
  };

export const editRoutes: Record<string, Handler> = {
  edit: view,
  "edit-save": save,
  "edit-preview": render("preview"),
  "edit-render": render("final"),
};
