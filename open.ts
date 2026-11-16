/**
 * The Music Studio lives in a session. Where prifly offers "status-click",
 * "open-session" and "start-session-plain", a left click on the status bar's
 * entry runs `clickRoute` with no dialog. On an older prifly the status bar can
 * only open a panel (a dialog), so the manifest's one panel, `open`, is a small page that
 * asks `api/open` what to do and goes: it lands the reader on their Music
 * Studio session (the most recent one this extension started that is still
 * around) with the studio view shown in its App tab, or starts one through the
 * extension's launcher (`prifly-launch`; the module's `launch` writes the
 * brief, `launched` learns which session it became and shows the view).
 *
 * The brief tells the session the reader is in the Music Studio; on a prifly
 * without session views it also says to update prifly, and the tools still work.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import type {
  Decoration,
  ExtensionApi,
  ExtensionSession,
  Launch,
  LaunchChoice,
} from "@prifly/extension-api";
import { resolveLink, sessionOf } from "./session";
import type { Studio } from "./studio";
import { showView, viewApi } from "./view";

/** The manifest's launcher, and the one thing it offers. */
export const LAUNCHER_ID = "studio";
export const LAUNCH_KEY = "session";
/** The started session's name in the sidebar. */
const STUDIO_TITLE = "Music Studio";

type Started = { id: string; at: number };
type Memory = { sessions: Started[] };
const DOC = "studio-sessions";
/** How many started sessions are remembered, the newest first. */
const KEEP = 20;

const EMPTY: Memory = { sessions: [] };

/** What the launcher row says in the New session form. */
export function choices(): LaunchChoice[] {
  return [
    {
      key: LAUNCH_KEY,
      title: "Music Studio",
      detail: "A session with the studio beside the chat",
    },
  ];
}

/** The first prompt of a Music Studio session. */
export function briefText(canShow: boolean): string {
  const lines = [
    "The reader just opened the Music Studio. You are their music and video producer here: use the music_* and video_* tools (music_library lists their projects).",
    "When they name a song or a video, call music_open first so the studio shows it beside the chat; the other tools open it by themselves the first time.",
    "Every paid step waits for their confirm.",
  ];
  lines.push(
    canShow
      ? "The studio is on screen beside this chat, on its Library. Greet them in one line and ask what they want to make or work on."
      : "This prifly cannot show the studio beside the chat, so music_open will say so: tell the reader once, in your first reply, to update prifly to see the studio. The tools still work.",
  );
  return lines.join("\n");
}

/** The library folder, made when it is not there yet, else the home folder: somewhere prifly can start a session. */
function startFolder(studio: Studio): string {
  const wanted = studio.libraryPath();
  try {
    mkdirSync(wanted, { recursive: true });
    return wanted;
  } catch (caught) {
    studio.api().log("studio-folder-failed", { folder: wanted, error: String(caught) });
    return homedir();
  }
}

async function update(studio: Studio, change: (record: Memory) => Memory): Promise<void> {
  const state = studio.api().state;
  if (state === undefined) throw new Error("This prifly keeps no state. Update prifly.");
  await state.update<Memory>(DOC, (current) => change(current ?? EMPTY));
}

/** The module's `launch`: the brief, in the library folder. */
export function launch(studio: Studio): Launch {
  const canShow = viewApi(studio.api()) !== null;
  return { prompt: briefText(canShow), cwd: startFolder(studio), name: STUDIO_TITLE };
}

async function remember(studio: Studio, session: string): Promise<void> {
  await update(studio, (record) => ({
    sessions: [
      { id: session, at: Date.now() },
      ...record.sessions.filter((each) => each.id !== session),
    ].slice(0, KEEP),
  }));
}

/** The module's `launched`: remembers the session and shows the studio's Library in it. */
export async function launched(studio: Studio, session: string): Promise<void> {
  await remember(studio, session);
  await showView(studio, session, null, null, true);
}

/** The Music Studio session to go back to: the newest one prifly still knows and the reader has not archived. */
export async function findSession(studio: Studio): Promise<ExtensionSession | null> {
  const state = studio.api().state;
  const record = (await state?.get<Memory>(DOC)) ?? EMPTY;
  for (const each of record.sessions) {
    const known = sessionOf(studio.api(), each.id);
    if (known !== null && known.archived !== true) return known;
  }
  return null;
}

/** Shows the studio in `session`: on its last project when it has one, else the Library. */
async function showStudio(studio: Studio, session: string): Promise<void> {
  const resolved = await resolveLink(studio, session);
  const project = resolved.state === "following" ? resolved.entry.id : null;
  await showView(studio, session, project, null, true);
}

/** The status bar item's key, and the id of its left-click action. */
export const STATUS_KEY = "music-studio";
export const CLICK_ACTION = "open";
/** The manifest's panel the status bar item stands for: the opener, which a right click still opens. */
export const OPENER_PANEL = "open";

/** Whether this prifly lets a click run extension code that opens or starts a session (no opener dialog). */
export function canClickThrough(api: ExtensionApi): boolean {
  const features = api.features ?? [];
  return ["status-click", "open-session", "start-session-plain"].every((each) =>
    features.includes(each),
  );
}

/** The status bar's Music Studio entry: a left click runs `click`, a right click opens the opener panel. */
export function statusItem(): Decoration {
  return {
    key: STATUS_KEY,
    icon: "zap",
    label: "Music Studio",
    tone: "info",
    details: ["Go to your Music Studio session, or start one"],
    panel: OPENER_PANEL,
    click: CLICK_ACTION,
  };
}

/**
 * The reader's click on the status bar item, with no dialog: reuse the Music
 * Studio session (`api.openSession`) or start one (`api.startSession`) and show
 * the studio in it. A failure is logged and thrown, which prifly shows as the
 * failure of the click.
 */
export async function clickRoute(studio: Studio): Promise<string> {
  const api = studio.api();
  try {
    if (!canClickThrough(api) || api.openSession === undefined || api.startSession === undefined)
      throw new Error("This prifly cannot open a session from a click. Update prifly.");
    if (api.state === undefined) throw new Error("This prifly keeps no state. Update prifly.");
    const found = await findSession(studio);
    if (found !== null) {
      await showStudio(studio, found.id);
      api.openSession(found.id);
      return "";
    }
    const started = await api.startSession({
      prompt: briefText(viewApi(api) !== null),
      cwd: startFolder(studio),
      title: STUDIO_TITLE,
    });
    await remember(studio, started.sessionId);
    await showView(studio, started.sessionId, null, null, true);
    return "";
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    api.log("studio-click-failed", { error: message });
    throw new Error(`Could not open Music Studio: ${message}`);
  }
}

/** What the opener page is answered with. */
export type OpenAnswer = {
  /** open: go to `session`; launch: start one and ask `api/started?since=` for it. */
  action: "open" | "launch";
  session: string | null;
  title: string | null;
  /** The server's clock when the question was asked. */
  since: number;
  /** Whether this prifly lets the page open a session (`prifly-open-session`). */
  canOpen: boolean;
  launcher: string;
  key: string;
};

/** `api/open`: reuse the Music Studio session and show its studio, or say a new one must be started. */
export async function openRoute(studio: Studio): Promise<OpenAnswer> {
  const api = studio.api();
  // Without state no session can be remembered: starting one would start another at every click.
  if (api.state === undefined) throw new Error("This prifly keeps no state. Update prifly.");
  const base = {
    since: Date.now(),
    canOpen: (api.features ?? []).includes("panel-open-session"),
    launcher: LAUNCHER_ID,
    key: LAUNCH_KEY,
  };
  const found = await findSession(studio);
  if (found === null) return { ...base, action: "launch", session: null, title: null };
  await showStudio(studio, found.id);
  return { ...base, action: "open", session: found.id, title: found.title };
}

/** What `api/started` answers while the page waits for the session it asked prifly to start. */
export type StartedAnswer =
  | { state: "waiting" }
  | { state: "started"; session: string; title: string };

/** `api/started?since=<ms>`: the session started since then, if one was. prifly tells the module nothing of a start that failed, so the page times out. */
export async function startedRoute(studio: Studio, since: number): Promise<StartedAnswer> {
  const record = (await studio.api().state?.get<Memory>(DOC)) ?? EMPTY;
  const [newest] = record.sessions;
  if (newest !== undefined && newest.at >= since) {
    return {
      state: "started",
      session: newest.id,
      title: sessionOf(studio.api(), newest.id)?.title ?? "Music Studio",
    };
  }
  return { state: "waiting" };
}
