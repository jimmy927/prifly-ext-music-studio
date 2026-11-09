import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { barStartMs } from "../audio/bars";
import { mixInputs } from "../mix/render";
import { readMix } from "../project/stage";
import type { MixView, ProduceView } from "../routes/views";
import { ask, chosenProject, declineCards, runJob, STEMS, stageWorld } from "./stage-world";
import type { World } from "./world";

async function folderOf(w: World, project: string): Promise<string> {
  const entry = await w.studio.store().find(project);
  if (entry === null) throw new Error("no such project");
  return w.studio.store().pathOf(entry);
}

const splitDone = async (w: World, project: string) => {
  const job = await runJob(w, "stems-split", { project });
  if (!("status" in job)) throw new Error(job.message);
  return job;
};

test("Split stems: one card, the multipart file, stems saved under stems/ and playable", async () => {
  const w = stageWorld();
  const project = await chosenProject(w);
  const job = await splitDone(w, project);
  expect(job).toMatchObject({ status: "done", work: "stems", result: "stems" });
  expect(job.done).toEqual(STEMS);
  expect(w.fake.confirms.at(-1)?.title).toBe("Split stems");
  const request = w.calls.find((call) => call.url.endsWith("/v1/music/stem-separation"));
  expect(request?.method).toBe("POST");
  const file = request?.form?.get("file");
  expect(file instanceof File).toBe(true);
  expect(file instanceof File ? file.name : "").toBe("a.mp3");

  const dir = await folderOf(w, project);
  for (const name of STEMS) expect(existsSync(join(dir, "stems", `${name}.wav`))).toBe(true);
  const view = (await ask(w, "produce", { project })) as ProduceView;
  expect(view.stems.map((each) => each.name)).toEqual(STEMS);
  expect(view.source).toEqual({ id: "a", label: "Sketch A" });
  const media = (await ask(w, "media", { project, kind: "stem", id: "drums" })) as {
    mime: string;
    base64: string;
  };
  expect(media.mime).toBe("audio/wav");
  expect(Buffer.from(media.base64, "base64").subarray(0, 4).toString()).toBe("RIFF");
});

test("stems of a Lyria sketch work too; cancelling the card splits nothing", async () => {
  const w = stageWorld();
  const project = await chosenProject(w, { text: "x", engine: "lyria-clip" });
  declineCards(w);
  const refused = await runJob(w, "stems-split", { project });
  expect(refused).toMatchObject({ ok: false, reason: "cancelled" });
  expect(w.calls.some((call) => call.url.endsWith("/stem-separation"))).toBe(false);
  expect(((await ask(w, "produce", { project })) as ProduceView).source?.label).toBe("Sketch A");
});

test("Produce needs something to split", async () => {
  const w = stageWorld();
  const made = await runJob(w, "sketch", { text: "x" });
  const project = "status" in made ? (made.project ?? "") : "";
  const view = (await ask(w, "produce", { project })) as ProduceView;
  expect(view.source).toBeNull();
  const none = await runJob(w, "stems-split", { project });
  expect(none).toMatchObject({ ok: false });
});

test("a sound-effect layer: prompt, start bar and length in, a file under layers/ out; regenerate and remove", async () => {
  const w = stageWorld();
  const project = await chosenProject(w);
  const job = await runJob(w, "sfx-add", {
    project,
    prompt: "cymbal swell",
    startBar: 5,
    lengthSec: 4,
  });
  if (!("status" in job)) throw new Error(job.message);
  expect(job.status).toBe("done");
  const sent = JSON.parse(
    w.calls.find((call) => call.url.endsWith("/v1/sound-generation"))?.body ?? "{}",
  );
  expect(sent).toEqual({
    text: "cymbal swell",
    duration_seconds: 4,
    loop: false,
    prompt_influence: 0.3,
    model_id: "eleven_text_to_sound_v2",
  });
  const id = job.result ?? "";
  const dir = await folderOf(w, project);
  expect(existsSync(join(dir, "layers", `${id}.mp3`))).toBe(true);
  const view = (await ask(w, "produce", { project })) as ProduceView;
  expect(view.layers).toEqual([
    { id, prompt: "cymbal swell", startBar: 5, lengthSec: 4, loop: false },
  ]);

  const again = await runJob(w, "sfx-regenerate", { project, layer: id });
  if (!("status" in again)) throw new Error(again.message);
  expect(again.result).toBe(id);
  expect(w.fake.confirms.at(-1)?.title).toBe("Regenerate the sound effect");
  expect(w.calls.filter((call) => call.url.endsWith("/v1/sound-generation"))).toHaveLength(2);

  expect(await ask(w, "sfx-remove", {}, { project, layer: id })).toEqual({ ok: true });
  expect(existsSync(join(dir, "layers", `${id}.mp3`))).toBe(false);
  expect(((await ask(w, "produce", { project })) as ProduceView).layers).toEqual([]);
  await expect(ask(w, "sfx-remove", {}, { project, layer: id })).rejects.toThrow("No such layer");
});

test("a sound effect with no prompt or a bad length is refused before the card", async () => {
  const w = stageWorld();
  const project = await chosenProject(w);
  const cards = w.fake.confirms.length;
  for (const body of [
    { prompt: " ", lengthSec: 3 },
    { prompt: "boom", lengthSec: 31 },
    { prompt: "boom", lengthSec: 0.2 },
    { prompt: "boom", lengthSec: 3, startBar: 0 },
  ]) {
    expect(await runJob(w, "sfx-add", { project, ...body })).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  }
  expect(w.fake.confirms).toHaveLength(cards);
});

test("Mix with no stems is empty and says to split first", async () => {
  const w = stageWorld();
  const project = await chosenProject(w);
  const view = (await ask(w, "mix", { project })) as MixView;
  expect(view.tracks).toEqual([]);
  expect(view.ffmpeg.ok).toBe(true);
  expect(await ask(w, "mix-render", {}, { project })).toMatchObject({
    ok: false,
    reason: "no_tracks",
    message: expect.stringContaining("Produce"),
  });
});

test("mix.json keeps level, pan, mute and solo per track", async () => {
  const w = stageWorld();
  const project = await chosenProject(w);
  await splitDone(w, project);
  const mix = {
    tracks: {
      "stem:vocals": { db: -4.5, pan: 0.25, mute: false, solo: true },
      "stem:drums": { db: 2, pan: -1, mute: true, solo: false },
    },
  };
  expect(await ask(w, "mix-save", {}, { project, mix })).toEqual({ ok: true });
  const view = (await ask(w, "mix", { project })) as MixView;
  expect(view.tracks.map((each) => each.key)).toEqual(STEMS.map((each) => `stem:${each}`));
  expect(view.tracks[0]?.mix).toEqual({ db: -4.5, pan: 0.25, mute: false, solo: true });
  expect(view.tracks[2]?.mix).toEqual({ db: 0, pan: 0, mute: false, solo: false });
  expect((await readMix(await folderOf(w, project))).tracks["stem:drums"]?.mute).toBe(true);
});

test("layers start at their bar: bars and the tempo give the offset ffmpeg is told", async () => {
  const w = stageWorld();
  const project = await chosenProject(w);
  await splitDone(w, project);
  await runJob(w, "sfx-add", { project, prompt: "hit", startBar: 3, lengthSec: 1 });
  const entry = await w.studio.store().find(project);
  if (entry === null) throw new Error("gone");
  const inputs = await mixInputs(w.studio, entry, await readMix(await folderOf(w, project)));
  expect(
    inputs.filter((each) => each.key.startsWith("stem:")).every((each) => each.startMs === 0),
  ).toBe(true);
  const layer = inputs.find((each) => each.key.startsWith("layer:"));
  // The sketch's plan names 122 BPM: a bar is 4 beats of 60/122 s.
  expect(layer?.startMs).toBe(barStartMs(3, 122));
  expect(layer?.startMs).toBe(3934);
});

test("Render mix runs ffmpeg locally: no card, no request, a playable WAV in mix/", async () => {
  const w = stageWorld();
  const project = await chosenProject(w);
  await splitDone(w, project);
  await runJob(w, "sfx-add", { project, prompt: "hit", startBar: 2, lengthSec: 1 });
  const cards = w.fake.confirms.length;
  const calls = w.calls.length;
  const mix = {
    tracks: {
      "stem:vocals": { db: -3, pan: -0.5, mute: false, solo: false },
      "stem:drums": { db: 0, pan: 0, mute: true, solo: false },
    },
  };
  const started = performance.now();
  const done = await ask(w, "mix-render", {}, { project, mix });
  expect(performance.now() - started).toBeLessThan(10000);
  expect(done).toMatchObject({ ok: true, n: 1, file: "mix/mix-1.wav" });
  expect(w.fake.confirms).toHaveLength(cards);
  expect(w.calls).toHaveLength(calls);
  const dir = await folderOf(w, project);
  const bytes = await Bun.file(join(dir, "mix", "mix-1.wav")).bytes();
  expect(Buffer.from(bytes.subarray(0, 4)).toString()).toBe("RIFF");
  expect(bytes.length).toBeGreaterThan(1000);
  const second = await ask(w, "mix-render", {}, { project });
  expect(second).toMatchObject({ ok: true, n: 2 });
  const view = (await ask(w, "mix", { project })) as MixView;
  expect(view.renders.map((each) => each.n)).toEqual([1, 2]);
  const media = (await ask(w, "media", { project, kind: "mix", id: "1" })) as { mime: string };
  expect(media.mime).toBe("audio/wav");
});

test("Render mix with everything muted says so and makes no file", async () => {
  const w = stageWorld();
  const project = await chosenProject(w);
  await splitDone(w, project);
  const tracks = Object.fromEntries(
    STEMS.map((name) => [`stem:${name}`, { db: 0, pan: 0, mute: true, solo: false }]),
  );
  expect(await ask(w, "mix-render", {}, { project, mix: { tracks } })).toMatchObject({
    ok: false,
    reason: "silent",
  });
  expect(existsSync(join(await folderOf(w, project), "mix", "mix-1.wav"))).toBe(false);
});

test("ffmpeg missing: Mix says why, and the rest of the stage still works", async () => {
  const w = stageWorld({ ffmpegPath: "/nonexistent/ffmpeg-for-test" });
  const project = await chosenProject(w);
  await splitDone(w, project);
  const view = (await ask(w, "mix", { project })) as MixView;
  expect(view.ffmpeg.ok).toBe(false);
  expect(view.ffmpeg.message).toContain("/nonexistent/ffmpeg-for-test");
  expect(view.tracks).toHaveLength(4);
  expect(await ask(w, "mix-save", {}, { project, mix: { tracks: {} } })).toEqual({ ok: true });
  expect(await ask(w, "mix-render", {}, { project })).toMatchObject({
    ok: false,
    reason: "no_ffmpeg",
  });
  expect(((await ask(w, "produce", { project })) as ProduceView).stems).toHaveLength(4);
});
