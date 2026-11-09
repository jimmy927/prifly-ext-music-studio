/**
 * The Library: every project with title, engine, length, created date and,
 * once prepared, BPM, key and LUFS; search (plain words, `key 8A`,
 * `bpm 120-128`); crates in a sidebar; open one.
 */

import { ENGINE_LABELS, formatLength } from "../../project/brief";
import { type CrateItem, call, errorText, type ListItem, type ProjectView } from "./api";
import { mountCrates } from "./crates";
import { fill, h, icon } from "./dom";
import { go } from "./header";
import { app, redraw } from "./state";

export async function loadLibrary(): Promise<void> {
  try {
    const answer = await call<{ projects: ListItem[] }>(
      `library?q=${encodeURIComponent(app.library.query)}&crate=${encodeURIComponent(app.library.crate)}`,
    );
    app.library.projects = answer.projects;
    app.library.crates = (await call<{ crates: CrateItem[] }>("crates")).crates;
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

async function crateChange(path: string, crate: string, project: string): Promise<void> {
  try {
    await call(path, { crate, project });
    app.library.error = null;
  } catch (caught) {
    app.library.error = errorText(caught);
  }
  await loadLibrary();
}

/** Add to a crate the track is not in yet; remove from the crate being shown. Both are always there. */
function crateCell(item: ListItem): HTMLElement {
  const open = app.library.crates.filter((each) => !item.crates.includes(each.id));
  const add = h(
    "select",
    {
      class: "crate-add",
      "aria-label": `Add ${item.title} to a crate`,
      disabled: open.length === 0,
    },
    h("option", { value: "" }, "Add to crate"),
    ...open.map((each) => h("option", { value: each.id }, each.name)),
  );
  add.addEventListener("change", () => {
    if (add.value !== "") void crateChange("crate-add", add.value, item.id);
  });
  const shown = app.library.crate !== "";
  return h(
    "td",
    { class: "crate-cell" },
    add,
    h(
      "button",
      {
        type: "button",
        class: "btn small",
        disabled: !shown,
        title: shown ? "Take it out of this crate" : "Pick a crate to take tracks out of it",
        onclick: () => void crateChange("crate-remove", app.library.crate, item.id),
      },
      "Remove",
    ),
  );
}

const bpmText = (item: ListItem): string => (item.prep?.bpm == null ? "—" : String(item.prep.bpm));
const lufsText = (item: ListItem): string =>
  item.prep?.lufs == null ? "—" : item.prep.lufs.toFixed(1);

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
        ...[
          "Title",
          "Engine",
          "Length",
          "Created",
          "BPM",
          "Key",
          "LUFS",
          "Sketches",
          "",
          "Crates",
        ].map((each) => h("th", null, each)),
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
          h("td", { class: "num" }, bpmText(each)),
          h("td", { class: "num" }, each.prep?.camelot ?? "—"),
          h("td", { class: "num" }, lufsText(each)),
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
          crateCell(each),
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
    placeholder: "Search, or try key 8A, bpm 120-128",
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
    else if (projects.length === 0 && query.trim() === "" && app.library.crate === "") {
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

  const crates = mountCrates();
  const root = h(
    "div",
    { class: "library with-crates", "data-stage": "library" },
    crates.root,
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
  return {
    root,
    update: () => {
      update();
      crates.update();
    },
  };
}
