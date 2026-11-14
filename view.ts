/**
 * The Music Studio session view: the panel's page shown in a session's App
 * tab, beside the chat (`sessionViews` in the manifest, prifly's
 * `api.showSessionView`, feature "session-views"). `music_open` shows it on
 * a project; the first music or video tool a session calls shows it too.
 *
 * The installed `@prifly/extension-api` does not declare the session view
 * calls yet, so they are declared here and looked up behind the feature check:
 * a prifly without them keeps the panel and the tools working as before.
 */

import type { ExtensionApi, PanelRequest } from "@prifly/extension-api";
import { entryOf } from "./routes/common";
import { resolveLink, STAGE_IDS, type StageId, stageOfTool } from "./session";
import type { Studio } from "./studio";

/** The manifest's id for the view; no panel of the extension has it. */
export const VIEW_ID = "studio-view";

/** What the host adds to a request from a session view. */
export type ViewRequest = PanelRequest & {
  sessionId?: string;
  params?: Record<string, string>;
};

/** The two session view calls of prifly's `api`, as a prifly with "session-views" offers them. */
export type ViewApi = {
  show(sessionId: string, viewId: string, params: Record<string, string>): void;
};

/** What a prifly that predates session views is answered with. */
export const OLD_PRIFLY =
  "This prifly cannot show a view beside the chat. Update prifly; the Music Studio window in the status bar still works.";

/** The session view calls, or null when this prifly has none. */
export function viewApi(api: ExtensionApi): ViewApi | null {
  if (!(api.features ?? []).includes("session-views")) return null;
  const candidate = api as ExtensionApi & {
    showSessionView?: (sessionId: string, viewId: string, params: Record<string, string>) => void;
  };
  const show = candidate.showSessionView;
  if (typeof show !== "function") return null;
  return { show: (sessionId, viewId, params) => show.call(candidate, sessionId, viewId, params) };
}

type Shown = Record<string, { project: string }>;
const DOC = "session-views";
const KEEP = 300;

function paramsOf(project: string, stage: StageId | null): Record<string, string> {
  return stage === null ? { project } : { project, stage };
}

/**
 * Shows the view in `session` on `project`. With `force` it is shown again
 * whatever is shown; without, only when the session has no view yet or has one
 * on another project, so a tool call after the first leaves the page to its own
 * polling. Returns whether it was shown; a failure is logged, never thrown.
 */
export async function showView(
  studio: Studio,
  session: string,
  project: string,
  stage: StageId | null,
  force: boolean,
): Promise<boolean> {
  const api = studio.api();
  const views = viewApi(api);
  const state = api.state;
  if (views === null || state === undefined) return false;
  const result: { fire: boolean; before: Shown[string] | undefined } = {
    fire: false,
    before: undefined,
  };
  await state.update<Shown>(DOC, (current) => {
    const shown = { ...(current ?? {}) };
    result.before = shown[session];
    result.fire = force || result.before === undefined || result.before.project !== project;
    if (!result.fire) return shown;
    delete shown[session];
    shown[session] = { project };
    for (const old of Object.keys(shown).slice(0, Math.max(0, Object.keys(shown).length - KEEP)))
      delete shown[old];
    return shown;
  });
  if (!result.fire) return false;
  try {
    views.show(session, VIEW_ID, paramsOf(project, stage));
    return true;
  } catch (caught) {
    api.log("session-view-failed", { error: String(caught) });
    // Not shown after all: the next tool call tries again.
    await state.update<Shown>(DOC, (current) => {
      const shown = { ...(current ?? {}) };
      if (result.before === undefined) delete shown[session];
      else shown[session] = result.before;
      return shown;
    });
    return false;
  }
}

/** Called once a tool knows its project: shows the view the first time, and when the project changed. Never fails the tool. */
export async function autoOpen(
  studio: Studio,
  session: string,
  project: string,
  tool: string,
): Promise<void> {
  try {
    await showView(studio, session, project, stageOfTool(tool), false);
  } catch (caught) {
    studio.api().log("session-view-failed", { error: String(caught) });
  }
}

/** What the page's `api/view` is answered with. */
export type ViewAnswer =
  | { state: "none" }
  | { state: "missing"; project: string }
  | {
      state: "open";
      project: string;
      title: string;
      stage: StageId | null;
      /** The session's tool-call stamp now, so the page jumps only on a later call. */
      stamp: number;
    };

/** The project and stage the view was shown with (`request.params`), as the page opens them. */
export async function viewRoute(studio: Studio, request: ViewRequest): Promise<ViewAnswer> {
  const project = request.params?.["project"] ?? "";
  if (project === "") return { state: "none" };
  let entry: Awaited<ReturnType<typeof entryOf>>;
  try {
    entry = await entryOf(studio, project);
  } catch {
    return { state: "missing", project };
  }
  const wanted = request.params?.["stage"];
  const stage = STAGE_IDS.find((each) => each === wanted) ?? null;
  const session = request.sessionId ?? request.query["session"] ?? "";
  const resolved = session === "" ? null : await resolveLink(studio, session);
  const stamp = resolved?.state === "following" && resolved.entry.id === entry.id ? resolved.at : 0;
  return { state: "open", project: entry.id, title: entry.title, stage, stamp };
}
