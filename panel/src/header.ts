/** The header line (credits and keys) and the stage bar. */

import { LYRIA_REASON } from "../../project/reasons";
import { call, errorText, type Status } from "./api";
import { type Child, h, icon } from "./dom";
import { app, redraw, STAGES, type View } from "./state";

export async function loadStatus(): Promise<void> {
  try {
    app.status = await call<Status>("status");
    app.statusError = null;
  } catch (caught) {
    app.statusError = errorText(caught);
  }
  redraw("head");
  redraw("idea");
}

const SETTINGS = "Settings → Extensions → Music Studio";

function eleven(): Child {
  const status = app.status;
  if (status === null)
    return h(
      "span",
      { class: "pill muted" },
      app.statusError === null ? "Checking keys…" : "Keys unknown",
    );
  if (!status.elevenlabs.keySet) {
    return h(
      "span",
      { class: "pill warn", title: `Add the key in ${SETTINGS}` },
      icon("lock", 13),
      "ElevenLabs: no key",
    );
  }
  const credits = status.elevenlabs.credits;
  if (credits === null) {
    return h(
      "span",
      { class: "pill warn", title: status.elevenlabs.error ?? "" },
      icon("alert", 13),
      "ElevenLabs: credits unavailable",
    );
  }
  return h(
    "span",
    {
      class: "pill ok",
      title: `${credits.used.toLocaleString("en-US")} of ${credits.limit.toLocaleString("en-US")} used, plan ${credits.tier}`,
    },
    `ElevenLabs: ${credits.left.toLocaleString("en-US")} credits left`,
  );
}

export function renderHeader(): HTMLElement {
  const gemini = app.status?.gemini.keySet;
  return h(
    "div",
    { class: "status-line", "data-part": "status" },
    eleven(),
    gemini === undefined
      ? null
      : h(
          "span",
          {
            class: `pill ${gemini ? "ok" : "warn"}`,
            title: gemini ? "" : `Add the key in ${SETTINGS}`,
          },
          gemini ? "Gemini key set" : "Gemini key not set",
        ),
  );
}

type Tab = { id: string; label: string; slice?: number };
const GROUPS: { name: string; tabs: Tab[] }[] = [
  {
    name: "Song",
    tabs: [
      { id: "idea", label: "Idea" },
      { id: "arrange", label: "Arrange" },
      { id: "produce", label: "Produce" },
      { id: "mix", label: "Mix" },
      { id: "master", label: "Master", slice: 4 },
    ],
  },
  { name: "DJ", tabs: [{ id: "prepare", label: "Prepare", slice: 4 }] },
  {
    name: "Video",
    tabs: [
      { id: "treatment", label: "Treatment", slice: 6 },
      { id: "storyboard", label: "Storyboard", slice: 6 },
      { id: "shoot", label: "Shoot", slice: 7 },
      { id: "edit", label: "Edit", slice: 7 },
    ],
  },
  { name: "", tabs: [{ id: "deliver", label: "Deliver", slice: 5 }] },
];

function tab(each: Tab): HTMLElement {
  if (each.slice !== undefined) {
    return h(
      "button",
      {
        type: "button",
        class: "tab",
        disabled: true,
        "aria-disabled": "true",
        title: `${each.label} arrives in slice ${each.slice}.`,
      },
      each.label,
    );
  }
  const view = each.id as View;
  const gated = STAGES.includes(view) ? gate(view) : { enabled: true, reason: null };
  const on = app.view === view;
  return h(
    "button",
    {
      type: "button",
      class: `tab${on ? " on" : ""}`,
      "aria-current": on ? "page" : "false",
      "data-stage": each.id,
      disabled: !gated.enabled,
      "aria-disabled": String(!gated.enabled),
      ...(gated.reason === null ? {} : { title: gated.reason }),
      onclick: () => go(view),
    },
    each.label,
  );
}

/** Whether a stage's tab is on, and why not. Arrange needs a chosen ElevenLabs sketch; Produce and Mix need any chosen sketch. */
export function gate(view: View): { enabled: boolean; reason: string | null } {
  const project = app.project;
  if (project === null || project.chosen === null)
    return { enabled: false, reason: "Choose a sketch on the Idea stage first." };
  if (view === "arrange") {
    const engine = project.sketchList.find((each) => each.id === project.chosen)?.engine;
    if (engine !== "elevenlabs") return { enabled: false, reason: LYRIA_REASON };
  }
  return { enabled: true, reason: null };
}

/** The reason Arrange is off, in words on the page (not only in a tooltip); empty when nothing is off for a reason worth saying. */
function stageNote(): string {
  if (app.project === null)
    return "Open a project from the Library to use Arrange, Produce and Mix.";
  return gate("arrange").reason ?? "";
}

export function go(view: View): void {
  app.view = view;
  redraw("all");
}

export function renderStageBar(): HTMLElement {
  const library = app.view === "library";
  const nav = h(
    "nav",
    { class: "stagebar", "aria-label": "Stages", "data-part": "stagebar" },
    ...GROUPS.map((group) =>
      h(
        "div",
        { class: "group", "data-group": group.name === "" ? "deliver" : group.name.toLowerCase() },
        group.name === "" ? null : h("span", { class: "group-name" }, group.name),
        h("div", { class: "tabs" }, ...group.tabs.map(tab)),
      ),
    ),
    h("span", { class: "grow" }),
    h(
      "button",
      {
        type: "button",
        class: `tab library${library ? " on" : ""}`,
        "aria-current": library ? "page" : "false",
        onclick: () => go("library"),
      },
      icon("library", 15),
      "Library",
    ),
  );
  // Always there, empty when there is nothing to say, so the page below never moves.
  const note = h(
    "p",
    { class: "stage-note", "data-part": "stage-note", role: "status" },
    stageNote(),
  );
  return h("div", { class: "bar-wrap" }, nav, note);
}
