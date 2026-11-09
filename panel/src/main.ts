/**
 * The Music Studio window. Data comes from `api/<path>` (see panel-router.ts);
 * the page polls while a sketch run is going. The theme arrives in a
 * `prifly-look` message and overrides the tokens in style.css.
 */

import { h } from "./dom";
import { loadStatus, renderHeader, renderStageBar } from "./header";
import { mountIdea } from "./idea";
import { loadLibrary, mountLibrary } from "./library";
import { app, onRedraw } from "./state";

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

function drawHead(): void {
  statusSlot.replaceChildren(renderHeader());
  bar.replaceChildren(renderStageBar());
}

function drawBody(): void {
  body.replaceChildren(app.view === "idea" ? idea.root : library.root);
  if (app.view === "idea") idea.sync();
  else void loadLibrary();
}

onRedraw((region) => {
  if (region === "head" || region === "all") drawHead();
  if (region === "idea") idea.update();
  if (region === "library") library.update();
  if (region === "all") drawBody();
});

drawHead();
drawBody();
void loadStatus();
