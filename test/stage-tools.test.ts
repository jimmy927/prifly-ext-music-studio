import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { CANCELLED } from "../tools";
import { chosenProject, declineCards, STEMS, stageWorld } from "./stage-world";

test("the four stage tools are registered", () => {
  const names = stageWorld()
    .fake.tools()
    .map((tool) => tool.name);
  expect(names).toEqual(
    expect.arrayContaining(["music_arrange", "music_stems", "music_sfx", "music_mix"]),
  );
});

test("music_arrange edits by section index, asks first, and returns the new version's path", async () => {
  const w = stageWorld();
  const project = await chosenProject(w);
  const text = await w.callTool("music_arrange", {
    project,
    edits: [
      {
        index: 1,
        text: "[Verse]\nnew words",
        positiveStyles: ["bright", "122 BPM"],
        durationSec: 14,
      },
      { index: 3, delete: true },
    ],
  });
  expect(text).toContain("Made version 1");
  const path =
    text
      .split("\n")
      .find((line) => line.startsWith("- "))
      ?.slice(2) ?? "";
  expect(path).toEndWith("versions/v1.mp3");
  expect(existsSync(path)).toBe(true);
  expect(w.fake.confirms.at(-1)?.title).toBe("Render changes");
  const render = w.calls.filter((call) => call.url.endsWith("/v1/music/detailed")).at(-1);
  const chunks = (
    JSON.parse(render?.body ?? "{}") as { composition_plan: { chunks: Record<string, unknown>[] } }
  ).composition_plan.chunks;
  expect(chunks.map((each) => ("song_id" in each ? "keep" : "make"))).toEqual([
    "keep",
    "make",
    "keep",
  ]);
  expect(chunks[1]).toMatchObject({ duration_ms: 14000, positive_styles: ["bright", "122 BPM"] });
});

test("music_arrange takes a whole section list too, where `from` ties a section to an old one", async () => {
  const w = stageWorld();
  const project = await chosenProject(w);
  const text = await w.callTool("music_arrange", {
    project,
    sections: [
      { text: "[Intro]\nla la", durationSec: 8, positiveStyles: ["122 BPM", "warm"], from: 0 },
      { text: "[Hook]\nsing", durationSec: 10, positiveStyles: ["bright"], from: null },
      { text: "[Chorus]\nla la", durationSec: 6, positiveStyles: ["122 BPM", "warm"], from: 2 },
    ],
  });
  expect(text).toContain("Made version 1");
  const render = w.calls.filter((call) => call.url.endsWith("/v1/music/detailed")).at(-1);
  const chunks = (
    JSON.parse(render?.body ?? "{}") as { composition_plan: { chunks: Record<string, unknown>[] } }
  ).composition_plan.chunks;
  expect(chunks).toHaveLength(3);
  expect(chunks[2]).toMatchObject({ range: { start_ms: 20000, end_ms: 26000 } });
});

test("music_arrange says what is wrong without a card: a bad index, nothing changed, Lyria", async () => {
  const w = stageWorld();
  const project = await chosenProject(w);
  const lyria = await chosenProject(w, { text: "x", engine: "lyria-clip" });
  const cards = w.fake.confirms.length;
  expect(
    await w.callTool("music_arrange", { project, edits: [{ index: 9, text: "x" }] }),
  ).toContain("no such section");
  expect(await w.callTool("music_arrange", { project, edits: [] })).toBe(
    "Not done: Nothing changed.",
  );
  expect(
    await w.callTool("music_arrange", { project: lyria, edits: [{ index: 0, text: "y" }] }),
  ).toContain("Lyria has no section plan");
  expect(w.fake.confirms).toHaveLength(cards);
});

test("the paid tools answer the plain cancel text and spend nothing when the reader cancels", async () => {
  const w = stageWorld();
  const project = await chosenProject(w);
  declineCards(w);
  const before = w.calls.length;
  expect(
    await w.callTool("music_arrange", { project, edits: [{ index: 0, text: "[Intro]\nx" }] }),
  ).toBe(CANCELLED);
  expect(await w.callTool("music_stems", { project })).toBe(CANCELLED);
  expect(await w.callTool("music_sfx", { project, prompt: "boom" })).toBe(CANCELLED);
  expect(w.calls).toHaveLength(before);
});

test("music_stems and music_sfx return file paths", async () => {
  const w = stageWorld();
  const project = await chosenProject(w);
  const stems = await w.callTool("music_stems", { project });
  expect(stems).toContain(`Split into ${STEMS.length} stems.`);
  const files = stems
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
  expect(files).toHaveLength(STEMS.length);
  for (const file of files) expect(existsSync(file)).toBe(true);
  const sfx = await w.callTool("music_sfx", {
    project,
    prompt: "riser",
    startBar: 9,
    lengthSec: 2,
    loop: true,
  });
  expect(sfx).toContain("at bar 9");
  expect(existsSync(sfx.split("- ")[1] ?? "")).toBe(true);
  expect(JSON.parse(w.calls.at(-1)?.body ?? "{}")).toMatchObject({
    loop: true,
    duration_seconds: 2,
  });
});

test("music_mix is local: no card, levels by track name, a WAV path back", async () => {
  const w = stageWorld();
  const project = await chosenProject(w);
  expect(await w.callTool("music_mix", { project })).toContain("no stems");
  await w.callTool("music_stems", { project });
  const cards = w.fake.confirms.length;
  const text = await w.callTool("music_mix", {
    project,
    levels: { vocals: { db: -6, pan: 0.3 }, drums: { mute: true } },
  });
  expect(text).toStartWith("Mixed to ");
  expect(existsSync(text.slice("Mixed to ".length))).toBe(true);
  expect(w.fake.confirms).toHaveLength(cards);
  expect(await w.callTool("music_mix", { project, levels: { kazoo: { db: 1 } } })).toContain(
    'no track "kazoo"',
  );
});

test("music_arrange sections inherit from the section `from` names, so a deletion keeps the audio", async () => {
  const w = stageWorld();
  const project = await chosenProject(w);
  const text = await w.callTool("music_arrange", {
    project,
    sections: [
      { text: "[Intro]\nla la", from: 0 },
      { text: "[Chorus]\nla la", from: 2 },
    ],
  });
  expect(text).toContain("Made version 1");
  const render = w.calls.filter((call) => call.url.endsWith("/v1/music/detailed")).at(-1);
  const chunks = (
    JSON.parse(render?.body ?? "{}") as { composition_plan: { chunks: Record<string, unknown>[] } }
  ).composition_plan.chunks;
  expect(chunks).toEqual([
    { song_id: "sketch-1", range: { start_ms: 0, end_ms: 8000 } },
    { song_id: "sketch-1", range: { start_ms: 20000, end_ms: 26000 } },
  ]);
});

test("music_mix with ffmpeg missing says why", async () => {
  const w = stageWorld({ ffmpegPath: "/nonexistent/ffmpeg-for-test" });
  const project = await chosenProject(w);
  await w.callTool("music_stems", { project });
  expect(await w.callTool("music_mix", { project })).toContain("/nonexistent/ffmpeg-for-test");
});
