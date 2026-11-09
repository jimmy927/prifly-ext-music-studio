/**
 * Helpers for the video tests: a Gemini that answers pictures and clips like
 * the docs say (no real call is ever made), a prepared project with a beat
 * grid, tiny real clips made by ffmpeg from synthetic sources, and a shot list
 * seeded without going through the paid steps.
 */

import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpeg } from "../audio/ffmpeg";
import { writePrep } from "../project/prep";
import { writeShots } from "../project/video";
import { takeFile, writeTake } from "../project/video-media";
import { draftShots, type ShotList } from "../video/shotlist";
import { chosenProject, elevenlabs, type Fakes } from "./stage-world";
import { type Call, type Handler, type World, world } from "./world";

/** A 1x1 PNG. */
export const PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);

export const interaction = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  id: "v1_test",
  status: "completed",
  model: "x",
  object: "interaction",
  steps: [
    { type: "user_input", content: [{ type: "text", text: "prompt" }] },
    { type: "model_output", content },
  ],
  ...extra,
});

export const imageReply = (): Response =>
  Response.json(
    interaction([
      { type: "image", mime_type: "image/png", data: Buffer.from(PNG).toString("base64") },
    ]),
  );

export const videoReply = (bytes: Uint8Array): Response =>
  Response.json(
    interaction([
      { type: "video", mime_type: "video/mp4", data: Buffer.from(bytes).toString("base64") },
    ]),
  );

export const googleError = (status: number, code: string, message: string): Response =>
  Response.json({ error: { code, message } }, { status });

/** What the fake Gemini does with the next video call. */
export type VideoMode =
  | { kind: "inline" }
  | { kind: "background"; polls: number }
  | { kind: "fail"; status: number; code: string; message: string }
  | { kind: "failed-interaction"; code: string; message: string };

export type Gemini = {
  mode: VideoMode;
  /** The clip every video call returns. */
  clip: Uint8Array;
  images: number;
  videos: number;
  polls: number;
  cancels: string[];
  /** Told the number of each video call as it arrives. */
  onVideo: (count: number) => void | Promise<void>;
  handler: (call: Call) => Response | Promise<Response | null> | null;
};

export function gemini(
  clip: Uint8Array = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
): Gemini {
  const state: Gemini = {
    mode: { kind: "inline" },
    clip,
    images: 0,
    videos: 0,
    polls: 0,
    cancels: [],
    onVideo: () => undefined,
    handler: () => null,
  };
  state.handler = async (call) => {
    if (call.url.includes("/interactions/") && call.url.endsWith("/cancel")) {
      state.cancels.push(call.url);
      return Response.json({ status: "cancelled" });
    }
    if (call.url.includes("/interactions/")) return poll(state);
    if (!call.url.endsWith("/v1beta/interactions") || call.method !== "POST") return null;
    const body = JSON.parse(call.body) as { model?: string };
    if (body.model === "gemini-3.1-flash-image") {
      state.images += 1;
      return imageReply();
    }
    if (body.model !== "gemini-omni-1.2-flash") return null;
    state.videos += 1;
    await state.onVideo(state.videos);
    return start(state);
  };
  return state;
}

function start(state: Gemini): Response {
  const mode = state.mode;
  if (mode.kind === "fail") return googleError(mode.status, mode.code, mode.message);
  if (mode.kind === "failed-interaction")
    return Response.json({
      id: "v1_bad",
      status: "failed",
      error: { code: mode.code, message: mode.message },
      steps: [],
    });
  if (mode.kind === "background")
    return Response.json({ id: `v1_${state.videos}`, status: "in_progress", steps: [] });
  return videoReply(state.clip);
}

function poll(state: Gemini): Response {
  state.polls += 1;
  const mode = state.mode;
  if (mode.kind === "background" && state.polls < mode.polls)
    return Response.json({ id: "v1_x", status: "in_progress", steps: [] });
  return videoReply(state.clip);
}

/** A world whose ElevenLabs and Gemini are both faked. */
export function videoWorld(
  g: Gemini = gemini(),
  options: Parameters<typeof world>[1] = {},
  fakes?: Fakes,
): World & { g: Gemini } {
  const eleven = elevenlabs(fakes);
  const handler: Handler = async (call) => (await g.handler(call)) ?? (await eleven(call));
  const w = world(handler, { ffmpegPath: "", ...options });
  return Object.assign(w, { g });
}

/** Writes a one-section analysis for the chosen sketch: 120 BPM, the first beat at 0, 30 seconds. */
export async function prepare(w: World, project: string, bpm = 120): Promise<string> {
  const entry = await w.studio.store().find(project);
  if (entry === null) throw new Error("no such project");
  const dir = w.studio.store().pathOf(entry);
  await writePrep(dir, {
    source: { kind: "sketch", id: "a", label: "Sketch A", file: "sketches/a.mp3" },
    analysis: {
      bpm,
      strength: 1,
      key: null,
      energy: 5,
      lufs: -14,
      truePeak: -1,
      durationSec: 30,
      analysedAt: "2026-01-01T00:00:00Z",
    },
    grid: { bpm, firstBeatSec: 0 },
    manualBpm: false,
    cues: [],
    loop: null,
  });
  return dir;
}

/** A project with three sketches (the first chosen) and a tempo. */
export async function preparedProject(w: World): Promise<{ project: string; dir: string }> {
  const project = await chosenProject(w);
  return { project, dir: await prepare(w, project) };
}

/** A tiny real clip: synthetic video, `seconds` long, no sound. */
export async function makeClip(path: string, seconds = 2, size = "160x90"): Promise<void> {
  const ran = await runFfmpeg("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=${size}:rate=15:duration=${seconds}`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    path,
  ]);
  if (!ran.ok) throw new Error(ran.message);
}

/** Drafts the shot list of a prepared project (blank descriptions), approves every shot and gives each a frame. */
export async function seedShots(dir: string, bpm = 120): Promise<ShotList> {
  const list = draftShots({
    sections: [
      { name: "Intro", startSec: 0 },
      { name: "Verse", startSec: 8 },
      { name: "Chorus", startSec: 20 },
    ],
    grid: { bpm, firstBeatSec: 0 },
    durationSec: 30,
    bars: 4,
  });
  mkdirSync(join(dir, "video", "frames"), { recursive: true });
  const shots = list.shots.map((shot, at) => {
    const frame = `video/frames/${shot.id}-x.png`;
    writeFileSync(join(dir, frame), PNG);
    return { ...shot, text: `Shot ${at + 1}: a wide view`, approved: true, frame };
  });
  const seeded = { ...list, shots };
  await writeShots(dir, seeded);
  return seeded;
}

let template: Promise<string> | null = null;

/** One tiny real clip made once for the whole run; every take is a copy of it. */
function templateClip(): Promise<string> {
  template ??= (async () => {
    const path = join(mkdtempSync(join(tmpdir(), "music-studio-clip-")), "template.mp4");
    await makeClip(path, 1);
    return path;
  })();
  return template;
}

/** Gives the shots a finished take each, a tiny real clip, and makes it the chosen one. */
export async function seedClips(dir: string, list: ShotList, which: number[]): Promise<ShotList> {
  mkdirSync(join(dir, "video", "takes"), { recursive: true });
  const shots = [...list.shots];
  for (const at of which) {
    const shot = shots[at];
    if (shot === undefined) continue;
    const file = takeFile(shot.id, 1);
    copyFileSync(await templateClip(), join(dir, file));
    await writeTake(dir, {
      id: `${shot.id}-1`,
      shot: shot.id,
      n: 1,
      status: "done",
      file,
      reason: null,
      failure: null,
      seconds: 3,
      usd: 0.21,
      interaction: null,
      created: new Date().toISOString(),
    });
    shots[at] = { ...shot, take: `${shot.id}-1` };
  }
  const seeded = { ...list, shots };
  await writeShots(dir, seeded);
  return seeded;
}
