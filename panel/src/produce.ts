/**
 * The Produce stage: split the song into stems (one lane each, playable), and
 * add sound-effect layers from a text prompt with a start bar and a length.
 * Buttons keep their places; they are disabled by state, never hidden.
 */

import { call, errorText, type LayerItem, type ProduceView } from "./api";
import { fill, h, icon } from "./dom";
import { player } from "./player";
import { app, redraw } from "./state";
import { busy, renderWork, startWork } from "./work";

let view: ProduceView | null = null;
let loadError: string | null = null;
let loadedFor: string | null = null;
let dirty = false;

async function load(): Promise<void> {
  const project = app.project;
  if (project === null) return;
  loadedFor = project.id;
  try {
    view = await call<ProduceView>(`produce?project=${encodeURIComponent(project.id)}`);
    loadError = null;
  } catch (caught) {
    view = null;
    loadError = errorText(caught);
  }
  dirty = true;
  redraw("stage");
}

/** Why a paid button is off, or null. */
function blocker(): string | null {
  if (view === null) return loadError ?? "Loading…";
  if (view.source === null) return "Choose a sketch on the Idea stage first.";
  if (app.status !== null && !app.status.elevenlabs.keySet)
    return "No ElevenLabs key. Add it in Settings → Extensions → Music Studio.";
  return busy() ? "A run is in progress." : null;
}

const heading = h("h2", null);
const sourceLine = h("p", { class: "meta" });
const stemsBox = h("div", { class: "lanes", "data-part": "stems" });
const layersBox = h("div", { class: "lanes", "data-part": "layers" });
const workSlot = h("div", { class: "work-slot" });
const split = h(
  "button",
  { type: "button", class: "btn primary", id: "split-stems", onclick: () => void splitStems() },
  icon("wave"),
  "Split stems",
);
const why = h("p", { class: "why", role: "status" });
const prompt = h("input", {
  type: "text",
  name: "prompt",
  placeholder: "cymbal swell, vinyl crackle, door slam…",
  oninput: () => buttons(),
});
const bar = h("input", { type: "number", name: "start-bar", min: 1, step: 1, value: "1" });
const length = h("input", {
  type: "number",
  name: "length",
  min: 0.5,
  max: 30,
  step: 0.5,
  value: "3",
  oninput: () => buttons(),
});
const loop = h("input", { type: "checkbox", name: "loop" });
const add = h(
  "button",
  { type: "button", class: "btn primary", id: "add-sfx", onclick: () => void addLayer() },
  icon("spark"),
  "Add sound effect",
);
const addWhy = h("p", { class: "why", role: "status" });

function addBlocker(): string | null {
  const base = blocker();
  if (base !== null) return base;
  if (prompt.value.trim() === "") return "Describe the sound first.";
  const sec = Number(length.value);
  if (!(sec >= 0.5 && sec <= 30)) return "A sound effect lasts 0.5 to 30 seconds.";
  return null;
}

function buttons(): void {
  const reason = blocker();
  split.disabled = reason !== null;
  why.textContent =
    reason ?? (view?.stems.length ? "Splitting again replaces the stems below." : "");
  const addReason = addBlocker();
  add.disabled = addReason !== null;
  addWhy.textContent = addReason === "Describe the sound first." ? "" : (addReason ?? "");
  for (const control of layersBox.querySelectorAll<HTMLButtonElement>("button.layer-action"))
    control.disabled = busy();
}

async function splitStems(): Promise<void> {
  const project = app.project;
  if (project === null) return;
  await startWork("stems-split", { project: project.id }, load);
}

async function addLayer(): Promise<void> {
  const project = app.project;
  if (project === null) return;
  await startWork(
    "sfx-add",
    {
      project: project.id,
      prompt: prompt.value,
      startBar: Number(bar.value),
      lengthSec: Number(length.value),
      loop: loop.checked,
    },
    async () => {
      prompt.value = "";
      await load();
    },
  );
}

async function regenerate(layer: LayerItem): Promise<void> {
  const project = app.project;
  if (project === null) return;
  await startWork("sfx-regenerate", { project: project.id, layer: layer.id }, load);
}

async function remove(layer: LayerItem): Promise<void> {
  const project = app.project;
  if (project === null) return;
  try {
    await call("sfx-remove", { project: project.id, layer: layer.id });
  } catch (caught) {
    loadError = errorText(caught);
  }
  await load();
}

function layerRow(project: string, layer: LayerItem): HTMLElement {
  return h(
    "div",
    { class: "lane layer", "data-layer": layer.id },
    h(
      "div",
      { class: "lane-head" },
      h("span", { class: "lane-name" }, layer.prompt),
      h(
        "span",
        { class: "meta" },
        `bar ${layer.startBar} · ${layer.lengthSec} s${layer.loop ? " · loop" : ""}`,
      ),
      h("span", { class: "grow" }),
      h(
        "button",
        {
          type: "button",
          class: "btn small layer-action",
          onclick: () => void regenerate(layer),
        },
        "Regenerate",
      ),
      h(
        "button",
        { type: "button", class: "btn small layer-action", onclick: () => void remove(layer) },
        "Remove",
      ),
    ),
    player(project, layer.id, "layer", `sound effect ${layer.prompt}`),
  );
}

function draw(): void {
  const project = app.project;
  if (project === null || view === null) {
    fill(
      stemsBox,
      h("p", { class: "empty" }, loadError ?? "Open a project from the Library first."),
    );
    fill(layersBox);
    return;
  }
  sourceLine.textContent =
    view.source === null
      ? ""
      : `Working from ${view.source.label}.${view.stemSource === null ? "" : ` Stems are from ${view.stemSource}.`}`;
  fill(
    stemsBox,
    view.stems.length === 0
      ? h(
          "p",
          { class: "empty" },
          "No stems yet. Split stems to separate the song into vocals, drums, bass and the rest.",
        )
      : null,
    ...view.stems.map((each) =>
      h(
        "div",
        { class: "lane stem", "data-stem": each.name },
        h("div", { class: "lane-head" }, h("span", { class: "lane-name" }, each.name)),
        player(project.id, each.name, "stem", `${each.name} stem`),
      ),
    ),
  );
  fill(
    layersBox,
    view.layers.length === 0 ? h("p", { class: "empty" }, "No sound effects yet.") : null,
    ...view.layers.map((each) => layerRow(project.id, each)),
  );
}

function update(): void {
  heading.textContent = app.project === null ? "Produce" : `Produce — ${app.project.title}`;
  fill(workSlot, renderWork());
  if (dirty) {
    dirty = false;
    draw();
  }
  buttons();
}

export function mountProduce(): { root: HTMLElement; update: () => void; sync: () => void } {
  const root = h(
    "div",
    { class: "stage produce", "data-stage": "produce" },
    h(
      "section",
      { class: "main wide" },
      heading,
      sourceLine,
      h("h3", null, "Stems"),
      h(
        "div",
        { class: "actions" },
        split,
        h("p", { class: "cost" }, "Billed by ElevenLabs to your plan. You confirm first."),
      ),
      why,
      stemsBox,
      h("h3", null, "Sound effects"),
      h(
        "div",
        { class: "sfx-form" },
        h("label", { class: "field grow" }, h("span", { class: "field-label" }, "Prompt"), prompt),
        h(
          "label",
          { class: "field narrow" },
          h("span", { class: "field-label" }, "Start bar"),
          bar,
        ),
        h(
          "label",
          { class: "field narrow" },
          h("span", { class: "field-label" }, "Length (s)"),
          length,
        ),
        h("label", { class: "check" }, loop, "Loop"),
        add,
      ),
      addWhy,
      layersBox,
      workSlot,
    ),
  );

  return {
    root,
    update,
    sync: () => {
      // Always read again: an Arrange render may have made a newer version since.
      if (loadedFor !== app.project?.id) view = null;
      void load();
      dirty = true;
      update();
    },
  };
}
