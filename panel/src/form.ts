/** The Idea stage's form: brief, preset chips, tempo, key, length, vocals and engine. */

import {
  ENGINE_LABELS,
  ENGINES,
  type EngineId,
  formatLength,
  LENGTHS,
  PRESETS,
  type Preset,
  type Vocals,
} from "../../project/brief";
import { h } from "./dom";
import { app } from "./state";

const NOTES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const KEYS = NOTES.flatMap((note) => [`${note} major`, `${note} minor`]);
const VOCAL_LABELS: Record<Vocals, string> = {
  generated: "Generated lyrics",
  mine: "My lyrics",
  instrumental: "Instrumental",
};

export type FormParts = {
  root: HTMLElement;
  /** Copies the draft into the inputs (after a preset, a suggestion or an opened project). */
  sync: () => void;
};

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h(
    "label",
    { class: "field" },
    h("span", { class: "field-label" }, label),
    control,
    hint === undefined ? null : h("span", { class: "hint" }, hint),
  );
}

function applyPreset(preset: Preset): void {
  const draft = app.draft;
  draft.preset = preset.id;
  draft.tempo = preset.tempo;
  draft.key = preset.key;
  draft.lengthSec = preset.lengthSec;
  draft.vocals = preset.vocals;
  if (draft.text.trim() === "") draft.text = `${preset.label} track`;
}

/** The form; `onChange` runs after every edit so the button and notices follow. */
export function buildForm(onChange: () => void): FormParts {
  const text = h("textarea", {
    id: "brief",
    rows: 4,
    maxlength: 2000,
    placeholder: "Describe the music: mood, instruments, what it is for.",
  });
  const chips = PRESETS.map((preset) =>
    h(
      "button",
      {
        type: "button",
        class: "chip",
        "data-preset": preset.id,
        onclick: () => {
          applyPreset(preset);
          sync();
          onChange();
        },
      },
      preset.label,
    ),
  );
  const tempo = h("input", { id: "tempo", type: "number", min: 40, max: 240, placeholder: "Any" });
  const key = h(
    "select",
    { id: "key" },
    h("option", { value: "" }, "Any"),
    ...KEYS.map((each) => h("option", { value: each }, each)),
  );
  const length = h(
    "select",
    { id: "length" },
    ...LENGTHS.map((each) => h("option", { value: each }, formatLength(each))),
  );
  const engine = h(
    "select",
    { id: "engine" },
    ...ENGINES.map((each) => h("option", { value: each }, ENGINE_LABELS[each])),
  );
  const lyrics = h("textarea", {
    id: "lyrics",
    rows: 5,
    maxlength: 6000,
    placeholder: "[Verse]\nYour lines here",
  });
  const lyricsField = field("Lyrics", lyrics);
  const vocals = (["generated", "mine", "instrumental"] as const).map((each) =>
    h(
      "label",
      { class: "seg" },
      h("input", { type: "radio", name: "vocals", value: each }),
      h("span", null, VOCAL_LABELS[each]),
    ),
  );

  const sync = (): void => {
    const draft = app.draft;
    text.value = draft.text;
    tempo.value = draft.tempo === null ? "" : String(draft.tempo);
    key.value = draft.key;
    length.value = String(draft.lengthSec);
    engine.value = draft.engine;
    lyrics.value = draft.lyrics;
    lyricsField.hidden = draft.vocals !== "mine";
    for (const radio of vocals) {
      const input = radio.querySelector("input");
      if (input !== null) input.checked = input.value === draft.vocals;
    }
    for (const chip of chips)
      chip.classList.toggle("on", chip.getAttribute("data-preset") === draft.preset);
  };

  const read = (): void => {
    const draft = app.draft;
    draft.text = text.value;
    draft.tempo = tempo.value === "" ? null : Number(tempo.value);
    draft.key = key.value;
    draft.lengthSec = Number(length.value);
    draft.engine = ENGINES.find((each): each is EngineId => each === engine.value) ?? "elevenlabs";
    draft.lyrics = lyrics.value;
    const picked = vocals
      .map((each) => each.querySelector("input"))
      .find((input) => input?.checked === true);
    draft.vocals =
      (["generated", "mine", "instrumental"] as const).find((each) => each === picked?.value) ??
      "generated";
    lyricsField.hidden = draft.vocals !== "mine";
    onChange();
  };
  for (const control of [text, tempo, key, length, engine, lyrics, ...vocals]) {
    control.addEventListener("input", read);
    control.addEventListener("change", read);
  }

  const root = h(
    "div",
    { class: "form" },
    field("Brief", text),
    h(
      "div",
      { class: "field" },
      h("span", { class: "field-label" }, "Presets"),
      h("div", { class: "chips" }, ...chips),
    ),
    h(
      "div",
      { class: "row" },
      field("Tempo (BPM)", tempo),
      field("Key", key),
      field("Length", length, "Of the finished song"),
    ),
    h(
      "div",
      { class: "field" },
      h("span", { class: "field-label" }, "Vocals"),
      h("div", { class: "segs" }, ...vocals),
    ),
    lyricsField,
    field("Engine", engine),
  );
  sync();
  return { root, sync };
}
