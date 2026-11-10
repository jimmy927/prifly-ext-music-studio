import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionToolContext } from "@prifly/extension-api";
import { route } from "../panel-router";
import { type FollowView, STAGE_OF_TOOL, stageOfTool } from "../session";
import { BRIEF, happy, type World, world } from "./world";

const follow = async (w: World, session: string): Promise<FollowView> =>
  (await route(w.studio, {
    path: "follow",
    query: { session },
    body: null,
  })) as FollowView;

/** Calls a tool as another session than the fake api's own. */
async function callAs(w: World, session: string, name: string, args: Record<string, unknown>) {
  const tool = w.fake.tools().find((each) => each.name === name);
  if (tool === undefined) throw new Error(`No tool ${name}`);
  const ctx: ExtensionToolContext = {
    session,
    pick: async () => null,
    signal: new AbortController().signal,
    scratchpad: w.folder,
  };
  return await tool.call(args, ctx);
}

type Links = Record<string, { project: string; tool: string; at: number }>;
const links = (w: World): Links => (w.fake.documents.get("session-links") ?? {}) as Links;

/** A world with two sketched projects, the second one newest. */
async function twoProjects() {
  const w = world(happy);
  await w.callTool("music_sketch", { brief: BRIEF.text });
  await w.callTool("music_sketch", { brief: "A second song" });
  const list = await w.studio.store().list();
  const [newest, oldest] = list;
  if (newest === undefined || oldest === undefined) throw new Error("two projects expected");
  w.fake.knownSessions.set("fake-session", { title: "Make a lofi song", cwd: "/work" });
  return { w, newest, oldest };
}

test("a sketch links the calling session to the project it made", async () => {
  const w = world(happy);
  w.fake.knownSessions.set("fake-session", { title: "Make a lofi song", cwd: "/work" });
  await w.callTool("music_sketch", { brief: BRIEF.text });
  const [entry] = await w.studio.store().list();
  expect(links(w)["fake-session"]).toMatchObject({ project: entry?.id, tool: "music_sketch" });
  const view = await follow(w, "fake-session");
  expect(view).toMatchObject({
    state: "following",
    project: entry?.id,
    projectTitle: entry?.title,
    stage: "idea",
    session: { id: "fake-session", title: "Make a lofi song" },
  });
});

test("a cancelled sketch links nothing", async () => {
  const w = world(happy, { confirm: false });
  await w.callTool("music_sketch", { brief: BRIEF.text });
  expect(links(w)).toEqual({});
});

test("a tool that names a project links it, and the stage follows the last tool", async () => {
  const { w, oldest } = await twoProjects();
  await w.callTool("music_mix", { project: oldest.id });
  expect(links(w)["fake-session"]).toMatchObject({ project: oldest.id, tool: "music_mix" });
  expect((await follow(w, "fake-session")).stage).toBe("mix");
  await w.callTool("video_render", { project: oldest.id, kind: "preview" });
  expect((await follow(w, "fake-session")).stage).toBe("deliver");
});

test("each call raises the stamp the panel jumps on", async () => {
  const { w, oldest } = await twoProjects();
  await w.callTool("music_mix", { project: oldest.id });
  const first = (await follow(w, "fake-session")).stamp;
  await w.callTool("music_mix", { project: oldest.id });
  expect((await follow(w, "fake-session")).stamp).toBeGreaterThan(first);
});

test("a tool called without a project uses the session's own, not the newest", async () => {
  const { w, newest, oldest } = await twoProjects();
  await w.callTool("music_mix", { project: oldest.id });
  const text = await w.callTool("music_mix", {});
  expect(links(w)["fake-session"]?.project).toBe(oldest.id);
  expect(text).not.toContain("No project");
  // A session with no link of its own still gets the newest.
  await callAs(w, "other-session", "music_mix", {});
  expect(links(w)["other-session"]?.project).toBe(newest.id);
});

test("a session whose folder is inside a project folder is linked to that project", async () => {
  const { w, newest, oldest } = await twoProjects();
  const inside = join(w.studio.store().pathOf(oldest), "deliver", "stems");
  mkdirSync(inside, { recursive: true });
  w.fake.knownSessions.set("cwd-session", { title: "Working in the folder", cwd: inside });
  const view = await follow(w, "cwd-session");
  expect(view).toMatchObject({ state: "following", project: oldest.id, stage: null, stamp: 0 });
  // The same link is what a tool without a project falls back to.
  await callAs(w, "cwd-session", "music_mix", {});
  expect(links(w)["cwd-session"]?.project).toBe(oldest.id);
  expect(links(w)["cwd-session"]?.project).not.toBe(newest.id);
});

test("a folder that only shares a name prefix with a project is not inside it", async () => {
  const { w, oldest } = await twoProjects();
  w.fake.knownSessions.set("near", {
    title: "Next door",
    cwd: `${w.studio.store().pathOf(oldest)}-x`,
  });
  expect((await follow(w, "near")).state).toBe("none");
});

test("a session with no project yet, an unknown session and a deleted project are told apart", async () => {
  const { w, oldest } = await twoProjects();
  w.fake.knownSessions.set("fresh", { title: "Fresh chat", cwd: "/elsewhere" });
  expect(await follow(w, "fresh")).toMatchObject({
    state: "none",
    project: null,
    session: { id: "fresh", title: "Fresh chat" },
  });
  expect(await follow(w, "nobody")).toMatchObject({ state: "unknown", session: null });
  await w.callTool("music_mix", { project: oldest.id });
  await w.studio.store().remove(oldest);
  expect(await follow(w, "fake-session")).toMatchObject({ state: "deleted", project: null });
});

test("the follow route needs a session", async () => {
  const w = world(happy);
  await expect(follow(w, "")).rejects.toThrow("No session to follow");
});

test("a link that cannot be saved does not fail the tool", async () => {
  const w = world(happy);
  const state = w.fake.api.state;
  if (state === undefined) throw new Error("the fake api keeps state");
  const update = state.update.bind(state);
  state.update = async (name, fn) => {
    if (name === "session-links") throw new Error("disk full");
    return await update(name, fn);
  };
  const text = await w.callTool("music_sketch", { brief: BRIEF.text });
  expect(text).toContain("Made 3 sketches.");
  expect(w.fake.logs.some((each) => each.event === "session-link-failed")).toBe(true);
});

test("every tool that works on a project has a stage; the library has none", () => {
  const projectTools = w0()
    .fake.tools()
    .map((each) => each.name);
  for (const name of projectTools.filter((each) => each !== "music_library"))
    expect(stageOfTool(name)).not.toBeNull();
  expect(stageOfTool("music_library")).toBeNull();
  expect(stageOfTool(null)).toBeNull();
  expect(STAGE_OF_TOOL).toMatchObject({
    music_sketch: "idea",
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
  });
});

function w0(): World {
  return world(happy);
}
