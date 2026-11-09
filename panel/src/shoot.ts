/**
 * The Shoot stage: each approved shot is shot with Gemini Omni Flash from its
 * frame, the cast and its description. Several takes per shot are kept and
 * one is chosen; the running spend is shown against the budget and shooting
 * stops at it. A take that failed shows why and is shot again with Retry. A run
 * is followed while it goes and picked up again if the page is reopened.
 * Buttons keep their places; they are disabled by state, never hidden.
 */

import { clockText } from "../../prep/grid";
import { MAX_TAKES_PER_SHOT } from "../../video/constants";
import { call, errorText, type Job, type ShootShot, type ShootView, type TakeView } from "./api";
import { fill, h, icon } from "./dom";
import { app, redraw } from "./state";
import { clip, keyHint, moneyLine, picture, plural, reattach, setLabel, usd } from "./video";
import { busy, renderWork, startWork, work } from "./work";

let view: ShootView | null = null;
let loadError: string | null = null;
let loadedFor: string | null = null;
let dirty = false;
let message: string | null = null;
let takes = 1;

const heading = h("h2", null);
const why = h("p", { class: "why", role: "status", "data-part": "why" });
const moneySlot = h("div", { class: "money-slot" });
const listBox = h("div", { class: "shots", "data-part": "shots" });
const workSlot = h("div", { class: "work-slot" });
const takesSelect = h(
  "select",
  {
    name: "takes",
    "aria-label": "Takes per shot",
    onchange: () => {
      takes = Number(takesSelect.value);
      buttons();
    },
  },
  ...Array.from({ length: MAX_TAKES_PER_SHOT }, (_each, at) =>
    h("option", { value: String(at + 1) }, `${at + 1} take${at === 0 ? "" : "s"} per shot`),
  ),
);
const shootButton = h(
  "button",
  { type: "button", class: "btn primary big", id: "shoot", onclick: () => void shoot(null) },
  icon("spark"),
  "Shoot approved shots",
);
const recoverButton = h(
  "button",
  { type: "button", class: "btn", id: "shoot-recover", onclick: () => void recover() },
  "Fetch interrupted clips",
);
const actionWhy = h("p", { class: "why", role: "status", "data-part": "action-why" });

async function load(): Promise<void> {
  const project = app.project;
  if (project === null) return;
  loadedFor = project.id;
  try {
    view = await call<ShootView>(`shoot?project=${encodeURIComponent(project.id)}`);
    loadError = null;
  } catch (caught) {
    view = null;
    loadError = errorText(caught);
  }
  dirty = true;
  redraw("stage");
}

/** Says how a finished shoot went: what was made, what failed, and whether the budget stopped it. */
function outcome(job: Job | null): void {
  if (job === null || job.status !== "done" || job.work !== "shoot") return;
  try {
    const out = JSON.parse(job.result ?? "") as {
      made: number;
      failed: number;
      left: number;
      stoppedBy: "budget" | null;
      spentUsd: number;
      budgetUsd: number;
    };
    const stopped =
      out.stoppedBy === "budget"
        ? ` Shooting stopped at the budget (${usd(out.spentUsd)} of ${usd(out.budgetUsd)}): ${out.left} take${out.left === 1 ? " was" : "s were"} not shot. Raise the budget on the Treatment stage to go on.`
        : "";
    work.notice = {
      tone: out.stoppedBy === "budget" || out.failed > 0 ? "warn" : "info",
      text: `Made ${out.made} take${out.made === 1 ? "" : "s"}${out.failed > 0 ? `, ${out.failed} failed (the reason is on the take)` : ""}.${stopped}`,
    };
  } catch {
    // A result that is not ours (a recover run says "n of m clips"): the progress row already said it.
  }
}

async function after(): Promise<void> {
  outcome(work.job);
  await load();
}

async function shoot(ids: string[] | null): Promise<void> {
  const project = app.project;
  if (project === null) return;
  message = null;
  await startWork(
    "shoot-run",
    { project: project.id, shots: ids, takes: ids === null ? takes : 1 },
    after,
  );
}

async function recover(): Promise<void> {
  const project = app.project;
  if (project === null) return;
  message = null;
  await startWork("shoot-recover", { project: project.id }, after);
}

async function choose(take: TakeView): Promise<void> {
  const project = app.project;
  if (project === null) return;
  try {
    view = await call<ShootView>("shoot-choose", { project: project.id, take: take.id });
    dirty = true;
  } catch (caught) {
    message = errorText(caught);
  }
  redraw("stage");
}

function takeRow(project: string, shot: ShootShot, take: TakeView): HTMLElement {
  const done = take.status === "done";
  const select = h(
    "button",
    {
      type: "button",
      class: `btn small${take.chosen ? " on" : ""}`,
      "aria-pressed": String(take.chosen),
      disabled: !done || take.chosen || busy(),
      onclick: () => void choose(take),
    },
    take.chosen ? "Chosen" : "Choose",
  );
  const retry = h(
    "button",
    {
      type: "button",
      class: "btn small",
      disabled: take.status !== "failed" || busy() || !canShoot(shot),
      onclick: () => void shoot([shot.id]),
    },
    "Retry",
  );
  const status =
    take.status === "done"
      ? `${take.seconds} s clip`
      : take.status === "pending"
        ? "Waiting for Google"
        : `Failed: ${take.reason ?? "no reason given"}`;
  return h(
    "div",
    { class: `take ${take.status}`, "data-take": take.id },
    h("span", { class: "card-title" }, `Take ${take.n}`),
    h(
      "span",
      {
        class: `meta${take.status === "failed" ? " error-text" : ""}`,
        role: take.status === "failed" ? "alert" : "status",
      },
      status,
    ),
    done ? clip(project, "take", take.id, `Take ${take.n} of shot ${shot.number}`) : null,
    h("div", { class: "take-actions" }, select, retry),
  );
}

/** Whether a shot may be shot now: approved, with a frame. */
const canShoot = (shot: ShootShot): boolean => shot.approved && shot.frame !== null;

function shotCard(project: string, shot: ShootShot): HTMLElement {
  const more = h(
    "button",
    {
      type: "button",
      class: "btn small",
      disabled: busy() || !canShoot(shot) || !(view?.geminiKey ?? false),
      title: canShoot(shot) ? "" : "Approve this shot's frame on the Storyboard stage first.",
      onclick: () => void shoot([shot.id]),
    },
    shot.takes.length === 0 ? "Shoot this shot" : "Another take",
  );
  return h(
    "article",
    { class: `shot${shot.approved ? " approved" : ""}`, "data-shot": shot.id },
    shot.frame === null
      ? h("div", { class: "pic-wrap empty-frame" }, h("span", { class: "meta" }, "No frame"))
      : picture(project, "frame", shot.id, shot.frame, `Frame of shot ${shot.number}`),
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
          `${clockText(shot.startSec)} to ${clockText(shot.endSec)}, ${shot.clipSeconds} s clip`,
        ),
      ),
      h("p", { class: "shot-text" }, shot.text === "" ? "(no description)" : shot.text),
      shot.approved
        ? null
        : h(
            "p",
            { class: "meta" },
            "Not approved: approve its frame on the Storyboard stage to shoot it.",
          ),
      ...shot.takes.map((take) => takeRow(project, shot, take)),
      h("div", { class: "shot-actions" }, more),
    ),
  );
}

function drawList(): void {
  const project = app.project;
  if (project === null || view === null || view.shots.length === 0) {
    fill(
      listBox,
      h(
        "p",
        { class: "empty", "data-state": "no-shots" },
        "No shot list yet. Draft one on the Storyboard stage.",
      ),
    );
    return;
  }
  const shots = view.shots;
  fill(listBox, ...shots.map((shot) => shotCard(project.id, shot)));
}

/** Why shooting is off, or null. */
function blocker(): string | null {
  if (view === null) return loadError ?? "Loading…";
  if (!view.geminiKey) return keyHint;
  if (view.shots.length === 0)
    return "There are no shots yet. Draft the shot list on the Storyboard stage.";
  if (view.waiting.count === 0)
    return "Nothing is waiting: approve frames on the Storyboard stage, or use Another take on a shot.";
  if (view.money.remainingUsd <= 0)
    return "The budget is used up. Raise it on the Treatment stage to shoot more.";
  return busy() ? "A run is in progress." : null;
}

function shootButtons(reason: string | null): void {
  const count = (view?.waiting.count ?? 0) * takes;
  const price = (view?.waiting.usd ?? 0) * takes;
  setLabel(
    shootButton,
    count === 0 ? "Shoot approved shots" : `Shoot ${plural(count, "take")}, about ${usd(price)}`,
  );
  shootButton.disabled = reason !== null;
  takesSelect.value = String(takes);
  takesSelect.disabled = view === null || busy();
}

function recoverButtons(): void {
  const orphans = view?.orphans ?? 0;
  recoverButton.disabled = orphans === 0 || busy() || !(view?.geminiKey ?? false);
  setLabel(
    recoverButton,
    orphans === 0 ? "Fetch interrupted clips" : `Fetch ${plural(orphans, "interrupted clip")}`,
  );
}

function buttons(): void {
  const reason = blocker();
  shootButtons(reason);
  recoverButtons();
  why.textContent = view !== null && !view.geminiKey ? keyHint : "";
  actionWhy.textContent =
    message ??
    reason ??
    `Clips are ${view?.prices.resolution ?? "720p"}, billed to your Gemini key at about ${usd(view?.prices.videoPerSecondUsd ?? 0)} a second (an estimate). You confirm the batch first; shooting stops at the budget.`;
}

function update(): void {
  heading.textContent = app.project === null ? "Shoot" : `Shoot — ${app.project.title}`;
  fill(moneySlot, moneyLine(view?.money ?? null));
  fill(workSlot, renderWork());
  if (dirty) {
    dirty = false;
    drawList();
  }
  buttons();
}

export function mountShoot(): { root: HTMLElement; update: () => void; sync: () => void } {
  const root = h(
    "div",
    { class: "stage shoot", "data-stage": "shoot" },
    h(
      "section",
      { class: "main wide" },
      heading,
      why,
      moneySlot,
      h("div", { class: "actions" }, takesSelect, shootButton, recoverButton),
      actionWhy,
      workSlot,
      listBox,
    ),
  );
  return {
    root,
    update,
    sync: () => {
      if (loadedFor !== app.project?.id) view = null;
      void load();
      void reattach(["shoot"], after, async () => "");
      dirty = true;
      update();
    },
  };
}
