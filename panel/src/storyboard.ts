/**
 * The Storyboard stage: "Draft shot list" cuts the song into shots on the
 * beatgrid (every cut on a beat, the shots tiling the song), then one still
 * frame is drawn per shot (paid, one confirm card for the batch). Each shot
 * can be approved, redrawn, re-described, split on a beat or joined with the
 * next. Buttons keep their places; they are disabled by state, never hidden.
 */

import { beatsBetween, clockText } from "../../prep/grid";
import { call, errorText, type Job, type ShotView, type StoryboardView } from "./api";
import { fill, h, icon } from "./dom";
import { go } from "./header";
import { cancelLocal, local, localBusy, localNotice, localProgress, startLocal } from "./local";
import { app, redraw } from "./state";
import { keyHint, moneyLine, picture, plural, reattach, setLabel, usd } from "./video";
import { busy, renderWork, startWork } from "./work";

let view: StoryboardView | null = null;
let loadError: string | null = null;
let loadedFor: string | null = null;
let dirty = false;
let armed = false;
let message: string | null = null;

const heading = h("h2", null);
const why = h("p", { class: "why", role: "status", "data-part": "why" });
const moneySlot = h("div", { class: "money-slot" });
const listBox = h("div", { class: "shots", "data-part": "shots" });
const problemBox = h("p", { class: "why", role: "alert", "data-part": "problems" });
const workSlot = h("div", { class: "work-slot" });
const localSlot = h("div", { class: "slot", "data-part": "run-status" });
const prepareButton = h(
  "button",
  { type: "button", class: "btn", id: "open-prepare", onclick: () => go("prepare") },
  "Open Prepare",
);
const draftButton = h(
  "button",
  { type: "button", class: "btn primary", id: "draft-shots", onclick: () => void draft(false) },
  icon("spark"),
  "Draft shot list",
);
const keepButton = h(
  "button",
  {
    type: "button",
    class: "btn",
    id: "draft-keep",
    onclick: () => {
      armed = false;
      buttons();
    },
  },
  "Keep my list",
);
const drawButton = h(
  "button",
  { type: "button", class: "btn primary", id: "draw-frames", onclick: () => void drawFrames(null) },
  icon("spark"),
  "Draw missing frames",
);
const approveAllButton = h(
  "button",
  {
    type: "button",
    class: "btn",
    id: "approve-all",
    onclick: () => void change({ approveAll: true }),
  },
  "Approve all drawn",
);
const cancelButton = h(
  "button",
  { type: "button", class: "btn", id: "draft-cancel", onclick: () => void cancelLocal() },
  "Cancel",
);
const actionWhy = h("p", { class: "why", role: "status", "data-part": "action-why" });

async function load(): Promise<void> {
  const project = app.project;
  if (project === null) return;
  loadedFor = project.id;
  try {
    view = await call<StoryboardView>(`storyboard?project=${encodeURIComponent(project.id)}`);
    loadError = null;
  } catch (caught) {
    view = null;
    loadError = errorText(caught);
  }
  dirty = true;
  redraw("stage");
}

async function change(body: Record<string, unknown>): Promise<void> {
  const project = app.project;
  if (project === null) return;
  message = null;
  try {
    const answer = await call<{ ok: true; view: StoryboardView } | { ok: false; message: string }>(
      "shot-edit",
      { project: project.id, ...body },
    );
    if (answer.ok) {
      view = answer.view;
      dirty = true;
    } else message = answer.message;
  } catch (caught) {
    message = errorText(caught);
  }
  redraw("stage");
}

async function draft(replace: boolean): Promise<void> {
  const project = app.project;
  if (project === null || view === null) return;
  if (view.hasWork && !replace && !armed) {
    armed = true;
    buttons();
    return;
  }
  armed = false;
  message = null;
  await startLocal(
    "draft",
    "storyboard-draft",
    { project: project.id, replace: view.hasWork },
    async (job) => {
      await load();
      return summary(job);
    },
  );
}

function summary(job: Job): string {
  try {
    const out = JSON.parse(job.result ?? "") as {
      shots: number;
      described: boolean;
      note: string | null;
    };
    const base = `Cut the song into ${out.shots} shots.`;
    return out.note === null
      ? `${base} Descriptions written; edit any of them.`
      : `${base} ${out.note}`;
  } catch {
    return "Done.";
  }
}

async function drawFrames(ids: string[] | null): Promise<void> {
  const project = app.project;
  if (project === null) return;
  await startWork("storyboard-frames", { project: project.id, shots: ids }, async () => {
    await load();
  });
}

/** Beats inside a shot at which it can be split, each at least one beat from either end. */
function splitPoints(shot: ShotView): { sec: number; label: string }[] {
  const list = view?.list;
  if (list === null || list === undefined) return [];
  const grid = { bpm: list.bpm, firstBeatSec: list.firstBeatSec };
  const beat = 60 / list.bpm;
  return beatsBetween(grid, shot.startSec + beat - 1e-3, shot.endSec - beat + 1e-3).map((each) => ({
    sec: each.sec,
    label: `bar ${each.bar}, beat ${each.beat} (${clockText(each.sec)})`,
  }));
}

function textBox(shot: ShotView): HTMLTextAreaElement {
  const box = h("textarea", {
    rows: 3,
    "aria-label": `Shot ${shot.number} description`,
    placeholder: "What the camera sees in this shot.",
    disabled: busy(),
  });
  box.value = shot.text;
  box.addEventListener("change", () => void change({ shot: shot.id, text: box.value }));
  return box;
}

function frameBox(project: string, shot: ShotView): HTMLElement {
  if (shot.frame === null)
    return h(
      "div",
      { class: "pic-wrap empty-frame", "data-state": "no-frame" },
      h("span", { class: "meta" }, "No frame yet"),
    );
  return picture(project, "frame", shot.id, shot.frame, `Frame of shot ${shot.number}`);
}

function splitControl(shot: ShotView): HTMLElement {
  const points = splitPoints(shot);
  const select = h("select", {
    "aria-label": `Split shot ${shot.number} at`,
    disabled: busy() || points.length === 0,
  });
  for (const point of points) select.append(h("option", { value: String(point.sec) }, point.label));
  select.value = String(points[Math.floor(points.length / 2)]?.sec ?? "");
  const button = h(
    "button",
    {
      type: "button",
      class: "btn small",
      disabled: busy() || points.length === 0,
      onclick: () => void change({ shot: shot.id, splitAt: Number(select.value) }),
    },
    "Split here",
  );
  return h("div", { class: "split" }, select, button);
}

function card(project: string, shot: ShotView, last: boolean): HTMLElement {
  const blocked = busy() || localBusy();
  const redraw1 = h(
    "button",
    {
      type: "button",
      class: "btn small",
      disabled: blocked || !(view?.geminiKey ?? false) || shot.text.trim() === "",
      onclick: () => void drawFrames([shot.id]),
    },
    shot.frame === null ? "Draw" : "Redraw",
  );
  const approve = h(
    "button",
    {
      type: "button",
      class: `btn small${shot.approved ? " on" : ""}`,
      "aria-pressed": String(shot.approved),
      disabled: blocked || shot.frame === null,
      onclick: () => void change({ shot: shot.id, approved: !shot.approved }),
    },
    icon("check", 13),
    shot.approved ? "Approved" : "Approve",
  );
  const merge = h(
    "button",
    {
      type: "button",
      class: "btn small",
      disabled: blocked || last,
      onclick: () => void change({ shot: shot.id, merge: true }),
    },
    "Join with next",
  );
  return h(
    "article",
    { class: `shot${shot.approved ? " approved" : ""}`, "data-shot": shot.id },
    frameBox(project, shot),
    h(
      "div",
      { class: "shot-body" },
      h(
        "div",
        { class: "shot-head" },
        h("span", { class: "card-title" }, `${shot.number}. ${shot.section}`),
        h(
          "span",
          { class: "meta" },
          `${clockText(shot.startSec)} to ${clockText(shot.endSec)}, ${shot.bars} bars, ${shot.clipSeconds} s clip`,
        ),
      ),
      textBox(shot),
      shot.frameError === null
        ? null
        : h("p", { class: "meta error-text", role: "alert" }, `Frame failed: ${shot.frameError}`),
      h("div", { class: "shot-actions" }, approve, redraw1, merge),
      splitControl(shot),
    ),
  );
}

function drawList(): void {
  const project = app.project;
  const list = view?.list;
  if (project === null || list === null || list === undefined) {
    fill(
      listBox,
      h(
        "p",
        { class: "empty", "data-state": "no-shots" },
        "No shot list yet. Draft one: the song is cut into shots on the beat, from its sections.",
      ),
    );
    return;
  }
  fill(
    listBox,
    ...list.shots.map((shot, at) => card(project.id, shot, at === list.shots.length - 1)),
  );
}

/** Why drafting is off, or null. */
function draftBlocker(): string | null {
  if (view === null) return loadError ?? "Loading…";
  if (view.tempo === null)
    return "There is no tempo yet. Analyse the track on the Prepare stage (or type its BPM in) so the shots can sit on bars.";
  return busy() || localBusy() ? "A run is in progress." : null;
}

function drawBlocker(): string | null {
  if (view === null) return loadError ?? "Loading…";
  if (!view.geminiKey) return keyHint;
  if (view.list === null) return "Draft the shot list first.";
  if (view.missing.count === 0) return "Every shot has a frame.";
  const blank = view.list.shots.find((each) => each.frame === null && each.text.trim() === "");
  if (blank !== undefined)
    return `Shot ${blank.number} has no description. Write what it shows first.`;
  if (view.missing.usd > view.money.remainingUsd)
    return "Over budget: raise the budget on the Treatment stage.";
  return busy() || localBusy() ? "A run is in progress." : null;
}

function draftButtons(reason: string | null): void {
  draftButton.disabled = reason !== null;
  setLabel(draftButton, armed ? "Replace the shot list" : "Draft shot list");
  keepButton.disabled = !armed;
  prepareButton.disabled = view === null || view.tempo !== null;
  cancelButton.disabled =
    !(local.job?.status === "running" && local.job.work === "draft") || local.cancelling;
  cancelButton.textContent = local.cancelling ? "Cancelling…" : "Cancel";
}

function frameButtons(reason: string | null): void {
  const count = view?.missing.count ?? 0;
  setLabel(
    drawButton,
    count === 0
      ? "Draw missing frames"
      : `Draw ${plural(count, "frame")}, about ${usd(view?.missing.usd ?? 0)}`,
  );
  drawButton.disabled = reason !== null;
  const drawn = view?.list?.shots.some((each) => each.frame !== null && !each.approved) ?? false;
  approveAllButton.disabled = !drawn || busy() || localBusy();
}

function buttons(): void {
  const draftReason = draftBlocker();
  const drawReason = drawBlocker();
  draftButtons(draftReason);
  frameButtons(drawReason);
  why.textContent = view !== null && !view.geminiKey ? keyHint : "";
  problemBox.textContent = (view?.problems ?? []).join(" ");
  actionWhy.textContent =
    message ??
    (armed
      ? "This replaces the list with its descriptions, frames and approvals. Press the button again to go ahead."
      : (draftReason ??
        drawReason ??
        "Frames are billed to your Gemini key (an estimate); you confirm the batch first."));
}

function update(): void {
  heading.textContent = app.project === null ? "Storyboard" : `Storyboard — ${app.project.title}`;
  fill(moneySlot, moneyLine(view?.money ?? null));
  fill(workSlot, renderWork());
  fill(localSlot, localProgress("draft"), localNotice("draft"));
  if (dirty) {
    dirty = false;
    drawList();
  }
  buttons();
}

export function mountStoryboard(): { root: HTMLElement; update: () => void; sync: () => void } {
  const root = h(
    "div",
    { class: "stage storyboard", "data-stage": "storyboard" },
    h(
      "section",
      { class: "main wide" },
      heading,
      why,
      moneySlot,
      h(
        "div",
        { class: "actions" },
        draftButton,
        keepButton,
        cancelButton,
        prepareButton,
        drawButton,
        approveAllButton,
      ),
      actionWhy,
      problemBox,
      localSlot,
      workSlot,
      listBox,
    ),
  );
  return {
    root,
    update,
    sync: () => {
      if (loadedFor !== app.project?.id) {
        view = null;
        armed = false;
      }
      void load();
      void reattach(["frames", "draft"], load, async (job) => {
        await load();
        return summary(job);
      });
      dirty = true;
      update();
    },
  };
}
