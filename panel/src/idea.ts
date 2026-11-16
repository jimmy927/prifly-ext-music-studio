/** The Idea stage: the form on the left, the sketches on the right, and the states between. */

import { call, errorText, type Job, type ProjectView, type SketchAnswer } from "./api";
import { type Child, fill, h, icon } from "./dom";
import { buildForm } from "./form";
import { loadStatus } from "./header";
import { renderSketches } from "./sketches";
import { mountSources } from "./sources";
import { app, type Notice, redraw } from "./state";

const POLL_MS = 1500;
let timer: ReturnType<typeof setTimeout> | null = null;
let cancelling = false;

/** Why Sketch is off, or null when it is on. */
export function blocker(): string | null {
  const status = app.status;
  if (status === null)
    return app.statusError === null ? "Loading your keys…" : "Cannot reach the extension.";
  if (app.confirming || app.job?.status === "running") return "A run is in progress.";
  if (app.draft.text.trim() === "" && app.sources.length === 0)
    return "Write a brief first, or add source material.";
  if (app.draft.vocals === "mine" && app.draft.lyrics.trim() === "" && app.sources.length === 0)
    return "Paste your lyrics, or pick another vocals option.";
  if (app.draft.engine === "elevenlabs") {
    if (!status.elevenlabs.keySet)
      return "No ElevenLabs key. Add it in Settings → Extensions → Music Studio.";
  } else if (!status.gemini.keySet) {
    return "No Gemini key. Add it in Settings → Extensions → Music Studio.";
  }
  return null;
}

async function showProject(id: string): Promise<void> {
  app.project = await call<ProjectView>(`project?id=${encodeURIComponent(id)}`);
}

function ended(job: Job): void {
  if (job.status === "failed") {
    if (job.kind === "bad_prompt")
      app.refusal = {
        message: job.error ?? "ElevenLabs refused the prompt.",
        suggestion: job.suggestion,
      };
    else app.notice = { tone: "error", text: job.error ?? "The run failed." };
  } else if (job.status === "cancelled") {
    app.notice = {
      tone: "info",
      text: `Cancelled after ${job.done.length} of ${job.total} sketches. Anything made is kept.`,
    };
  }
  void loadStatus();
}

async function poll(): Promise<void> {
  const current = app.job;
  if (current === null) return;
  try {
    const job = await call<Job>(`job?id=${encodeURIComponent(current.id)}`);
    app.job = job;
    if (job.project !== null) await showProject(job.project);
    else app.project = null;
    if (job.status === "running") timer = setTimeout(() => void poll(), POLL_MS);
    else {
      cancelling = false;
      ended(job);
    }
  } catch (caught) {
    app.notice = { tone: "error", text: errorText(caught) };
    app.job = null;
  }
  redraw("idea");
}

/** Resumes polling for a job started before the page was reopened, if one is known. */
export function startPolling(): void {
  if (timer !== null) clearTimeout(timer);
  void poll();
}

async function sketch(): Promise<void> {
  app.notice = null;
  app.refusal = null;
  app.project = null;
  app.job = null;
  app.confirming = true;
  redraw("idea");
  try {
    const answer = await call<SketchAnswer>("sketch", { ...app.draft, sources: app.sources });
    app.confirming = false;
    if (answer.ok) {
      app.sources = [];
      app.job = answer.job;
      startPolling();
      return;
    }
    const tone: Notice["tone"] = answer.reason === "cancelled" ? "info" : "warn";
    app.notice = {
      tone,
      text:
        answer.reason === "cancelled"
          ? "Cancelled. Nothing was made and nothing was spent."
          : answer.message,
    };
  } catch (caught) {
    app.confirming = false;
    app.notice = { tone: "error", text: errorText(caught) };
  }
  redraw("idea");
}

async function cancel(): Promise<void> {
  if (app.job === null) return;
  cancelling = true;
  redraw("idea");
  try {
    await call("cancel", { job: app.job.id });
  } catch (caught) {
    app.notice = { tone: "error", text: errorText(caught) };
  }
}

function notices(): Child[] {
  const out: Child[] = [];
  if (app.refusal !== null) {
    const { message, suggestion } = app.refusal;
    out.push(
      h(
        "div",
        { class: "notice warn", role: "alert", "data-state": "refused" },
        icon("alert"),
        h(
          "div",
          { class: "notice-body" },
          h("strong", null, "ElevenLabs refused this brief."),
          h("p", null, message),
          suggestion === null
            ? h(
                "p",
                null,
                "It named no alternative. Try describing the sound instead of an artist, a band or a song.",
              )
            : h(
                "div",
                { class: "suggestion" },
                h("p", null, "Suggested instead:"),
                h("blockquote", null, suggestion),
                h(
                  "button",
                  {
                    type: "button",
                    class: "btn small",
                    onclick: () => {
                      app.draft.text = suggestion;
                      app.draft.preset = null;
                      app.refusal = null;
                      redraw("all");
                    },
                  },
                  "Use suggestion",
                ),
              ),
        ),
      ),
    );
  }
  if (app.notice !== null) {
    out.push(
      h(
        "div",
        { class: `notice ${app.notice.tone}`, role: "status" },
        icon(app.notice.tone === "info" ? "info" : "alert"),
        h("div", { class: "notice-body" }, app.notice.text),
      ),
    );
  }
  return out;
}

export function mountIdea(): { root: HTMLElement; update: () => void; sync: () => void } {
  const side = h("div", { class: "side-wrap" });
  const messages = h("div", { class: "notices" });
  const button = h(
    "button",
    { type: "button", class: "btn primary big", id: "sketch", onclick: () => void sketch() },
    icon("spark"),
    "Sketch 3 ideas",
  );
  const why = h("p", { class: "why", role: "status" });
  const cost = h("p", { class: "cost" });
  const form = buildForm(() => update());
  const sources = mountSources({ where: "idea", redraw: () => redraw("idea") });

  function update(): void {
    const reason = blocker();
    button.disabled = reason !== null;
    why.textContent = reason ?? "";
    cost.textContent =
      app.draft.engine === "elevenlabs"
        ? "Billed by ElevenLabs to your plan. You confirm first."
        : "Billed to your Gemini key. You confirm first.";
    fill(messages, ...notices());
    sources.update();
    fill(
      side,
      renderSketches(() => void cancel(), cancelling),
    );
  }
  const root = h(
    "div",
    { class: "idea", "data-stage": "idea" },
    h(
      "section",
      { class: "main" },
      h("h2", null, "Idea"),
      messages,
      form.root,
      sources.root,
      h("div", { class: "actions" }, button, cost),
      why,
    ),
    side,
  );
  update();
  return {
    root,
    update,
    sync: () => {
      form.sync();
      sources.sync();
      update();
    },
  };
}
