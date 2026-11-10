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
function page(search: string): string[] {
  const urls: string[] = [];
  Object.assign(globalThis, {
    location: { search },
    fetch: async (url: string) => {
      urls.push(url);
      return Response.json({});
    },
  });
  return urls;
}

test("the docked window knows its session from the address", () => {
  page("?theme=dark&session=abc-123");
  expect(panelSession()).toBe("abc-123");
  page("?theme=dark");
  expect(panelSession()).toBeNull();
  page("?session=");
  expect(panelSession()).toBeNull();
});

test("every request carries the session, so a paid button's card is asked over it", async () => {
  const urls = page("?session=abc%20123");
  await call("sketch", {});
  await call("project?id=p1");
  expect(urls).toEqual(["api/sketch?session=abc%20123", "api/project?id=p1&session=abc%20123"]);
});

test("without a session the requests are as before", async () => {
  const urls = page("?theme=light");
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
