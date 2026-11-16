import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { activate, choices, launch, launched, panel } from "../index";
import {
  briefText,
  LAUNCH_KEY,
  LAUNCHER_ID,
  launched as learn,
  openRoute,
  startedRoute,
} from "../open";
import { run, type Shown, TIMEOUT_TEXT } from "../panel/src/opener";
import { openSessionView } from "../panel/src/session-view";
import { app } from "../panel/src/state";
import { route } from "../panel-router";
import manifest from "../prifly-extension.json";
import { linkSession } from "../session";
import { fakeApi } from "./fake-api";
import { happy, world } from "./world";

afterEach(() => {
  app.opening = null;
  app.view = "idea";
});

/** The extension as prifly runs it: activated on a fake api with an empty library. */
function running(options: { views?: boolean; openSession?: boolean } = {}) {
  const folder = mkdtempSync(join(tmpdir(), "music-studio-open-"));
  const fake = fakeApi({ settings: { libraryFolder: folder }, ...options });
  const stop = activate(fake.api);
  return { folder, fake, stop };
}

const click = () =>
  panel("open", { path: "open", query: {}, body: null }) as Promise<{
    action: string;
    session: string | null;
    canOpen: boolean;
    launcher: string;
    key: string;
  }>;

test("the manifest has the session view and an opener, and no panel that shows the studio", () => {
  expect(manifest.sessionViews.map((each) => each.id)).toEqual(["studio-view"]);
  expect(manifest.panels.map((each) => each.id)).toEqual(["open"]);
  expect(manifest.panels[0]?.page).toBe("open.html");
  expect(manifest.launch.map((each) => each.id)).toEqual([LAUNCHER_ID]);
  expect(choices().map((each) => each.key)).toEqual([LAUNCH_KEY]);
});

test("the click starts a session when there is none, through the launcher, and shows nothing yet", async () => {
  const { fake, stop } = running({ views: true, openSession: true });
  try {
    expect(await click()).toMatchObject({
      action: "launch",
      session: null,
      canOpen: true,
      launcher: LAUNCHER_ID,
      key: LAUNCH_KEY,
    });
    expect(fake.viewShown).toEqual([]);
  } finally {
    stop();
  }
});

test("the click reuses the Music Studio session: no second one, the studio shown on the Library", async () => {
  const { fake, folder, stop } = running({ views: true, openSession: true });
  try {
    fake.knownSessions.set("s-one", { title: "Music Studio", cwd: folder });
    await launched("studio", "session", "s-one");
    // Learning of the new session already shows the Library in it.
    expect(fake.viewShown).toEqual([{ sessionId: "s-one", viewId: "studio-view", params: {} }]);
    fake.viewShown.length = 0;
    expect(await click()).toMatchObject({ action: "open", session: "s-one", canOpen: true });
    expect(await click()).toMatchObject({ action: "open", session: "s-one" });
    expect(fake.viewShown).toHaveLength(2);
    expect(fake.viewShown[0]).toEqual({ sessionId: "s-one", viewId: "studio-view", params: {} });
  } finally {
    stop();
  }
});

test("the click goes back to the newest session prifly still has, never an archived or lost one", async () => {
  const w = world(happy, { views: true, openSession: true });
  w.fake.knownSessions.set("old", { title: "Old", cwd: w.folder });
  w.fake.knownSessions.set("archived", { title: "Archived", cwd: w.folder, archived: true });
  for (const id of ["old", "archived", "lost"]) {
    await learn(w.studio, id);
    await Bun.sleep(2);
  }
  expect((await openRoute(w.studio)).session).toBe("old");
  w.fake.knownSessions.delete("old");
  expect((await openRoute(w.studio)).action).toBe("launch");
});

test("the studio opens on the session's last project when it has one", async () => {
  const w = world(happy, { views: true, openSession: true });
  await w.callTool("music_sketch", { brief: "A song about rain" });
  const [entry] = await w.studio.store().list();
  if (entry === undefined) throw new Error("a project was made");
  w.fake.knownSessions.set("s-two", { title: "Studio", cwd: w.folder });
  await learn(w.studio, "s-two");
  await linkSession(w.studio, "s-two", entry.id, "music_mix");
  w.fake.viewShown.length = 0;
  expect((await openRoute(w.studio)).session).toBe("s-two");
  expect(w.fake.viewShown).toEqual([
    { sessionId: "s-two", viewId: "studio-view", params: { project: entry.id } },
  ]);
  // A view asked for with no project follows the session's link to it.
  const asked = await route(w.studio, {
    path: "view",
    query: {},
    body: null,
    sessionId: "s-two",
    params: {},
  });
  expect(asked).toMatchObject({ state: "open", project: entry.id });
});

test("a view with no project, for a session with none, shows the Library", async () => {
  const w = world(happy, { views: true });
  const asked = await route(w.studio, {
    path: "view",
    query: {},
    body: null,
    sessionId: "s-new",
    params: {},
  });
  expect(asked).toEqual({ state: "none" });
  const original = { fetch: globalThis.fetch, location: globalThis.location };
  Object.assign(globalThis, {
    location: { pathname: "/extension-view/x/studio-view/s1/index.html", search: "" },
    fetch: async () => Response.json(asked),
  });
  try {
    app.view = "idea";
    await openSessionView();
    expect(app.view as string).toBe("library");
    expect(app.opening).toBeNull();
    expect(app.project).toBeNull();
  } finally {
    Object.assign(globalThis, original);
  }
});

test("the Library lists projects with no project param, empty or not", async () => {
  const w = world(happy, { views: true });
  const library = () =>
    route(w.studio, { path: "library", query: {}, body: null, sessionId: "s1", params: {} });
  expect(await library()).toEqual({ projects: [] });
  await w.callTool("music_sketch", { brief: "A song about rain" });
  const listed = (await library()) as { projects: { id: string }[] };
  expect(listed.projects).toHaveLength(1);
});

test("launch writes the studio brief, started in the library folder (made when missing)", () => {
  const where = running({ views: true });
  try {
    const made = join(where.folder, "not-yet");
    Object.assign(where.fake.api.settings ?? {}, { libraryFolder: made });
    const result = launch();
    expect(result.cwd).toBe(made);
    expect(result.name).toBe("Music Studio");
    expect(result.prompt).toBe(briefText(true));
    expect(result.prompt).toContain("music_open");
    expect(result.prompt).toContain("music_*");
    expect(result.prompt).toContain("video_*");
    expect(result.prompt).not.toContain("update prifly");
  } finally {
    where.stop();
  }
});

test("on a prifly without session views the brief says to update prifly and the session still starts", async () => {
  const where = running({});
  try {
    const result = launch();
    expect(result.prompt).toBe(briefText(false));
    expect(result.prompt).toContain("update prifly");
    expect(result.prompt).toContain("music_*");
    // Learning of the session shows nothing and fails nothing; a click still finds it.
    await launched("studio", "session", "s-old");
    expect(where.fake.viewShown).toEqual([]);
    where.fake.knownSessions.set("s-old", { title: "Studio", cwd: where.folder });
    expect(await click()).toMatchObject({ action: "open", session: "s-old", canOpen: false });
  } finally {
    where.stop();
  }
});

test("a library folder that cannot be made falls back to the home folder, and says so in the log", () => {
  const folder = mkdtempSync(join(tmpdir(), "music-studio-open-"));
  const blocker = join(folder, "a-file");
  writeFileSync(blocker, "x");
  const fake = fakeApi({ settings: { libraryFolder: join(blocker, "inside") } });
  const stop = activate(fake.api);
  try {
    expect(launch().cwd).toBe(homedir());
    expect(fake.logs.some((each) => each.event === "studio-folder-failed")).toBe(true);
  } finally {
    stop();
  }
});

test("api/started waits for a session started after the click, then names it", async () => {
  const w = world(happy, { views: true });
  const before = Date.now();
  expect(await startedRoute(w.studio, before)).toEqual({ state: "waiting" });
  w.fake.knownSessions.set("s-new", { title: "Fresh", cwd: w.folder });
  await learn(w.studio, "s-new");
  expect(await startedRoute(w.studio, before)).toEqual({
    state: "started",
    session: "s-new",
    title: "Fresh",
  });
  // A session from before this click is not this click's.
  expect(await startedRoute(w.studio, Date.now() + 1000)).toEqual({ state: "waiting" });
});

/** An opener over a scripted server: what each path answers, and what the page posted and said. */
function opener(answers: Record<string, unknown[]>) {
  const posted: Record<string, string>[] = [];
  const shown: Shown[] = [];
  const asked: string[] = [];
  return {
    posted,
    shown,
    asked,
    deps: {
      get: async (path: string) => {
        asked.push(path);
        const next = answers[path.split("?")[0] ?? path]?.shift();
        if (next instanceof Error) throw next;
        return next;
      },
      post: (message: Record<string, string>) => void posted.push(message),
      sleep: async () => undefined,
      show: (each: Shown) => void shown.push(each),
    },
  };
}

const LAUNCH = { action: "launch", since: 5, canOpen: true, launcher: "studio", key: "session" };

test("the opener page says it is loading, then lands on the existing session", async () => {
  const page = opener({ open: [{ ...LAUNCH, action: "open", session: "s-one", title: "Studio" }] });
  await run(page.deps);
  expect(page.shown[0]).toEqual({ kind: "busy", text: "Opening your Music Studio session…" });
  expect(page.posted).toEqual([{ type: "prifly-open-session", session: "s-one" }]);
});

test("the opener page starts a session, waits for it, then lands on it", async () => {
  const page = opener({
    open: [LAUNCH],
    started: [{ state: "waiting" }, { state: "started", session: "s-new", title: "Music Studio" }],
  });
  await run(page.deps);
  expect(page.posted).toEqual([
    { type: "prifly-launch", launcher: "studio", key: "session" },
    { type: "prifly-open-session", session: "s-new" },
  ]);
  expect(page.asked).toEqual(["open", "started?since=5", "started?since=5"]);
  expect(page.shown.some((each) => each.kind === "error")).toBe(false);
});

test("the opener page on a prifly that cannot open a session points at the sidebar", async () => {
  const page = opener({
    open: [{ ...LAUNCH, action: "open", session: "s-one", title: "Studio", canOpen: false }],
  });
  await run(page.deps);
  expect(page.posted).toEqual([]);
  expect(page.shown.at(-1)?.kind).toBe("info");
  expect(page.shown.at(-1)?.text).toContain("sidebar");
});

test("the opener page says when no session came, and when it could not even ask", async () => {
  const silent = opener({
    open: [LAUNCH],
    started: Array.from({ length: 40 }, () => ({ state: "waiting" })),
  });
  await run(silent.deps);
  expect(silent.shown.at(-1)).toEqual({ kind: "error", text: TIMEOUT_TEXT });
  const broken = opener({ open: [new Error("This prifly keeps no state. Update prifly.")] });
  await run(broken.deps);
  expect(broken.posted).toEqual([]);
  expect(broken.shown.at(-1)).toEqual({
    kind: "error",
    text: "Could not open Music Studio: This prifly keeps no state. Update prifly.",
  });
});

test("on a prifly without state the click fails with a message and starts nothing", async () => {
  const { fake, stop } = running({ views: true, openSession: true });
  try {
    delete (fake.api as { state?: unknown }).state;
    await expect(click()).rejects.toThrow("This prifly keeps no state. Update prifly.");
    expect(fake.viewShown).toEqual([]);
  } finally {
    stop();
  }
});
