import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activate, panel } from "../index";
import { EMPTY_BRIEF, parseBrief } from "../project/brief";
import { libraryFolder, Store, slugOf } from "../project/store";
import { bundle } from "../scripts/build-panel";
import { fakeApi, fakeState } from "./fake-api";
import { AUDIO } from "./world";

const made = {
  audio: AUDIO,
  ext: "mp3" as const,
  songId: "s1",
  plan: { p: 1 },
  timestamps: null,
  lyrics: null,
  title: "Minor Lift",
};

test("a project is a folder with brief.json and sketches/<x>.mp3 and <x>.json, indexed in state", async () => {
  const root = mkdtempSync(join(tmpdir(), "store-"));
  const { state, documents } = fakeState();
  const store = new Store(root, state);
  const brief = { ...EMPTY_BRIEF, text: "Hold music, friendly" };
  const entry = await store.create(brief, "Hold music, friendly");
  expect(entry.dir).toBe(`hold-music-friendly-${entry.id}`);
  await store.saveSketch(entry, "a", made, "elevenlabs");
  expect(readFileSync(join(root, entry.dir, "sketches", "a.mp3"))).toEqual(Buffer.from(AUDIO));
  const record = JSON.parse(readFileSync(join(root, entry.dir, "sketches", "a.json"), "utf8")) as {
    songId: string;
    plan: unknown;
  };
  expect(record.songId).toBe("s1");
  expect(record.plan).toEqual({ p: 1 });
  expect(JSON.parse(readFileSync(join(root, entry.dir, "brief.json"), "utf8"))).toMatchObject({
    id: entry.id,
    brief,
  });
  expect((documents.get("library") as { sketches: number }[])[0]?.sketches).toBe(1);

  await store.choose(entry, "a");
  expect((await store.find(entry.id))?.chosen).toBe("a");
  expect((await store.readBrief(entry))?.chosen).toBe("a");

  await store.remove(entry);
  expect(await store.entries()).toEqual([]);
});

test("the library folder expands ~ and falls back to the default", () => {
  expect(libraryFolder("/x/y")).toBe("/x/y");
  expect(libraryFolder("")).toEndWith("Music/prifly-music-studio");
  expect(libraryFolder("~/Songs")).toEndWith("/Songs");
  expect(libraryFolder("~/Songs").startsWith("~")).toBe(false);
  expect(slugOf("Äh! A  Song??")).toBe("ah-a-song");
  expect(slugOf("???")).toBe("untitled");
});

test("a brief is checked and the lyrics are asked for when vocals are mine", () => {
  expect(parseBrief({ text: "x", tempo: 500 })).toBe("Tempo is between 40 and 240 BPM.");
  expect(parseBrief({ text: "x", vocals: "mine" })).toContain("lyrics");
  const ok = parseBrief({ text: " a song ", tempo: 127.6, engine: "nope", preset: "techno-128" });
  expect(ok).toMatchObject({
    text: "a song",
    tempo: 128,
    engine: "elevenlabs",
    preset: "techno-128",
  });
});

test("activate registers the tools and the panel module answers its routes", async () => {
  const fake = fakeApi({
    settings: { libraryFolder: mkdtempSync(join(tmpdir(), "act-")) },
    secrets: {},
  });
  const stop = activate(fake.api);
  expect(fake.tools().map((tool) => tool.name)).toEqual([
    "music_sketch",
    "music_library",
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
  expect(await panel("studio", { path: "library", query: {}, body: null })).toEqual({
    projects: [],
  });
  await Bun.sleep(5);
  expect(fake.statuses.at(-1)).toContain("No key yet");
  stop();
  await expect(panel("studio", { path: "library", query: {}, body: null })).rejects.toThrow(
    "not running",
  );
});

test("the committed panel/app.js is the bundle of the current sources", async () => {
  const committed = readFileSync(join(import.meta.dir, "..", "panel", "app.js"), "utf8");
  expect(committed).toBe(await bundle());
});
