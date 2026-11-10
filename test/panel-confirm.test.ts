import { expect, test } from "bun:test";
import { askReader } from "../confirm";
import { route } from "../panel-router";
import type { Job } from "../studio";
import { BRIEF, happy, type World, world } from "./world";

type Started = { ok: true; job: Job } | { ok: false; reason: string; message: string };

const sketch = async (w: World, query: Record<string, string> = {}) =>
  (await route(w.studio, { path: "sketch", query, body: BRIEF })) as Started;

/** Waits until the run ends so the test leaves nothing running. */
async function settle(w: World, id: string): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    if (w.studio.jobs.get(id)?.status !== "running") return;
    await Bun.sleep(5);
  }
}

test("the bug: with no session and no tool call, prifly's confirm says no at once", async () => {
  const w = world(happy, { confirmNeedsSession: true });
  expect(await w.fake.api.confirm?.({ title: "t", summary: "s", details: "d" })).toBe(false);
});

test("a panel button on a docked panel asks over the panel's session", async () => {
  const w = world(happy, { confirmNeedsSession: true });
  const started = await sketch(w, { session: "session-1" });
  if (!started.ok) throw new Error(started.message);
  expect(w.fake.confirms).toHaveLength(1);
  expect(w.fake.confirms[0]?.sessionId).toBe("session-1");
  expect(w.fake.confirms[0]?.title).toBe("Sketch 3 ideas");
  expect(w.fake.dialogs).toHaveLength(0);
  await settle(w, started.job.id);
});

test("a session card the reader declines is a cancel, nothing is made", async () => {
  const w = world(happy, { confirmNeedsSession: true, confirm: false });
  const started = await sketch(w, { session: "session-1" });
  expect(started).toMatchObject({ ok: false, reason: "cancelled" });
  expect(w.calls.some((each) => each.url.endsWith("/v1/music/detailed"))).toBe(false);
});

test("a panel with no session asks in a dialog with the same summary and content", async () => {
  const w = world(happy, { confirmNeedsSession: true, dialog: "" });
  const started = await sketch(w);
  if (!started.ok) throw new Error(started.message);
  expect(w.fake.confirms).toHaveLength(0);
  const dialog = w.fake.dialogs[0];
  expect(dialog?.title).toBe("Sketch 3 ideas");
  expect(dialog?.description).toContain("billed by ElevenLabs to your plan");
  expect(dialog?.text).toContain(BRIEF.text);
  expect(dialog?.confirm).toBe("Generate");
  expect(dialog?.sessionId).toBeUndefined();
  await settle(w, started.job.id);
});

test("closing the dialog is a cancel", async () => {
  const w = world(happy, { confirmNeedsSession: true, dialog: null });
  expect(await sketch(w)).toMatchObject({ ok: false, reason: "cancelled" });
  expect(w.calls.some((each) => each.url.endsWith("/v1/music/detailed"))).toBe(false);
});

test("a session tool keeps asking with api.confirm, over its own session", async () => {
  const w = world(happy, { confirmNeedsSession: true });
  const text = await w.callTool("music_sketch", { brief: BRIEF.text });
  expect(text).toContain("Made 3 sketches.");
  expect(w.fake.confirms[0]?.session).toBe("fake-session");
  expect(w.fake.confirms[0]?.sessionId).toBeUndefined();
  expect(w.fake.dialogs).toHaveLength(0);
});

test("askReader says null when there is no way to ask", async () => {
  const w = world(happy);
  const api = { ...w.fake.api };
  delete api.confirm;
  expect(await askReader(api, { title: "t", summary: "s", details: "d" })).toBeNull();
});
