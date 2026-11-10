/**
 * The Music Studio extension: what prifly imports. `activate` registers the
 * session tools and keeps the status line; `panel` answers the Music Studio
 * window. The ElevenLabs and Gemini keys are `secret` settings, kept in this
 * extension's own sealed secrets, never in prifly's vault.
 */

import type { ExtensionApi, PanelRequest } from "@prifly/extension-api";
import { allTools } from "./all-tools";
import { route } from "./panel-router";
import { Studio } from "./studio";

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
  given.onSettings?.(refresh);
  given.log("activated");
  return () => {
    api = null;
  };
}

export function panel(_panelId: string, request: PanelRequest): Promise<unknown> {
  return route(studio, request);
}
