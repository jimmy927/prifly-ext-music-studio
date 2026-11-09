/**
 * The Treatment stage: the video's concept and look, its format (16:9, plus
 * an optional 9:16 vertical cut), the shot length rule (2, 4 or 8 bars), the
 * dollar budget, and the cast of up to six reference pictures, drawn from a
 * prompt (paid, behind a confirm card) or dropped or picked from a file.
 * Buttons keep their places; they are disabled by state, never hidden.
 */

import { MAX_CAST, SHOT_BARS } from "../../video/constants";
import { call, errorText, type TreatmentView } from "./api";
import { fill, h, icon } from "./dom";
import { app, redraw } from "./state";
import { keyHint, moneyLine, picture, reattach, usd } from "./video";
import { busy, renderWork, startWork } from "./work";

let view: TreatmentView | null = null;
let loadError: string | null = null;
let loadedFor: string | null = null;
let dirty = false;
let redrawCast = false;
let message: string | null = null;

const heading = h("h2", null);
const why = h("p", { class: "why", role: "status", "data-part": "why" });
const moneySlot = h("div", { class: "money-slot" });
const concept = h("textarea", {
  name: "concept",
  rows: 4,
  placeholder: "What the video is about: who, where, what happens.",
  "aria-label": "Concept",
});
const look = h("textarea", {
  name: "look",
  rows: 2,
  placeholder: "The look: film stock, colours, lighting, camera.",
  "aria-label": "Look",
});
const vertical = h("input", { type: "checkbox", name: "vertical" });
const budget = h("input", {
  type: "number",
  name: "budget",
  min: 0,
  step: 1,
  "aria-label": "Budget in dollars",
});
const barRadios = SHOT_BARS.map((bars) =>
  h("input", {
    type: "radio",
    name: "shot-bars",
    value: String(bars),
    "aria-label": `${bars} bars`,
  }),
);
const save = h(
  "button",
  { type: "button", class: "btn primary", id: "treatment-save", onclick: () => void saveForm() },
  icon("check"),
  "Save treatment",
);
const saveWhy = h("p", { class: "why", role: "status" });
const castBox = h("div", { class: "cast", "data-part": "cast" });
const fileInput = h("input", {
  type: "file",
  accept: "image/png,image/jpeg,image/webp",
  hidden: true,
});
const addButton = h(
  "button",
  { type: "button", class: "btn", id: "cast-add", onclick: () => fileInput.click() },
  "Add a picture from a file",
);
const drop = h("div", { class: "drop", "data-part": "drop", tabindex: 0 }, "Drop a picture here");
const castName = h("input", {
  type: "text",
  name: "cast-name",
  placeholder: "Name (Mia, the car…)",
  "aria-label": "Cast name",
});
const castPrompt = h("input", {
  type: "text",
  name: "cast-prompt",
  placeholder: "Describe the person, creature or object to draw",
  "aria-label": "Cast prompt",
});
const drawButton = h(
  "button",
  { type: "button", class: "btn primary", id: "cast-draw", onclick: () => void draw() },
  icon("spark"),
  "Draw a cast picture",
);
const drawWhy = h("p", { class: "why", role: "status" });
const workSlot = h("div", { class: "work-slot" });

async function load(): Promise<void> {
  const project = app.project;
  if (project === null) return;
  loadedFor = project.id;
  try {
    view = await call<TreatmentView>(`treatment?project=${encodeURIComponent(project.id)}`);
    loadError = null;
  } catch (caught) {
    view = null;
    loadError = errorText(caught);
  }
  dirty = false;
  redrawCast = true;
  redraw("stage");
}

/** Puts the saved values in the form (only when the reader has no unsaved edits). */
function setForm(): void {
  const t = view?.treatment;
  if (t === undefined || dirty) return;
  concept.value = t.concept;
  look.value = t.look;
  vertical.checked = t.vertical;
  for (const radio of barRadios) radio.checked = Number(radio.value) === t.shotBars;
  budget.value = String(view?.money.budgetUsd ?? "");
}

function touched(): void {
  dirty = true;
  buttons();
}

async function saveForm(): Promise<void> {
  const project = app.project;
  if (project === null) return;
  message = null;
  const bars = barRadios.find((each) => each.checked)?.value;
  const asked = Number(budget.value);
  try {
    view = await call<TreatmentView>("treatment-save", {
      project: project.id,
      concept: concept.value,
      look: look.value,
      vertical: vertical.checked,
      shotBars: Number(bars),
      budgetUsd: budget.value.trim() === "" || !Number.isFinite(asked) ? null : asked,
    });
    loadError = null;
    dirty = false;
    message = "Saved.";
  } catch (caught) {
    message = errorText(caught);
  }
  redraw("stage");
}

async function addFile(file: File): Promise<void> {
  const project = app.project;
  if (project === null) return;
  message = null;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const answer = await call<{ ok: true; view: TreatmentView } | { ok: false; message: string }>(
      "cast-add",
      {
        project: project.id,
        name: file.name.replace(/\.[^.]+$/, ""),
        base64: btoa(binary),
      },
    );
    if (answer.ok) {
      view = answer.view;
      redrawCast = true;
    } else message = answer.message;
  } catch (caught) {
    message = errorText(caught);
  }
  redraw("stage");
}

async function remove(id: string): Promise<void> {
  const project = app.project;
  if (project === null) return;
  try {
    view = await call<TreatmentView>("cast-remove", { project: project.id, id });
    redrawCast = true;
  } catch (caught) {
    message = errorText(caught);
  }
  redraw("stage");
}

async function draw(): Promise<void> {
  const project = app.project;
  if (project === null) return;
  const name = castName.value;
  await startWork(
    "cast-draw",
    { project: project.id, name, prompt: castPrompt.value },
    async () => {
      castPrompt.value = "";
      castName.value = "";
      await load();
    },
  );
}

function tile(project: string, each: TreatmentView["treatment"]["cast"][number]): HTMLElement {
  return h(
    "div",
    { class: "cast-tile", "data-cast": each.id },
    picture(project, "cast", each.id, each.id, each.name === "" ? "Cast picture" : each.name),
    h("span", { class: "card-title" }, each.name === "" ? "Unnamed" : each.name),
    h(
      "span",
      { class: "meta" },
      each.source === "generated" ? "Drawn from a prompt" : "From a file",
    ),
    h(
      "button",
      {
        type: "button",
        class: "btn small",
        "aria-label": `Remove ${each.name === "" ? "this picture" : each.name}`,
        disabled: busy(),
        onclick: () => void remove(each.id),
      },
      "Remove",
    ),
  );
}

function drawCast(): void {
  const project = app.project;
  const cast = view?.treatment.cast ?? [];
  fill(
    castBox,
    cast.length === 0 || project === null
      ? h(
          "p",
          { class: "empty", "data-state": "no-cast" },
          "No cast yet. Pictures keep a character looking the same in every shot; the video works without any.",
        )
      : h("div", { class: "cast-grid" }, ...cast.map((each) => tile(project.id, each))),
  );
}

/** Why drawing a cast picture is off, or null. */
function drawBlocker(): string | null {
  if (view === null) return loadError ?? "Loading…";
  if (!view.geminiKey) return keyHint;
  if (view.treatment.cast.length >= MAX_CAST) return `The cast holds at most ${MAX_CAST} pictures.`;
  if (castPrompt.value.trim() === "") return "Describe the picture first.";
  if (view.money.remainingUsd < view.prices.imageUsd) return "Over budget: raise the budget above.";
  return busy() ? "A run is in progress." : null;
}

function buttons(): void {
  const blocked = view === null || busy();
  save.disabled = blocked || !dirty;
  saveWhy.textContent = message ?? (dirty ? "Unsaved changes." : "");
  const full = (view?.treatment.cast.length ?? 0) >= MAX_CAST;
  addButton.disabled = blocked || full;
  drop.classList.toggle("off", blocked || full);
  const reason = drawBlocker();
  drawButton.disabled = reason !== null;
  drawWhy.textContent =
    reason ??
    `Billed to your Gemini key: about ${usd(view?.prices.imageUsd ?? 0)} for one picture (an estimate). You confirm first.`;
  for (const control of [concept, look, vertical, budget, ...barRadios, castName, castPrompt])
    control.disabled = blocked;
  const topReason = view === null ? (loadError ?? "Loading…") : !view.geminiKey ? keyHint : "";
  why.textContent = topReason;
}

function update(): void {
  heading.textContent = app.project === null ? "Treatment" : `Treatment — ${app.project.title}`;
  fill(moneySlot, moneyLine(view?.money ?? null));
  fill(workSlot, renderWork());
  setForm();
  if (redrawCast) {
    redrawCast = false;
    drawCast();
  }
  buttons();
}

function wire(): void {
  for (const control of [concept, look, vertical, budget, ...barRadios])
    control.addEventListener("input", touched);
  castPrompt.addEventListener("input", buttons);
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (file !== undefined) void addFile(file);
  });
  drop.addEventListener("dragover", (event) => event.preventDefault());
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files[0];
    if (file !== undefined && !addButton.disabled) void addFile(file);
  });
}

export function mountTreatment(): { root: HTMLElement; update: () => void; sync: () => void } {
  wire();
  const root = h(
    "div",
    { class: "stage treatment", "data-stage": "treatment" },
    h(
      "section",
      { class: "main wide" },
      heading,
      why,
      moneySlot,
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Concept"), concept),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Look"), look),
      h(
        "div",
        { class: "format-row", "data-part": "format" },
        h("span", { class: "field-label" }, "Format"),
        h("span", { class: "chip on static" }, "16:9"),
        h("label", { class: "seg" }, vertical, "Also a 9:16 vertical cut"),
        h("span", { class: "field-label" }, "Shot length"),
        ...barRadios.map((radio, at) =>
          h("label", { class: "seg" }, radio, `${SHOT_BARS[at]} bars`),
        ),
        h("span", { class: "field-label" }, "Budget"),
        h("label", { class: "seg" }, "$", budget),
      ),
      h("div", { class: "actions" }, save, saveWhy),
      h("h3", null, "Cast"),
      castBox,
      h("div", { class: "cast-add" }, addButton, fileInput, drop),
      h(
        "div",
        { class: "sfx-form" },
        h(
          "label",
          { class: "field narrow" },
          h("span", { class: "field-label" }, "Name"),
          castName,
        ),
        h(
          "label",
          { class: "field grow" },
          h("span", { class: "field-label" }, "Prompt"),
          castPrompt,
        ),
        drawButton,
      ),
      drawWhy,
      workSlot,
    ),
  );
  return {
    root,
    update,
    sync: () => {
      if (loadedFor !== app.project?.id) view = null;
      void load();
      void reattach(["cast"], load, async () => "");
      update();
    },
  };
}
