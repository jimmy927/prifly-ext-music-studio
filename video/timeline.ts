/**
 * The edit as an ffmpeg command. The shot list says where every shot sits on
 * the beat grid, the edit says how it comes in (cut, flash, crossfade of one
 * beat) and how fast it plays (normal, or a ramp down to 50% at the end), and
 * this turns that into one `-filter_complex` graph.
 *
 * Every clip is trimmed to its shot, scaled to cover the frame, given the
 * same frame rate, and muted (`-an` before its input; the only sound is the
 * soundtrack). A shot with no clip is a black segment, so the edit still
 * lasts as long as the song. A crossfade starts one beat before the cut and
 * ends on it, so every cut stays on its beat.
 *
 * Two ways to join the segments give the same picture. With `xfade` (ffmpeg
 * 4.3 and later) the segments are chained with `xfade` and `concat`. Without
 * it (the 4.2 this was written against) a black canvas as long as the song is
 * overlaid with each segment at its time, a crossfading one fading in by its
 * alpha over what is already there.
 */

import { BEATS_PER_BAR } from "../prep/grid";
import type { Speed, Transition } from "../project/video-media";

export type Slot = {
  shot: string;
  startSec: number;
  endSec: number;
  /** The clip's file, or null when the shot has not been shot. */
  clip: string | null;
  transition: Transition;
  speed: Speed;
};

export type TimelineSpec = {
  slots: Slot[];
  width: number;
  height: number;
  fps: number;
  /** Seconds in a beat. */
  beatSec: number;
  /** The soundtrack, and where in it the video starts (the vertical cut starts part-way). */
  audio: { file: string; fromSec: number } | null;
  /** A `.ass` file to burn in. */
  captions: string | null;
  xfade: boolean;
  preset: "ultrafast" | "veryfast" | "medium";
  crf: number;
  threads: number | null;
};

export type Built = {
  args: string[];
  graph: string;
  /** The clip files in input order. */
  inputs: string[];
  /** Shots rendered black because they have no clip. */
  gaps: number;
  totalSec: number;
};

const num = (value: number): string => String(Math.round(value * 1000) / 1000);

/** Escapes a value for a filter option, once for the option and once for the graph (ffmpeg's two levels). */
export function escapeFilterValue(value: string): string {
  return value.replace(/[\\':]/g, "\\$&").replace(/[\\'[\],;]/g, "\\$&");
}

/** The length of a crossfade into slot `at`: one beat, or less where a neighbour is shorter; 0 for a cut. */
export function fadeSeconds(slots: Slot[], at: number, beatSec: number): number {
  const slot = slots[at];
  const before = slots[at - 1];
  if (slot === undefined || before === undefined || slot.transition !== "crossfade") return 0;
  const d = Math.min(beatSec, slot.endSec - slot.startSec, before.endSec - before.startSec);
  return d < 0.05 ? 0 : d;
}

/**
 * The ramp: the last bar of a shot (at most half of it) plays at a speed that
 * falls linearly from 100% to 50%. Slowing source seconds `r` that way takes
 * `2 r ln 2` output seconds, so the ramp needs fewer source seconds than the
 * shot is long: `head` seconds at full speed, then `tail` that are slowed.
 */
export function rampSource(
  length: number,
  barSec: number,
): { head: number; tail: number; source: number } {
  const out = Math.min(length / 2, barSec);
  const tail = out / (2 * Math.LN2);
  const head = length - out;
  return { head, tail, source: head + tail };
}

/**
 * The `setpts` expression of a ramp. Speed falls linearly from 1 to 1/2 over
 * the last `tail` source seconds, so a source time `t` past `head` plays at
 * `head - 2 * tail * ln(1 - (t - head) / (2 * tail))`.
 */
export function rampExpression(head: number, tail: number): string {
  const h = num(head);
  const t2 = num(2 * tail);
  return `'if(lt(T,${h}),PTS,(${h}-${t2}*log(1-(T-${h})/${t2}))/TB)'`;
}

type Segment = {
  index: number;
  /** Output seconds the segment lasts, the crossfade's lead-in included. */
  length: number;
  /** Seconds before the slot's start it begins (the crossfade lead-in). */
  lead: number;
  chain: string;
  fade: boolean;
};

function frameFit(spec: TimelineSpec): string {
  const { width, height } = spec;
  return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${spec.fps}`;
}

/** The chain that makes one clip fit its slot. `input` is the ffmpeg input number. */
function clipChain(spec: TimelineSpec, slot: Slot, input: number, length: number): string {
  const ramp = slot.speed === "ramp" ? rampSource(length, BEATS_PER_BAR * spec.beatSec) : null;
  const source = ramp?.source ?? length;
  const speed =
    ramp === null ? "setpts=PTS-STARTPTS" : `setpts=${rampExpression(ramp.head, ramp.tail)}`;
  return [
    `[${input}:v]setpts=PTS-STARTPTS`,
    `tpad=stop_mode=clone:stop_duration=${num(source)}`,
    `trim=duration=${num(source)}`,
    speed,
    frameFit(spec),
  ].join(",");
}

function blackChain(spec: TimelineSpec, length: number): string {
  return `color=c=black:s=${spec.width}x${spec.height}:r=${spec.fps}:d=${num(length)},setsar=1`;
}

function segmentsOf(spec: TimelineSpec, inputs: string[]): Segment[] {
  const out: Segment[] = [];
  for (const [index, slot] of spec.slots.entries()) {
    const lead = fadeSeconds(spec.slots, index, spec.beatSec);
    const length = slot.endSec - slot.startSec + lead;
    let chain: string;
    if (slot.clip === null) chain = blackChain(spec, length);
    else {
      inputs.push(slot.clip);
      chain = clipChain(spec, slot, inputs.length - 1, length);
    }
    out.push({ index, length, lead, chain, fade: lead > 0 });
  }
  return out;
}

const withFormat = (chain: string, format: string): string => `${chain},format=${format}`;

/** Joins the segments with xfade and concat; returns the graph lines and the last label. */
function joinChained(spec: TimelineSpec, segments: Segment[]): { lines: string[]; last: string } {
  const lines: string[] = [];
  const tail = `settb=1/${spec.fps},fps=${spec.fps}`;
  for (const seg of segments)
    lines.push(`${withFormat(seg.chain, "yuv420p")},${tail}[s${seg.index}]`);
  let acc = "s0";
  let accSec = segments[0]?.length ?? 0;
  for (const seg of segments.slice(1)) {
    const name = `j${seg.index}`;
    const join = seg.fade
      ? `[${acc}][s${seg.index}]xfade=transition=fade:duration=${num(seg.lead)}:offset=${num(accSec - seg.lead)}`
      : `[${acc}][s${seg.index}]concat=n=2:v=1:a=0`;
    lines.push(`${join},${tail}[${name}]`);
    accSec += seg.length - seg.lead;
    acc = name;
  }
  return { lines, last: acc };
}

/** Lays the segments on a black canvas as long as the edit, each at its time. */
function joinLayered(
  spec: TimelineSpec,
  segments: Segment[],
  totalSec: number,
): { lines: string[]; last: string } {
  const lines = [
    `color=c=black:s=${spec.width}x${spec.height}:r=${spec.fps}:d=${num(totalSec)},format=yuv420p[base]`,
  ];
  let acc = "base";
  for (const seg of segments) {
    const slot = spec.slots[seg.index];
    if (slot === undefined || slot.clip === null) continue;
    const at = slot.startSec - seg.lead;
    const fade = seg.fade ? `,fade=t=in:st=0:d=${num(seg.lead)}:alpha=1` : "";
    const format = seg.fade ? "yuva420p" : "yuv420p";
    lines.push(
      `${withFormat(seg.chain, format)}${fade},setpts=PTS-STARTPTS+${num(at)}/TB[o${seg.index}]`,
    );
    const name = `l${seg.index}`;
    lines.push(`[${acc}][o${seg.index}]overlay=eof_action=pass:format=yuv420[${name}]`);
    acc = name;
  }
  return { lines, last: acc };
}

/** A white flash on the beat of each cut that asks for one: fully white at the cut, fading out over half a beat. */
function flashes(spec: TimelineSpec, from: string): { lines: string[]; last: string } {
  const lines: string[] = [];
  let acc = from;
  const length = Math.min(spec.beatSec / 2, 0.3);
  for (const [index, slot] of spec.slots.entries()) {
    if (index === 0 || slot.transition !== "flash") continue;
    lines.push(
      `color=c=white:s=${spec.width}x${spec.height}:r=${spec.fps}:d=${num(length)},format=yuva420p,fade=t=out:st=0:d=${num(length)}:alpha=1,setpts=PTS-STARTPTS+${num(slot.startSec)}/TB[f${index}]`,
      `[${acc}][f${index}]overlay=eof_action=pass:format=yuv420[x${index}]`,
    );
    acc = `x${index}`;
  }
  return { lines, last: acc };
}

/** The filter graph and the clip inputs of a timeline. */
export function buildGraph(spec: TimelineSpec): Built {
  const inputs: string[] = [];
  const segments = segmentsOf(spec, inputs);
  const totalSec = spec.slots.at(-1)?.endSec ?? 0;
  const joined = spec.xfade ? joinChained(spec, segments) : joinLayered(spec, segments, totalSec);
  const flashed = flashes(spec, joined.last);
  const lines = [...joined.lines, ...flashed.lines];
  const tail =
    spec.captions === null
      ? `[${flashed.last}]format=yuv420p[vout]`
      : `[${flashed.last}]ass=filename=${escapeFilterValue(spec.captions)},format=yuv420p[vout]`;
  return {
    args: [],
    graph: [...lines, tail].join(";"),
    inputs,
    gaps: spec.slots.filter((each) => each.clip === null).length,
    totalSec,
  };
}

/** The arguments (after the program name) that render `spec` to `out`. */
export function renderArgs(spec: TimelineSpec, out: string): Built {
  const built = buildGraph(spec);
  const audioIndex = built.inputs.length;
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    ...(spec.threads === null ? [] : ["-threads", String(spec.threads)]),
    ...built.inputs.flatMap((file) => ["-an", "-i", file]),
    ...(spec.audio === null
      ? []
      : [
          ...(spec.audio.fromSec > 0 ? ["-ss", num(spec.audio.fromSec)] : []),
          "-i",
          spec.audio.file,
        ]),
    "-filter_complex",
    built.graph,
    "-map",
    "[vout]",
    ...(spec.audio === null ? [] : ["-map", `${audioIndex}:a`]),
    "-c:v",
    "libx264",
    "-preset",
    spec.preset,
    "-crf",
    String(spec.crf),
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(spec.fps),
    ...(spec.audio === null ? [] : ["-c:a", "aac", "-b:a", "192k", "-ar", "44100"]),
    "-t",
    num(built.totalSec),
    "-movflags",
    "+faststart",
    out,
  ];
  return { ...built, args };
}
