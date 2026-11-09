/** The header line (credits and keys) and the stage bar. */

import { call, errorText, type Status } from "./api";
import { type Child, h, icon } from "./dom";
import { app, redraw, type View } from "./state";

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
      { id: "arrange", label: "Arrange", slice: 2 },
      { id: "produce", label: "Produce", slice: 3 },
      { id: "mix", label: "Mix", slice: 3 },
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
  const on = app.view === "idea";
  return h(
    "button",
    {
      type: "button",
      class: `tab${on ? " on" : ""}`,
      "aria-current": on ? "page" : "false",
      onclick: () => go("idea"),
    },
    each.label,
  );
}

export function go(view: View): void {
  app.view = view;
  redraw("all");
}

export function renderStageBar(): HTMLElement {
  const library = app.view === "library";
  return h(
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
}
