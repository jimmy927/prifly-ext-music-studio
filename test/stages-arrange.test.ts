import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Draft, toDraft } from "../arrange/plan";
import type { ArrangeView } from "../routes/views";
import { ask, chosenProject, declineCards, runJob, stageWorld } from "./stage-world";
import { BRIEF } from "./world";

const draftsOf = async (w: ReturnType<typeof stageWorld>, project: string): Promise<Draft[]> => {
  const view = (await ask(w, "arrange", { project })) as ArrangeView;
  return toDraft(view.base?.sections ?? []);
};

const detailed = (w: ReturnType<typeof stageWorld>) =>
  w.calls.filter((call) => call.url.endsWith("/v1/music/detailed"));

test("Arrange shows the chosen ElevenLabs sketch's stored plan as sections", async () => {
  const w = stageWorld();
  const project = await chosenProject(w);
  const view = (await ask(w, "arrange", { project })) as ArrangeView;
  expect(view.available).toBe(true);
  expect(view.base?.label).toBe("Sketch A");
  expect(view.base?.sections.map((each) => each.durationMs)).toEqual([8000, 12000, 6000, 4000]);
  expect(view.tempo).toBe(122);
  expect(view.versions).toEqual([]);
});

test("Render changes: one card, only changed sections generated, kept ones reused, v1 saved", async () => {
  const fakes = { renders: 0, songs: 0 };
  const w = stageWorld({}, fakes);
  const project = await chosenProject(w);
  const sketchCalls = detailed(w).length;
  const drafts = await draftsOf(w, project);
  drafts[1] = { ...(drafts[1] as Draft), text: "[Verse]\nnew words", negativeStyles: ["sparse"] };
  drafts.splice(3, 1, {
    ...(drafts[3] as Draft),
    source: null,
    text: "[Bridge]\nhey",
    durationMs: 5000,
  });

  const done = await runJob(w, "arrange-render", { project, sections: drafts });
  if (!("status" in done)) throw new Error(done.message);
  expect(done.status).toBe("done");
  expect(done.work).toBe("arrange");
  expect(done.result).toBe("v1");
  expect(w.fake.confirms).toHaveLength(2); // the sketches, then this render
  expect(w.fake.confirms[1]?.title).toBe("Render changes");
  expect(w.fake.confirms[1]?.summary).toContain("Generate 2 sections");
  expect(w.fake.confirms[1]?.content).toContain("Verse: changed (negative styles, lyrics)");
  expect(w.fake.confirms[1]?.content).toContain("Intro: kept");

  const render = detailed(w)[sketchCalls];
  const body = JSON.parse(render?.body ?? "{}") as Record<string, unknown>;
  expect(body["model_id"]).toBe("music_v2_5");
  expect(body["store_for_inpainting"]).toBe(true);
  const chunks = (body["composition_plan"] as { chunks: Record<string, unknown>[] }).chunks;
  expect(chunks.map((each) => ("song_id" in each ? "keep" : "make"))).toEqual([
    "keep",
    "make",
    "keep",
    "make",
  ]);
  // The first sketch (`sketch-1`) is a, the chosen one; its chunks are 8000, 12000, 6000, 4000 ms long.
  expect(chunks[0]).toEqual({ song_id: "sketch-1", range: { start_ms: 0, end_ms: 8000 } });
  expect(chunks[2]).toEqual({ song_id: "sketch-1", range: { start_ms: 20000, end_ms: 26000 } });
  expect(fakes.renders).toBe(1);

  const dir = w.studio.store().pathOf((await w.studio.store().find(project)) as never);
  expect(existsSync(join(dir, "versions", "v1.mp3"))).toBe(true);
  expect(existsSync(join(dir, "versions", "v1.json"))).toBe(true);
  expect(existsSync(join(dir, "sketches", "a.mp3"))).toBe(true);

  const view = (await ask(w, "arrange", { project })) as ArrangeView;
  expect(view.active).toBe("v1");
  expect(view.base?.label).toBe("Version 1");
  expect(view.base?.sections.map((each) => each.durationMs)).toEqual([8000, 12000, 6000, 5000]);
  expect(view.versions[0]).toMatchObject({
    id: "v1",
    counts: { kept: 2, changed: 1, inserted: 1, deleted: 1 },
  });
});

test("the second render edits the first version: merged range, durations from v1, v1 kept and playable", async () => {
  const w = stageWorld();
  const project = await chosenProject(w);
  const first = await draftsOf(w, project);
  first[3] = { ...(first[3] as Draft), source: null, durationMs: 5000, text: "[Outro]\nbye" };
  const one = await runJob(w, "arrange-render", { project, sections: first });
  if (!("status" in one)) throw new Error(one.message);

  const second = await draftsOf(w, project);
  second[3] = { ...(second[3] as Draft), text: "[Outro]\nbye bye" };
  const two = await runJob(w, "arrange-render", { project, sections: second });
  if (!("status" in two)) throw new Error(two.message);
  expect(two.result).toBe("v2");
  const render = detailed(w).at(-1);
  const chunks = (JSON.parse(render?.body ?? "{}") as { composition_plan: { chunks: unknown[] } })
    .composition_plan.chunks;
  // v1 was stored by ElevenLabs as render-N; the three kept sections are one slice of it.
  expect(chunks).toHaveLength(2);
  expect(chunks[0]).toMatchObject({ range: { start_ms: 0, end_ms: 26000 } });
  expect(JSON.stringify(chunks[0])).toContain("render-");

  const view = (await ask(w, "arrange", { project })) as ArrangeView;
  expect(view.versions.map((each) => each.id)).toEqual(["v1", "v2"]);
  const picked = (await ask(w, "version-pick", {}, { project, version: "v1" })) as ArrangeView;
  expect(picked.active).toBe("v1");
  expect(picked.base?.sections[3]?.text).toBe("[Outro]\nbye");
  const media = (await ask(w, "media", { project, kind: "version", id: "v1" })) as {
    mime: string;
    base64: string;
  };
  expect(media.mime).toBe("audio/mpeg");
  expect(media.base64.length).toBeGreaterThan(10);
  await expect(ask(w, "version-pick", {}, { project, version: "v9" })).rejects.toThrow(
    "No such version",
  );
});

test("cancelling the card renders nothing and says so", async () => {
  const w = stageWorld();
  const project = await chosenProject(w);
  const drafts = await draftsOf(w, project);
  declineCards(w);
  const before = detailed(w).length;
  const answer = await runJob(w, "arrange-render", {
    project,
    sections: drafts.map((each, at) => (at === 0 ? { ...each, text: "[Intro]\nx" } : each)),
  });
  expect(answer).toMatchObject({ ok: false, reason: "cancelled" });
  expect(detailed(w)).toHaveLength(before);
});

test("nothing changed and bad lengths are refused before any card", async () => {
  const w = stageWorld();
  const project = await chosenProject(w);
  const drafts = await draftsOf(w, project);
  const cards = w.fake.confirms.length;
  expect(await runJob(w, "arrange-render", { project, sections: drafts })).toMatchObject({
    ok: false,
    message: "Nothing changed.",
  });
  const short = drafts.map((each, at) => (at === 1 ? { ...each, durationMs: 2000 } : each));
  expect(await runJob(w, "arrange-render", { project, sections: short })).toMatchObject({
    ok: false,
    reason: "invalid",
  });
  expect(w.fake.confirms).toHaveLength(cards);
});

test("ElevenLabs refusing the plan shows its message and suggestion; no version is saved", async () => {
  const w = stageWorld();
  const project = await chosenProject(w);
  const drafts = await draftsOf(w, project);
  const inner = w.studio.deps.fetch;
  (w.studio.deps as { fetch: typeof inner }).fetch = async (url, init) =>
    typeof init?.body === "string" && init.body.includes("composition_plan")
      ? Response.json(
          {
            detail: {
              status: "bad_prompt",
              message: "Inpainting is not on your plan.",
              data: { prompt_suggestion: "A calm piano." },
            },
          },
          { status: 400 },
        )
      : inner(url, init);
  const job = await runJob(w, "arrange-render", {
    project,
    sections: drafts.map((each, at) => (at === 1 ? { ...each, text: "[Verse]\nx" } : each)),
  });
  if (!("status" in job)) throw new Error(job.message);
  expect(job).toMatchObject({
    status: "failed",
    kind: "bad_prompt",
    error: "Inpainting is not on your plan.",
    suggestion: "A calm piano.",
  });
  const view = (await ask(w, "arrange", { project })) as ArrangeView;
  expect(view.versions).toEqual([]);
});

test("a chosen Lyria sketch has Arrange off, with the reason", async () => {
  const w = stageWorld();
  const project = await chosenProject(w, { ...BRIEF, engine: "lyria-clip" });
  const view = (await ask(w, "arrange", { project })) as ArrangeView;
  expect(view.available).toBe(false);
  expect(view.reason).toBe("Lyria has no section plan, so there is nothing to arrange.");
  const cards = w.fake.confirms.length;
  const refused = await runJob(w, "arrange-render", { project, sections: [] });
  expect(refused).toMatchObject({ ok: false, message: view.reason });
  expect(w.fake.confirms).toHaveLength(cards);
});
