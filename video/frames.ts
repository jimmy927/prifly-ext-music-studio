/**
 * The Treatment and Storyboard stages' paid pictures: a cast member drawn
 * from a prompt, and a still frame per shot (the cast as reference images).
 * One confirm card covers a whole batch, with the dollar estimate and what
 * the budget has left; a frame the model refuses is recorded on its shot and
 * the batch goes on, a failure that would repeat (key, billing, credits)
 * stops it.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { drawImage, type Picture } from "../engines/gemini-video";
import { EngineError } from "../engines/types";
import { launch } from "../jobs";
import type { IndexEntry } from "../project/store";
import {
  addSpend,
  budgetOf,
  type CastMember,
  isCastId,
  readLedger,
  readPicture,
  readShots,
  readTreatment,
  removeFile,
  savePicture,
  type Treatment,
  writeShots,
  writeTreatment,
} from "../project/video";
import { fail, type Started, type Studio } from "../studio";
import { affordable, framesUsd, remainingUsd, spentUsd } from "./budget";
import { ESTIMATE_NOTE, IMAGE_MODEL, IMAGE_USD, MAX_CAST, money } from "./constants";
import { castPrompt, framePrompt } from "./prompts";
import type { Shot, ShotList } from "./shotlist";

const picks = (list: ShotList, ids: string[]): Shot[] =>
  ids.flatMap((id) => list.shots.filter((each) => each.id === id));

/** Failures that would happen again on the next picture: stop the batch. */
export const stopsBatch = (caught: unknown): boolean =>
  caught instanceof EngineError &&
  (caught.kind === "auth" || caught.kind === "billing" || caught.kind === "credits");

export async function castPictures(dir: string, cast: CastMember[]): Promise<Picture[]> {
  const out: Picture[] = [];
  for (const each of cast) {
    try {
      await stat(join(dir, each.file));
      out.push(await readPicture(dir, each.file));
    } catch {
      // A picture that was deleted by hand is left out of the references.
    }
  }
  return out;
}

const budgetLine = (budget: number, spent: number): string =>
  `${money(spent)} spent of the ${money(budget)} budget (${ESTIMATE_NOTE})`;

/** Refuses with the numbers when `usd` more would pass the budget. */
function overBudget(budget: number, spent: number, usd: number, what: string): Started | null {
  if (affordable(budget, spent, usd)) return null;
  return fail(
    "invalid",
    `Over budget: ${what} cost about ${money(usd)}, and ${money(Math.max(0, budget - spent))} is left of the ${money(budget)} budget. Raise the budget on the Treatment stage, or draw fewer.`,
  );
}

/** Draws a new cast member from a prompt (paid), adding it to the treatment. */
export async function startCastDraw(
  studio: Studio,
  entry: IndexEntry,
  input: { name: string; prompt: string },
  linked?: AbortSignal,
): Promise<Started> {
  const dir = studio.store().pathOf(entry);
  const treatment = await readTreatment(dir);
  if (input.prompt.trim() === "") return fail("invalid", "Describe the cast member first.");
  if (treatment.cast.length >= MAX_CAST)
    return fail("invalid", `The cast holds at most ${MAX_CAST} pictures. Remove one first.`);
  const budget = budgetOf(treatment, studio.api().settings?.["videoBudgetUsd"]);
  const spent = spentUsd(await readLedger(dir));
  const refused = overBudget(budget, spent, IMAGE_USD, "a cast picture");
  if (refused !== null) return refused;
  const id = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  const prompt = castPrompt(treatment, input.prompt.trim());
  return await launch(
    studio,
    entry,
    {
      work: "cast",
      provider: "gemini",
      label: "Drawing a cast picture",
      total: 1,
      confirm: {
        title: "Draw a cast picture",
        summary: `Draw one reference picture with Gemini 3.1 Flash Image: about ${money(IMAGE_USD)}. ${budgetLine(budget, spent)}`,
        content: input.prompt.trim(),
        details: `POST /v1beta/interactions, model ${IMAGE_MODEL}, 1K, 1 call`,
      },
      run: async ({ key, signal, job }) => {
        const picture = await drawImage(
          studio.deps.fetch,
          key,
          { prompt, references: [], aspect: "1:1" },
          signal,
        );
        const file = await savePicture(dir, "cast", id, picture);
        const now = await readTreatment(dir);
        const member: CastMember = {
          id,
          name: input.name.trim().slice(0, 60),
          prompt: input.prompt.trim(),
          file,
          source: "generated",
        };
        await writeTreatment(dir, { ...now, cast: [...now.cast, member].slice(0, MAX_CAST) });
        await addSpend(dir, "cast", id, IMAGE_USD);
        job.done.push(id);
        return id;
      },
    },
    linked,
  );
}

/** Takes a cast member out of the treatment and deletes its picture. */
export async function removeCast(dir: string, id: unknown): Promise<Treatment> {
  const treatment = await readTreatment(dir);
  const gone = isCastId(id) ? treatment.cast.find((each) => each.id === id) : undefined;
  if (gone === undefined) throw new Error("There is no such cast member.");
  await removeFile(dir, gone.file);
  const next = { ...treatment, cast: treatment.cast.filter((each) => each.id !== id) };
  await writeTreatment(dir, next);
  return next;
}

/** What is wrong with drawing these shots, or null. */
function problemWith(list: ShotList | null, shots: Shot[]): string | null {
  if (list === null) return "There is no shot list yet. Draft one first.";
  if (shots.length === 0) return "There is nothing to draw: every shot already has a frame.";
  const blank = shots.find((each) => each.text.trim() === "");
  if (blank !== undefined) {
    const at = list.shots.findIndex((each) => each.id === blank.id) + 1;
    return `Shot ${at} has no description. Write what it shows first.`;
  }
  return null;
}

/**
 * Draws a still frame for each shot in `ids` (all that have none, when `ids`
 * is null): one batch, one confirm card with the dollar estimate. A redrawn
 * frame replaces the old one and needs approving again.
 */
export async function startFrames(
  studio: Studio,
  entry: IndexEntry,
  ids: string[] | null,
  linked?: AbortSignal,
): Promise<Started> {
  const dir = studio.store().pathOf(entry);
  const list = await readShots(dir);
  const shots =
    list === null
      ? []
      : ids === null
        ? list.shots.filter((each) => each.frame === null)
        : picks(list, ids);
  const problem = problemWith(list, shots);
  if (problem !== null) return fail("invalid", problem);
  const treatment = await readTreatment(dir);
  const budget = budgetOf(treatment, studio.api().settings?.["videoBudgetUsd"]);
  const spent = spentUsd(await readLedger(dir));
  const usd = framesUsd(shots.length);
  const refused = overBudget(budget, spent, usd, `${shots.length} frames`);
  if (refused !== null) return refused;
  const refs = await castPictures(dir, treatment.cast);
  const word = shots.length === 1 ? "frame" : "frames";
  return await launch(
    studio,
    entry,
    {
      work: "frames",
      provider: "gemini",
      label: `Drawing ${shots.length} ${word}`,
      total: shots.length,
      confirm: {
        title: `Draw ${shots.length} still ${word}`,
        summary: `Draw ${shots.length} still ${word} with Gemini 3.1 Flash Image: about ${money(usd)}${refs.length > 0 ? `, with ${refs.length} cast picture${refs.length === 1 ? "" : "s"} as references` : ""}. ${budgetLine(budget, spent)} Left after: ${money(remainingUsd(budget, spent + usd))}.`,
        content: shots.map((each) => `${each.section}: ${each.text}`).join("\n"),
        details: `POST /v1beta/interactions, model ${IMAGE_MODEL}, 1K, 16:9, ${shots.length} call${shots.length === 1 ? "" : "s"}, ${money(IMAGE_USD)} each`,
      },
      run: async ({ key, signal, job }) =>
        await drawAll(studio, { dir, key, signal, shots, treatment, refs, job }),
    },
    linked,
  );
}

type Batch = {
  dir: string;
  key: string;
  signal: AbortSignal;
  shots: Shot[];
  treatment: Treatment;
  refs: Picture[];
  job: { done: string[] };
};

/** Records on a shot (re-read first, so the reader's edits while it ran are kept) what happened to its frame. */
async function recordFrame(dir: string, id: string, change: Partial<Shot>): Promise<void> {
  const list = await readShots(dir);
  if (list === null) return;
  await writeShots(dir, {
    ...list,
    shots: list.shots.map((each) => (each.id === id ? { ...each, ...change } : each)),
  });
}

async function drawAll(studio: Studio, batch: Batch): Promise<string> {
  let drawn = 0;
  for (const shot of batch.shots) {
    if (batch.signal.aborted) break;
    try {
      const picture = await drawImage(
        studio.deps.fetch,
        batch.key,
        { prompt: framePrompt(batch.treatment, shot), references: batch.refs, aspect: "16:9" },
        batch.signal,
      );
      const file = await savePicture(
        batch.dir,
        "frames",
        `${shot.id}-${Date.now().toString(36)}`,
        picture,
      );
      await recordFrame(batch.dir, shot.id, { frame: file, frameError: null, approved: false });
      await removeFile(batch.dir, shot.frame);
      await addSpend(batch.dir, "frame", shot.id, IMAGE_USD);
      drawn += 1;
      batch.job.done.push(shot.id);
    } catch (caught) {
      if (batch.signal.aborted) break;
      const reason = caught instanceof Error ? caught.message : String(caught);
      await recordFrame(batch.dir, shot.id, { frameError: reason });
      if (stopsBatch(caught)) throw caught;
    }
  }
  return `${drawn} of ${batch.shots.length} frames`;
}
