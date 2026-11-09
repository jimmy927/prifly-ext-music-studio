/** The Library: every project with title, engine, length and created date; search; open one. */

import { ENGINE_LABELS, formatLength } from "../../project/brief";
import { call, errorText, type ListItem, type ProjectView } from "./api";
import { fill, h, icon } from "./dom";
import { go } from "./header";
import { app, redraw } from "./state";

export async function loadLibrary(): Promise<void> {
  try {
    const answer = await call<{ projects: ListItem[] }>(
      `library?q=${encodeURIComponent(app.library.query)}`,
    );
    app.library.projects = answer.projects;
    app.library.error = null;
  } catch (caught) {
    app.library.error = errorText(caught);
  }
  redraw("library");
}

async function open(id: string): Promise<void> {
  try {
    const project = await call<ProjectView>(`project?id=${encodeURIComponent(id)}`);
    app.project = project;
    if (project.brief !== null) app.draft = { ...project.brief };
    app.job = null;
    app.notice = null;
    app.refusal = null;
    go("idea");
  } catch (caught) {
    app.library.error = errorText(caught);
    redraw("library");
  }
}

const day = (iso: string): string => iso.slice(0, 10);

function table(projects: ListItem[]): HTMLElement {
  return h(
    "table",
    { class: "projects" },
    h(
      "thead",
      null,
      h(
        "tr",
        null,
        ...["Title", "Engine", "Length", "Created", "Sketches", ""].map((each) =>
          h("th", null, each),
        ),
      ),
    ),
    h(
      "tbody",
      null,
      ...projects.map((each) =>
        h(
          "tr",
          { "data-project": each.id },
          h("td", { class: "title" }, each.title),
          h("td", null, ENGINE_LABELS[each.engine]),
          h("td", null, formatLength(each.lengthSec)),
          h("td", null, day(each.created)),
          h(
            "td",
            null,
            `${each.sketches}${each.chosen === null ? "" : `, ${each.chosen.toUpperCase()} chosen`}`,
          ),
          h(
            "td",
            null,
            h(
              "button",
              { type: "button", class: "btn small", onclick: () => void open(each.id) },
              "Open",
            ),
          ),
        ),
      ),
    ),
  );
}

export function mountLibrary(): { root: HTMLElement; update: () => void } {
  const body = h("div", { class: "library-body" });
  let wait: ReturnType<typeof setTimeout> | null = null;
  const search = h("input", {
    type: "search",
    class: "search",
    placeholder: "Search title, engine or brief",
    "aria-label": "Search the library",
  });
  search.addEventListener("input", () => {
    app.library.query = search.value;
    if (wait !== null) clearTimeout(wait);
    wait = setTimeout(() => void loadLibrary(), 250);
  });

  function update(): void {
    const { projects, error, query } = app.library;
    if (error !== null)
      fill(
        body,
        h(
          "div",
          { class: "notice error", role: "alert" },
          icon("alert"),
          h("div", { class: "notice-body" }, error),
        ),
      );
    else if (projects === null)
      fill(body, h("p", { class: "empty", role: "status" }, "Loading the library…"));
    else if (projects.length === 0 && query.trim() === "") {
      fill(
        body,
        h(
          "div",
          { class: "empty-state", "data-state": "empty" },
          icon("wave", 28),
          h("p", null, "The library is empty."),
          h("p", { class: "meta" }, "Sketch an idea and it is saved here."),
          h(
            "button",
            { type: "button", class: "btn primary", onclick: () => go("idea") },
            "Go to Idea",
          ),
        ),
      );
    } else if (projects.length === 0)
      fill(body, h("p", { class: "empty" }, `No project matches "${query}".`));
    else fill(body, table(projects));
  }

  const root = h(
    "div",
    { class: "library", "data-stage": "library" },
    h(
      "section",
      { class: "main wide" },
      h(
        "div",
        { class: "lib-head" },
        h("h2", null, "Library"),
        h("div", { class: "search-wrap" }, icon("search", 15), search),
      ),
      body,
    ),
  );
  update();
  return { root, update };
}
