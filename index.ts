/**
 * The Music Studio extension: what prifly imports. `activate` registers the
 * session tools and keeps the status line; `panel` answers the studio view in a
 * session's App tab and the status bar's opener page (open.ts), `action` (the status bar click, no dialog), and `choices`,
 * `launch` and `launched` start the Music Studio session. The ElevenLabs and Gemini keys are `secret` settings, kept in this
 * extension's own sealed secrets, never in prifly's vault.
 */

import type { ExtensionApi, Launch, LaunchChoice } from "@prifly/extension-api";
import { allTools } from "./all-tools";
import {
  CLICK_ACTION,
  canClickThrough,
  clickRoute,
  choices as launchChoices,
  launch as launchSession,
  STATUS_KEY,
  launched as sessionLaunched,
  statusItem,
} from "./open";
import { route } from "./panel-router";
import { Studio } from "./studio";
import type { ViewRequest } from "./view";

let api: ExtensionApi | null = null;

/** The network is the global `fetch`, looked up at each call so a test can stand in for it. */
const studio = new Studio({
  api: () => api,
  fetch: (input, init) => globalThis.fetch(input, init),
});

async function statusLine(given: ExtensionApi): Promise<string> {
  const eleven = (await given.secrets?.get("elevenlabsKey")) ?? null;
  const gemini = (await given.secrets?.get("geminiKey")) ?? null;
  if (eleven === null && gemini === null) return "No key yet: add one in Settings → Extensions";
  return [eleven === null ? null : "ElevenLabs", gemini === null ? null : "Gemini"]
    .filter((each) => each !== null)
    .join(" + ");
}

export function activate(given: ExtensionApi): () => void {
  api = given;
  const refresh = () => void statusLine(given).then((text) => given.status?.(text));
  refresh();
  given.tools?.register(allTools(studio));
  studio.serveMedia();
  given.onSettings?.(() => {
    refresh();
    // The library folder may have changed.
    studio.serveMedia();
  });
  // With the click calls, the status bar's Music Studio runs `action` below with no dialog; else the opener panel is the click.
  if (canClickThrough(given)) given.show?.({}, [statusItem()]);
  given.log("activated");
  return () => {
    studio.streaming = false;
    api = null;
  };
}

/** The opener page and the session view answer alike: `request.params` says what the view was shown with. */
export function panel(_panelId: string, request: ViewRequest): Promise<unknown> {
  return route(studio, request);
}

/** The launcher's one row, for the New session form. */
export function choices(): LaunchChoice[] {
  return launchChoices();
}

/** What a click on the status bar's Music Studio starts: a session with the studio's brief. */
export function launch(): Launch {
  return launchSession(studio);
}

/** The session a launch became: its studio view is shown on the Library. */
export function launched(_launchId: string, _key: string, session: string): Promise<void> {
  return sessionLaunched(studio, session);
}

/** The reader's left click on the status bar's Music Studio: its session forward, or a new one, with no dialog. */
export function action(key: string, actionId: string): Promise<string> {
  if (key !== STATUS_KEY || actionId !== CLICK_ACTION)
    return Promise.reject(new Error(`Music Studio has no action ${actionId} on ${key}`));
  return clickRoute(studio);
}
