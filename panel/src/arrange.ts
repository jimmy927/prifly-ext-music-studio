/**
 * The Arrange stage: the song's sections as a strip in bars, an editor for the
 * selected section, the Changes list, "Render changes", and the versions made
 * so far. The Changes list and the Render button's state come from the same
 * plan builder the extension renders with, so what is shown is what is sent.
 */

import {
  buildPlan,
  type Change,
  type Draft,
  labelOf,
  MAX_CHUNK_MS,
  MIN_CHUNK_MS,
  toDraft,
} from "../../arrange/plan";
import { barsIn } from "../../audio/bars";
import { type ArrangeView, call, errorText, type VersionItem } from "./api";
import { fill, h, icon } from "./dom";
import { player } from "./player";
import { app, redraw } from "./state";
import { busy, renderWork, startWork } from "./work";

let view: ArrangeView | null = null;
let loadError: string | null = null;
let loadedFor: string | null = null;
let draft: Draft[] = [];
let selected = 0;
/** The page below is stale: the data changed (loaded, picked) and strip, editor and versions must be drawn again. */
let dirty = false;

const clock = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

const styles = (text: string): string[] =>
  text
    .split(",")
    .map((each) => each.trim())
    .filter((each) => each !== "");

function resetDraft(): void {
  draft = view?.base ? toDraft(view.base.sections) : [];
  selected = 0;
}

async function load(): Promise<void> {
  const project = app.project;
  if (project === null) return;
  loadedFor = project.id;
  try {
    view = await call<ArrangeView>(`arrange?project=${encodeURIComponent(project.id)}`);
    loadError = null;
    resetDraft();
  } catch (caught) {
    view = null;
    loadError = errorText(caught);
  }
  dirty = true;
  redraw("stage");
}

/** The plan the current edits make, for the Changes list and the Render button. */
const planned = () => buildPlan("preview", view?.base?.sections ?? [], draft);

const heading = h("h2", null);
const unavailable = h("div", { class: "notice warn", "data-state": "unavailable" });
const strip = h("div", { class: "strip", "data-part": "strip" });
const editor = h("div", { class: "editor", "data-part": "editor" });
const changesBox = h("div", { class: "changes", "data-part": "changes" });
const versionsBox = h("div", { class: "versions", "data-part": "versions" });
const workSlot = h("div", { class: "work-slot" });
const why = h("p", { class: "why", role: "status" });

const insert = h(
  "button",
  { type: "button", class: "btn small", onclick: () => insertAfter() },
  "Insert section",
);
const remove = h(
  "button",
  { type: "button", class: "btn small", onclick: () => removeSelected() },
  "Delete section",
);
const revert = h(
  "button",
  { type: "button", class: "btn", onclick: () => revertAll() },
  "Revert edits",
);
const render = h(
  "button",
  {
    type: "button",
    class: "btn primary big",
    id: "render-changes",
    onclick: () => void renderChanges(),
  },
  icon("spark"),
  "Render changes",
);

/** Why Render changes is off, or null. */
function blocker(): string | null {
  if (view === null) return loadError ?? "Loading the song…";
  if (!view.available) return view.reason;
  if (busy()) return "A run is in progress.";
  const built = planned();
  return built.ok ? null : built.message;
}

function setButtons(): void {
  const editable = view?.available === true && !busy();
  const reason = blocker();
  render.disabled = reason !== null;
  insert.disabled = !editable;
  remove.disabled = !editable || draft.length <= 1;
  revert.disabled = !editable || !edited();
  for (const control of editor.querySelectorAll<HTMLInputElement>("input, textarea"))
    control.disabled = !editable;
  for (const control of versionsBox.querySelectorAll<HTMLButtonElement>("button.pick"))
    control.disabled = !editable;
  why.textContent = reason ?? "";
}

const edited = (): boolean => planned().changes.some((each) => each.kind !== "kept");

function insertAfter(): void {
  const near = draft[selected];
  const section: Draft = {
    text: "[New section]\n",
    durationMs: 15000,
    positiveStyles: near?.positiveStyles ?? [],
    negativeStyles: [],
    contextAdherence: "high",
    source: null,
  };
  draft.splice(selected + 1, 0, section);
  selected += 1;
  drawEdit();
}

function removeSelected(): void {
  if (draft.length <= 1) return;
  draft.splice(selected, 1);
  selected = Math.min(selected, draft.length - 1);
  drawEdit();
}

function revertAll(): void {
  resetDraft();
  drawEdit();
}

async function renderChanges(): Promise<void> {
  const project = app.project;
  if (project === null) return;
  await startWork("arrange-render", { project: project.id, sections: draft }, async () => {
    await load();
    redraw("head");
  });
}

function drawStrip(): void {
  const tempo = view?.tempo ?? 120;
  const changes = planned().changes;
  fill(
    strip,
    ...draft.map((each, at) => {
      const kind = changes[at]?.kind ?? "kept";
      return h(
        "button",
        {
          type: "button",
          class: `sec ${kind}${at === selected ? " on" : ""}`,
          style: `flex:${each.durationMs} 1 0`,
          "aria-pressed": String(at === selected),
          "data-kind": kind,
          "data-section": String(at),
          onclick: () => {
            selected = at;
            drawEdit();
          },
        },
        h("span", { class: "sec-name" }, labelOf(each.text)),
        h("span", { class: "sec-bars" }, `${barsIn(each.durationMs, tempo)} bars`),
      );
    }),
  );
}

function drawChanges(): void {
  const built = planned();
  const list: Change[] = built.changes;
  const count = (kind: Change["kind"]) => list.filter((each) => each.kind === kind).length;
  fill(
    changesBox,
    h("h3", null, "Changes"),
    list.every((each) => each.kind === "kept")
      ? h("p", { class: "empty" }, "Nothing changed yet. Select a section and edit it.")
      : h(
          "ul",
          { class: "change-list" },
          ...list
            .filter((each) => each.kind !== "kept")
            .map((each) =>
              h(
                "li",
                { class: `change ${each.kind}`, "data-kind": each.kind },
                h("span", { class: "tag" }, each.kind),
                `${each.label}${each.fields.length === 0 ? "" : ` (${each.fields.join(", ")})`}`,
              ),
            ),
        ),
    h(
      "p",
      { class: "meta" },
      `${count("changed") + count("inserted")} to generate, ${count("kept")} kept as audio, ${count("deleted")} deleted`,
    ),
  );
}

function field(label: string, control: HTMLElement): HTMLElement {
  return h("label", { class: "field" }, h("span", { class: "field-label" }, label), control);
}

function drawEditor(): void {
  const section = draft[selected];
  if (section === undefined) {
    fill(editor, h("p", { class: "empty" }, "No section to edit."));
    return;
  }
  const tempo = view?.tempo ?? 120;
  const bars = h(
    "span",
    { class: "meta" },
    `${barsIn(section.durationMs, tempo)} bars at ${tempo} BPM`,
  );
  const edit = (apply: (value: string) => void) => (event: Event) => {
    apply((event.target as HTMLInputElement).value);
    drawStrip();
    drawChanges();
    setButtons();
  };
  fill(
    editor,
    h("h3", null, `Section ${selected + 1}: ${labelOf(section.text)}`),
    field(
      "Positive styles (comma separated)",
      h("input", {
        type: "text",
        name: "positive",
        value: section.positiveStyles.join(", "),
        oninput: edit((v) => {
          section.positiveStyles = styles(v);
        }),
      }),
    ),
    field(
      "Negative styles (comma separated)",
      h("input", {
        type: "text",
        name: "negative",
        value: section.negativeStyles.join(", "),
        oninput: edit((v) => {
          section.negativeStyles = styles(v);
        }),
      }),
    ),
    field(
      "Lyrics, starting with the [Section name]",
      h(
        "textarea",
        {
          name: "lyrics",
          rows: 6,
          oninput: edit((v) => {
            section.text = v;
          }),
        },
        section.text,
      ),
    ),
    field(
      "Length (seconds)",
      h("input", {
        type: "number",
        name: "length",
        min: MIN_CHUNK_MS / 1000,
        max: MAX_CHUNK_MS / 1000,
        step: 0.5,
        value: String(section.durationMs / 1000),
        oninput: edit((v) => {
          section.durationMs = Math.round(Number(v) * 1000);
          bars.textContent = `${barsIn(section.durationMs, tempo)} bars at ${tempo} BPM`;
        }),
      }),
    ),
    bars,
  );
}

function drawVersions(): void {
  const project = app.project;
  const all: VersionItem[] = [...(view?.versions ?? [])].reverse();
  fill(
    versionsBox,
    h("h3", null, "Versions"),
    all.length === 0
      ? h(
          "p",
          { class: "empty" },
          "No version yet. Render changes to make Version 1; the sketch stays as it is.",
        )
      : h(
          "ul",
          { class: "version-list" },
          ...all.map((each) => versionRow(each, project?.id ?? "")),
        ),
  );
}

function versionRow(each: VersionItem, project: string): HTMLElement {
  const current = view?.active === each.id;
  const c = each.counts;
  return h(
    "li",
    { class: `version${current ? " current" : ""}`, "data-version": each.id },
    h(
      "div",
      { class: "card-head" },
      h("div", { class: "card-title" }, `Version ${each.n}`),
      current
        ? h("span", { class: "badge" }, icon("check", 14), "Current")
        : h(
            "button",
            { type: "button", class: "btn small pick", onclick: () => void pick(each.id) },
            "Use this version",
          ),
    ),
    player(project, each.id, "version", `version ${each.n}`),
    h(
      "div",
      { class: "meta" },
      `${clock(each.durationMs)} · ${each.sectionCount} sections · ${c.changed} changed, ${c.inserted} inserted, ${c.kept} kept, ${c.deleted} deleted`,
    ),
  );
}

async function pick(id: string): Promise<void> {
  const project = app.project;
  if (project === null) return;
  try {
    view = await call<ArrangeView>("version-pick", { project: project.id, version: id });
    resetDraft();
  } catch (caught) {
    loadError = errorText(caught);
  }
  drawEdit();
}

/** Everything that follows the draft: the strip, the editor, the Changes list, the buttons. */
function drawEdit(): void {
  drawStrip();
  drawEditor();
  drawChanges();
  drawVersions();
  setButtons();
}

function update(): void {
  const title = app.project?.title ?? "";
  heading.textContent = title === "" ? "Arrange" : `Arrange — ${title}`;
  unavailable.hidden = true;
  fill(unavailable);
  const reason = view?.available === false ? view.reason : loadError;
  if (reason !== null && reason !== undefined) {
    unavailable.hidden = false;
    fill(unavailable, icon("info"), h("div", { class: "notice-body" }, reason));
  }
  fill(workSlot, renderWork());
  if (dirty) {
    dirty = false;
    drawEdit();
  }
  setButtons();
}

export function mountArrange(): { root: HTMLElement; update: () => void; sync: () => void } {
  const root = h(
    "div",
    { class: "stage arrange", "data-stage": "arrange" },
    h(
      "section",
      { class: "main wide" },
      heading,
      unavailable,
      strip,
      h("div", { class: "row" }, insert, remove),
      editor,
      changesBox,
      h(
        "div",
        { class: "actions" },
        render,
        revert,
        h("p", { class: "cost" }, "Billed by ElevenLabs to your plan. You confirm first."),
      ),
      why,
      workSlot,
      versionsBox,
    ),
  );

  return {
    root,
    update,
    sync: () => {
      if (app.project !== null && (loadedFor !== app.project.id || view === null)) {
        view = null;
        draft = [];
        void load();
      }
      dirty = true;
      update();
    },
  };
}
