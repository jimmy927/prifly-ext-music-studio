/**
 * The Shoot stage's paid run: each approved shot becomes a clip from its
 * still frame, the cast and its description with Gemini Omni Flash. One
 * confirm card covers the batch; shooting stops where the budget does and
 * says so. A shot is at most 15 seconds (the longest clip Omni makes; the
 * shot list never makes a longer one), so every shot is one call. Each take is
 * kept in `video/takes/`; a take that failed keeps its reason and is shot
 * again by asking for the shot again. Google's interaction id is written down
 * as soon as the call is accepted, so a clip whose call was still running when
 * the extension stopped can be fetched afterwards (`startRecover`).
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateVideo, type Picture, resumeVideo } from "../engines/gemini-video";
import { EngineError } from "../engines/types";
import { launch } from "../jobs";
import type { IndexEntry } from "../project/store";
import {
  addSpend,
  budgetOf,
  readLedger,
  readPicture,
  readShots,
  readTreatment,
  type Treatment,
  writeShots,
} from "../project/video";
import {
  nextTakeN,
  readTakes,
  type TakeRecord,
  takeFile,
  takesOf,
  writeTake,
} from "../project/video-media";
import { fail, type Started, type Studio } from "../studio";
import { affordable, fitBudget, remainingUsd, spentUsd, takeUsd } from "./budget";
import {
  ESTIMATE_NOTE,
  MAX_REFERENCES,
  MAX_TAKES_PER_SHOT,
  money,
  SHOOT_RESOLUTION,
  VIDEO_MODEL,
} from "./constants";
import { castPictures, stopsBatch } from "./frames";
import { clipPrompt } from "./prompts";
import { clipSeconds, type Shot } from "./shotlist";

const MINUTES = 60_000;
/** Google makes a 15 second clip in a minute or a few; this is the point to stop waiting. */
const TAKE_TIMEOUT_MS = 12 * MINUTES;

export type Item = { shot: Shot; seconds: number; usd: number };

/** What a finished shoot job's `result` holds, as JSON. */
export type ShootOutcome = {
  made: number;
  failed: number;
  /** Takes not shot because the budget was reached. */
  left: number;
  stoppedBy: "budget" | null;
  spentUsd: number;
  budgetUsd: number;
};

export type ShootRequest = { shots: string[] | null; takes: number };

/** A request from untrusted data. */
export function parseShootRequest(raw: unknown): ShootRequest {
  const body = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const ids = Array.isArray(body["shots"])
    ? body["shots"].filter((each): each is string => typeof each === "string")
    : null;
  const takes = typeof body["takes"] === "number" ? Math.round(body["takes"]) : 1;
  return { shots: ids, takes: Math.min(MAX_TAKES_PER_SHOT, Math.max(1, takes)) };
}

/** The shots to shoot: those asked for (all approved with a frame), else the approved ones that have no clip yet. */
function wanted(shots: Shot[], ids: string[] | null, takes: TakeRecord[]): Shot[] | string {
  if (ids !== null) {
    const out: Shot[] = [];
    for (const id of ids) {
      const shot = shots.find((each) => each.id === id);
      if (shot === undefined) return "There is no such shot.";
      if (!shot.approved || shot.frame === null)
        return `Shot ${shots.indexOf(shot) + 1} is not approved. Approve its frame on the Storyboard stage first.`;
      out.push(shot);
    }
    return out;
  }
  const open = shots.filter(
    (each) =>
      each.approved &&
      each.frame !== null &&
      !takesOf(takes, each.id).some((take) => take.status === "done"),
  );
  return open.length === 0
    ? "Nothing to shoot: no approved shot is waiting. Approve frames on the Storyboard stage."
    : open;
}

export const itemsFor = (shots: Shot[], takes: number): Item[] =>
  shots.flatMap((shot) => {
    const seconds = clipSeconds(shot);
    return Array.from({ length: takes }, () => ({ shot, seconds, usd: takeUsd(seconds) }));
  });

/** Records what happened to a shot's clip (re-reading the list first, so edits made meanwhile are kept). */
async function recordShot(
  dir: string,
  id: string,
  change: (shot: Shot) => Partial<Shot>,
): Promise<void> {
  const list = await readShots(dir);
  if (list === null) return;
  await writeShots(dir, {
    ...list,
    shots: list.shots.map((each) => (each.id === id ? { ...each, ...change(each) } : each)),
  });
}

function cardFor(plan: {
  fits: Item[];
  left: Item[];
  usd: number;
  budget: number;
  spent: number;
  castCount: number;
}) {
  const { fits, left, usd, budget, spent } = plan;
  const seconds = fits.reduce((sum, each) => sum + each.seconds, 0);
  const stop =
    left.length === 0
      ? ""
      : ` The budget has room for ${fits.length} of ${fits.length + left.length} takes; shooting stops there.`;
  return {
    title: `Shoot ${fits.length} take${fits.length === 1 ? "" : "s"}`,
    summary: `Shoot ${fits.length} take${fits.length === 1 ? "" : "s"} (${seconds} seconds of video) with Gemini Omni Flash: about ${money(usd)}, ${money(spent)} already spent of the ${money(budget)} budget, ${money(remainingUsd(budget, spent + usd))} left after.${stop} ${ESTIMATE_NOTE}`,
    content: fits
      .map((each) => `${each.shot.section} (${each.seconds} s): ${each.shot.text}`)
      .join("\n"),
    details: `POST /v1beta/interactions, model ${VIDEO_MODEL}, ${SHOOT_RESOLUTION}, 16:9, background, ${fits.length} call${fits.length === 1 ? "" : "s"}; the frame and ${plan.castCount} cast picture${plan.castCount === 1 ? "" : "s"} as references; polled until done`,
  };
}

/** Shoots the approved shots; paid, one confirm card. */
export async function startShoot(
  studio: Studio,
  entry: IndexEntry,
  request: ShootRequest,
  linked?: AbortSignal,
): Promise<Started> {
  const dir = studio.store().pathOf(entry);
  const list = await readShots(dir);
  if (list === null)
    return fail("invalid", "There is no shot list yet. Draft one on the Storyboard stage.");
  const chosen = wanted(list.shots, request.shots, await readTakes(dir));
  if (typeof chosen === "string") return fail("invalid", chosen);
  const treatment = await readTreatment(dir);
  const budget = budgetOf(treatment, studio.api().settings?.["videoBudgetUsd"]);
  const spent = spentUsd(await readLedger(dir));
  const plan = fitBudget(itemsFor(chosen, request.takes), (each) => each.usd, budget, spent);
  if (plan.fits.length === 0)
    return fail(
      "invalid",
      `Over budget: the first take costs about ${money(plan.left[0]?.usd ?? 0)} and ${money(remainingUsd(budget, spent))} is left of the ${money(budget)} budget. Raise the budget on the Treatment stage.`,
    );
  const cast = await castPictures(dir, treatment.cast);
  return await launch(
    studio,
    entry,
    {
      work: "shoot",
      provider: "gemini",
      label: `Shooting ${plan.fits.length} take${plan.fits.length === 1 ? "" : "s"}`,
      total: plan.fits.length,
      confirm: cardFor({
        ...plan,
        budget,
        spent,
        castCount: Math.min(cast.length, MAX_REFERENCES - 1),
      }),
      run: async ({ key, signal, job }) =>
        await shootAll(studio, {
          dir,
          key,
          signal,
          job,
          items: plan.fits,
          treatment,
          budget,
          left: plan.left.length,
        }),
    },
    linked,
  );
}

type Run = {
  dir: string;
  key: string;
  signal: AbortSignal;
  job: { label: string; done: string[] };
  items: Item[];
  treatment: Treatment;
  budget: number;
  /** Takes the card already left out for the budget. */
  left: number;
};

/** The frame, then up to five cast pictures: Omni takes six reference images in all. */
async function referencesFor(run: Run, shot: Shot): Promise<Picture[]> {
  const cast = await castPictures(run.dir, run.treatment.cast);
  const frame = shot.frame === null ? [] : [await readPicture(run.dir, shot.frame)];
  return [...frame, ...cast].slice(0, MAX_REFERENCES);
}

async function shootAll(studio: Studio, run: Run): Promise<string> {
  const outcome: ShootOutcome = {
    made: 0,
    failed: 0,
    left: run.left,
    stoppedBy: null,
    spentUsd: 0,
    budgetUsd: run.budget,
  };
  for (const [at, item] of run.items.entries()) {
    if (run.signal.aborted) break;
    const spent = spentUsd(await readLedger(run.dir));
    if (!affordable(run.budget, spent, item.usd)) {
      outcome.stoppedBy = "budget";
      outcome.left += run.items.length - at;
      break;
    }
    const ok = await shootOne(studio, run, item, `${at + 1} of ${run.items.length}`);
    if (ok) outcome.made += 1;
    else outcome.failed += 1;
  }
  outcome.spentUsd = spentUsd(await readLedger(run.dir));
  if (outcome.left > 0) outcome.stoppedBy = "budget";
  return JSON.stringify(outcome);
}

/** One take. True when the clip was saved; a failure that would repeat is thrown after it is recorded. */
async function shootOne(studio: Studio, run: Run, item: Item, position: string): Promise<boolean> {
  const takes = await readTakes(run.dir);
  const n = nextTakeN(takes, item.shot.id);
  const record: TakeRecord = {
    id: `${item.shot.id}-${n}`,
    shot: item.shot.id,
    n,
    status: "pending",
    file: null,
    reason: null,
    failure: null,
    seconds: item.seconds,
    usd: item.usd,
    interaction: null,
    created: new Date().toISOString(),
  };
  await writeTake(run.dir, record);
  run.job.label = `Shooting take ${position}: ${item.shot.section}`;
  let noted: Promise<void> = Promise.resolve();
  try {
    const references = await referencesFor(run, item.shot);
    const bytes = await generateVideo(
      studio.deps.fetch,
      run.key,
      {
        prompt: clipPrompt(run.treatment, item.shot, Math.max(0, references.length - 1)),
        references,
        aspect: "16:9",
        seconds: item.seconds,
        resolution: SHOOT_RESOLUTION,
      },
      {
        signal: run.signal,
        intervalMs: studio.pollMs(),
        timeoutMs: TAKE_TIMEOUT_MS,
        onStarted: (id) => {
          record.interaction = id;
          noted = writeTake(run.dir, record);
        },
      },
    );
    await noted;
    await keepClip(run.dir, record, bytes);
    run.job.done.push(record.id);
    return true;
  } catch (caught) {
    await noted;
    await failTake(run.dir, record, caught, run.signal.aborted);
    if (run.signal.aborted) return false;
    if (stopsBatch(caught) || !(caught instanceof EngineError)) throw caught;
    return false;
  }
}

/** Saves a clip that came back, counts its price, and makes it the shot's clip if the shot has none. */
async function keepClip(dir: string, record: TakeRecord, bytes: Uint8Array): Promise<void> {
  const file = takeFile(record.shot, record.n);
  await writeFile(join(dir, file), bytes);
  await writeTake(dir, { ...record, status: "done", file, reason: null, failure: null });
  await addSpend(dir, "take", record.id, record.usd);
  await recordShot(dir, record.shot, (shot) => (shot.take === null ? { take: record.id } : {}));
}

async function failTake(
  dir: string,
  record: TakeRecord,
  caught: unknown,
  cancelled: boolean,
): Promise<void> {
  const reason = cancelled
    ? "Cancelled before the clip came back."
    : caught instanceof Error
      ? caught.message
      : String(caught);
  const failure = caught instanceof EngineError ? caught.kind : null;
  await writeTake(dir, { ...record, status: "failed", reason, failure, usd: 0 });
}

/**
 * Fetches the clips of calls Google accepted but whose answer the extension
 * did not wait for (it stopped, or the panel's host restarted). Nothing new
 * is bought, so there is no card; the price is counted now.
 */
export async function startRecover(
  studio: Studio,
  entry: IndexEntry,
  linked?: AbortSignal,
): Promise<Started> {
  const dir = studio.store().pathOf(entry);
  const waiting = (await readTakes(dir)).filter((each) => each.status === "pending");
  if (waiting.length === 0) return fail("invalid", "No take is waiting to be fetched.");
  return await launch(
    studio,
    entry,
    {
      work: "shoot",
      provider: "gemini",
      label: `Fetching ${waiting.length} clip${waiting.length === 1 ? "" : "s"} from Google`,
      total: waiting.length,
      confirm: null,
      run: async ({ key, signal, job }) => {
        let made = 0;
        for (const take of waiting) {
          if (signal.aborted) break;
          if (await recoverOne(studio, { dir, key, signal }, take)) {
            made += 1;
            job.done.push(take.id);
          }
        }
        return `${made} of ${waiting.length} clips`;
      },
    },
    linked,
  );
}

async function recoverOne(
  studio: Studio,
  run: { dir: string; key: string; signal: AbortSignal },
  take: TakeRecord,
): Promise<boolean> {
  if (take.interaction === null) {
    await writeTake(run.dir, {
      ...take,
      status: "failed",
      reason:
        "The extension stopped before Google accepted this call, so nothing was made or billed.",
      usd: 0,
    });
    return false;
  }
  try {
    const bytes = await resumeVideo(studio.deps.fetch, run.key, take.interaction, {
      signal: run.signal,
      intervalMs: studio.pollMs(),
      timeoutMs: 5 * MINUTES,
    });
    await keepClip(run.dir, take, bytes);
    return true;
  } catch (caught) {
    if (run.signal.aborted) return false;
    await failTake(run.dir, take, caught, false);
    if (stopsBatch(caught)) throw caught;
    return false;
  }
}
