/**
 * Following the session this window is docked beside (`session=` in its
 * address). Every 2 s while the window is visible it asks `api/follow` which
 * project that session works on and which stage its last tool belongs to; it
 * opens the project when the link changes and moves to the stage when the
 * session calls another tool. The reader can still go anywhere; the Follow
 * button turns this off and on.
 */

import { call, errorText, type FollowView, type ProjectView, panelSession } from "./api";
import { type Child, h } from "./dom";
import { gate, go } from "./header";
import { app, redraw, type View } from "./state";

const POLL_MS = 2000;

export const NO_PROJECT_TEXT =
  "This session has no Music Studio project yet. Ask Claude to start one.";
export const UNKNOWN_TEXT = "Prifly does not know this session, so there is no project to follow.";
export const DELETED_TEXT = "The project this session was working on has been deleted.";

/** What the window says under its title for a state of the session; empty when there is nothing to say. */
export function noteFor(view: FollowView | null, error: string | null): string {
  if (error !== null) return `Could not ask which project the session works on: ${error}`;
  if (view?.state === "none") return NO_PROJECT_TEXT;
  if (view?.state === "unknown") return UNKNOWN_TEXT;
  if (view?.state === "deleted") return DELETED_TEXT;
  return "";
}

let busy = false;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Opens a project the way the Library does, then shows `stage` when that stage is on, else Idea. */
async function openProject(id: string, stage: View | null): Promise<void> {
  const project = await call<ProjectView>(`project?id=${encodeURIComponent(id)}`);
  app.project = project;
  if (project.brief !== null) app.draft = { ...project.brief };
  app.job = null;
  app.notice = null;
  app.refusal = null;
  go(stage !== null && gate(stage).enabled ? stage : "idea");
}

/** Moves the window to what the answer says, once per change. */
async function apply(view: FollowView): Promise<void> {
  const follow = app.follow;
  const called = view.stamp > 0 && view.stamp !== follow.stamp;
  const changed = view.project !== null && view.project !== follow.project;
  follow.stamp = view.stamp;
  follow.project = view.project;
  if (view.project === null) return;
  if (changed) {
    await openProject(view.project, view.stage);
  } else if (called && view.stage !== null) {
    app.project = await call<ProjectView>(`project?id=${encodeURIComponent(view.project)}`);
    go(gate(view.stage).enabled ? view.stage : app.view);
  }
}

/** Asks once; the window follows the answer when Follow is on. */
export async function pollFollow(): Promise<void> {
  const follow = app.follow;
  const session = follow.session;
  if (session === null || busy) return;
  busy = true;
  try {
    follow.view = await call<FollowView>(`follow?session=${encodeURIComponent(session)}`);
    follow.error = null;
    if (follow.on) await apply(follow.view);
  } catch (caught) {
    follow.error = errorText(caught);
  } finally {
    busy = false;
  }
  redraw("head");
}

function schedule(): void {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (document.visibilityState === "visible" && app.follow.on) void pollFollow();
    schedule();
  }, POLL_MS);
}

/** Starts following if the window was opened with `session=`; does nothing on its own. */
export function startFollowing(): void {
  const session = panelSession();
  if (session === null) return;
  app.follow = { session, on: true, view: null, error: null, stamp: 0, project: null };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && app.follow.on) void pollFollow();
  });
  void pollFollow();
  schedule();
}

function toggle(): void {
  const follow = app.follow;
  follow.on = !follow.on;
  // Turning it on shows where the session is now, as if its project was just linked.
  follow.stamp = 0;
  follow.project = null;
  redraw("head");
  if (follow.on) void pollFollow();
}

function label(): string {
  const { on, view } = app.follow;
  const title = view?.session?.title;
  if (title === undefined) return on ? "Following this session" : "Not following this session";
  return `${on ? "Following" : "Not following"} ${title}`;
}

/** The Follow button and the "Following <session>" line; nothing when the window has no session. */
export function renderFollow(): Child {
  const follow = app.follow;
  if (follow.session === null) return null;
  const project = follow.view?.projectTitle;
  return h(
    "div",
    { class: "follow", "data-part": "follow" },
    h(
      "button",
      {
        type: "button",
        class: `btn small follow-toggle${follow.on ? " on" : ""}`,
        "aria-pressed": String(follow.on),
        title: follow.on ? "Stop moving with the session" : "Move with the session again",
        onclick: toggle,
      },
      follow.on ? "Follow: on" : "Follow: off",
    ),
    h(
      "span",
      { class: "follow-line", ...(project == null ? {} : { title: `Project: ${project}` }) },
      label(),
    ),
  );
}

/** A line for the states with no project; always there in follow mode so nothing below it moves. */
export function renderFollowNote(): Child {
  const follow = app.follow;
  if (follow.session === null) return null;
  return h(
    "p",
    { class: "follow-note", "data-part": "follow-note", role: "status" },
    follow.on ? noteFor(follow.view, follow.error) : "",
  );
}
