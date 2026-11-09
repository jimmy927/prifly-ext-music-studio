/**
 * The Prepare stage's controls: the grid (nudge, first beat, a typed BPM),
 * cues A to H, the loop, the keys that mix, and crates. Every button is always
 * there; it is disabled until the track can take it.
 */

import { clockText, LOOP_BARS, SLOTS } from "../../prep/grid";
import { call, errorText } from "./api";
import { fill, h, icon } from "./dom";
import { localBusy } from "./local";
import { edit, prep, ps } from "./prep-state";
import { app, redraw } from "./state";

/** Set by the page: seek the transport to a time. */
export const hooks: { seek: (sec: number) => void } = { seek: () => undefined };

const gridOf = () => prep()?.grid ?? null;
const editable = (): boolean => gridOf() !== null && !localBusy();

function button(
  label: string,
  onClick: () => void,
  enabled: boolean,
  extra = "",
): HTMLButtonElement {
  return h(
    "button",
    { type: "button", class: `btn small ${extra}`.trim(), disabled: !enabled, onclick: onClick },
    label,
  );
}

export const bpmInput = h("input", {
  type: "number",
  min: 40,
  max: 240,
  step: 0.01,
  id: "bpm-input",
  "aria-label": "BPM",
  placeholder: "BPM",
});

export function gridControls(): HTMLElement {
  const nudge = (ms: number) =>
    button(
      `${ms > 0 ? "+" : "−"}${Math.abs(ms)} ms`,
      () => void edit("prep-nudge", { ms }),
      editable(),
    );
  const typed = (): void => {
    const bpm = Number(bpmInput.value);
    void edit("prep-bpm", { bpm: bpmInput.value.trim() === "" ? null : bpm });
  };
  bpmInput.disabled = prep() === null || localBusy();
  return h(
    "div",
    { class: "controls-row", "data-part": "grid" },
    h("span", { class: "field-label" }, "Grid"),
    nudge(-10),
    nudge(-1),
    nudge(1),
    nudge(10),
    button("First beat here", () => void edit("prep-first-beat", { sec: ps.playhead }), editable()),
    h("span", { class: "field-label sep" }, "BPM"),
    bpmInput,
    button("Set BPM", typed, prep() !== null && !localBusy()),
  );
}

function cueRow(slot: (typeof SLOTS)[number]): HTMLElement {
  const cue = prep()?.cues.find((each) => each.slot === slot);
  const beat = gridOf() === null ? 0 : 60 / (gridOf()?.bpm ?? 120);
  const name = h("input", {
    type: "text",
    class: "cue-name",
    value: cue?.name ?? "",
    placeholder: cue === undefined ? "" : "Name",
    "aria-label": `Name of cue ${slot}`,
    disabled: cue === undefined || localBusy(),
  });
  name.addEventListener("change", () => {
    if (cue !== undefined) void edit("prep-cue", { slot, sec: cue.sec, name: name.value });
  });
  const move = (by: number) => () => {
    if (cue !== undefined) void edit("prep-cue", { slot, sec: cue.sec + by * beat });
  };
  return h(
    "div",
    { class: `cue-row${cue === undefined ? "" : " set"}`, "data-slot": slot },
    h("span", { class: "cue-slot" }, slot),
    h("span", { class: "cue-time" }, cue === undefined ? "—" : clockText(cue.sec)),
    name,
    button("Set here", () => void edit("prep-cue", { slot, sec: ps.playhead }), editable()),
    button("Go", () => cue !== undefined && hooks.seek(cue.sec), cue !== undefined),
    button("−1 beat", move(-1), cue !== undefined && editable()),
    button("+1 beat", move(1), cue !== undefined && editable()),
    button(
      "Delete",
      () => void edit("prep-cue-delete", { slot }),
      cue !== undefined && !localBusy(),
    ),
  );
}

export function cuesBox(): HTMLElement {
  const auto = button(
    "Cues from sections",
    () => void edit("prep-auto-cues"),
    editable() && ps.view?.hasPlan === true,
  );
  auto.title =
    ps.view?.hasPlan === true
      ? "Replace the cues with one per section start"
      : "This song has no section plan";
  return h(
    "div",
    { class: "cues", "data-part": "cues" },
    h("div", { class: "cues-head" }, h("h3", null, "Cues"), auto),
    ...SLOTS.map(cueRow),
  );
}

export const loopBars = h(
  "select",
  { id: "loop-bars", "aria-label": "Loop length in bars" },
  ...LOOP_BARS.map((bars) =>
    h(
      "option",
      { value: String(bars), selected: bars === 4 },
      `${bars} ${bars === 1 ? "bar" : "bars"}`,
    ),
  ),
);

export function loopControls(): HTMLElement {
  const loop = prep()?.loop ?? null;
  return h(
    "div",
    { class: "controls-row", "data-part": "loop" },
    h("span", { class: "field-label" }, "Loop"),
    loopBars,
    button(
      "Set loop here",
      () => void edit("prep-loop", { startSec: ps.playhead, bars: Number(loopBars.value) }),
      editable(),
    ),
    button("Clear loop", () => void edit("prep-loop-clear"), loop !== null && !localBusy()),
    button("Go to loop", () => loop !== null && hooks.seek(loop.startSec), loop !== null),
    h(
      "span",
      { class: "meta" },
      loop === null
        ? "No loop. It starts on the beat nearest the playhead."
        : `${clockText(loop.startSec)} to ${clockText(loop.endSec)}, ${loop.bars} ${loop.bars === 1 ? "bar" : "bars"}`,
    ),
  );
}

export function compatibleRow(): HTMLElement {
  const list = prep()?.compatible ?? [];
  return h(
    "div",
    { class: "controls-row", "data-part": "compatible" },
    h("span", { class: "field-label" }, "Mixes with"),
    list.length === 0
      ? h("span", { class: "meta" }, "The key is not known yet.")
      : h(
          "span",
          { class: "chips" },
          ...list.map((each) =>
            h(
              "span",
              { class: "key-chip", title: each.name },
              `${each.code} ${each.name}, ${each.relation}`,
            ),
          ),
        ),
  );
}

export const crateSelect = h("select", { id: "crate-pick", "aria-label": "Crate" });

async function toggleCrate(crate: string, inCrate: boolean): Promise<void> {
  const project = app.project?.id;
  if (project === undefined || ps.view === null) return;
  try {
    const answer = await call<{ ok: true; crates: typeof ps.view.crates }>("prep-crate", {
      project,
      crate,
      in: inCrate,
    });
    ps.view = { ...ps.view, crates: answer.crates };
  } catch (caught) {
    ps.message = errorText(caught);
  }
  redraw("stage");
}

export function crateControls(): HTMLElement {
  const crates = ps.view?.crates ?? [];
  const open = crates.filter((each) => !each.has);
  const keep = crateSelect.value;
  fill(crateSelect, ...open.map((each) => h("option", { value: each.id }, each.name)));
  if (open.some((each) => each.id === keep)) crateSelect.value = keep;
  crateSelect.disabled = open.length === 0 || prep() === null;
  return h(
    "div",
    { class: "controls-row", "data-part": "crates" },
    h("span", { class: "field-label" }, "Crates"),
    crateSelect,
    button(
      "Add to crate",
      () => void toggleCrate(crateSelect.value, true),
      open.length > 0 && prep() !== null,
    ),
    crates.length === 0
      ? h("span", { class: "meta" }, "No crates yet. Make one in the Library.")
      : h(
          "span",
          { class: "chips" },
          ...crates
            .filter((each) => each.has)
            .map((each) =>
              h(
                "span",
                { class: "crate-chip" },
                each.name,
                h(
                  "button",
                  {
                    type: "button",
                    class: "chip-x",
                    "aria-label": `Remove from ${each.name}`,
                    onclick: () => void toggleCrate(each.id, false),
                  },
                  icon("close", 12),
                ),
              ),
            ),
        ),
  );
}
