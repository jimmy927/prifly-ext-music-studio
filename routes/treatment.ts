/** The Treatment stage's routes: the concept, look, format, shot rule and budget, and the cast. */

import { readTreatment, type Treatment, writeTreatment } from "../project/video";
import { parseBudget } from "../video/budget";
import { addCastFile, readPictureFile } from "../video/cast";
import { IMAGE_USD, SHOOT_RESOLUTION, SHOT_BARS, VIDEO_USD_PER_SECOND } from "../video/constants";
import { removeCast, startCastDraw } from "../video/frames";
import { bodyOf, entryOf, type Handler, startedAnswer } from "./common";
import { hasGeminiKey, moneyOf, tempoOf } from "./video-common";
import type { TreatmentView } from "./video-views";

async function viewOf(studio: Parameters<Handler>[0], projectId: unknown): Promise<TreatmentView> {
  const entry = await entryOf(studio, projectId);
  const dir = studio.store().pathOf(entry);
  const treatment = await readTreatment(dir);
  return {
    geminiKey: await hasGeminiKey(studio),
    tempo: await tempoOf(dir),
    treatment: {
      concept: treatment.concept,
      look: treatment.look,
      vertical: treatment.vertical,
      shotBars: treatment.shotBars,
      cast: treatment.cast.map((each) => ({
        id: each.id,
        name: each.name,
        prompt: each.prompt,
        source: each.source,
      })),
      references: treatment.references.map((each) => ({
        id: each.id,
        name: each.name,
        note: each.note,
      })),
    },
    money: await moneyOf(studio, dir, treatment),
    prices: {
      imageUsd: IMAGE_USD,
      videoPerSecondUsd: VIDEO_USD_PER_SECOND[SHOOT_RESOLUTION],
      resolution: SHOOT_RESOLUTION,
    },
  };
}

const view: Handler = async (studio, request) => await viewOf(studio, request.query["project"]);

const cleanText = (value: unknown, max: number, fallback: string): string =>
  typeof value === "string" ? value.trim().slice(0, max) : fallback;

/** The treatment with the fields of `body` applied. */
export function applyTreatment(now: Treatment, body: Record<string, unknown>): Treatment {
  const bars = SHOT_BARS.find((each) => each === body["shotBars"]);
  const budget = body["budgetUsd"];
  return {
    ...now,
    concept: cleanText(body["concept"], 4000, now.concept),
    look: cleanText(body["look"], 1000, now.look),
    vertical: typeof body["vertical"] === "boolean" ? body["vertical"] : now.vertical,
    shotBars: bars ?? now.shotBars,
    budgetUsd:
      budget === null ? null : typeof budget === "number" ? parseBudget(budget) : now.budgetUsd,
  };
}

const save: Handler = async (studio, request) => {
  const body = bodyOf(request);
  const entry = await entryOf(studio, body["project"]);
  const dir = studio.store().pathOf(entry);
  await writeTreatment(dir, applyTreatment(await readTreatment(dir), body));
  return await viewOf(studio, entry.id);
};

const add: Handler = async (studio, request) => {
  const body = bodyOf(request);
  const entry = await entryOf(studio, body["project"]);
  const dir = studio.store().pathOf(entry);
  const name = typeof body["name"] === "string" ? body["name"] : "";
  let bytes: Uint8Array | string;
  if (typeof body["base64"] === "string")
    bytes = new Uint8Array(Buffer.from(body["base64"], "base64"));
  else if (typeof body["path"] === "string") bytes = await readPictureFile(body["path"]);
  else bytes = "Drop a picture file, or give its path.";
  if (typeof bytes === "string") return { ok: false as const, message: bytes };
  const added = await addCastFile(dir, name, bytes);
  return added.ok
    ? { ok: true as const, view: await viewOf(studio, entry.id) }
    : { ok: false as const, message: added.message };
};

const remove: Handler = async (studio, request) => {
  const body = bodyOf(request);
  const entry = await entryOf(studio, body["project"]);
  await removeCast(studio.store().pathOf(entry), body["id"]);
  return await viewOf(studio, entry.id);
};

const draw: Handler = async (studio, request) => {
  const body = bodyOf(request);
  const entry = await entryOf(studio, body["project"]);
  const input = {
    name: typeof body["name"] === "string" ? body["name"] : "",
    prompt: typeof body["prompt"] === "string" ? body["prompt"] : "",
  };
  return startedAnswer(await startCastDraw(studio, entry, input));
};

export const treatmentRoutes: Record<string, Handler> = {
  treatment: view,
  "treatment-save": save,
  "cast-add": add,
  "cast-remove": remove,
  "cast-draw": draw,
};
