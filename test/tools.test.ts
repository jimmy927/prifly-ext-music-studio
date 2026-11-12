import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { CANCELLED } from "../tools";
import { BRIEF, happy, world } from "./world";

test("both tools are registered under their names", () => {
  const w = world(happy);
  expect(w.fake.tools().map((tool) => tool.name)).toEqual([
    "music_sketch",
    "music_library",
    "music_choose",
    "music_arrange",
    "music_stems",
    "music_sfx",
    "music_mix",
    "music_master",
    "music_prepare",
    "music_deliver",
    "video_treatment",
    "video_storyboard",
    "video_shoot",
    "video_edit",
    "video_render",
  ]);
});

test("music_sketch asks first; on cancel it says so and makes nothing", async () => {
  const w = world(happy, { confirm: false });
  const text = await w.callTool("music_sketch", { brief: BRIEF.text });
  expect(text).toBe(CANCELLED);
  expect(w.fake.confirms).toHaveLength(1);
  expect(w.fake.confirms[0]?.session).toBe("fake-session");
  expect(w.calls.some((c) => c.url.endsWith("/v1/music/detailed"))).toBe(false);
  expect(await w.callTool("music_library", {})).toBe("The library is empty.");
});

test("music_sketch confirmed: returns the file paths and can copy them to the scratchpad", async () => {
  const w = world(happy);
  const text = await w.callTool("music_sketch", {
    brief: BRIEF.text,
    preset: "lofi",
    copyToScratchpad: true,
  });
  expect(w.fake.confirms).toHaveLength(1);
  expect(w.fake.confirms[0]?.summary).toContain("billed by ElevenLabs");
  expect(text).toContain("Made 3 sketches.");
  const paths = text
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
  expect(paths).toHaveLength(3);
  for (const path of paths) expect(existsSync(path)).toBe(true);
  expect(text).toContain("Copied to ");
  const target = text.split("Copied to ")[1] ?? "";
  expect(existsSync(`${target}/a.mp3`)).toBe(true);
  expect(existsSync(`${target}/c.mp3`)).toBe(true);
});

test("music_sketch without a key is a plain refusal that names Settings", async () => {
  const w = world(happy, { keys: {} });
  const text = await w.callTool("music_sketch", { brief: "x" });
  expect(text).toContain("Not done");
  expect(text).toContain("Settings → Extensions");
  expect(w.fake.confirms).toHaveLength(0);
});

test("music_sketch reports ElevenLabs' suggestion when the prompt is refused", async () => {
  const w = world((call) =>
    call.url.endsWith("/v1/user/subscription")
      ? Response.json({ tier: "starter", character_count: 0, character_limit: 40000 })
      : Response.json(
          {
            detail: {
              status: "bad_prompt",
              message: "No.",
              data: { prompt_suggestion: "A rock ballad." },
            },
          },
          { status: 422 },
        ),
  );
  const text = await w.callTool("music_sketch", { brief: "like Queen" });
  expect(text).toContain("Stopped after 0 of 3 sketches");
  expect(text).toContain("A rock ballad.");
});

test("music_library lists projects with their paths, and filters by query", async () => {
  const w = world(happy);
  await w.callTool("music_sketch", { brief: "Lo-fi study beat" });
  const all = await w.callTool("music_library", {});
  expect(all).toContain("Lo-fi study beat");
  expect(all).toContain("elevenlabs");
  expect(all).toContain("a.mp3");
  expect(await w.callTool("music_library", { query: "zzz" })).toBe('No project matches "zzz".');
});
