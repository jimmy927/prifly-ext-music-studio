/**
 * The paid runs of the later stages as the page sees them: ask, wait for the
 * reader's confirm card in prifly, poll the job with Cancel, and say how it
 * ended (a refused prompt with its suggestion, a failure, a cancel). One run
 * at a time; the buttons of every stage read `busy()` and are disabled, never
 * hidden.
 */

import { call, errorText, type Job, type StartAnswer } from "./api";
import { type Child, h, icon } from "./dom";
import { loadStatus } from "./header";
import { type Notice, redraw } from "./state";

const POLL_MS = 1500;

type Refusal = { message: string; suggestion: string | null };

export const work: {
  confirming: boolean;
  job: Job | null;
  cancelling: boolean;
  notice: Notice | null;
  refusal: Refusal | null;
} = { confirming: false, job: null, cancelling: false, notice: null, refusal: null };

export const busy = (): boolean => work.confirming || work.job?.status === "running";

/** Clears the last run's notices, e.g. when the reader moves to another stage. */
export function clearWork(): void {
  if (busy()) return;
  work.job = null;
  work.notice = null;
  work.refusal = null;
}

function ended(job: Job): void {
  work.cancelling = false;
  if (job.status === "failed") {
    if (job.kind === "bad_prompt")
      work.refusal = {
        message: job.error ?? "ElevenLabs refused the prompt.",
        suggestion: job.suggestion,
      };
    else work.notice = { tone: "error", text: job.error ?? "The run failed." };
  } else if (job.status === "cancelled") {
    work.notice = {
      tone: "info",
      text: "Cancelled. Nothing was added; anything already made is kept.",
    };
  }
  void loadStatus();
}

async function poll(id: string, after: () => Promise<void>): Promise<void> {
  try {
    const job = await call<Job>(`job?id=${encodeURIComponent(id)}`);
    work.job = job;
    if (job.status === "running") {
      redraw("stage");
      setTimeout(() => void poll(id, after), POLL_MS);
      return;
    }
    ended(job);
    if (job.status === "done") await after();
  } catch (caught) {
    work.notice = { tone: "error", text: errorText(caught) };
    work.job = null;
  }
  redraw("stage");
}

/** Picks up a run that is already going (the page was reopened meanwhile); `after` runs when it is done. */
export async function follow(job: Job, after: () => Promise<void>): Promise<void> {
  work.notice = null;
  work.refusal = null;
  work.job = job;
  redraw("stage");
  await poll(job.id, after);
}

/** Posts `body` to `path` (a route that starts a paid run) and follows the job; `after` runs when it is done. */
export async function startWork(
  path: string,
  body: unknown,
  after: () => Promise<void>,
): Promise<void> {
  work.notice = null;
  work.refusal = null;
  work.job = null;
  work.confirming = true;
  redraw("stage");
  try {
    const answer = await call<StartAnswer>(path, body);
    work.confirming = false;
    if (answer.ok) {
      work.job = answer.job;
      redraw("stage");
      await poll(answer.job.id, after);
      return;
    }
    work.notice =
      answer.reason === "cancelled"
        ? { tone: "info", text: "Cancelled. Nothing was made and nothing was spent." }
        : { tone: "warn", text: answer.message };
  } catch (caught) {
    work.confirming = false;
    work.notice = { tone: "error", text: errorText(caught) };
  }
  redraw("stage");
}

async function cancel(): Promise<void> {
  if (work.job === null) return;
  work.cancelling = true;
  redraw("stage");
  try {
    await call("cancel", { job: work.job.id });
  } catch (caught) {
    work.notice = { tone: "error", text: errorText(caught) };
  }
}

function progress(): Child {
  if (work.confirming) {
    return h(
      "div",
      { class: "progress", role: "status", "data-state": "confirming" },
      h("span", null, "Waiting for you to confirm the cost in prifly…"),
    );
  }
  const job = work.job;
  if (job === null || job.status !== "running") return null;
  return h(
    "div",
    { class: "progress", role: "status", "data-state": "running" },
    h("span", null, `${job.label}. This can take a minute or more.`),
    h("div", { class: "track" }, h("div", { class: "fill indeterminate" })),
    h(
      "button",
      {
        type: "button",
        class: "btn small",
        disabled: work.cancelling,
        onclick: () => void cancel(),
      },
      work.cancelling ? "Cancelling…" : "Cancel",
    ),
  );
}

function refusal(): Child {
  if (work.refusal === null) return null;
  const { message, suggestion } = work.refusal;
  return h(
    "div",
    { class: "notice warn", role: "alert", "data-state": "refused" },
    icon("alert"),
    h(
      "div",
      { class: "notice-body" },
      h("strong", null, "ElevenLabs refused this."),
      h("p", null, message),
      suggestion === null
        ? null
        : h(
            "div",
            { class: "suggestion" },
            h("p", null, "Suggested instead:"),
            h("blockquote", null, suggestion),
          ),
    ),
  );
}

/** The progress row and the notices of the last run; an empty block when there is nothing to say. */
export function renderWork(): HTMLElement {
  const notice = work.notice;
  return h(
    "div",
    { class: "work", "data-part": "work" },
    progress(),
    refusal(),
    notice === null
      ? null
      : h(
          "div",
          { class: `notice ${notice.tone}`, role: notice.tone === "error" ? "alert" : "status" },
          icon(notice.tone === "info" ? "info" : "alert"),
          h("div", { class: "notice-body" }, notice.text),
        ),
  );
}
