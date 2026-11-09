/**
 * The Deliver stage: DAW stems named like `122bpm 8A Vocals.wav`, the master
 * with BPM and key tags, a rekordbox XML (this track, or a crate as a
 * playlist), and the prepared track with its cue and loop points as JSON, into
 * `<project>/deliver` or a folder you name. The music video (the newest
 * 1080p render) and the 9:16 vertical cut are rows of their own: on once
 * there is a render, or a clip to cut from.
 */

import type { DeliverItem } from "../../export/run";
import { call, type DeliverOutcome, type DeliverView, errorText } from "./api";
import { fill, h, icon } from "./dom";
import { cancelLocal, local, localBusy, localNotice, localProgress, startLocal } from "./local";
import { app, redraw } from "./state";

let view: DeliverView | null = null;
let loadError: string | null = null;
let loadedFor: string | null = null;
let written: DeliverOutcome | null = null;
const picked = new Set<DeliverItem>(["stems", "master", "rekordbox", "loops"]);
let elsewhere = false;

async function load(): Promise<void> {
  const project = app.project;
  if (project === null) return;
  loadedFor = project.id;
  try {
    view = await call<DeliverView>(`deliver?project=${encodeURIComponent(project.id)}`);
    loadError = null;
  } catch (caught) {
    view = null;
    loadError = errorText(caught);
  }
  redraw("stage");
}

const heading = h("h2", null);
const banner = h("div", { class: "notice warn", role: "alert", "data-state": "no-ffmpeg" });
const rows = h("div", { class: "deliver-rows", "data-part": "items" });
const why = h("p", { class: "why", role: "status" });
const slot = h("div", { class: "slot", "data-part": "run-status" });
const resultBox = h("div", { class: "written", "data-part": "written" });
const folder = h("input", {
  type: "text",
  id: "deliver-folder",
  class: "folder-input",
  placeholder: "Full path, for example C:\\Music\\deliver",
  "aria-label": "Folder",
});
const crate = h("select", { id: "deliver-crate", "aria-label": "Rekordbox scope" });
const deliverButton = h(
  "button",
  { type: "button", class: "btn primary big", id: "deliver", onclick: () => void run() },
  icon("check"),
  "Deliver",
);
const cancelButton = h(
  "button",
  { type: "button", class: "btn", id: "deliver-cancel", onclick: () => void cancelLocal() },
  "Cancel",
);

const hereText = h("span", null, "In the project: deliver");
const here = h("input", { type: "radio", name: "where", id: "where-project", checked: true });
const there = h("input", { type: "radio", name: "where", id: "where-folder" });
for (const radio of [here, there])
  radio.addEventListener("change", () => {
    elsewhere = there.checked;
    buttons();
  });

type Row = { item: DeliverItem; title: string; detail: string; available: boolean; why: string };

function rowsOf(): Row[] {
  const v = view;
  return [
    {
      item: "stems",
      title: "Stems for a DAW",
      detail: "WAV 24-bit, named like 122bpm 8A Vocals.wav",
      available: (v?.stems ?? 0) > 0,
      why: "No stems yet. Split them on the Produce stage.",
    },
    {
      item: "master",
      title: "Master with BPM and key tags",
      detail: "ID3 TBPM and TKEY in an MP3, Vorbis tags in an OGG; a WAV carries none",
      available: v?.master != null,
      why: "No master yet. Make one on the Master stage.",
    },
    {
      item: "rekordbox",
      title: "rekordbox XML",
      detail: "Tempo grid, cues A to H and the loop; one playlist per crate",
      available: v?.prepared === true,
      why: "Not analysed yet. Analyse it on the Prepare stage.",
    },
    {
      item: "loops",
      title: "Track with cue and loop points as JSON",
      detail: "A copy of the analysed audio and a .loops.json beside it",
      available: v?.prepared === true,
      why: "Not analysed yet. Analyse it on the Prepare stage.",
    },
    {
      item: "video",
      title: "Music video",
      detail: `MP4, H.264, 1080p, the master as sound${v?.video.render?.stale === true ? ". The edit has changed since this render" : ""}`,
      available: v?.video.render != null,
      why: "No 1080p render yet. Render 1080p on the Edit stage first.",
    },
    {
      item: "vertical",
      title: "Vertical cut",
      detail: `9:16, about ${v?.video.verticalSec ?? 30} seconds of the chorus or the range you chose, ${v?.video.captions === true ? "captions on" : "no captions (no sung words)"}, centre crop. Rendered now: you confirm first`,
      available: (v?.video.clips ?? 0) > 0,
      why: "No shot has a clip yet. Shoot on the Shoot stage first.",
    },
  ];
}

function itemRow(row: Row): HTMLElement {
  const box = h("input", {
    type: "checkbox",
    id: `item-${row.item}`,
    checked: picked.has(row.item) && row.available,
    disabled: !row.available,
  });
  box.addEventListener("change", () => {
    if (box.checked) picked.add(row.item);
    else picked.delete(row.item);
    buttons();
  });
  return h(
    "label",
    { class: `deliver-row${row.available ? "" : " off"}`, "data-item": row.item },
    box,
    h(
      "span",
      { class: "deliver-text" },
      h("span", { class: "card-title" }, row.title),
      h("span", { class: "meta" }, row.available ? row.detail : row.why),
    ),
    row.item === "rekordbox" ? crate : null,
  );
}

function drawRows(): void {
  const v = view;
  const keep = crate.value;
  fill(
    crate,
    h("option", { value: "" }, "This track"),
    ...(v?.crates ?? []).map((each) =>
      h("option", { value: each.id }, `Crate: ${each.name} (${each.count})`),
    ),
  );
  if ((v?.crates ?? []).some((each) => each.id === keep)) crate.value = keep;
  fill(rows, ...rowsOf().map(itemRow));
}

function blocker(): string | null {
  if (view === null) return loadError ?? "Loading…";
  if (!view.ffmpeg.ok) return view.ffmpeg.message;
  const items = rowsOf().filter((each) => each.available && picked.has(each.item));
  if (items.length === 0) return "Tick something that is ready to deliver.";
  if (elsewhere && folder.value.trim() === "") return "Type the folder to write into.";
  return null;
}

function buttons(): void {
  const reason = blocker();
  const busy = localBusy();
  deliverButton.disabled = reason !== null || busy;
  cancelButton.disabled =
    !(local.job?.status === "running" && local.job.work === "deliver") || local.cancelling;
  cancelButton.textContent = local.cancelling ? "Cancelling…" : "Cancel";
  folder.disabled = !elsewhere || busy;
  here.disabled = busy;
  there.disabled = busy;
  crate.disabled = busy || !(view?.prepared ?? false);
  why.textContent =
    reason ??
    (busy ? "" : "Written on this computer. Files with the same name in the folder are replaced.");
  const bad = view !== null && !view.ffmpeg.ok;
  banner.hidden = !bad;
  fill(
    banner,
    icon("alert"),
    h(
      "div",
      { class: "notice-body" },
      h("strong", null, "Delivering needs ffmpeg. "),
      view?.ffmpeg.message ?? "",
    ),
  );
}

async function run(): Promise<void> {
  const project = app.project;
  if (project === null || view === null) return;
  const items = rowsOf()
    .filter((each) => each.available && picked.has(each.item))
    .map((each) => each.item);
  written = null;
  await startLocal(
    "deliver",
    "deliver-run",
    {
      project: project.id,
      items,
      dest: elsewhere ? folder.value.trim() : null,
      crate: crate.value === "" ? null : crate.value,
    },
    async (job) => {
      try {
        written = JSON.parse(job.result ?? "") as DeliverOutcome;
      } catch {
        written = null;
      }
      await load();
      return written === null ? "Done." : `Wrote ${written.files.length} files to ${written.dir}`;
    },
  );
}

function drawWritten(): void {
  fill(
    resultBox,
    h("h3", null, "Written"),
    written === null
      ? h(
          "p",
          { class: "empty", "data-state": "none-written" },
          "Nothing written in this session yet.",
        )
      : h(
          "div",
          null,
          h("ul", { class: "files" }, ...written.files.map((file) => h("li", null, file))),
          ...written.notes.map((each) => h("p", { class: "meta" }, each)),
        ),
  );
}

function update(): void {
  heading.textContent = app.project === null ? "Deliver" : `Deliver — ${app.project.title}`;
  hereText.textContent = `In the project: ${view?.folder ?? "deliver"}`;
  drawRows();
  drawWritten();
  buttons();
  fill(slot, localProgress("deliver"), localNotice("deliver"));
}

export function mountDeliver(): { root: HTMLElement; update: () => void; sync: () => void } {
  const root = h(
    "div",
    { class: "stage deliver", "data-stage": "deliver" },
    h(
      "section",
      { class: "main wide" },
      heading,
      banner,
      rows,
      h(
        "div",
        { class: "where", "data-part": "where" },
        h("span", { class: "field-label" }, "Folder"),
        h("label", { class: "seg" }, here, hereText),
        h("label", { class: "seg" }, there, "Another folder"),
        folder,
      ),
      h("div", { class: "actions" }, deliverButton, cancelButton, why),
      slot,
      resultBox,
    ),
  );
  return {
    root,
    update,
    sync: () => {
      if (loadedFor !== app.project?.id) {
        view = null;
        written = null;
      }
      void load();
      update();
    },
  };
}
