/**
 * Source material: which files count, how a video is sampled, how the
 * analysis becomes a brief (an explicit argument wins), the cache that makes a
 * second read free, the treatment's cast (at most 6), and that a refused card
 * spends nothing. Gemini is faked; ffmpeg makes a 3-second clip.
 */

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSources } from "../project/sources";
import { readTreatment } from "../project/video";
import { ANALYSIS_MODEL, MAX_FRAMES, MAX_SOURCES } from "../sources/constants";
import { expandSources } from "../sources/files";
import { audioArgv, durationFrom, frameArgv, samplingOf } from "../sources/frames";
import { mergeBrief, pickCast } from "../sources/merge";
import { CANCELLED } from "../tools";
import { album, SYNTH, sourcesWorld } from "./sources-world";
import { ask, declineCards, finished } from "./stage-world";
import { PNG, prepare } from "./video-world";

const eleven = (w: { calls: { url: string; body: string }[] }) =>
  w.calls.filter((each) => each.url.endsWith("/v1/music/detailed"));

test("a folder expands to its pictures and videos by name; other files, hidden files and subfolders are left out", async () => {
  const folder = await album(2, true);
  const { files, skipped } = await expandSources([folder]);
  expect(files.map((each) => `${each.kind}:${each.name}`)).toEqual([
    "image:a.png",
    "image:b.png",
    "video:clip.mp4",
  ]);
  expect(skipped).toEqual([]);
});

test("named files are filtered by type and size; an unsupported, missing or relative one says why", async () => {
  const folder = await album(1, false);
  const { files, skipped } = await expandSources([
    join(folder, "a.png"),
    join(folder, "notes.txt"),
    join(folder, "gone.png"),
    "relative/a.png",
    join(folder, "a.png"),
  ]);
  expect(files.map((each) => each.name)).toEqual(["a.png"]);
  expect(skipped.map((each) => each.reason)).toEqual([
    expect.stringContaining("not a picture"),
    "there is no such file",
    "not a full path",
  ]);
  const empty = join(folder, "empty.png");
  writeFileSync(empty, "");
  expect((await expandSources(empty)).skipped[0]?.reason).toBe("empty");
});

test("a folder with more than the limit is cut there and the rest is said to be left out", async () => {
  const folder = mkdtempSync(join(tmpdir(), "music-studio-many-"));
  for (let at = 0; at < MAX_SOURCES + 2; at += 1)
    writeFileSync(join(folder, `p${String(at).padStart(2, "0")}.png`), PNG);
  const { files, skipped } = await expandSources(folder);
  expect(files).toHaveLength(MAX_SOURCES);
  expect(skipped).toHaveLength(2);
  expect(skipped[0]?.reason).toContain(String(MAX_SOURCES));
});

test("frames are sampled one every 3 s, spread over a long clip, capped; the arguments say so", () => {
  expect(samplingOf(10)).toEqual({ intervalSec: 3, count: 4 });
  expect(samplingOf(1)).toEqual({ intervalSec: 3, count: 1 });
  expect(samplingOf(120)).toEqual({ intervalSec: 15, count: MAX_FRAMES });
  expect(samplingOf(null)).toEqual({ intervalSec: 3, count: MAX_FRAMES });
  const argv = frameArgv("/v/clip.mp4", "/out", samplingOf(10));
  expect(argv).toContain("/v/clip.mp4");
  expect(argv[argv.indexOf("-vf") + 1]).toContain("fps=1/3");
  expect(argv[argv.indexOf("-frames:v") + 1]).toBe("4");
  expect(argv.at(-1)).toBe("/out/frame-%02d.jpg");
  const long = frameArgv("/v/c.mp4", "/o", samplingOf(120));
  expect(long[long.indexOf("-vf") + 1]).toContain("fps=1/15");
  expect(long[long.indexOf("-frames:v") + 1]).toBe(String(MAX_FRAMES));
  expect(durationFrom("  Duration: 00:01:02.50, start: 0.000000, bitrate: 1 kb/s")).toBe(62.5);
  expect(durationFrom("nothing")).toBeNull();
  const audio = audioArgv("/v/clip.mp4");
  expect(audio).toContain("-vn");
  expect(audio[audio.indexOf("-t") + 1]).toBe("60");
});

test("the analysis fills the brief where the call left a field out; what the call gave wins", () => {
  const none = mergeBrief({ text: "" }, SYNTH);
  expect(none).toMatchObject({
    text: SYNTH.song.brief,
    tempo: 96,
    key: "G major",
    vocals: "mine",
    lyrics: SYNTH.song.lyrics,
  });
  const given = mergeBrief(
    { text: "A sad ballad", tempo: 70, key: "A minor", vocals: "instrumental", lyrics: "" },
    SYNTH,
  );
  expect(given["tempo"]).toBe(70);
  expect(given["key"]).toBe("A minor");
  expect(given["vocals"]).toBe("instrumental");
  expect(given["lyrics"]).toBe("");
  expect(String(given["text"]).startsWith("A sad ballad\n")).toBe(true);
  expect(String(given["text"])).toContain(SYNTH.song.brief);
  const own = mergeBrief({ text: "x", vocals: "mine", lyrics: "My own words" }, SYNTH);
  expect(own["lyrics"]).toBe("My own words");
  expect(
    mergeBrief({ text: "x", vocals: "mine" }, { ...SYNTH, song: { ...SYNTH.song, lyrics: "" } }),
  ).toMatchObject({
    vocals: "generated",
  });
});

test("the cast is picked from the sources' pictures, one per picture, at most 6", () => {
  const source = (id: string, name: string, kind: "image" | "video") => ({
    id,
    name,
    kind,
    original: `/x/${name}`,
    file: null,
    thumb: kind === "image" ? `sources/${id}-thumb.png` : null,
    frames: kind === "video" ? [`sources/${id}-frame-01.jpg`] : [],
    durationSec: null,
    seen: null,
    audio: null,
    notes: [],
  });
  const sources = [
    ...Array.from({ length: 8 }, (_each, at) => source(`s${at + 1}`, `p${at}.png`, "image")),
    source("s9", "clip.mp4", "video"),
  ];
  const ideas = [
    ...sources.map((each, at) => ({ name: `Person ${at}`, description: "", source: each.name })),
    { name: "Ghost", description: "", source: "missing.png" },
    { name: "Twin", description: "", source: "p0.png" },
  ];
  const synthesis = { ...SYNTH, video: { ...SYNTH.video, cast: ideas } };
  const picks = pickCast(synthesis, sources);
  expect(picks).toHaveLength(6);
  expect(picks.map((each) => each.source.name)).toEqual([
    "p0.png",
    "p1.png",
    "p2.png",
    "p3.png",
    "p4.png",
    "p5.png",
  ]);
  expect(pickCast(synthesis, sources, 2)).toHaveLength(2);
  expect(pickCast(synthesis, sources, 0)).toHaveLength(0);
});

test("music_sketch with sources reads them behind one card, then sketches from the brief they gave", async () => {
  const w = sourcesWorld();
  const folder = await album(2, true);
  const text = await w.callTool("music_sketch", { sources: [folder] });
  expect(w.fake.confirms).toHaveLength(1);
  const card = w.fake.confirms[0];
  expect(card?.summary).toContain("Read 2 pictures and 1 video with Gemini");
  expect(card?.summary).toContain(ANALYSIS_MODEL);
  expect(card?.content).toContain("clip.mp4");
  expect(text).toContain("Made 3 sketches.");
  // One call for the pictures, one for the frames, one for the audio, one for the ideas.
  expect(w.sg.calls.toSorted()).toEqual(["audio", "frames", "pictures", "synthesis"]);
  const prompts = eleven(w).map(
    (each) => (JSON.parse(each.body) as { prompt?: string }).prompt ?? each.body,
  );
  expect(prompts).toHaveLength(3);
  expect(prompts.every((each) => each.includes(SYNTH.song.brief))).toBe(true);
  expect(prompts[0]).toContain("Tempo: 96 BPM.");
  expect(prompts[0]).toContain("Key: G major.");
  const entry = (await w.studio.store().list())[0];
  if (entry === undefined) throw new Error("no project");
  const record = await w.studio.store().readBrief(entry);
  expect(record?.brief.text).toBe(SYNTH.song.brief);
  expect(record?.brief.tempo).toBe(96);
  expect(record?.brief.lyrics).toBe(SYNTH.song.lyrics);
  const dir = w.studio.store().pathOf(entry);
  const sources = await readSources(dir);
  expect(sources.sources.map((each) => each.name)).toEqual(["a.png", "b.png", "clip.mp4"]);
  expect(sources.synthesis?.song.brief).toBe(SYNTH.song.brief);
  const clip = sources.sources[2];
  expect(clip?.frames.length).toBe(1);
  expect(clip?.durationSec).toBeGreaterThan(2);
  expect(clip?.audio?.mood).toBe("upbeat");
  expect(clip?.audio?.bpm === null || typeof clip?.audio?.bpm === "number").toBe(true);
  expect(existsSync(join(dir, clip?.frames[0] ?? "none"))).toBe(true);
  expect(existsSync(join(dir, sources.sources[0]?.thumb ?? "none"))).toBe(true);
});

test("explicit arguments win over what the sources suggest", async () => {
  const w = sourcesWorld();
  const folder = await album(1, false);
  await w.callTool("music_sketch", {
    sources: [folder],
    brief: "A sad piano ballad",
    tempo: 70,
    key: "A minor",
    vocals: "instrumental",
  });
  const entry = (await w.studio.store().list())[0];
  const brief = (await w.studio.store().readBrief(entry ?? ({} as never)))?.brief;
  expect(brief?.tempo).toBe(70);
  expect(brief?.key).toBe("A minor");
  expect(brief?.vocals).toBe("instrumental");
  expect(brief?.text.startsWith("A sad piano ballad")).toBe(true);
  expect(brief?.text).toContain(SYNTH.song.brief);
});

test("the same sources a second time are read from the cache: no call, no mention on the card", async () => {
  const w = sourcesWorld();
  const folder = await album(2, true);
  await w.callTool("music_sketch", { sources: [folder] });
  const calls = w.sg.calls.length;
  expect(calls).toBe(4);
  await w.callTool("music_sketch", { sources: [folder] });
  expect(w.sg.calls).toHaveLength(calls);
  expect(w.fake.confirms).toHaveLength(2);
  expect(w.fake.confirms[1]?.summary).not.toContain("Read ");
  expect(await w.studio.store().list()).toHaveLength(2);
});

test("video_treatment with sources fills concept, look, a cast of at most 6 and the video references; the reader's own words stay", async () => {
  const synth = {
    ...SYNTH,
    video: {
      ...SYNTH.video,
      cast: Array.from({ length: 8 }, (_each, at) => ({
        name: `Friend ${at + 1}`,
        description: "a friend",
        source: `${String.fromCharCode(97 + at)}.png`,
      })),
    },
  };
  const w = sourcesWorld({}, synth);
  const folder = await album(8, true);
  await w.callTool("music_sketch", { sources: [folder] });
  const entry = (await w.studio.store().list())[0];
  if (entry === undefined) throw new Error("no project");
  const project = entry.id;
  const dir = await prepare(w, project);
  const readCalls = w.sg.calls.length;
  const cards = w.fake.confirms.length;
  const text = await w.callTool("video_treatment", {
    project,
    sources: [folder],
    look: "Super 8, grainy",
  });
  // Already read for the sketch: no call and no card.
  expect(w.sg.calls).toHaveLength(readCalls);
  expect(w.fake.confirms).toHaveLength(cards);
  const treatment = await readTreatment(dir);
  expect(treatment.concept).toBe(SYNTH.video.concept);
  expect(treatment.look).toBe("Super 8, grainy");
  expect(treatment.cast).toHaveLength(6);
  expect(treatment.cast.map((each) => each.name)).toEqual([
    "Friend 1",
    "Friend 2",
    "Friend 3",
    "Friend 4",
    "Friend 5",
    "Friend 6",
  ]);
  expect(treatment.cast.every((each) => existsSync(join(dir, each.file)))).toBe(true);
  expect(treatment.references.map((each) => each.name)).toEqual(["clip.mp4"]);
  expect(text).toContain("From the source material: concept, cast");
  expect(text).toContain("- shot reference");
  // Again: the picks replace their earlier selves, the cast stays at 6.
  await w.callTool("video_treatment", { project, sources: [folder] });
  expect((await readTreatment(dir)).cast).toHaveLength(6);
});

test("a cast file the call gave takes its place and leaves the rest of the six for the sources", async () => {
  const synth = {
    ...SYNTH,
    video: {
      ...SYNTH.video,
      cast: Array.from({ length: 6 }, (_each, at) => ({
        name: `Friend ${at + 1}`,
        description: "",
        source: `${String.fromCharCode(97 + at)}.png`,
      })),
    },
  };
  const w = sourcesWorld({}, synth);
  const folder = await album(6, false);
  await w.callTool("music_sketch", { sources: [folder] });
  const entry = (await w.studio.store().list())[0];
  if (entry === undefined) throw new Error("no project");
  const dir = await prepare(w, entry.id);
  await w.callTool("video_treatment", {
    project: entry.id,
    castFiles: [join(folder, "a.png"), join(folder, "b.png")],
    sources: [folder],
  });
  expect((await readTreatment(dir)).cast).toHaveLength(6);
});

test("a refused card reads nothing and spends nothing, for the sketch and for the treatment", async () => {
  const w = sourcesWorld({ confirm: false });
  const folder = await album(2, true);
  expect(await w.callTool("music_sketch", { sources: [folder] })).toBe(CANCELLED);
  expect(w.sg.calls).toEqual([]);
  expect(eleven(w)).toHaveLength(0);
  expect(await w.studio.store().list()).toEqual([]);
  // A project to ask the treatment about.
  const ok = sourcesWorld();
  await ok.callTool("music_sketch", { brief: "A song" });
  const entry = (await ok.studio.store().list())[0];
  if (entry === undefined) throw new Error("no project");
  await prepare(ok, entry.id);
  declineCards(ok);
  expect(await ok.callTool("video_treatment", { project: entry.id, sources: [folder] })).toBe(
    CANCELLED,
  );
  expect(ok.sg.calls).toEqual([]);
  expect(existsSync(join(ok.studio.store().pathOf(entry), "sources.json"))).toBe(false);
});

test("the states a call can be in: no Gemini key, ffmpeg missing, nothing readable", async () => {
  const folder = await album(1, true);
  const noKey = sourcesWorld({ keys: { elevenlabsKey: "xi-test" } });
  expect(await noKey.callTool("music_sketch", { sources: [folder] })).toContain("Gemini key");
  expect(noKey.fake.confirms).toHaveLength(0);
  const noFfmpeg = sourcesWorld({ ffmpegPath: "/nonexistent/ffmpeg" });
  expect(await noFfmpeg.callTool("music_sketch", { sources: [folder] })).toContain(
    "ffmpeg was not found",
  );
  expect(noFfmpeg.fake.confirms).toHaveLength(0);
  const w = sourcesWorld();
  const text = join(folder, "notes.txt");
  expect(await w.callTool("music_sketch", { sources: [text] })).toContain("No pictures or videos");
  expect(w.fake.confirms).toHaveLength(0);
});

test("a model that does not take audio only leaves the audio's mood out, with a note", async () => {
  const w = sourcesWorld();
  w.sg.refuseAudio = true;
  const folder = await album(1, true);
  const text = await w.callTool("music_sketch", { sources: [folder] });
  expect(text).toContain("Made 3 sketches.");
  const entry = (await w.studio.store().list())[0];
  if (entry === undefined) throw new Error("no project");
  const clip = (await readSources(w.studio.store().pathOf(entry))).sources.find(
    (each) => each.kind === "video",
  );
  expect(clip?.audio?.mood).toBe("");
  expect(clip?.audio?.note).toContain("did not take the audio");
});

test("a failed reading ends the sketch run with the reason and leaves no project; Try again costs only what was not read", async () => {
  const w = sourcesWorld();
  const folder = await album(1, false);
  const original = w.sg.handler;
  w.sg.handler = (call) => {
    const body = JSON.parse(call.body || "{}") as { input?: { text?: string }[] };
    if ((body.input ?? []).some((each) => each.text?.includes("Turn them into"))) {
      return Response.json(
        { error: { code: "internal", message: "Gemini fell over." } },
        { status: 500 },
      );
    }
    return original(call);
  };
  const text = await w.callTool("music_sketch", { sources: [folder] });
  expect(text).toContain("Stopped after 0 of 3 sketches: Gemini fell over.");
  expect(await w.studio.store().list()).toEqual([]);
  w.sg.handler = original;
  const again = await w.callTool("music_sketch", { sources: [folder] });
  expect(again).toContain("Made 3 sketches.");
  // The picture was read the first time; only the ideas were missing.
  expect(w.sg.calls.filter((each) => each === "pictures")).toHaveLength(1);
});

test("the page's routes: stage a file, read a project's sources behind a card, show the state and a thumbnail", async () => {
  const w = sourcesWorld();
  await w.callTool("music_sketch", { brief: "A song" });
  const entry = (await w.studio.store().list())[0];
  if (entry === undefined) throw new Error("no project");
  const project = entry.id;
  const none = (await ask(w, "sources", { project })) as { state: string; items: unknown[] };
  expect(none.state).toBe("none");
  expect(none.items).toEqual([]);
  const bad = (await ask(w, "sources-stage", {}, { name: "notes.txt", base64: "aGk=" })) as {
    ok: boolean;
  };
  expect(bad.ok).toBe(false);
  const staged = (await ask(
    w,
    "sources-stage",
    {},
    { name: "a.png", base64: Buffer.from(PNG).toString("base64") },
  )) as { ok: true; path: string };
  expect(readFileSync(staged.path)).toEqual(Buffer.from(PNG));
  const started = (await ask(w, "sources-analyse", {}, { project, add: [staged.path] })) as {
    ok: true;
    job: { id: string };
  };
  expect(started.ok).toBe(true);
  expect((await finished(w, started.job.id)).status).toBe("done");
  expect(w.fake.confirms.at(-1)?.title).toBe("Read the source material");
  const view = (await ask(w, "sources", { project })) as {
    state: string;
    items: { name: string; hasPicture: boolean; seen: { place: string } | null }[];
  };
  expect(view.state).toBe("read");
  expect(view.items[0]).toMatchObject({
    name: "a.png",
    hasPicture: true,
    seen: { place: "a beach" },
  });
  const media = (await ask(w, "media", { project, kind: "source", id: "s1" })) as {
    mime: string;
    base64: string;
  };
  expect(media.mime).toBe("image/png");
  expect(media.base64.length).toBeGreaterThan(10);
  const empty = await ask(w, "sources-analyse", {}, { project: "00000000" }).catch(
    (caught: Error) => caught.message,
  );
  expect(empty).toBe("No such project.");
});
