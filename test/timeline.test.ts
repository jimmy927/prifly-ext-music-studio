/**
 * The edit as an ffmpeg command: the graph for both joins (xfade and the
 * overlay fallback), then the fallback run for real on this machine's ffmpeg
 * (4.2, which has no xfade) with synthetic 160x90 sources a second or two long.
 */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpeg, runFfmpegBytes } from "../audio/ffmpeg";
import { filterNames, probeCaps } from "../video/caps";
import { assKaraoke, parseWords } from "../video/captions";
import {
  escapeFilterValue,
  fadeSeconds,
  rampExpression,
  rampSource,
  renderArgs,
  type Slot,
  type TimelineSpec,
} from "../video/timeline";
import { wav } from "./stage-world";
import { makeClip } from "./video-world";

const slot = (at: number, over: Partial<Slot> = {}): Slot => ({
  shot: `0000000${at}`,
  startSec: at * 4,
  endSec: at * 4 + 4,
  clip: `/clips/${at}.mp4`,
  transition: "cut",
  speed: "normal",
  ...over,
});

const spec = (slots: Slot[], over: Partial<TimelineSpec> = {}): TimelineSpec => ({
  slots,
  width: 1920,
  height: 1080,
  fps: 30,
  beatSec: 0.5,
  audio: { file: "/music/master.wav", fromSec: 0 },
  captions: null,
  xfade: true,
  preset: "veryfast",
  crf: 20,
  threads: null,
  ...over,
});

const FOUR = [
  slot(0),
  slot(1, { transition: "crossfade", speed: "ramp" }),
  slot(2, { transition: "flash" }),
  slot(3, { clip: null }),
];

test("clips are trimmed to their shot, muted with -an, and the soundtrack is the master mapped last", () => {
  const built = renderArgs(spec(FOUR), "/out/video.mp4");
  expect(built.inputs).toEqual(["/clips/0.mp4", "/clips/1.mp4", "/clips/2.mp4"]);
  const args = built.args;
  expect(args.join(" ")).toContain(
    "-an -i /clips/0.mp4 -an -i /clips/1.mp4 -an -i /clips/2.mp4 -i /music/master.wav",
  );
  expect(args.slice(args.indexOf("-map"), args.indexOf("-map") + 4)).toEqual([
    "-map",
    "[vout]",
    "-map",
    "3:a",
  ]);
  expect(args).toContain("-t");
  expect(args[args.indexOf("-t") + 1]).toBe("16");
  expect(args.at(-1)).toBe("/out/video.mp4");
  expect(built.graph).toContain(
    "[0:v]setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=4,trim=duration=4,setpts=PTS-STARTPTS",
  );
  expect(args.filter((each) => each === "-an")).toHaveLength(3);
});

test("a crossfade lead of one beat: the clip is cut one beat longer and xfade starts one beat before the cut", () => {
  expect(fadeSeconds(FOUR, 1, 0.5)).toBe(0.5);
  expect(fadeSeconds(FOUR, 0, 0.5)).toBe(0);
  expect(fadeSeconds(FOUR, 2, 0.5)).toBe(0);
  const { graph } = renderArgs(spec(FOUR), "o.mp4");
  // The ramp shortens the source, but the segment still lasts the slot plus the lead: 4.5 s.
  expect(graph).toContain("xfade=transition=fade:duration=0.5:offset=3.5");
  expect(graph).toContain("[s0][s1]xfade");
  // The cut into shot 3 is a concat; shot 4 is a black segment.
  expect(graph).toContain("[j1][s2]concat=n=2:v=1:a=0");
  expect(graph).toContain("color=c=black:s=1920x1080:r=30:d=4,setsar=1");
  expect(graph).toContain("[j2][s3]concat=n=2:v=1:a=0");
});

test("a crossfade is shorter than a beat when a neighbour is shorter, and a tiny one is a cut", () => {
  const short = [slot(0, { endSec: 0.3 }), slot(1, { startSec: 0.3, transition: "crossfade" })];
  expect(fadeSeconds(short, 1, 0.5)).toBeCloseTo(0.3);
  const tiny = [slot(0, { endSec: 0.03 }), slot(1, { startSec: 0.03, transition: "crossfade" })];
  expect(fadeSeconds(tiny, 1, 0.5)).toBe(0);
});

test("a flash is a white pulse on the beat of the cut, fading out over half a beat", () => {
  const { graph } = renderArgs(spec(FOUR), "o.mp4");
  expect(graph).toContain(
    "color=c=white:s=1920x1080:r=30:d=0.25,format=yuva420p,fade=t=out:st=0:d=0.25:alpha=1,setpts=PTS-STARTPTS+8/TB[f2]",
  );
  expect(graph).toContain("overlay=eof_action=pass:format=yuv420[x2]");
});

test("a speed ramp plays the last bar at a speed falling from 100% to 50% and takes less source", () => {
  const { head, tail, source } = rampSource(4.5, 2);
  expect(head).toBeCloseTo(2.5);
  expect(tail).toBeCloseTo(2 / (2 * Math.LN2));
  expect(source).toBeCloseTo(2.5 + Math.LOG2E, 3);
  expect(rampExpression(2.5, tail)).toBe(
    `'if(lt(T,2.5),PTS,(2.5-${Math.round(2 * tail * 1000) / 1000}*log(1-(T-2.5)/${Math.round(2 * tail * 1000) / 1000}))/TB)'`,
  );
  const { graph } = renderArgs(spec(FOUR), "o.mp4");
  expect(graph).toContain("trim=duration=3.943,setpts='if(lt(T,2.5)");
});

test("the overlay fallback lays each clip on a black canvas as long as the edit, a crossfade fading in by its alpha", () => {
  const built = renderArgs(spec(FOUR, { xfade: false }), "o.mp4");
  const { graph } = built;
  expect(graph).toContain("color=c=black:s=1920x1080:r=30:d=16,format=yuv420p[base]");
  expect(graph).toContain(
    "format=yuva420p,fade=t=in:st=0:d=0.5:alpha=1,setpts=PTS-STARTPTS+3.5/TB[o1]",
  );
  expect(graph).toContain("[base][o0]overlay=eof_action=pass:format=yuv420[l0]");
  expect(graph).toContain("setpts=PTS-STARTPTS+8/TB[o2]");
  // The black shot adds no overlay: the canvas shows through.
  expect(graph).not.toContain("[o3]");
  expect(graph).not.toContain("xfade");
  expect(graph.endsWith("format=yuv420p[vout]")).toBe(true);
});

test("captions are burned in with an escaped path, and the vertical cut crops the centre of the frame and starts the audio part-way", () => {
  const vertical = renderArgs(
    spec([slot(0), slot(1)], {
      width: 1080,
      height: 1920,
      captions: "C:\\a b\\it's.ass",
      audio: { file: "m.wav", fromSec: 12.5 },
    }),
    "v.mp4",
  );
  expect(vertical.graph).toContain(
    "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
  );
  expect(vertical.graph).toContain("ass=filename=C\\\\:\\\\\\\\a b\\\\\\\\it\\\\\\'s.ass");
  const at = vertical.args.indexOf("-ss");
  expect(vertical.args.slice(at, at + 3)).toEqual(["-ss", "12.5", "-i"]);
  expect(escapeFilterValue("a:b")).toBe("a\\\\:b");
});

test("no soundtrack means no audio input, map or codec", () => {
  const built = renderArgs(spec([slot(0)], { audio: null }), "o.mp4");
  expect(built.args).not.toContain("aac");
  expect(built.args.filter((each) => each === "-map")).toHaveLength(1);
});

test("the filter list says whether this ffmpeg has xfade, ass and the rest", () => {
  const listing = [
    "Filters:",
    "  T.. = Timeline support",
    " ... ass               V->V       Render ASS subtitles onto input video using the libass library.",
    " TSC overlay           VV->V      Overlay a video source on top of the input.",
    " ... xfade             VV->V      Cross fade one video with another video.",
  ].join("\n");
  const names = filterNames(listing);
  expect(names.has("xfade")).toBe(true);
  expect(names.has("ass")).toBe(true);
  expect(names.has("overlay")).toBe(true);
  expect(names.has("Timeline")).toBe(false);
});

/* Real ffmpeg: tiny synthetic sources, the overlay fallback (what 4.2 runs). */

const folder = mkdtempSync(join(tmpdir(), "music-studio-timeline-"));
const clipFile = join(folder, "clip.mp4");

async function probe(path: string): Promise<{ seconds: number; audio: number; log: string }> {
  const ran = await runFfmpeg("ffmpeg", ["-hide_banner", "-i", path, "-f", "null", "-"]);
  if (!ran.ok) throw new Error(ran.message);
  const match = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(ran.log);
  const seconds =
    match === null ? 0 : Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  // Only the input's own streams: the null output lists its streams too.
  const input = ran.log.split("Output #0")[0] ?? "";
  return { seconds, audio: (input.match(/Audio:/g) ?? []).length, log: ran.log };
}

/** The mean brightness (0 to 255) of the frame at `at` seconds. */
async function brightness(path: string, at: number): Promise<number> {
  const ran = await runFfmpegBytes("ffmpeg", [
    "-v",
    "error",
    "-ss",
    String(at),
    "-i",
    path,
    "-frames:v",
    "1",
    "-vf",
    "scale=1:1",
    "-pix_fmt",
    "gray",
    "-f",
    "rawvideo",
    "-",
  ]);
  if (!ran.ok) throw new Error(ran.message);
  return ran.bytes[0] ?? -1;
}

const small = (slots: Slot[], over: Partial<TimelineSpec> = {}): TimelineSpec => ({
  ...spec(slots, {
    xfade: false,
    width: 160,
    height: 90,
    beatSec: 0.25,
    preset: "ultrafast",
    crf: 35,
    threads: 1,
  }),
  ...over,
});

const ONE_SECOND = (at: number, over: Partial<Slot> = {}): Slot => ({
  shot: `0000000${at}`,
  startSec: at,
  endSec: at + 1,
  clip: clipFile,
  transition: "cut",
  speed: "normal",
  ...over,
});

test("this ffmpeg has no xfade and the fallback is chosen from what it says", async () => {
  const caps = await probeCaps("ffmpeg");
  expect(caps.ok).toBe(true);
  if (!caps.ok) return;
  const listing = await runFfmpeg("ffmpeg", ["-hide_banner", "-filters"]);
  expect(caps.xfade).toBe(listing.ok && filterNames(listing.output).has("xfade"));
  expect(caps.x264).toBe(true);
});

test("the fallback renders a real edit: cuts, a black gap, a ramped crossfade, a flash, the master as the only sound", async () => {
  await makeClip(clipFile, 3);
  const audio = join(folder, "master.wav");
  writeFileSync(audio, wav(5));
  const slots = [
    ONE_SECOND(0),
    ONE_SECOND(1, { clip: null }),
    ONE_SECOND(2, { transition: "crossfade", speed: "ramp" }),
    ONE_SECOND(3, { transition: "flash" }),
  ];
  const out = join(folder, "edit.mp4");
  const built = renderArgs(small(slots, { audio: { file: audio, fromSec: 0 } }), out);
  const ran = await runFfmpeg("ffmpeg", built.args);
  if (!ran.ok) throw new Error(`${ran.message}\n${built.graph}`);
  const seen = await probe(out);
  expect(seen.seconds).toBeCloseTo(4, 1);
  expect(seen.audio).toBe(1);
  expect(built.gaps).toBe(1);
  // The shot with no clip is black; the shot before it is not.
  expect(await brightness(out, 0.5)).toBeGreaterThan(40);
  expect(await brightness(out, 1.5)).toBeLessThan(20);
  // The flash is white on the beat of the cut at 3 s, then gone.
  expect(await brightness(out, 3.02)).toBeGreaterThan(200);
  expect(await brightness(out, 3.7)).toBeLessThan(200);
});

test("a caption file in a folder with an apostrophe and a space in its name is read by the ass filter", async () => {
  const odd = join(folder, "it's a folder");
  mkdirSync(odd, { recursive: true });
  const ass = join(odd, "captions.ass");
  writeFileSync(
    ass,
    assKaraoke(parseWords([{ word: "Hi", start_ms: 100, end_ms: 800 }]), {
      width: 160,
      height: 90,
    }) ?? "",
  );
  const out = join(folder, "captions.mp4");
  const built = renderArgs(small([ONE_SECOND(0)], { captions: ass, audio: null }), out);
  const ran = await runFfmpeg("ffmpeg", built.args);
  if (!ran.ok) throw new Error(`${ran.message}\n${built.graph}`);
  expect((await probe(out)).seconds).toBeCloseTo(1, 1);
});

test("a clip shorter than its shot is held on its last frame", async () => {
  const out = join(folder, "held.mp4");
  const built = renderArgs(small([{ ...ONE_SECOND(0), endSec: 5 }], { audio: null }), out);
  const ran = await runFfmpeg("ffmpeg", built.args);
  if (!ran.ok) throw new Error(`${ran.message}\n${built.graph}`);
  expect((await probe(out)).seconds).toBeCloseTo(5, 1);
  expect(await brightness(out, 4.5)).toBeGreaterThan(40);
});

test("the vertical cut crops the centre of the 16:9 frame to 9:16", async () => {
  const out = join(folder, "vertical.mp4");
  const built = renderArgs(small([ONE_SECOND(0)], { width: 90, height: 160, audio: null }), out);
  const ran = await runFfmpeg("ffmpeg", built.args);
  if (!ran.ok) throw new Error(`${ran.message}\n${built.graph}`);
  expect((await probe(out)).log).toContain("90x160");
});
