/** The Library's sidebar: All projects and the crates, with create, rename and delete. A crate is a named list of tracks. */

import { type CrateItem, call, errorText } from "./api";
import { fill, h } from "./dom";
import { loadLibrary } from "./library";
import { app, redraw } from "./state";

let renaming: string | null = null;
let deleting: string | null = null;
let problem: string | null = null;

export async function loadCrates(): Promise<void> {
  try {
    app.library.crates = (await call<{ crates: CrateItem[] }>("crates")).crates;
    problem = null;
  } catch (caught) {
    problem = errorText(caught);
  }
  redraw("library");
}

/** Posts a crate change; the answer is the new list. */
async function change(path: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    app.library.crates = (await call<{ crates: CrateItem[] }>(path, body)).crates;
    problem = null;
    if (!app.library.crates.some((each) => each.id === app.library.crate)) app.library.crate = "";
    renaming = null;
    deleting = null;
    await loadLibrary();
    return true;
  } catch (caught) {
    problem = errorText(caught);
    redraw("library");
    return false;
  }
}

function pick(id: string): void {
  app.library.crate = id;
  void loadLibrary();
}

const newName = h("input", {
  type: "text",
  id: "new-crate",
  placeholder: "New crate",
  "aria-label": "New crate name",
});
const create = h(
  "button",
  { type: "button", class: "btn small", id: "crate-create", onclick: () => void make() },
  "Create",
);
const note = h("p", { class: "crate-note", role: "alert" });
const list = h("ul", { class: "crate-list", "data-part": "crates" });

async function make(): Promise<void> {
  if (await change("crate-create", { name: newName.value })) newName.value = "";
}

function crateRow(crate: CrateItem): HTMLElement {
  const on = app.library.crate === crate.id;
  if (renaming === crate.id) {
    const input = h("input", {
      type: "text",
      class: "rename",
      value: crate.name,
      "aria-label": `Rename ${crate.name}`,
    });
    return h(
      "li",
      { class: "crate on", "data-crate": crate.id },
      input,
      h(
        "button",
        {
          type: "button",
          class: "btn small",
          onclick: () => void change("crate-rename", { crate: crate.id, name: input.value }),
        },
        "Save",
      ),
      h(
        "button",
        {
          type: "button",
          class: "btn small",
          onclick: () => {
            renaming = null;
            redraw("library");
          },
        },
        "Cancel",
      ),
    );
  }
  return h(
    "li",
    { class: `crate${on ? " on" : ""}`, "data-crate": crate.id },
    h(
      "button",
      {
        type: "button",
        class: "crate-pick",
        "aria-pressed": String(on),
        onclick: () => pick(crate.id),
      },
      h("span", { class: "crate-name" }, crate.name),
      h("span", { class: "meta" }, String(crate.count)),
    ),
    deleting === crate.id
      ? h(
          "button",
          {
            type: "button",
            class: "btn small danger",
            onclick: () => void change("crate-delete", { crate: crate.id }),
          },
          "Delete crate",
        )
      : h(
          "button",
          {
            type: "button",
            class: "btn small",
            "aria-label": `Rename ${crate.name}`,
            onclick: () => {
              renaming = crate.id;
              deleting = null;
              redraw("library");
            },
          },
          "Rename",
        ),
    h(
      "button",
      {
        type: "button",
        class: "btn small",
        "aria-label": `${deleting === crate.id ? "Keep" : "Delete"} ${crate.name}`,
        onclick: () => {
          deleting = deleting === crate.id ? null : crate.id;
          redraw("library");
        },
      },
      deleting === crate.id ? "Keep" : "Delete",
    ),
  );
}

function update(): void {
  const all = app.library.crate === "";
  note.textContent = problem ?? "";
  fill(
    list,
    h(
      "li",
      { class: `crate${all ? " on" : ""}`, "data-crate": "" },
      h(
        "button",
        {
          type: "button",
          class: "crate-pick",
          "aria-pressed": String(all),
          onclick: () => pick(""),
        },
        h("span", { class: "crate-name" }, "All projects"),
        h("span", { class: "meta" }, String(app.library.projects?.length ?? "")),
      ),
    ),
    ...app.library.crates.map(crateRow),
  );
}

export function mountCrates(): { root: HTMLElement; update: () => void } {
  newName.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Enter") void make();
  });
  const root = h(
    "aside",
    { class: "side crates", "data-part": "crate-sidebar" },
    h("h2", null, "Crates"),
    list,
    h("div", { class: "crate-new" }, newName, create),
    note,
  );
  update();
  return { root, update };
}
