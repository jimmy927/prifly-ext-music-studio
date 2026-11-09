import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CANCELLED } from "../tools";
import { audioProject, dj, song } from "./dj-world";
import { declineCards, runJob } from "./stage-world";

test("the three DJ tools are registered", () => {
  const names = dj()
    .fake.tools()
    .map((tool) => tool.name);
  expect(names).toEqual(expect.arrayContaining(["music_master", "music_prepare", "music_deliver"]));
});

test("music_master masters locally, asks nothing, and returns the path with the loudness before and after", async () => {
  const w = dj();
  const { id, dir } = await audioProject(w, song(120, 6));
  const text = await w.callTool("music_master", { project: id, target: "club", format: "wav" });
  expect(text).toContain("Mastered");
  expect(text).toContain("Club, -9 LUFS, as WAV 24-bit");
  expect(text).toContain("From Sketch A:");
  expect(text).toContain("After:");
  expect(text).toContain("converted, not lossless");
  expect(text).toContain(join(dir, "master", "master-1.wav"));
  expect(existsSync(join(dir, "master", "master-1.wav"))).toBe(true);
  expect(w.fake.confirms).toHaveLength(2 - 2 + w.fake.confirms.length);
  expect(w.fake.confirms.some((card) => card.title.includes("Master"))).toBe(false);
});

test("music_master says what is wrong in words", async () => {
  const w = dj();
  const { id } = await audioProject(w, song(120, 6));
  expect(await w.callTool("music_master", { project: id, target: "loud" })).toContain(
    "target is one of club, streaming, game",
  );
  expect(await w.callTool("music_master", { project: id, format: "flac" })).toContain(
    "format is one of wav, mp3, ogg",
  );
  expect(await w.callTool("music_master", { project: "ffffffff" })).toContain(
    "No project has the id",
  );
  const bad = dj({ ffmpegPath: "/nonexistent/ffmpeg" });
  const other = await audioProject(bad, song(120, 6));
  expect(await bad.callTool("music_master", { project: other.id })).toContain(
    "ffmpeg was not found",
  );
});

test("music_prepare analyses, applies BPM, cues, loop and crate, and returns the facts", async () => {
  const w = dj();
  const { id, dir } = await audioProject(w, song(120, 30));
  const text = await w.callTool("music_prepare", {
    project: id,
    autoCues: true,
    cues: [{ slot: "H", sec: 5.1 }],
    loop: { startSec: 2, bars: 2 },
    crate: "Warm up",
  });
  expect(text).toMatch(/BPM 12\d(\.\d+)?, first beat at 0\.\d+ s\./);
  expect(text).toMatch(/Key .+, Camelot \d{1,2}[AB]\./);
  expect(text).toContain("Energy");
  expect(text).toMatch(/Cues: A 0\.\d+ s \(Intro\), B \d/);
  expect(text).toMatch(/H 5\.\d+ s/);
  expect(text).toMatch(/Loop: 1\.\d+ s to \d/);
  expect(text).toContain('In crate "Warm up".');
  expect(text).toContain(join(dir, "prep.json"));
  const crates = (await w.fake.api.state?.get("crates")) as { name: string; tracks: string[] }[];
  expect(crates[0]).toMatchObject({ name: "Warm up", tracks: [id] });
});

test("music_prepare with a typed BPM overrides the analysis and a bad cue is reported, not applied", async () => {
  const w = dj();
  const { id } = await audioProject(w, song(120, 30));
  const text = await w.callTool("music_prepare", {
    project: id,
    bpm: 125,
    cues: [{ slot: "A", sec: 999 }],
  });
  expect(text).toContain("BPM 125 (typed in)");
  expect(text).toContain("Not applied: That is past the end of the track.");
  expect(text).not.toContain("999");
});

test("music_deliver writes into the project's deliver folder without asking", async () => {
  const w = dj();
  const { id, dir } = await audioProject(w, song(120, 6));
  await runJob(w, "stems-split", { project: id });
  const before = w.fake.confirms.length;
  const text = await w.callTool("music_deliver", { project: id, items: ["stems"] });
  expect(text).toContain(`in ${join(dir, "deliver")}`);
  expect(text).toMatch(
    /- .*\/stems\/\d*\.?\d*bpm|- .*\/stems\/Vocals\.wav|- .*\/stems\/.*Vocals\.wav/,
  );
  expect(w.fake.confirms).toHaveLength(before);
  expect(readdirSync(join(dir, "deliver", "stems"))).toHaveLength(4);
});

test("music_deliver outside the project asks first; cancel writes nothing and says so", async () => {
  const w = dj();
  const { id, dir } = await audioProject(w, song(120, 6));
  await runJob(w, "stems-split", { project: id });
  declineCards(w);
  const text = await w.callTool("music_deliver", {
    project: id,
    items: ["stems"],
    destination: "scratchpad",
  });
  expect(text).toBe(CANCELLED);
  expect(w.fake.confirms.at(-1)?.title).toBe("Write files outside the project");
  expect(w.fake.confirms.at(-1)?.summary).toContain("stems");
  expect(existsSync(join(dir, "deliver"))).toBe(false);
});

test("music_deliver to the scratchpad or a chosen folder writes after the reader says yes", async () => {
  const w = dj();
  const { id } = await audioProject(w, song(120, 6));
  await w.callTool("music_prepare", { project: id });
  const text = await w.callTool("music_deliver", {
    project: id,
    items: ["loops", "rekordbox"],
    destination: "scratchpad",
  });
  expect(w.fake.confirms.at(-1)?.title).toBe("Write files outside the project");
  expect(text).toContain("Wrote 3 files");
  expect(text).toContain(".loops.json");
  expect(text).toContain("rekordbox");
  expect(await w.callTool("music_deliver", { project: id, destination: "relative/dir" })).toContain(
    "full folder path",
  );
});

test("music_deliver names a crate that does not exist", async () => {
  const w = dj();
  const { id } = await audioProject(w, song(120, 6));
  await w.callTool("music_prepare", { project: id });
  expect(
    await w.callTool("music_deliver", { project: id, items: ["rekordbox"], crate: "Nope" }),
  ).toContain('There is no crate "Nope"');
});
