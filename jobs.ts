/**
 * The paid runs after the sketches (an Arrange render, stem separation, a
 * sound effect) share one shape: check the key, ask the reader on a confirm
 * card, then do the work in the background as a job the panel polls and can
 * cancel. Nothing is spent before the reader confirms.
 */

import type { ExtensionApi } from "@prifly/extension-api";
import { askReader } from "./confirm";
import type { IndexEntry, Store } from "./project/store";
import {
  endFailed,
  fail,
  isLocalKind,
  type Job,
  type JobKind,
  SETTINGS_HINT,
  type Started,
  type Studio,
} from "./studio";

export type Confirm = Parameters<NonNullable<ExtensionApi["confirm"]>>[0];

export type Work = {
  work: Extract<JobKind, "arrange" | "stems" | "sfx" | "cast" | "frames" | "shoot">;
  /** Whose key pays: ElevenLabs (the default) or Gemini. */
  provider?: "gemini";
  label: string;
  total: number;
  /** The card the reader answers first; null for work that costs nothing new (fetching a clip already paid for). */
  confirm: Confirm | null;
  /** Does the work; returns what it made ("v2"). Throws to fail the job. */
  run: (context: { key: string; signal: AbortSignal; job: Job; store: Store }) => Promise<string>;
};

async function execute(
  studio: Studio,
  job: Job,
  run: () => Promise<string>,
  signal: AbortSignal,
): Promise<Job> {
  try {
    job.result = await run();
    job.status = signal.aborted ? "cancelled" : "done";
  } catch (caught) {
    endFailed(job, caught, signal);
  }
  studio.release(job.id);
  return job;
}

/** Whether a paid run is going in this extension already. */
export const busy = (studio: Studio): boolean =>
  [...studio.jobs.values()].some((each) => each.status === "running" && !isLocalKind(each.work));

/** Checks, asks and starts. `linked` aborts the run when the session that called the tool goes away. */
export async function launch(
  studio: Studio,
  entry: IndexEntry,
  work: Work,
  linked?: AbortSignal,
): Promise<Started> {
  const gemini = work.provider === "gemini";
  const key = await studio.key(gemini ? "lyria-clip" : "elevenlabs");
  if (key === null)
    return fail("no_key", `There is no ${gemini ? "Gemini" : "ElevenLabs"} key. ${SETTINGS_HINT}`);
  if (busy(studio)) return fail("invalid", "Another run is still going. Wait for it or cancel it.");
  const api = studio.api();
  if (work.confirm !== null) {
    const answer = await askReader(api, work.confirm);
    if (answer === null)
      return fail("unsupported", "This prifly cannot ask you first. Update prifly.");
    if (!answer) return fail("cancelled", "Not done: you cancelled.");
    // Another call may have started while the card was open.
    if (busy(studio))
      return fail("invalid", "Another run is still going. Wait for it or cancel it.");
  }
  const job: Job = {
    id: crypto.randomUUID().slice(0, 8),
    work: work.work,
    label: work.label,
    project: entry.id,
    engine: gemini ? null : "elevenlabs",
    status: "running",
    done: [],
    total: work.total,
    result: null,
    error: null,
    kind: null,
    suggestion: null,
  };
  const abort = new AbortController();
  linked?.addEventListener("abort", () => abort.abort());
  studio.register(job, abort);
  const run = () => work.run({ key, signal: abort.signal, job, store: studio.store() });
  return { ok: true, job, finished: execute(studio, job, run, abort.signal) };
}

/** Work done on this computer (no key, no cost, no card): analysing, mastering, exporting. */
export type LocalWork = {
  work: Extract<JobKind, "master" | "analyse" | "deliver" | "draft" | "preview" | "render">;
  label: string;
  /** How many steps it has; each finished step is pushed on `job.done`. */
  total: number;
  /** Does the work; returns what it made. Throws to fail the job. */
  run: (context: { signal: AbortSignal; job: Job; store: Store }) => Promise<string>;
};

/** Whether a local run is going; it does not wait for a paid one, nor the other way round. */
export const localBusy = (studio: Studio): boolean =>
  [...studio.jobs.values()].some((each) => each.status === "running" && isLocalKind(each.work));

/** Starts local work in the background as a job the panel polls and can cancel. */
export function launchLocal(
  studio: Studio,
  project: string | null,
  work: LocalWork,
  linked?: AbortSignal,
): Started {
  if (localBusy(studio))
    return fail("invalid", "Another local run is still going. Wait for it or cancel it.");
  const job: Job = {
    id: crypto.randomUUID().slice(0, 8),
    work: work.work,
    label: work.label,
    project,
    engine: null,
    status: "running",
    done: [],
    total: work.total,
    result: null,
    error: null,
    kind: null,
    suggestion: null,
  };
  const abort = new AbortController();
  linked?.addEventListener("abort", () => abort.abort());
  studio.register(job, abort);
  const run = () => work.run({ signal: abort.signal, job, store: studio.store() });
  return { ok: true, job, finished: execute(studio, job, run, abort.signal) };
}
