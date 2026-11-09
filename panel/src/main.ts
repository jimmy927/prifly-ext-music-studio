/**
 * The Music Studio window. Data comes from `api/<path>` (see panel-router.ts);
 * the page polls while a sketch run is going. The theme arrives in a
 * `prifly-look` message and overrides the tokens in style.css.
 */

import { mountArrange } from "./arrange";
import { mountDeliver } from "./deliver";
import { h } from "./dom";
import { loadStatus, renderHeader, renderStageBar } from "./header";
import { mountIdea } from "./idea";
import { loadLibrary, mountLibrary } from "./library";
import { mountMaster } from "./master";
import { mountMix } from "./mix";
import { mountPrepare } from "./prepare";
import { mountProduce } from "./produce";
import { app, onRedraw, STAGES } from "./state";
import { clearWork } from "./work";

const LOOK: Record<string, string> = {
  "--background": "--bg",
  "--foreground": "--fg",
  "--card": "--card",
  "--muted": "--muted",
  "--muted-foreground": "--muted-fg",
  "--border": "--border",
  "--accent": "--accent",
  "--font-sans": "--font",
  "--font-mono": "--mono",
};

addEventListener("message", (event: MessageEvent) => {
  const data: unknown = event.data;
  if (
    typeof data !== "object" ||
    data === null ||
    (data as { type?: unknown }).type !== "prifly-look"
  )
    return;
  const look = data as { dark?: unknown; tokens?: Record<string, unknown> };
  document.documentElement.classList.toggle("dark", look.dark === true);
  for (const [theirs, ours] of Object.entries(LOOK)) {
    const value = look.tokens?.[theirs];
    if (typeof value === "string" && value !== "")
      document.documentElement.style.setProperty(ours, value);
  }
});

const head = h(
  "header",
  { class: "top" },
  h("h1", null, "Music Studio"),
  h("span", { class: "grow" }),
);
const statusSlot = h("div", { class: "status-slot" });
const bar = h("div", { class: "bar-slot" });
const body = h("main", { class: "body" });
const root = h("div", { class: "studio", "data-part": "studio" }, head, bar, body);
head.append(statusSlot);
document.body.replaceChildren(root);

const idea = mountIdea();
const library = mountLibrary();
const stages = {
  arrange: mountArrange(),
  produce: mountProduce(),
  mix: mountMix(),
  master: mountMaster(),
  prepare: mountPrepare(),
  deliver: mountDeliver(),
};

/** The mounted stage page for the current view, or null on Idea and Library. */
function stage() {
  return STAGES.includes(app.view) ? stages[app.view as keyof typeof stages] : null;
}

function drawHead(): void {
  statusSlot.replaceChildren(renderHeader());
  bar.replaceChildren(renderStageBar());
}

function drawBody(): void {
  const current = stage();
  body.replaceChildren(current?.root ?? (app.view === "idea" ? idea.root : library.root));
  if (current !== null) {
    clearWork();
    current.sync();
  } else if (app.view === "idea") idea.sync();
  else void loadLibrary();
}

onRedraw((region) => {
  if (region === "head" || region === "all") drawHead();
  if (region === "idea") idea.update();
  if (region === "library") library.update();
  if (region === "stage") stage()?.update();
  if (region === "all") drawBody();
});

drawHead();
drawBody();
void loadStatus();
