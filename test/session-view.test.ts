import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionToolContext } from "@prifly/extension-api";
import { activate, panel } from "../index";
import { inSessionView, panelSession } from "../panel/src/api";
import { MISSING_TEXT, openSessionView } from "../panel/src/session-view";
import { app } from "../panel/src/state";
import { route } from "../panel-router";
import manifest from "../prifly-extension.json";
import { OLD_PRIFLY, type ViewAnswer } from "../view";
import { fakeApi } from "./fake-api";
import { BRIEF, happy, type World, world } from "./world";

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

async function sketched(w: World, text = BRIEF.text) {
  await w.callTool("music_sketch", { brief: text });
  const [newest] = await w.studio.store().list();
  if (newest === undefined) throw new Error("a project was made");
  return newest;
}

afterEach(() => {
  app.opening = null;
});

test("the manifest declares the studio session view on the panel's page, with media", () => {
  const [view] = manifest.sessionViews;
  expect(manifest.sessionViews).toHaveLength(1);
  expect(view).toEqual({
    id: "studio-view",
    label: "Music Studio",
    folder: "panel",
    page: "index.html",
    media: true,
  });
  // A view's id is one no panel has, and the view is the only UI: no panel shows the studio.
  expect(manifest.panels.map((each) => each.id)).not.toContain(view?.id);
  expect(manifest.panels.map((each) => each.id)).not.toContain("studio");
  expect(manifest.panels.map((each) => each.page)).not.toContain(view?.page);
});

test("music_open shows the view in the calling session with the project and stage", async () => {
  const w = world(happy, { views: true });
  const entry = await sketched(w);
  w.fake.viewShown.length = 0;
  const text = await w.callTool("music_open", { project: entry.id, stage: "mix" });
  expect(w.fake.viewShown).toEqual([
    {
      sessionId: "fake-session",
      viewId: "studio-view",
      params: { project: entry.id, stage: "mix" },
    },
  ]);
  expect(text).toContain(entry.title);
  expect(text).toContain("mix");
});

test("music_open takes a title, and opens on Idea without a stage", async () => {
  const w = world(happy, { views: true });
  const entry = await sketched(w);
  w.fake.viewShown.length = 0;
  await w.callTool("music_open", { project: entry.title.toUpperCase() });
  expect(w.fake.viewShown[0]?.params).toEqual({ project: entry.id, stage: "idea" });
});

test("music_open without a project uses the session's own, and says what it cannot do", async () => {
  const w = world(happy, { views: true });
  expect(await w.callTool("music_open", {})).toContain("library is empty");
  const entry = await sketched(w);
  w.fake.viewShown.length = 0;
  await w.callTool("music_open", {});
  expect(w.fake.viewShown[0]?.params["project"]).toBe(entry.id);
  expect(await w.callTool("music_open", { project: "no such song" })).toContain("No project");
  expect(await w.callTool("music_open", { project: entry.id, stage: "dance" })).toContain(
    "no stage",
  );
  expect(w.fake.viewShown).toHaveLength(1);
});

test("music_open on a prifly without session views tells the session to update prifly", async () => {
  const w = world(happy);
  const entry = await sketched(w);
  const text = await w.callTool("music_open", { project: entry.id });
  expect(text).toBe(`Not done: ${OLD_PRIFLY}`);
  expect(text).toContain("Update prifly");
});

test("the first music tool of a session opens the view on its project, at its stage, once", async () => {
  const w = world(happy, { views: true });
  const first = await sketched(w);
  expect(w.fake.viewShown).toEqual([
    {
      sessionId: "fake-session",
      viewId: "studio-view",
      params: { project: first.id, stage: "idea" },
    },
  ]);
  // The same project again, at another stage: the page's own polling shows it.
  await w.callTool("music_mix", { project: first.id });
  await w.callTool("music_mix", { project: first.id });
  expect(w.fake.viewShown).toHaveLength(1);
  // Another project replaces the params; another session gets its own view.
  const second = await sketched(w, "A second song");
  expect(w.fake.viewShown).toHaveLength(2);
  expect(w.fake.viewShown[1]?.params).toEqual({ project: second.id, stage: "idea" });
  await callAs(w, "other-session", "music_mix", { project: second.id });
  expect(w.fake.viewShown).toHaveLength(3);
  expect(w.fake.viewShown[2]).toEqual({
    sessionId: "other-session",
    viewId: "studio-view",
    params: { project: second.id, stage: "mix" },
  });
});

test("a video tool opens the view at its stage", async () => {
  const w = world(happy, { views: true });
  const entry = await sketched(w);
  await callAs(w, "video-session", "video_treatment", { project: entry.id });
  expect(w.fake.viewShown.at(-1)).toEqual({
    sessionId: "video-session",
    viewId: "studio-view",
    params: { project: entry.id, stage: "treatment" },
  });
});

test("music_open counts as shown, so the next tool does not reload the page", async () => {
  const w = world(happy, { views: true });
  const entry = await sketched(w);
  await w.callTool("music_open", { project: entry.id, stage: "master" });
  const count = w.fake.viewShown.length;
  await w.callTool("music_mix", { project: entry.id });
  expect(w.fake.viewShown).toHaveLength(count);
});

test("without the session-views feature nothing is shown and the tools work", async () => {
  const w = world(happy);
  await sketched(w);
  expect(w.fake.viewShown).toEqual([]);
  expect(w.fake.documents.has("session-views")).toBe(false);
});

test("a view that cannot be shown is tried again by the next tool and never fails one", async () => {
  const w = world(happy, { views: true });
  let refuse = true;
  const real = (w.fake.api as unknown as { showSessionView: (...given: unknown[]) => void })
    .showSessionView;
  Object.assign(w.fake.api, {
    showSessionView: (...given: unknown[]) => {
      if (refuse) throw new Error("no such view");
      real(...given);
    },
  });
  const entry = await sketched(w);
  expect(w.fake.viewShown).toEqual([]);
  expect(w.fake.logs.some((each) => each.event === "session-view-failed")).toBe(true);
  refuse = false;
  await w.callTool("music_mix", { project: entry.id });
  expect(w.fake.viewShown).toHaveLength(1);
});

const viewRequest = (path: string, params: Record<string, string>, query = {}) => ({
  path,
  query,
  body: null,
  sessionId: "fake-session",
  params,
});

test("panel(view) answers what the view was shown with, and routes like the panel", async () => {
  const folder = mkdtempSync(join(tmpdir(), "music-studio-view-"));
  const fake = fakeApi({ settings: { libraryFolder: folder }, views: true, media: true });
  const stop = activate(fake.api);
  try {
    const gone = (await panel(
      "studio-view",
      viewRequest("view", { project: "00000000", stage: "mix" }),
    )) as ViewAnswer;
    expect(gone).toEqual({ state: "missing", project: "00000000" });
    expect(await panel("studio-view", viewRequest("view", {}))).toEqual({ state: "none" });
    // Every other path answers exactly as the panel does.
    expect(await panel("studio-view", viewRequest("library", { project: "x" }))).toEqual(
      await panel("open", { path: "library", query: {}, body: null }),
    );
    await expect(panel("studio-view", viewRequest("nope", {}))).rejects.toThrow("No such route");
  } finally {
    stop();
  }
});

test("api/view opens the project and a known stage, and leaves an unknown stage to Idea", async () => {
  const w = world(happy, { views: true });
  const entry = await sketched(w);
  const at = async (stage: string) =>
    (await route(w.studio, viewRequest("view", { project: entry.id, stage }))) as ViewAnswer;
  const mixed = await at("mix");
  expect(mixed).toMatchObject({
    state: "open",
    project: entry.id,
    title: entry.title,
    stage: "mix",
  });
  expect(mixed.state === "open" && mixed.stamp).toBeGreaterThan(0);
  expect(await at("dance")).toMatchObject({ state: "open", stage: null });
});

test("the extension serves the library folder for the panel and the view, when prifly can", () => {
  const folder = mkdtempSync(join(tmpdir(), "music-studio-media-"));
  const on = fakeApi({ settings: { libraryFolder: folder }, media: true });
  activate(on.api)();
  expect(on.mediaFolders).toEqual([{ panelId: "studio-view", folder }]);
  const off = fakeApi({ settings: { libraryFolder: folder } });
  activate(off.api)();
  expect(off.mediaFolders).toEqual([]);
});

test("api/media sends a streaming url where the folder is served, else base64", async () => {
  const w = world(happy, { media: true });
  const entry = await sketched(w);
  const ask = (query: Record<string, string>) =>
    route(w.studio, { path: "media", query: { project: entry.id, id: "a", ...query }, body: null });
  // Not served yet: base64, even when the page asks for a stream.
  expect(await ask({ stream: "1" })).toHaveProperty("base64");
  w.studio.serveMedia();
  expect(w.fake.mediaFolders.map((each) => each.panelId)).toEqual(["studio-view"]);
  expect(await ask({ stream: "1" })).toEqual({
    mime: "audio/mpeg",
    url: `media/${entry.dir}/sketches/a.mp3`,
  });
  expect(await ask({})).toHaveProperty("base64");
  await expect(ask({ stream: "1", id: "zz" })).rejects.toThrow();
});

test("the page knows the session view's address and its session", () => {
  const original = globalThis.location;
  const at = (pathname: string, search = "") =>
    Object.assign(globalThis, { location: { pathname, search } });
  try {
    at("/extension-view/music-studio/studio-view/abc%20123/index.html");
    expect(inSessionView()).toBe(true);
    expect(panelSession()).toBe("abc 123");
    at("/extension-panel/music-studio/open/open.html", "");
    expect(inSessionView()).toBe(false);
    expect(panelSession()).toBeNull();
  } finally {
    Object.assign(globalThis, { location: original });
  }
});

test("the page says it is loading, and a missing project with a way to the Library", async () => {
  const original = { fetch: globalThis.fetch, location: globalThis.location };
  const seen: (string | null)[] = [];
  Object.assign(globalThis, {
    location: { pathname: "/extension-view/x/studio-view/s1/index.html", search: "" },
    fetch: async () => {
      seen.push(app.opening?.state ?? null);
      return Response.json({ state: "missing", project: "deadbeef" });
    },
  });
  try {
    await openSessionView();
    expect(seen).toEqual(["loading"]);
    expect(app.opening).toEqual({ state: "missing", text: MISSING_TEXT });
    Object.assign(globalThis, {
      fetch: async () => Response.json({ error: "No keys." }, { status: 500 }),
    });
    await openSessionView();
    expect(app.opening).toEqual({ state: "error", text: "Could not open the project: No keys." });
  } finally {
    Object.assign(globalThis, original);
  }
});
