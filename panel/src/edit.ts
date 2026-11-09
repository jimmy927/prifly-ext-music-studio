/**
 * The Edit stage: the shots cut together on a timeline in bars. Each shot
 * comes in with a cut, a flash on the beat or a one-beat crossfade, and plays
 * at normal speed or ramps down to 50% at its end; karaoke captions come from
 * the song's word timestamps; the soundtrack is the master and the clips are
 * muted. "Preview 540p" renders on this computer; "Render 1080p" asks first
 * and says it will load the machine. Both are cancellable jobs. A shot that
 * has no clip renders black and the page says so. Buttons keep their places;
 * they are disabled by state, never hidden.
 */

import { clockText } from "../../prep/grid";
import {
  call,
  type EditView,
  errorText,
  type Job,
  type RenderOutcome,
  type RenderView,
} from "./api";
import { fill, h, icon } from "./dom";
import { go } from "./header";
import { cancelLocal, local, localBusy, localNotice, localProgress, startLocal } from "./local";
import { app, redraw } from "./state";
import { drawTimeline } from "./timeline";
import { clip, reattach } from "./video";
import { busy } from "./work";

let view: EditView | null = null;
let loadError: string | null = null;
let loadedFor: string | null = null;
let dirty = false;
let message: string | null = null;
let previewShown = 0;

const heading = h("h2", null);
const banner = h("div", { class: "notice warn", role: "alert", "data-state": "no-ffmpeg" });
const why = h("p", { class: "why", role: "status", "data-part": "why" });
const timelineBox = h("div", { class: "timeline-box", "data-part": "timeline" });
const shotsBox = h("div", { class: "edit-rows", "data-part": "shots" });
const warnBox = h("ul", { class: "warnings", "data-part": "warnings", role: "status" });
const slot = h("div", { class: "slot", "data-part": "run-status" });
const rendersBox = h("div", { class: "renders", "data-part": "renders" });
const previewBox = h("div", { class: "preview-box", "data-part": "preview" });
const actionWhy = h("p", { class: "why", role: "status", "data-part": "action-why" });
const captionsBox = h("input", {
  type: "checkbox",
  name: "captions",
  "aria-label": "Karaoke captions",
});
const captionsNote = h("span", { class: "meta" });
const prepareButton = h(
  "button",
  { type: "button", class: "btn", id: "open-storyboard", onclick: () => go("storyboard") },
  "Open Storyboard",
);
const previewButton = h(
  "button",
  {
    type: "button",
    class: "btn primary big",
    id: "edit-preview",
    onclick: () => void render("preview"),
  },
  icon("play"),
  "Preview 540p",
);
const finalButton = h(
  "button",
  { type: "button", class: "btn big", id: "edit-render", onclick: () => void render("render") },
  icon("check"),
  "Render 1080p",
);
const cancelButton = h(
  "button",
  { type: "button", class: "btn", id: "edit-cancel", onclick: () => void cancelLocal() },
  "Cancel",
);

async function load(): Promise<void> {
  const project = app.project;
  if (project === null) return;
  loadedFor = project.id;
  try {
    view = await call<EditView>(`edit?project=${encodeURIComponent(project.id)}`);
    loadError = null;
  } catch (caught) {
    view = null;
    loadError = errorText(caught);
  }
  dirty = true;
  redraw("stage");
}

async function save(body: Record<string, unknown>): Promise<void> {
  const project = app.project;
  if (project === null) return;
  message = null;
  try {
    view = await call<EditView>("edit-save", { project: project.id, ...body });
    dirty = true;
  } catch (caught) {
    message = errorText(caught);
  }
  redraw("stage");
}

/** The sentence for a finished render. */
function done(job: Job): string {
  try {
    const out = JSON.parse(job.result ?? "") as RenderOutcome;
    const extra = out.warnings.length === 0 ? "" : ` ${out.warnings.join(" ")}`;
    const name = out.kind === "preview" ? "540p preview" : "1080p video";
    return `Rendered the ${name}, ${clockText(out.seconds)} long.${extra}`;
  } catch {
    return "Rendered.";
  }
}

async function render(kind: "preview" | "render"): Promise<void> {
  const project = app.project;
  if (project === null) return;
  message = null;
  await startLocal(
    kind,
    kind === "preview" ? "edit-preview" : "edit-render",
    { project: project.id },
    async (job) => {
      await load();
      return done(job);
    },
  );
}

function choice<T extends string>(
  value: T,
  options: { value: T; label: string }[],
  label: string,
  onChange: (next: T) => void,
  disabled: boolean,
): HTMLSelectElement {
  const select = h(
    "select",
    { "aria-label": label, disabled },
    ...options.map((each) => h("option", { value: each.value }, each.label)),
  );
  select.value = value;
  select.addEventListener("change", () => onChange(select.value as T));
  return select;
}

function shotRow(slotView: EditView["slots"][number], locked: boolean): HTMLElement {
  const first = slotView.number === 1;
  return h(
    "div",
    { class: `edit-row${slotView.hasClip ? "" : " gap"}`, "data-shot": slotView.shot },
    h("span", { class: "card-title" }, `${slotView.number}. ${slotView.section}`),
    h("span", { class: "meta" }, `bar ${slotView.startBar}, ${slotView.bars} bars`),
    choice(
      slotView.transition,
      [
        { value: "cut", label: "Cut" },
        { value: "flash", label: "Flash on the beat" },
        { value: "crossfade", label: "Crossfade, 1 beat" },
      ],
      `Shot ${slotView.number} transition in`,
      (next) => void save({ shots: { [slotView.shot]: { transition: next } } }),
      locked || first,
    ),
    choice(
      slotView.speed,
      [
        { value: "normal", label: "Speed 100%" },
        { value: "ramp", label: "Ramp to 50% at the end" },
      ],
      `Shot ${slotView.number} speed`,
      (next) => void save({ shots: { [slotView.shot]: { speed: next } } }),
      locked,
    ),
    h(
      "span",
      { class: `meta${slotView.hasClip ? "" : " error-text"}` },
      slotView.hasClip ? "Clip ready" : "No clip: renders black",
    ),
  );
}

function renderLine(label: string, r: RenderView | null, folder: string): HTMLElement {
  if (r === null)
    return h("p", { class: "meta", "data-render": label }, `${label}: not rendered yet.`);
  const where = `${folder}/video/renders/${r.kind}-${r.n}.mp4`;
  return h(
    "p",
    { class: "meta", "data-render": label },
    `${label}: ${clockText(r.seconds)}, ${r.captions ? "with captions" : "no captions"}${r.gaps > 0 ? `, ${r.gaps} black shot${r.gaps === 1 ? "" : "s"}` : ""}${r.stale ? ". The edit has changed since this was rendered" : ""}. ${where}`,
  );
}

function draw(): void {
  const project = app.project;
  if (project === null) return;
  drawTimeline(timelineBox, project.id, view);
  const locked = busy() || localBusy();
  fill(shotsBox, ...(view?.slots ?? []).map((each) => shotRow(each, locked)));
  fill(warnBox, ...(view?.warnings ?? []).map((each) => h("li", null, icon("alert", 13), each)));
  const r = view?.renders;
  fill(
    rendersBox,
    renderLine("540p preview", r?.preview ?? null, project.folder),
    renderLine("1080p video", r?.final ?? null, project.folder),
    renderLine("Vertical cut (made on Deliver)", r?.vertical ?? null, project.folder),
    view?.vertical == null
      ? null
      : h(
          "p",
          { class: "meta" },
          `The vertical cut takes ${view.vertical.shots} shots, ${clockText(view.vertical.startSec)} to ${clockText(view.vertical.endSec)}, 9:16 from the centre of the frame.`,
        ),
  );
  const latest = r?.preview ?? null;
  fill(
    previewBox,
    latest === null
      ? h(
          "p",
          { class: "empty", "data-state": "no-preview" },
          "No preview yet. Preview 540p renders the cuts, captions and sound on this computer.",
        )
      : clip(project.id, "preview", String(latest.n), "Preview of the edit"),
  );
  previewShown = latest?.n ?? 0;
}

function blocker(): string | null {
  if (view === null) return loadError ?? "Loading…";
  if (!view.ffmpeg.ok) return view.ffmpeg.message;
  if (view.tempo === null)
    return "There is no tempo yet. Analyse the track on the Prepare stage first.";
  if (view.slots.length === 0)
    return "There are no shots yet. Draft the shot list on the Storyboard stage.";
  if (view.slots.every((each) => !each.hasClip))
    return "Nothing is shot yet. Shoot at least one shot on the Shoot stage.";
  return busy() || localBusy() ? "A run is in progress." : null;
}

function captionControls(): void {
  const c = view?.captions;
  captionsBox.checked = c?.on ?? false;
  captionsBox.disabled = view === null || (c?.words ?? 0) === 0 || busy() || localBusy();
  if (c === undefined) captionsNote.textContent = "";
  else if (c.reason !== null) captionsNote.textContent = c.reason;
  else
    captionsNote.textContent = c.burnable
      ? `${c.words} words`
      : `${c.words} words, but this ffmpeg has no ass filter`;
}

function buttons(): void {
  const reason = blocker();
  previewButton.disabled = reason !== null;
  finalButton.disabled = reason !== null;
  const running =
    local.job?.status === "running" &&
    (local.job.work === "preview" || local.job.work === "render");
  cancelButton.disabled = !running || local.cancelling;
  cancelButton.textContent = local.cancelling ? "Cancelling…" : "Cancel";
  prepareButton.disabled = view === null || view.slots.length > 0;
  captionControls();
  banner.hidden = view === null || view.ffmpeg.ok;
  fill(
    banner,
    icon("alert"),
    h(
      "div",
      { class: "notice-body" },
      h("strong", null, "Rendering needs ffmpeg. "),
      view?.ffmpeg.message ?? "",
    ),
  );
  why.textContent = "";
  const estimate =
    view === null
      ? ""
      : ` Rendering 1080p takes roughly ${Math.max(1, Math.round(view.estimate.finalSec / 60))} min here (a guess) and loads the processor; you confirm first.`;
  actionWhy.textContent =
    message ??
    (local.starting
      ? "Waiting for you to confirm on the card in prifly…"
      : (reason ??
        `Joins with ${view?.join === "xfade" ? "xfade" : "fade overlays (this ffmpeg has no xfade)"}.${estimate}`));
}

function update(): void {
  heading.textContent = app.project === null ? "Edit" : `Edit — ${app.project.title}`;
  fill(
    slot,
    localProgress(local.job?.work === "render" ? "render" : "preview"),
    localNotice(local.kind === "render" ? "render" : "preview"),
  );
  if (dirty || previewShown !== (view?.renders.preview?.n ?? 0)) {
    dirty = false;
    draw();
  }
  buttons();
}

export function mountEdit(): { root: HTMLElement; update: () => void; sync: () => void } {
  captionsBox.addEventListener("change", () => void save({ captions: captionsBox.checked }));
  const root = h(
    "div",
    { class: "stage edit", "data-stage": "edit" },
    h(
      "section",
      { class: "main wide" },
      heading,
      banner,
      why,
      timelineBox,
      h(
        "div",
        { class: "edit-options" },
        h("label", { class: "seg" }, captionsBox, "Karaoke captions"),
        captionsNote,
      ),
      warnBox,
      h("div", { class: "actions" }, previewButton, finalButton, cancelButton, prepareButton),
      actionWhy,
      slot,
      previewBox,
      rendersBox,
      h("h3", null, "Shots"),
      shotsBox,
    ),
  );
  return {
    root,
    update,
    sync: () => {
      if (loadedFor !== app.project?.id) view = null;
      void load();
      void reattach(["preview", "render"], load, async (job) => {
        await load();
        return done(job);
      });
      dirty = true;
      update();
    },
  };
}
