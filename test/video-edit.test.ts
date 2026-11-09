/**
 * The Edit stage through the panel's routes, with real ffmpeg on tiny
 * synthetic clips (160x90): the timeline view with its gaps and warnings,
 * the per-shot choices, the 540p preview, the 1080p render behind its card,
 * the soundtrack, captions, Deliver's two video items, and the media route.
 */

import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runFfmpeg } from "../audio/ffmpeg";
import { saveMaster } from "../project/master";
import { readTreatment } from "../project/video";
import { readEdit, readRenders, writeRender } from "../project/video-media";
import type { EditView } from "../routes/video-views";
import type { DeliverOutcome, DeliverView } from "../routes/views";
import type { Job } from "../studio";
import { renderProject } from "../video/render";
import { ask, declineCards, type Refused, runJob } from "./stage-world";
import { PNG, preparedProject, seedClips, seedShots, videoWorld } from "./video-world";

async function setup(clips = [0, 1]) {
  const w = videoWorld();
  const { project, dir } = await preparedProject(w);
  const list = await seedClips(dir, await seedShots(dir), clips);
  const entry = await w.studio.store().find(project);
  if (entry === null) throw new Error("no project");
  return { w, project, dir, list, entry };
}

const view = async (w: Parameters<typeof ask>[0], project: string) =>
  (await ask(w, "edit", { project })) as EditView;
const jobOf = (job: Job | Refused): Job => {
  if (!("status" in job)) throw new Error(job.message);
  return job;
};

/** The duration of a file in seconds, and its size WxH, from ffmpeg's own words. */
async function facts(path: string): Promise<{ seconds: number; size: string }> {
  const ran = await runFfmpeg("ffmpeg", ["-hide_banner", "-i", path, "-f", "null", "-"]);
  if (!ran.ok) throw new Error(ran.message);
  const time = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(ran.log);
  const size = /Video:.* (\d+x\d+)[ ,]/.exec(ran.log);
  return {
    seconds: time === null ? 0 : Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]),
    size: size?.[1] ?? "",
  };
}

test("the timeline is in bars, shots without a clip are gaps, and the view warns", async () => {
  const { w, project, list } = await setup();
  const shown = await view(w, project);
  expect(shown.slots).toHaveLength(5);
  expect(shown.slots.map((each) => each.hasClip)).toEqual([true, true, false, false, false]);
  expect(shown.slots[1]).toMatchObject({
    number: 2,
    startBar: 5,
    bars: 4,
    startSec: 8,
    endSec: 16,
  });
  expect(shown.totalSec).toBe(30);
  expect(shown.beatSec).toBe(0.5);
  expect(shown.gaps).toBe(3);
  expect(shown.warnings.join(" ")).toContain("3 of 5 shots have no clip yet and will render black");
  expect(shown.audio).toMatchObject({ label: "Sketch A", kind: "sketch" });
  expect(shown.ffmpeg.ok).toBe(true);
  expect(shown.join).toMatch(/xfade|overlay/);
  expect(shown.slots.map((each) => each.shot)).toEqual(list.shots.map((each) => each.id));
});

test("with no shot list the timeline is empty and the edit cannot be rendered", async () => {
  const w = videoWorld();
  const { project } = await preparedProject(w);
  const shown = await view(w, project);
  expect(shown.slots).toEqual([]);
  const refused = (await ask(w, "edit-preview", {}, { project })) as Refused;
  expect(refused).toMatchObject({ ok: false, reason: "invalid" });
  expect(refused.message).toContain("no shot list");
});

test("per-shot transition and speed and the captions switch are saved", async () => {
  const { w, project, dir, list } = await setup();
  const id = list.shots[1]?.id ?? "";
  const saved = (await ask(
    w,
    "edit-save",
    {},
    { project, shots: { [id]: { transition: "crossfade" } }, captions: false },
  )) as EditView;
  expect(saved.slots[1]).toMatchObject({ transition: "crossfade", speed: "normal" });
  expect(saved.captions.on).toBe(false);
  const again = (await ask(
    w,
    "edit-save",
    {},
    { project, shots: { [id]: { speed: "ramp" } } },
  )) as EditView;
  expect(again.slots[1]).toMatchObject({ transition: "crossfade", speed: "ramp" });
  expect((await readEdit(dir)).shots[id]).toEqual({ transition: "crossfade", speed: "ramp" });
  // A value that is no transition falls back to a cut.
  const odd = (await ask(
    w,
    "edit-save",
    {},
    { project, shots: { [id]: { transition: "wipe" } } },
  )) as EditView;
  expect(odd.slots[1]?.transition).toBe("cut");
});

test("an instrumental has no captions and the view says so; sung words are counted", async () => {
  const { w, project, dir } = await setup();
  const shown = await view(w, project);
  expect(shown.captions).toMatchObject({ on: true, words: 0 });
  expect(shown.captions.reason).toContain("no sung words");
  const file = join(dir, "sketches", "a.json");
  const record = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  writeFileSync(
    file,
    JSON.stringify({
      ...record,
      timestamps: [
        { word: "Hello", start_ms: 500, end_ms: 900 },
        { word: "there", start_ms: 1000, end_ms: 1500 },
      ],
    }),
  );
  const sung = await view(w, project);
  expect(sung.captions).toMatchObject({ words: 2, reason: null });
});

test("Preview 540p renders the edit locally as a cancellable job: the clips, a black gap, the master as sound, captions burned in", async () => {
  const { w, project, dir } = await setup();
  const file = join(dir, "sketches", "a.json");
  const record = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  writeFileSync(
    file,
    JSON.stringify({
      ...record,
      timestamps: [
        { word: "It's", start_ms: 500, end_ms: 900 },
        { word: "{live}", start_ms: 1000, end_ms: 1500 },
      ],
    }),
  );
  const started = Date.now();
  const job = jobOf(await runJob(w, "edit-preview", { project }));
  expect(job.status).toBe("done");
  expect(job.work).toBe("preview");
  expect(Date.now() - started).toBeLessThan(15_000);
  const renders = await readRenders(dir);
  expect(renders).toHaveLength(1);
  expect(renders[0]).toMatchObject({ kind: "preview", n: 1, captions: true, gaps: 3 });
  const out = join(dir, renders[0]?.file ?? "");
  const seen = await facts(out);
  expect(seen.seconds).toBeCloseTo(30, 0);
  expect(seen.size).toBe("160x90");
  expect(existsSync(join(dir, "video", "renders", "preview-1.ass"))).toBe(true);
  expect(readFileSync(join(dir, "video", "renders", "preview-1.ass"), "utf8")).toContain("(live)");
  const shown = await view(w, project);
  expect(shown.renders.preview).toMatchObject({ n: 1, stale: false, gaps: 3, captions: true });
  // Changing the edit makes the render stale.
  await ask(w, "edit-save", {}, { project, captions: false });
  expect((await view(w, project)).renders.preview?.stale).toBe(true);
});

test("a render with every shot black is refused with words", async () => {
  const { w, project } = await setup([]);
  const refused = (await ask(w, "edit-preview", {}, { project })) as Refused;
  expect(refused).toMatchObject({ ok: false, reason: "invalid" });
  expect(refused.message).toContain("Nothing is shot yet");
});

test("Render 1080p shows a card with an estimated time that says it will load the machine; no is no render", async () => {
  const { w, project, dir } = await setup();
  declineCards(w);
  const declined = (await ask(w, "edit-render", {}, { project })) as Refused;
  expect(declined).toMatchObject({ ok: false, reason: "cancelled" });
  const card = w.fake.confirms.at(-1);
  expect(card?.title).toBe("Render 1080p");
  expect(card?.summary).toContain("30 seconds of video, 1920×1080");
  expect(card?.summary).toMatch(/Estimated time: about \d+ (seconds|minutes), a rough guess/);
  expect(card?.summary).toContain("keep the processor busy");
  expect(card?.summary).toContain("cancel it from the panel");
  expect(await readRenders(dir)).toEqual([]);
});

test("Render 1080p after a yes makes the final render, keeps it as a separate kind, and the preview card is not asked", async () => {
  const { w, project, dir } = await setup();
  const cards = w.fake.confirms.length;
  const preview = jobOf(await runJob(w, "edit-preview", { project }));
  expect(preview.status).toBe("done");
  expect(w.fake.confirms).toHaveLength(cards);
  const final = jobOf(await runJob(w, "edit-render", { project }));
  expect(final.status).toBe("done");
  expect(final.work).toBe("render");
  expect(w.fake.confirms).toHaveLength(cards + 1);
  expect((await readRenders(dir)).map((each) => each.kind)).toEqual(["preview", "final"]);
});

test("a render that is cancelled leaves no half-written file", async () => {
  const { w, dir, entry } = await setup();
  const abort = new AbortController();
  abort.abort();
  const done = await renderProject(w.studio, entry, { kind: "preview", signal: abort.signal });
  expect(done).toMatchObject({ ok: false, reason: "cancelled" });
  expect(existsSync(join(dir, "video", "renders", "preview-1.mp4"))).toBe(false);
  expect(await readRenders(dir)).toEqual([]);
});

test("the soundtrack is the master, else the mix, else the version, else the sketch", async () => {
  const { w, project, dir } = await setup();
  expect((await view(w, project)).audio).toMatchObject({ kind: "sketch" });
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "mix"), { recursive: true });
  writeFileSync(join(dir, "mix", "mix-1.wav"), "x");
  expect((await view(w, project)).audio).toMatchObject({ kind: "mix", label: "Mix 1" });
  mkdirSync(join(dir, "master"), { recursive: true });
  writeFileSync(join(dir, "master", "master-1.wav"), "x");
  const loudness = { integrated: -14, truePeak: -1, range: 5 };
  await saveMaster(dir, {
    n: 1,
    file: "master/master-1.wav",
    target: "streaming",
    format: "wav",
    from: "Mix 1",
    input: loudness,
    output: loudness,
    type: "linear",
    created: "2026-01-01",
  });
  expect((await view(w, project)).audio).toMatchObject({ kind: "master", label: "Master 1" });
});

test("Deliver offers the music video once there is a 1080p render, and copies it", async () => {
  const { w, project, dir } = await setup();
  const before = (await ask(w, "deliver", { project })) as DeliverView;
  expect(before.video.render).toBeNull();
  expect(before.video.clips).toBe(2);
  const none = jobOf(await runJob(w, "deliver-run", { project, items: ["video"] }));
  expect(none.status).toBe("failed");
  expect(none.error).toContain("no 1080p render");
  jobOf(await runJob(w, "edit-render", { project }));
  const after = (await ask(w, "deliver", { project })) as DeliverView;
  expect(after.video.render).toMatchObject({ n: 1, stale: false });
  const delivered = jobOf(await runJob(w, "deliver-run", { project, items: ["video"] }));
  expect(delivered.status).toBe("done");
  const outcome = JSON.parse(delivered.result ?? "{}") as DeliverOutcome;
  expect(outcome.files).toHaveLength(1);
  expect(outcome.files[0]).toEndWith("music video.mp4");
  expect(statSync(outcome.files[0] ?? "").size).toBe(
    statSync(join(dir, "video", "renders", "final-1.mp4")).size,
  );
});

test("Deliver's vertical cut asks first: no is no render", async () => {
  const { w, project, dir } = await setup();
  declineCards(w);
  const declined = (await ask(w, "deliver-run", {}, { project, items: ["vertical"] })) as Refused;
  expect(declined).toMatchObject({ ok: false, reason: "cancelled" });
  expect(w.fake.confirms.at(-1)?.title).toBe("Render the vertical cut");
  expect(await readRenders(dir)).toEqual([]);
});

test("Deliver's vertical cut, after a yes, renders 9:16 from the chorus range and delivers it", async () => {
  const { w, project } = await setup([0, 1, 2, 3, 4]);
  const before = (await ask(w, "deliver", { project })) as DeliverView;
  expect(before.video.verticalSec).toBeGreaterThan(20);
  const delivered = jobOf(await runJob(w, "deliver-run", { project, items: ["vertical"] }));
  expect(delivered.status).toBe("done");
  const outcome = JSON.parse(delivered.result ?? "{}") as DeliverOutcome;
  expect(outcome.files[0]).toEndWith("vertical.mp4");
  expect((await facts(outcome.files[0] ?? "")).size).toBe("90x160");
});

test("the vertical cut is a 9:16 render of whole shots from the chosen range", async () => {
  const { w, project, dir, entry } = await setup([0, 1, 2, 3, 4]);
  await ask(w, "edit-save", {}, { project, vertical: { startSec: 8, endSec: 20 } });
  const shown = await view(w, project);
  expect(shown.vertical).toMatchObject({ startSec: 8, endSec: 20, shots: 2 });
  const done = await renderProject(w.studio, entry, {
    kind: "vertical",
    signal: new AbortController().signal,
  });
  expect(done.ok).toBe(true);
  if (!done.ok) return;
  const seen = await facts(done.path);
  expect(seen.seconds).toBeCloseTo(12, 0);
  // 160x90 turned on its side, as the test studio does for the vertical cut.
  expect(seen.size).toBe("90x160");
  expect((await readRenders(dir)).at(-1)).toMatchObject({ kind: "vertical", seconds: 12 });
  const bad = await ask(w, "edit-save", {}, { project, vertical: null });
  expect((bad as EditView).vertical).not.toBeNull();
});

test("api/media sends pictures and small video only: cast, frame, a take's 360p copy and the preview, never a final render", async () => {
  const { w, project, dir, list } = await setup();
  const { addCastFile } = await import("../video/cast");
  const added = await addCastFile(dir, "Mia", PNG);
  if (!added.ok) throw new Error(added.message);
  const cast = (await ask(w, "media", { project, kind: "cast", id: added.member.id })) as {
    mime: string;
    base64: string;
  };
  expect(cast.mime).toBe("image/png");
  expect(Buffer.from(cast.base64, "base64").length).toBe(PNG.length);
  const frame = (await ask(w, "media", {
    project,
    kind: "frame",
    id: list.shots[0]?.id ?? "",
  })) as {
    mime: string;
  };
  expect(frame.mime).toBe("image/png");
  const take = (await ask(w, "media", { project, kind: "take", id: `${list.shots[0]?.id}-1` })) as {
    mime: string;
    base64: string;
  };
  expect(take.mime).toBe("video/mp4");
  expect(existsSync(join(dir, "video", "takes", `${list.shots[0]?.id}-1.proxy.mp4`))).toBe(true);
  expect(Buffer.from(take.base64, "base64").length).toBeLessThan(
    statSync(join(dir, "video", "takes", `${list.shots[0]?.id}-1.mp4`)).size + 20_000,
  );
  jobOf(await runJob(w, "edit-preview", { project }));
  const preview = (await ask(w, "media", { project, kind: "preview", id: "1" })) as {
    mime: string;
  };
  expect(preview.mime).toBe("video/mp4");
  jobOf(await runJob(w, "edit-render", { project }));
  for (const kind of ["final", "render", "vertical"])
    expect(
      String(await ask(w, "media", { project, kind, id: "1" }).catch((caught: unknown) => caught)),
    ).toContain(`No such ${kind}`);
  // Nothing over 12 MB goes through JSON.
  writeFileSync(join(dir, "video", "renders", "preview-9.mp4"), new Uint8Array(13 * 1024 * 1024));
  await writeRender(dir, {
    n: 9,
    kind: "preview",
    file: "video/renders/preview-9.mp4",
    signature: "",
    seconds: 1,
    captions: false,
    gaps: 0,
    created: "2026-02-01",
  });
  expect(
    String(
      await ask(w, "media", { project, kind: "preview", id: "9" }).catch(
        (caught: unknown) => caught,
      ),
    ),
  ).toContain("too big");
  expect((await readTreatment(dir)).cast).toHaveLength(1);
});

test("no ffmpeg is a message, not a crash", async () => {
  const w = videoWorld(undefined, { ffmpegPath: "/nonexistent/ffmpeg" });
  const { project, dir } = await preparedProject(w);
  await seedClips(dir, await seedShots(dir), []);
  const shown = await view(w, project);
  expect(shown.ffmpeg.ok).toBe(false);
  expect(shown.ffmpeg.message).toContain("/nonexistent/ffmpeg");
});
