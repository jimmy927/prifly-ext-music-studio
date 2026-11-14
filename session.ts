/**
 * Which Music Studio project a prifly session is working on. A session is
 * linked to a project when one of its tools made or used it (the link is kept
 * in `api.state`, with the tool called last), or when its folder is inside the
 * project's folder. The first tool a session calls also shows the Music Studio
 * view beside its chat (view.ts). The panel docked beside the session asks `follow` which
 * project that is and which stage the last tool belongs to.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute, relative } from "node:path";
import type { ExtensionApi, ExtensionSession, ExtensionTool } from "@prifly/extension-api";
import type { IndexEntry } from "./project/store";
import type { Studio } from "./studio";
import { autoOpen } from "./view";

export const STAGE_IDS = [
  "idea",
  "arrange",
  "produce",
  "mix",
  "master",
  "prepare",
  "treatment",
  "storyboard",
  "shoot",
  "edit",
  "deliver",
] as const;

export type StageId = (typeof STAGE_IDS)[number];

/** The stage of the panel a tool's work belongs to. */
export const STAGE_OF_TOOL: Readonly<Record<string, StageId>> = {
  music_sketch: "idea",
  music_choose: "idea",
  music_arrange: "arrange",
  music_stems: "produce",
  music_sfx: "produce",
  music_mix: "mix",
  music_master: "master",
  music_prepare: "prepare",
  music_deliver: "deliver",
  video_treatment: "treatment",
  video_storyboard: "storyboard",
  video_shoot: "shoot",
  video_edit: "edit",
  video_render: "deliver",
};

/** The stage to show after `tool` ran, or null for a tool with no stage of its own. */
export const stageOfTool = (tool: string | null): StageId | null =>
  tool === null ? null : (STAGE_OF_TOOL[tool] ?? null);

type Link = { project: string; tool: string; at: number };
type Links = Record<string, Link>;

const DOC = "session-links";
/** How many sessions' links are kept; the least recently used go first. */
const KEEP = 300;

const calling = new AsyncLocalStorage<{ session: string; tool: string }>();

/** Records that `tool` of `session` used `project`; the stamp rises with every call. */
export async function linkSession(
  studio: Studio,
  session: string,
  project: string,
  tool: string,
): Promise<void> {
  const state = studio.api().state;
  if (state === undefined) return;
  await state.update<Links>(DOC, (current) => {
    const links = current ?? {};
    const at = Math.max(Date.now(), (links[session]?.at ?? 0) + 1);
    const next: Links = { ...links, [session]: { project, tool, at } };
    const ids = Object.keys(next);
    if (ids.length <= KEEP) return next;
    const oldest = ids.sort((a, b) => (next[a]?.at ?? 0) - (next[b]?.at ?? 0));
    for (const id of oldest.slice(0, ids.length - KEEP)) delete next[id];
    return next;
  });
}

/** Called by a tool once it knows its project: links the calling session to it. Never fails the tool. */
export async function noteProject(studio: Studio, project: string): Promise<void> {
  const call = calling.getStore();
  if (call === undefined) return;
  try {
    await linkSession(studio, call.session, project, call.tool);
    await autoOpen(studio, call.session, project, call.tool);
  } catch (caught) {
    studio.api().log("session-link-failed", { error: String(caught) });
  }
}

/** The session prifly knows by this id, or null (also on a prifly without session lookup). */
export function sessionOf(api: ExtensionApi, id: string): ExtensionSession | null {
  try {
    return api.session(id);
  } catch {
    // A prifly without session lookup: the session is simply not known.
    return null;
  }
}

/** The project whose folder holds `cwd` (or is it), else null. */
function projectAt(studio: Studio, entries: IndexEntry[], cwd: string): IndexEntry | null {
  const store = studio.store();
  for (const entry of entries) {
    const inside = relative(store.pathOf(entry), cwd);
    if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) return entry;
  }
  return null;
}

export type Resolved =
  | { state: "following"; entry: IndexEntry; tool: string | null; at: number }
  | { state: "none" }
  | { state: "deleted" };

/** The project a session is linked to: by a tool it called, else by its folder. */
export async function resolveLink(studio: Studio, session: string): Promise<Resolved> {
  const state = studio.api().state;
  const links = (await state?.get<Links>(DOC)) ?? {};
  const link = links[session];
  const store = studio.store();
  const named = link === undefined ? null : await store.find(link.project);
  if (link !== undefined && named !== null)
    return { state: "following", entry: named, tool: link.tool, at: link.at };
  const cwd = sessionOf(studio.api(), session)?.cwd;
  const inside =
    cwd === undefined || cwd === "" ? null : projectAt(studio, await store.list(), cwd);
  if (inside !== null) return { state: "following", entry: inside, tool: null, at: 0 };
  return { state: link === undefined ? "none" : "deleted" };
}

/** The project a tool called without `project` should use: the calling session's, else null. */
export async function sessionProject(studio: Studio): Promise<IndexEntry | null> {
  const call = calling.getStore();
  if (call === undefined) return null;
  const resolved = await resolveLink(studio, call.session);
  return resolved.state === "following" ? resolved.entry : null;
}

/** Runs `tools` so that the projects they use are linked to the calling session. */
export function inSession(tools: ExtensionTool[]): ExtensionTool[] {
  return tools.map((tool) => ({
    ...tool,
    call: (args, ctx) =>
      calling.run({ session: ctx.session, tool: tool.name }, () => tool.call(args, ctx)),
  }));
}

/** What the panel's follow poll is answered with. */
export type FollowView = {
  /** following: open `project`; none: the session has no project yet; unknown: prifly does not know the session; deleted: its project is gone. */
  state: "following" | "none" | "unknown" | "deleted";
  session: { id: string; title: string } | null;
  project: string | null;
  projectTitle: string | null;
  /** The stage of the last tool the session called on the project, else null. */
  stage: StageId | null;
  /** Rises with every tool call; the panel jumps to `stage` when it changes. */
  stamp: number;
};

/** The answer to `api/follow?session=<id>`. */
export async function followRoute(studio: Studio, id: string): Promise<FollowView> {
  if (id === "") throw new Error("No session to follow.");
  const known = sessionOf(studio.api(), id);
  const resolved = await resolveLink(studio, id);
  const view = { project: null, projectTitle: null, stage: null, stamp: 0 };
  if (resolved.state === "following") {
    return {
      ...view,
      state: "following",
      session: { id, title: known?.title ?? id.slice(0, 8) },
      project: resolved.entry.id,
      projectTitle: resolved.entry.title,
      stage: stageOfTool(resolved.tool),
      stamp: resolved.at,
    };
  }
  if (known === null) return { ...view, state: "unknown", session: null };
  return { ...view, state: resolved.state, session: { id, title: known.title } };
}
