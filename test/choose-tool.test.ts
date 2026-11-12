import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { type Answer, ask, finished, stageWorld } from "./stage-world";
import { BRIEF, type World } from "./world";

/** A project with three sketches and none chosen. */
async function unchosen(w: World): Promise<string> {
  const started = (await ask(w, "sketch", {}, BRIEF)) as Answer;
  if (!started.ok) throw new Error(started.message);
  return (await finished(w, started.job.id)).project ?? "";
}

const chosenOf = async (w: World, id: string) => (await w.studio.store().find(id))?.chosen ?? null;

test("music_choose marks the sketch as chosen, free, and answers with title and path", async () => {
  const w = stageWorld();
  const project = await unchosen(w);
  expect(await chosenOf(w, project)).toBeNull();
  const text = await w.callTool("music_choose", { project, sketch: "b" });
  expect(text).toContain(`(${project})`);
  expect(text).toContain("Chose sketch B");
  const path =
    text
      .split("\n")
      .find((line) => line.startsWith("- "))
      ?.slice(2) ?? "";
  expect(path).toEndWith("sketches/b.mp3");
  expect(existsSync(path)).toBe(true);
  expect(w.fake.confirms).toHaveLength(1);
  expect(await chosenOf(w, project)).toBe("b");
});

test("music_choose names the projects and sketches that exist when it cannot choose", async () => {
  const w = stageWorld();
  const project = await unchosen(w);
  expect(await w.callTool("music_choose", { project: "nope", sketch: "a" })).toContain(
    "No project has the id nope.",
  );
  const missing = await w.callTool("music_choose", { project });
  expect(missing).toContain("Pick sketch a, b or c");
  expect(missing).toContain("it has a, b, c");
  expect(await w.callTool("music_choose", { project, sketch: "d" })).toContain("it has a, b, c");
  const entry = await w.studio.store().find(project);
  if (entry === null) throw new Error("no project");
  await rm(join(w.studio.store().pathOf(entry), "sketches", "c.json"));
  const gone = await w.callTool("music_choose", { project, sketch: "c" });
  expect(gone).toContain("Sketch c does not exist");
  expect(gone).toContain("it has a, b");
  expect(await chosenOf(w, project)).toBeNull();
});

test("music_arrange without a chosen sketch refuses and names music_choose and the sketch argument", async () => {
  const w = stageWorld();
  const project = await unchosen(w);
  const cards = w.fake.confirms.length;
  const text = await w.callTool("music_arrange", { project, edits: [{ index: 0, text: "x" }] });
  expect(text).toContain("music_choose");
  expect(text).toContain("`sketch`");
  expect(w.fake.confirms).toHaveLength(cards);
});

test("music_arrange with sketch chooses it, then goes on to its confirm card", async () => {
  const w = stageWorld();
  const project = await unchosen(w);
  const cards = w.fake.confirms.length;
  const text = await w.callTool("music_arrange", {
    project,
    sketch: "c",
    edits: [{ index: 0, text: "[Intro]\nnew" }],
  });
  expect(await chosenOf(w, project)).toBe("c");
  expect(w.fake.confirms).toHaveLength(cards + 1);
  expect(w.fake.confirms.at(-1)?.title).toBe("Render changes");
  expect(text).toContain("Made version 1");
  const bad = await w.callTool("music_arrange", {
    project,
    sketch: "z",
    edits: [{ index: 0, text: "x" }],
  });
  expect(bad).toContain("Pick sketch a, b or c");
  expect(w.fake.confirms).toHaveLength(cards + 1);
});

test("choosing another sketch once a version exists says Arrange keeps the version", async () => {
  const w = stageWorld();
  const project = await unchosen(w);
  await w.callTool("music_choose", { project, sketch: "a" });
  await w.callTool("music_arrange", { project, edits: [{ index: 0, text: "[Intro]\nx" }] });
  const text = await w.callTool("music_choose", { project, sketch: "b" });
  expect(text).toContain("Arrange still works from Version 1, not Sketch B");
  expect(await chosenOf(w, project)).toBe("b");
  const again = await w.callTool("music_choose", { project, sketch: "b" });
  expect(again).not.toContain("Arrange still works");
  const viaArrange = await w.callTool("music_arrange", {
    project,
    sketch: "c",
    edits: [{ index: 0, text: "[Intro]\ny" }],
  });
  expect(viaArrange).toContain("Arrange still works from Version 1, not Sketch C");
  expect(viaArrange).toContain("Made version 2");
});
