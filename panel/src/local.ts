/**
 * Local runs as the page sees them (Master, Analyse, Deliver): start a job,
 * poll it, show its step and a bar, and let the reader cancel. There is no
 * confirm card because nothing is spent. The progress row and the notice row
 * always take their space, so the buttons around them never move.
 */

import { call, errorText, type Job, type StartAnswer } from "./api";
import { h, icon } from "./dom";
import { redraw } from "./state";

export type LocalKind = "master" | "analyse" | "deliver";
const POLL_MS = 600;

type LocalNotice = { kind: LocalKind; tone: "info" | "warn" | "error"; text: string };

export const local: {
  kind: LocalKind | null;
  job: Job | null;
  starting: boolean;
  cancelling: boolean;
  notice: LocalNotice | null;
} = { kind: null, job: null, starting: false, cancelling: false, notice: null };

export const localBusy = (): boolean => local.starting || local.job?.status === "running";

/** Tells the reader how a run that started and ended went; `done` reloads the page's data and returns the success sentence. */
async function ended(
  kind: LocalKind,
  job: Job,
  done: (job: Job) => Promise<string>,
): Promise<void> {
  local.cancelling = false;
  if (job.status === "failed")
    local.notice = { kind, tone: "error", text: job.error ?? "The run failed." };
  else if (job.status === "cancelled")
    local.notice = {
      kind,
      tone: "info",
      text: "Cancelled. Nothing was changed; anything already written is kept.",
    };
  else local.notice = { kind, tone: "info", text: await done(job) };
}

async function poll(
  kind: LocalKind,
  id: string,
  done: (job: Job) => Promise<string>,
): Promise<void> {
  try {
    const job = await call<Job>(`job?id=${encodeURIComponent(id)}`);
    local.job = job;
    if (job.status === "running") {
      redraw("stage");
      setTimeout(() => void poll(kind, id, done), POLL_MS);
      return;
    }
    await ended(kind, job, done);
  } catch (caught) {
    local.notice = { kind, tone: "error", text: errorText(caught) };
    local.job = null;
    local.cancelling = false;
  }
  redraw("stage");
}

/** Posts `body` to a route that starts a local job and follows the job. */
export async function startLocal(
  kind: LocalKind,
  path: string,
  body: unknown,
  done: (job: Job) => Promise<string>,
): Promise<void> {
  local.notice = null;
  local.job = null;
  local.kind = kind;
  local.starting = true;
  redraw("stage");
  try {
    const answer = await call<StartAnswer>(path, body);
    local.starting = false;
    if (answer.ok) {
      local.job = answer.job;
      redraw("stage");
      await poll(kind, answer.job.id, done);
      return;
    }
    local.notice = { kind, tone: "warn", text: answer.message };
  } catch (caught) {
    local.starting = false;
    local.notice = { kind, tone: "error", text: errorText(caught) };
  }
  redraw("stage");
}

export async function cancelLocal(): Promise<void> {
  if (local.job === null) return;
  local.cancelling = true;
  redraw("stage");
  try {
    await call("cancel", { job: local.job.id });
  } catch (caught) {
    local.cancelling = false;
    local.notice = {
      kind: local.kind ?? "master",
      tone: "error",
      text: errorText(caught),
    };
  }
}

const STEP_WORDS: Record<string, string> = {
  measured: "measured",
  rendered: "rendered",
  checked: "checked",
  decoded: "decoded",
  tempo: "tempo found",
  key: "key found",
  loudness: "loudness measured",
  stems: "stems written",
  master: "master written",
  rekordbox: "rekordbox written",
  loops: "loop points written",
};

/** A row of fixed height: the running job's step and bar, or nothing. */
export function localProgress(kind: LocalKind): HTMLElement {
  const job = local.job;
  const running = job !== null && job.work === kind && job.status === "running";
  const step = running ? Math.min(job.done.length + 1, job.total) : 0;
  const last = running ? job.done.at(-1) : undefined;
  return h(
    "div",
    { class: "local-progress", role: "status", "data-state": running ? "running" : "idle" },
    h(
      "span",
      { class: "local-step" },
      running
        ? `${job.label}: step ${step} of ${job.total}${last === undefined ? "" : ` (${STEP_WORDS[last] ?? last})`}`
        : "",
    ),
    h(
      "div",
      { class: "track", "aria-hidden": "true" },
      h("div", {
        class: "fill",
        style: `width:${running ? Math.round((job.done.length / Math.max(1, job.total)) * 100) : 0}%`,
      }),
    ),
  );
}

/** The last run's outcome for `kind`, in a row that keeps its height when empty. */
export function localNotice(kind: LocalKind): HTMLElement {
  const notice = local.notice;
  return h(
    "div",
    { class: "local-notice", "data-part": `${kind}-notice` },
    notice === null || notice.kind !== kind
      ? null
      : h(
          "div",
          { class: `notice ${notice.tone}`, role: notice.tone === "error" ? "alert" : "status" },
          icon(notice.tone === "info" ? "info" : "alert"),
          h("div", { class: "notice-body" }, notice.text),
        ),
  );
}
