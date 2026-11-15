import { afterEach, expect, test } from "bun:test";
import { call, type FollowView, panelSession } from "../panel/src/api";
import { DELETED_TEXT, NO_PROJECT_TEXT, noteFor, UNKNOWN_TEXT } from "../panel/src/follow";

const view = (state: FollowView["state"]): FollowView => ({
  state,
  session: null,
  project: null,
  projectTitle: null,
  stage: null,
  stamp: 0,
});

const original = { location: globalThis.location, fetch: globalThis.fetch };
afterEach(() => {
  Object.assign(globalThis, original);
});

/** Stands in for the page's address and records the urls the page fetches. */
function page(pathname: string): string[] {
  const urls: string[] = [];
  Object.assign(globalThis, {
    location: { pathname, search: "" },
    fetch: async (url: string) => {
      urls.push(url);
      return Response.json({});
    },
  });
  return urls;
}

const VIEW = "/extension-view/music-studio/studio-view/abc%20123/index.html";

test("the session view knows its session from the address", () => {
  page(VIEW);
  expect(panelSession()).toBe("abc 123");
  page("/extension-panel/music-studio/open/open.html");
  expect(panelSession()).toBeNull();
});

test("every request carries the session, so a paid button's card is asked over it", async () => {
  const urls = page(VIEW);
  await call("sketch", {});
  await call("project?id=p1");
  expect(urls).toEqual(["api/sketch?session=abc%20123", "api/project?id=p1&session=abc%20123"]);
});

test("without a session the requests are as before", async () => {
  const urls = page("/extension-panel/music-studio/open/open.html");
  await call("project?id=p1");
  expect(urls).toEqual(["api/project?id=p1"]);
});

test("the states with no project to follow are said in words", () => {
  expect(noteFor(view("none"), null)).toBe(NO_PROJECT_TEXT);
  expect(NO_PROJECT_TEXT).toBe(
    "This session has no Music Studio project yet. Ask Claude to start one.",
  );
  expect(noteFor(view("unknown"), null)).toBe(UNKNOWN_TEXT);
  expect(noteFor(view("deleted"), null)).toBe(DELETED_TEXT);
  expect(noteFor(view("following"), null)).toBe("");
  expect(noteFor(null, null)).toBe("");
  expect(noteFor(null, "offline")).toContain("offline");
});
