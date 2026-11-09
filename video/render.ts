/**
 * Renders the edit with ffmpeg on this computer, or writes a job folder
 * (the inputs and the exact ffmpeg argv) for a session to run on a rented
 * box. Three kinds: the 540p preview, the 1080p music video, and the 9:16
 * vertical cut (about 30 seconds of shots from the 16:9 frame's centre,
 * with captions). A render is cancellable: the signal stops ffmpeg and the
 * half-written file is removed.
 */

import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { basename, extname, join } from "node:path";
import { runFfmpeg } from "../audio/ffmpeg";
import { beatSeconds } from "../prep/grid";
import type { IndexEntry } from "../project/store";
import { json, videoDir } from "../project/video";
import {
  nextRender,
  type RenderKind,
  type RenderRecord,
  writeRender,
} from "../project/video-media";
import type { Studio } from "../studio";
import { probeCaps } from "./caps";
import { assKaraoke } from "./captions";
import { FINAL_SIZE, FPS, PREVIEW_SIZE, VERTICAL_SIZE } from "./constants";
import { type EditState, loadEdit, signatureOf } from "./edit-model";
import { shotsIn } from "./range";
import { renderArgs, type Slot, type TimelineSpec } from "./timeline";

export type Rendered =
  | { ok: true; record: RenderRecord; path: string; warnings: string[] }
  | { ok: false; reason: "no_ffmpeg" | "invalid" | "failed" | "cancelled"; message: string };

const SIZES = { preview: PREVIEW_SIZE, final: FINAL_SIZE, vertical: VERTICAL_SIZE } as const;

type Size = { width: number; height: number };

/** The frame of a render: its kind's size, or the smaller one a test asked the studio for (turned on its side for the vertical cut). */
export function sizeFor(studio: Studio, kind: RenderKind): Size {
  const small = studio.deps.renderSize;
  if (small === undefined) return SIZES[kind];
  return kind === "vertical" ? { width: small.height, height: small.width } : small;
}

/** Rough seconds a render takes: about the video's length on four cores. A guess, shown as one. */
export function estimateSeconds(kind: RenderKind, videoSec: number): number {
  const cores = Math.max(1, cpus().length);
  const speed = kind === "preview" ? 4 : 1;
  return Math.max(5, Math.round((videoSec * 4) / cores / speed));
}

/** "about 3 minutes" */
export function durationWords(seconds: number): string {
  if (seconds < 90) return `about ${Math.max(5, Math.round(seconds / 5) * 5)} seconds`;
  return `about ${Math.round(seconds / 60)} minutes`;
}

/** The slots, rebased to start at 0, of the shots in `range`. */
function rebased(state: EditState, kind: RenderKind): { slots: Slot[]; fromSec: number } {
  if (kind !== "vertical" || state.vertical === null || state.list === null)
    return { slots: state.slots, fromSec: 0 };
  const ids = new Set(shotsIn(state.list.shots, state.vertical).map((each) => each.id));
  const from = state.vertical.startSec;
  const slots = state.slots
    .filter((each) => ids.has(each.shot))
    .map((each) => ({ ...each, startSec: each.startSec - from, endSec: each.endSec - from }));
  return { slots, fromSec: from };
}

export type Inputs = {
  state: EditState;
  kind: RenderKind;
  xfade: boolean;
  /** The `.ass` to burn in, or null. */
  captions: string | null;
  threads: number | null;
  size: Size;
};

/** The timeline spec for a render. Paths are the ones given: absolute for a local run, relative for a job folder. */
export function specOf(
  input: Inputs,
  audioFile: string | null,
  slots: Slot[],
  fromSec: number,
): TimelineSpec {
  const { size } = input;
  const grid = input.state.list;
  return {
    slots,
    width: size.width,
    height: size.height,
    fps: FPS,
    beatSec: grid === null ? 0.5 : beatSeconds({ bpm: grid.bpm, firstBeatSec: grid.firstBeatSec }),
    audio: audioFile === null ? null : { file: audioFile, fromSec },
    captions: input.captions,
    xfade: input.xfade,
    preset: input.kind === "preview" ? "ultrafast" : "veryfast",
    crf: input.kind === "preview" ? 30 : 20,
    threads: input.threads,
  };
}

/** The `.ass` text for a render, or null when captions are off or there are no words. */
export function captionsFor(
  state: EditState,
  kind: RenderKind,
  fromSec: number,
  size: Size,
): string | null {
  if (!state.settings.captions) return null;
  const range = kind === "vertical" && state.vertical !== null ? state.vertical : null;
  return assKaraoke(state.words, {
    width: size.width,
    height: size.height,
    ...(range === null ? {} : { fromSec, toSec: range.endSec }),
  });
}

/** Why a state cannot be rendered, or null. */
export function unrenderable(state: EditState, slots: Slot[]): string | null {
  if (state.list === null || state.list.shots.length === 0)
    return "There is no shot list yet. Draft one on the Storyboard stage.";
  if (slots.length === 0) return "No shots fall in the vertical cut's range.";
  if (slots.every((each) => each.clip === null))
    return "Nothing is shot yet: every shot would be black. Shoot at least one on the Shoot stage.";
  return null;
}

export type RenderRequest = { kind: RenderKind; signal: AbortSignal };

/** Renders the project's edit to `video/renders/<kind>-<n>.mp4` and keeps a record of it. */
export async function renderProject(
  studio: Studio,
  entry: IndexEntry,
  request: RenderRequest,
  step: (name: string) => void = () => undefined,
): Promise<Rendered> {
  const { kind, signal } = request;
  const binary = studio.ffmpeg();
  const caps = await probeCaps(binary);
  if (!caps.ok) return { ok: false, reason: "no_ffmpeg", message: caps.message };
  if (!caps.x264)
    return {
      ok: false,
      reason: "no_ffmpeg",
      message: "This ffmpeg has no H.264 encoder (libx264).",
    };
  const state = await loadEdit(studio, entry);
  const { slots, fromSec } = rebased(state, kind);
  const problem = unrenderable(state, slots);
  if (problem !== null) return { ok: false, reason: "invalid", message: problem };
  const warnings = state.warnings.filter((each) => !each.startsWith("Shot "));
  const next = await nextRender(state.dir, kind);
  const size = sizeFor(studio, kind);
  const text = caps.ass ? captionsFor(state, kind, fromSec, size) : null;
  if (state.settings.captions && !caps.ass)
    warnings.push("This ffmpeg has no ass filter (libass), so the captions were left out.");
  if (state.settings.captions && state.words.length === 0)
    warnings.push("This song has no sung words, so there are no captions.");
  let ass: string | null = null;
  if (text !== null) {
    ass = join(state.dir, "video", "renders", `${kind}-${next.n}.ass`);
    await writeFile(ass, text);
  }
  const input: Inputs = {
    state,
    kind,
    xfade: caps.xfade,
    captions: ass,
    threads: kind === "preview" ? 2 : null,
    size,
  };
  const built = renderArgs(
    specOf(input, state.audio?.path ?? null, slots, fromSec),
    join(state.dir, next.file),
  );
  step("graph");
  const ran = await runFfmpeg(binary, built.args, signal);
  if (!ran.ok) {
    await rm(join(state.dir, next.file), { force: true });
    return signal.aborted
      ? { ok: false, reason: "cancelled", message: "Cancelled. The half-written file was removed." }
      : { ok: false, reason: "failed", message: ran.message };
  }
  step("rendered");
  const record: RenderRecord = {
    n: next.n,
    kind,
    file: next.file,
    signature: signatureOf(state, state.settings.captions),
    seconds: built.totalSec,
    captions: ass !== null,
    gaps: built.gaps,
    created: new Date().toISOString(),
  };
  await writeRender(state.dir, record);
  return { ok: true, record, path: join(state.dir, next.file), warnings };
}

const extOf = (file: string, fallback: string): string => extname(file).slice(1) || fallback;

/**
 * Writes `video/jobs/<kind>-<time>/`: the clips, the soundtrack and the
 * captions copied into `inputs/`, and `job.json` with the exact ffmpeg
 * argv, to run with the folder as the working directory. The graph uses
 * overlays rather than `xfade`, so it runs on any ffmpeg.
 */
export async function planRender(
  studio: Studio,
  entry: IndexEntry,
  kind: RenderKind,
): Promise<{ ok: true; folder: string; argv: string[] } | { ok: false; message: string }> {
  const state = await loadEdit(studio, entry);
  const { slots, fromSec } = rebased(state, kind);
  const problem = unrenderable(state, slots);
  if (problem !== null) return { ok: false, message: problem };
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  const folder = join(videoDir(state.dir), "jobs", `${kind}-${stamp}`);
  await mkdir(join(folder, "inputs"), { recursive: true });
  await mkdir(join(folder, "output"), { recursive: true });
  const local = new Map<string, string>();
  for (const slot of slots) {
    if (slot.clip === null || local.has(slot.clip)) continue;
    const name = `inputs/clip-${local.size + 1}.${extOf(slot.clip, "mp4")}`;
    await copyFile(slot.clip, join(folder, name));
    local.set(slot.clip, name);
  }
  let audio: string | null = null;
  if (state.audio !== null) {
    audio = `inputs/${basename(state.audio.path)}`;
    await copyFile(state.audio.path, join(folder, audio));
  }
  const size = sizeFor(studio, kind);
  const text = captionsFor(state, kind, fromSec, size);
  if (text !== null) await writeFile(join(folder, "inputs", "captions.ass"), text);
  const relative = slots.map((each) => ({
    ...each,
    clip: each.clip === null ? null : (local.get(each.clip) ?? null),
  }));
  const input: Inputs = {
    state,
    kind,
    xfade: false,
    captions: text === null ? null : "inputs/captions.ass",
    threads: null,
    size,
  };
  const out = `output/${kind}.mp4`;
  const built = renderArgs(specOf(input, audio, relative, fromSec), out);
  const job = {
    program: "ffmpeg",
    cwd: ".",
    argv: built.args,
    output: out,
    note: "Run `ffmpeg` with these arguments from this folder. The paths in argv are relative to it.",
  };
  await writeFile(join(folder, "job.json"), json(job));
  return { ok: true, folder, argv: built.args };
}
