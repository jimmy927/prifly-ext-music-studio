/** The right-hand side of the Idea stage: the job's progress row and the three sketch cards. */

import { ENGINE_LABELS, SKETCH_IDS, type SketchId } from "../../project/brief";
import { call, errorText, type ProjectView } from "./api";
import { type Child, h, icon } from "./dom";
import { player } from "./player";
import { app, redraw } from "./state";

async function choose(project: string, sketch: SketchId): Promise<void> {
  try {
    app.project = await call<ProjectView>("choose", { project, sketch });
  } catch (caught) {
    app.notice = { tone: "error", text: errorText(caught) };
  }
  redraw("idea");
}

function slot(id: SketchId, index: number): Child {
  const letter = id.toUpperCase();
  const project = app.project;
  const made = project?.sketchList.find((each) => each.id === id);
  if (project === null || made === undefined) {
    const job = app.job;
    const running = job?.status === "running" || app.confirming;
    const now = job?.status === "running" && job.done.length === index;
    const text = now
      ? `Making sketch ${letter}…`
      : running
        ? `Sketch ${letter} is next`
        : `Sketch ${letter} was not made`;
    return h(
      "li",
      { class: `card ghost${now ? " busy" : ""}`, "data-sketch": id },
      h("div", { class: "card-title" }, text),
      now && h("div", { class: "bar-busy" }),
    );
  }
  const chosen = project.chosen === id;
  return h(
    "li",
    { class: `card${chosen ? " chosen" : ""}`, "data-sketch": id },
    h(
      "div",
      { class: "card-head" },
      h("div", { class: "card-title" }, `Sketch ${letter}`),
      chosen
        ? h("span", { class: "badge" }, icon("check", 14), "Chosen")
        : h(
            "button",
            { type: "button", class: "btn small", onclick: () => void choose(project.id, id) },
            "Mark as chosen",
          ),
    ),
    player(project.id, id),
    h("div", { class: "meta" }, ENGINE_LABELS[made.engine], " · 0:30"),
    made.lyrics === null
      ? null
      : h(
          "details",
          { class: "lyrics" },
          h("summary", null, "Lyrics"),
          h("pre", null, made.lyrics),
        ),
  );
}

/** The progress row of a running job, with Cancel. */
function progress(cancel: () => void, cancelling: boolean): Child {
  if (app.confirming) {
    return h(
      "div",
      { class: "progress", role: "status" },
      h("span", null, "Waiting for you to confirm the cost in prifly…"),
    );
  }
  const job = app.job;
  if (job === null || job.status !== "running") return null;
  const step = Math.min(job.done.length + 1, job.total);
  return h(
    "div",
    { class: "progress", role: "status" },
    h(
      "span",
      null,
      `Making sketch ${step} of ${job.total} with ${ENGINE_LABELS[job.engine]}. A sketch takes about half a minute.`,
    ),
    h(
      "div",
      { class: "track" },
      h("div", {
        class: "fill",
        style: `width:${Math.round((job.done.length / job.total) * 100)}%`,
      }),
    ),
    h(
      "button",
      { type: "button", class: "btn small", disabled: cancelling, onclick: cancel },
      cancelling ? "Cancelling…" : "Cancel",
    ),
  );
}

export function renderSketches(cancel: () => void, cancelling: boolean): HTMLElement {
  const project = app.project;
  const heading = project === null ? "Sketches" : `Sketches — ${project.title}`;
  const empty = project === null && app.job === null && !app.confirming;
  return h(
    "section",
    { class: "side", "data-part": "sketches" },
    h("h2", null, heading),
    progress(cancel, cancelling),
    empty
      ? h(
          "p",
          { class: "empty" },
          "Nothing sketched yet. Write a brief, pick a preset if you like, and press Sketch 3 ideas.",
        )
      : h("ul", { class: "cards" }, ...SKETCH_IDS.map((id, index) => slot(id, index))),
    project === null ? null : h("p", { class: "meta folder" }, `Saved in ${project.folder}`),
  );
}
