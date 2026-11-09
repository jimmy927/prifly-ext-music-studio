import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { renderMaster } from "../master/render";
import { analyseProject } from "../prep/run";
import { audioProject, dj, localJob, song } from "./dj-world";
import { ask, chosenProject } from "./stage-world";
import { noise, pcmWav } from "./synth";

type MasterView = {
  ffmpeg: { ok: boolean; message: string };
  source: { kind: string; label: string; lossy: boolean } | null;
  loudness: { integrated: number; truePeak: number; range: number } | null;
  masters: {
    n: number;
    file: string;
    target: string;
    format: string;
    output: { integrated: number } | null;
  }[];
};

test("Master shows the source's loudness, renders to a target, and keeps earlier masters", async () => {
  const w = dj();
  const { id, dir } = await audioProject(w, song(120, 8));
  const before = (await ask(w, "master", { project: id })) as MasterView;
  expect(before.ffmpeg.ok).toBe(true);
  expect(before.source).toMatchObject({ kind: "sketch", label: "Sketch A", lossy: true });
  expect(before.loudness?.integrated).toBeLessThan(0);
  expect(before.masters).toEqual([]);

  const job = await localJob(w, "master-render", {
    project: id,
    target: "streaming",
    format: "wav",
  });
  expect(job).toMatchObject({ status: "done", work: "master", result: "master-1", engine: null });
  expect(job.done).toEqual(["measured", "rendered", "checked"]);
  const second = await localJob(w, "master-render", { project: id, target: "game", format: "ogg" });
  expect(second.result).toBe("master-2");

  const after = (await ask(w, "master", { project: id })) as MasterView;
  expect(after.masters.map((each) => `${each.n} ${each.target} ${each.format}`)).toEqual([
    "1 streaming wav",
    "2 game ogg",
  ]);
  expect(Math.abs((after.masters[0]?.output?.integrated ?? 0) - -14)).toBeLessThan(1.5);
  expect(existsSync(join(dir, "master", "master-1.wav"))).toBe(true);
  expect(existsSync(join(dir, "master", "master-2.ogg"))).toBe(true);
  // No card, no cost.
  expect(w.fake.confirms.map((each) => each.title)).not.toContain("Master");

  const media = (await ask(w, "media", { project: id, kind: "master", id: "1" })) as {
    mime: string;
    base64: string;
  };
  expect(media.mime).toBe("audio/wav");
  expect(media.base64.length).toBeGreaterThan(100);
});

test("Master refuses a target or format it does not know", async () => {
  const w = dj();
  const { id } = await audioProject(w);
  await expect(
    ask(w, "master-render", {}, { project: id, target: "loud", format: "wav" }),
  ).rejects.toThrow("Club, Streaming or Game");
  await expect(
    ask(w, "master-render", {}, { project: id, target: "club", format: "flac" }),
  ).rejects.toThrow("WAV, MP3 or OGG");
});

test("with nothing chosen there is nothing to master, and the render fails with the words", async () => {
  const w = dj();
  const started = (await ask(
    w,
    "sketch",
    {},
    { text: "x", preset: "lofi", tempo: 80, key: "F major" },
  )) as { ok: true; job: { id: string; project: string } };
  const job = await localJob(w, "master-render", {
    project: started.job.project,
    target: "club",
    format: "wav",
  });
  expect(job.status).toBe("failed");
  expect(job.error).toContain("nothing to master yet");
  const view = (await ask(w, "master", { project: started.job.project })) as MasterView;
  expect(view.source).toBeNull();
});

test("when ffmpeg is missing Master and Prepare say why instead of failing quietly", async () => {
  const w = dj({ ffmpegPath: "/nonexistent/ffmpeg" });
  const { id } = await audioProject(w);
  const view = (await ask(w, "master", { project: id })) as MasterView;
  expect(view.ffmpeg.ok).toBe(false);
  expect(view.ffmpeg.message).toContain("/nonexistent/ffmpeg");
  expect(view.loudness).toBeNull();
  const failed = await localJob(w, "master-render", { project: id, target: "club", format: "wav" });
  expect(failed.status).toBe("failed");
  expect(failed.error).toContain("ffmpeg was not found");
  const prepare = (await ask(w, "prepare", { project: id })) as { ffmpeg: { ok: boolean } };
  expect(prepare.ffmpeg.ok).toBe(false);
  const analysed = await localJob(w, "prepare-analyse", { project: id });
  expect(analysed.status).toBe("failed");
  expect(analysed.error).toContain("ffmpeg was not found");
});

test("a failed render says what ffmpeg said and leaves no half-written master", async () => {
  const w = dj();
  const { id, dir } = await audioProject(w, pcmWav(new Float32Array(400)));
  const job = await localJob(w, "master-render", { project: id, target: "club", format: "wav" });
  expect(job.status).toBe("failed");
  expect(job.error).not.toBeNull();
  expect(existsSync(join(dir, "master", "master-1.wav"))).toBe(false);
});

test("cancelling stops a render and an analysis, and nothing is kept", async () => {
  const w = dj();
  const { id, dir } = await audioProject(w);
  const entry = await w.studio.store().find(id);
  if (entry === null) throw new Error("no project");
  const abort = new AbortController();
  abort.abort();
  const mastered = await renderMaster(
    w.studio,
    entry,
    { target: "club", format: "wav" },
    abort.signal,
  );
  expect(mastered).toMatchObject({ ok: false, reason: "cancelled" });
  const analysed = await analyseProject(w.studio, entry, abort.signal);
  expect(analysed).toMatchObject({ ok: false, reason: "cancelled" });
  expect(existsSync(join(dir, "prep.json"))).toBe(false);
  expect(existsSync(join(dir, "master", "master-1.wav"))).toBe(false);
});

type PrepareView = {
  prep: {
    analysis: {
      bpm: number | null;
      key: { camelot: string; name: string } | null;
      energy: number;
      lufs: number | null;
    };
    grid: { bpm: number; firstBeatSec: number } | null;
    manualBpm: boolean;
    cues: { slot: string; sec: number; name: string }[];
    loop: { startSec: number; bars: number; endSec: number } | null;
    compatible: { code: string; relation: string }[];
  } | null;
  peaks: { perSec: number; peaks: number[] } | null;
  hasPlan: boolean;
  stale: boolean;
  crates: { id: string; name: string; has: boolean }[];
};

type Edit = { ok: true; prep: NonNullable<PrepareView["prep"]> } | { ok: false; message: string };

test("Prepare finds tempo, key, grid, energy and loudness, and cues the plan's sections", async () => {
  const w = dj();
  const { id, dir } = await audioProject(w);
  const first = (await ask(w, "prepare", { project: id })) as PrepareView;
  expect(first.prep).toBeNull();
  expect(first.hasPlan).toBe(true);

  const job = await localJob(w, "prepare-analyse", { project: id });
  expect(job).toMatchObject({ status: "done", work: "analyse" });
  expect(job.done).toEqual(["decoded", "tempo", "key", "loudness"]);
  const view = (await ask(w, "prepare", { project: id })) as PrepareView;
  const prep = view.prep;
  expect(Math.abs((prep?.analysis.bpm ?? 0) - 120)).toBeLessThanOrEqual(0.5);
  expect(Math.abs((prep?.grid?.firstBeatSec ?? 0) - 0.3)).toBeLessThanOrEqual(0.02);
  expect(prep?.analysis.key?.camelot).toMatch(/^\d{1,2}[AB]$/);
  expect(prep?.analysis.energy).toBeGreaterThanOrEqual(1);
  expect(prep?.analysis.energy).toBeLessThanOrEqual(10);
  expect(prep?.analysis.lufs).toBeLessThan(0);
  expect(prep?.compatible).toHaveLength(4);
  expect(prep?.cues.map((each) => each.slot)).toEqual(["A", "B", "C", "D"]);
  expect(prep?.cues.map((each) => each.name)).toEqual(["Intro", "Verse", "Chorus", "Outro"]);
  expect(view.peaks?.peaks.length).toBeGreaterThan(500);
  expect(existsSync(join(dir, "prep.json"))).toBe(true);
  const row = ((await ask(w, "library")) as { projects: { prep: { bpm: number } | null }[] })
    .projects[0];
  expect(Math.abs((row?.prep?.bpm ?? 0) - 120)).toBeLessThanOrEqual(0.5);
});

test("Prepare edits: nudge, first beat, manual cues, move, delete, one loop, crate", async () => {
  const w = dj();
  const { id } = await audioProject(w);
  await localJob(w, "prepare-analyse", { project: id });
  const edit = async (path: string, body: Record<string, unknown>) =>
    (await ask(w, path, {}, { project: id, ...body })) as Edit;
  const bpm = ((await ask(w, "prepare", { project: id })) as PrepareView).prep?.grid?.bpm ?? 0;

  const nudged = await edit("prep-nudge", { ms: 10 });
  expect(nudged.ok && nudged.prep.grid?.bpm).toBe(bpm);

  const cue = await edit("prep-cue", { slot: "E", sec: 3.9 });
  if (!cue.ok) throw new Error(cue.message);
  const e = cue.prep.cues.find((each) => each.slot === "E");
  const beat = 60 / bpm;
  const first = cue.prep.grid?.firstBeatSec ?? 0;
  expect(
    Math.abs((((e?.sec ?? 0) - first) / beat) % 1) < 0.01 ||
      Math.abs((((e?.sec ?? 0) - first) / beat) % 1) > 0.99,
  ).toBe(true);
  const moved = await edit("prep-cue", { slot: "E", sec: 7 });
  if (!moved.ok) throw new Error(moved.message);
  expect(moved.prep.cues.filter((each) => each.slot === "E")).toHaveLength(1);
  expect(moved.prep.cues.find((each) => each.slot === "E")?.sec).not.toBe(e?.sec);
  const gone = await edit("prep-cue-delete", { slot: "E" });
  if (!gone.ok) throw new Error(gone.message);
  expect(gone.prep.cues.some((each) => each.slot === "E")).toBe(false);
  expect(await edit("prep-cue", { slot: "Z", sec: 1 })).toEqual({
    ok: false,
    message: "Pick a cue from A to H.",
  });
  expect((await edit("prep-cue", { slot: "A", sec: 500 })).ok).toBe(false);

  const loop = await edit("prep-loop", { startSec: 2, bars: 2 });
  if (!loop.ok) throw new Error(loop.message);
  expect(loop.prep.loop?.bars).toBe(2);
  expect(
    Math.abs((loop.prep.loop?.endSec ?? 0) - (loop.prep.loop?.startSec ?? 0) - 2 * 4 * beat),
  ).toBeLessThan(0.01);
  const looped = await edit("prep-loop", { startSec: 5, bars: 1 });
  if (!looped.ok) throw new Error(looped.message);
  expect(looped.prep.loop?.startSec).not.toBe(loop.prep.loop?.startSec);
  const cleared = await edit("prep-loop-clear", {});
  expect(cleared.ok && cleared.prep.loop).toBeNull();

  const auto = await edit("prep-auto-cues", {});
  expect(auto.ok && auto.prep.cues.length).toBe(4);

  const made = (await ask(w, "crate-create", {}, { name: "Set" })) as { id: string };
  const crates = (await ask(w, "prep-crate", {}, { project: id, crate: made.id, in: true })) as {
    crates: { has: boolean }[];
  };
  expect(crates.crates[0]?.has).toBe(true);
  const out = (await ask(w, "prep-crate", {}, { project: id, crate: made.id, in: false })) as {
    crates: { has: boolean }[];
  };
  expect(out.crates[0]?.has).toBe(false);
});

test("before analysis the edits say the track is not analysed yet", async () => {
  const w = dj();
  const id = await chosenProject(w);
  expect(await ask(w, "prep-cue", {}, { project: id, slot: "A", sec: 1 })).toEqual({
    ok: false,
    message: "This track is not analysed yet. Analyse it first.",
  });
});

test("a track with no clear tempo is analysed without one, and a typed BPM makes the grid", async () => {
  const w = dj();
  const { id } = await audioProject(w, pcmWav(noise(10)));
  const job = await localJob(w, "prepare-analyse", { project: id });
  expect(job.status).toBe("done");
  const view = (await ask(w, "prepare", { project: id })) as PrepareView;
  expect(view.prep?.analysis.bpm).toBeNull();
  expect(view.prep?.grid).toBeNull();
  expect(await ask(w, "prep-cue", {}, { project: id, slot: "A", sec: 1 })).toMatchObject({
    ok: false,
  });
  const typed = (await ask(w, "prep-bpm", {}, { project: id, bpm: 126 })) as Edit;
  if (!typed.ok) throw new Error(typed.message);
  expect(typed.prep.grid).toEqual({ bpm: 126, firstBeatSec: 0 });
  expect(typed.prep.manualBpm).toBe(true);
  // Analysing again keeps the typed tempo while none is found.
  await localJob(w, "prepare-analyse", { project: id });
  const again = (await ask(w, "prepare", { project: id })) as PrepareView;
  expect(again.prep?.grid?.bpm).toBe(126);
  expect(again.prep?.manualBpm).toBe(true);
});

test("a newer master than the analysed file marks the analysis stale", async () => {
  const w = dj();
  const { id } = await audioProject(w, song(120, 8));
  await localJob(w, "prepare-analyse", { project: id });
  expect(((await ask(w, "prepare", { project: id })) as PrepareView).stale).toBe(false);
  await localJob(w, "master-render", { project: id, target: "streaming", format: "wav" });
  expect(((await ask(w, "prepare", { project: id })) as PrepareView).stale).toBe(true);
});
