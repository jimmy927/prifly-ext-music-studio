/**
 * The paid runs after the sketches (an Arrange render, stem separation, a
 * sound effect) share one shape: check the key, ask the reader on a confirm
 * card, then do the work in the background as a job the panel polls and can
 * cancel. Nothing is spent before the reader confirms.
 */

import type { ExtensionApi } from "@prifly/extension-api";
import type { IndexEntry, Store } from "./project/store";
import {
  endFailed,
  fail,
  type Job,
  type JobKind,
  SETTINGS_HINT,
  type Started,
  type Studio,
} from "./studio";

export type Confirm = Parameters<NonNullable<ExtensionApi["confirm"]>>[0];

export type Work = {
  work: Exclude<JobKind, "sketch">;
  label: string;
  total: number;
  confirm: Confirm;
  /** Does the work; returns what it made ("v2"). Throws to fail the job. */
  run: (context: { key: string; signal: AbortSignal; job: Job; store: Store }) => Promise<string>;
};

async function execute(
  studio: Studio,
  job: Job,
  work: Work,
  key: string,
  signal: AbortSignal,
): Promise<Job> {
  try {
    job.result = await work.run({ key, signal, job, store: studio.store() });
    job.status = signal.aborted ? "cancelled" : "done";
  } catch (caught) {
    endFailed(job, caught, signal);
  }
  studio.release(job.id);
  return job;
}

/** Whether a paid run is going in this extension already. */
export const busy = (studio: Studio): boolean =>
  [...studio.jobs.values()].some((each) => each.status === "running");

/** Checks, asks and starts. `linked` aborts the run when the session that called the tool goes away. */
export async function launch(
  studio: Studio,
  entry: IndexEntry,
  work: Work,
  linked?: AbortSignal,
): Promise<Started> {
  const key = await studio.key("elevenlabs");
  if (key === null) return fail("no_key", `There is no ElevenLabs key. ${SETTINGS_HINT}`);
  if (busy(studio)) return fail("invalid", "Another run is still going. Wait for it or cancel it.");
  const api = studio.api();
  if (api.confirm === undefined)
    return fail("unsupported", "This prifly cannot ask you first. Update prifly.");
  if (!(await api.confirm(work.confirm))) return fail("cancelled", "Not done: you cancelled.");
  const job: Job = {
    id: crypto.randomUUID().slice(0, 8),
    work: work.work,
    label: work.label,
    project: entry.id,
    engine: "elevenlabs",
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
  return { ok: true, job, finished: execute(studio, job, work, key, abort.signal) };
}
