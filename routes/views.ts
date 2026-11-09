/** The shapes the stage routes answer with, so the page and the routes agree. Types only. */

import type { Section } from "../arrange/plan";
import type { FormatId, Loudness, Target, TargetId } from "../audio/loudness";
import type { TrackMix } from "../audio/mixgraph";
import type { Cue, Grid } from "../prep/grid";
import type { TrackInfo } from "../project/tracks";
import type { Job } from "../studio";

export type VersionItem = {
  id: string;
  n: number;
  from: string;
  counts: { kept: number; changed: number; inserted: number; deleted: number };
  created: string;
  sectionCount: number;
  durationMs: number;
};

export type ArrangeView = {
  available: boolean;
  /** Why Arrange is off, when it is. */
  reason: string | null;
  base: { label: string; from: string; sections: Section[] } | null;
  tempo: number;
  active: string | null;
  versions: VersionItem[];
};

export type LayerItem = {
  id: string;
  prompt: string;
  startBar: number;
  lengthSec: number;
  loop: boolean;
};

export type ProduceView = {
  source: { id: string; label: string } | null;
  stemSource: string | null;
  tempo: number;
  stems: { name: string }[];
  layers: LayerItem[];
};

export type MixTrack = TrackInfo & { mix: TrackMix };

export type MixView = {
  ffmpeg: { ok: boolean; message: string };
  tempo: number;
  stemSource: string | null;
  tracks: MixTrack[];
  renders: { n: number; file: string }[];
};

export type FfmpegState = { ok: boolean; message: string };

export type MasterItem = {
  n: number;
  file: string;
  target: TargetId;
  format: FormatId;
  from: string;
  input: Loudness;
  output: Loudness | null;
  type: string;
  created: string;
};

export type MasterView = {
  ffmpeg: FfmpegState;
  source: { kind: "mix" | "version" | "sketch"; id: string; label: string; lossy: boolean } | null;
  lossyNote: string;
  loudness: Loudness | null;
  measureError: string | null;
  targets: Target[];
  formats: { id: FormatId; label: string }[];
  masters: MasterItem[];
};

export type PrepKeyInfo = { name: string; camelot: string; tonality: string };

export type PrepDescribed = {
  source: { kind: "master" | "mix" | "version" | "sketch"; id: string; label: string };
  analysis: {
    bpm: number | null;
    strength: number;
    key: PrepKeyInfo | null;
    energy: number;
    lufs: number | null;
    truePeak: number | null;
    durationSec: number;
    analysedAt: string;
  };
  grid: Grid | null;
  manualBpm: boolean;
  cues: Cue[];
  loop: { startSec: number; bars: number; endSec: number } | null;
  compatible: { code: string; relation: string; name: string }[];
};

export type PrepareView = {
  ffmpeg: FfmpegState;
  source: { kind: string; id: string; label: string } | null;
  /** The newest master or mix is not the file that was analysed. */
  stale: boolean;
  prep: PrepDescribed | null;
  peaks: { perSec: number; peaks: number[] } | null;
  hasPlan: boolean;
  crates: { id: string; name: string; has: boolean }[];
};

export type PrepEdit = { ok: true; prep: PrepDescribed } | { ok: false; message: string };

export type DeliverView = {
  ffmpeg: FfmpegState;
  title: string;
  folder: string;
  stems: number;
  master: { n: number; format: string } | null;
  prepared: boolean;
  cues: number;
  loop: boolean;
  video: {
    /** The newest 1080p render; `stale` when the edit has changed since. */
    render: { n: number; seconds: number; stale: boolean } | null;
    /** Shots with a clip: the vertical cut needs some. */
    clips: number;
    verticalSec: number | null;
    /** The song has sung words to caption. */
    captions: boolean;
  };
  crates: { id: string; name: string; count: number }[];
};

/** What a finished deliver job's `result` holds, as JSON. */
export type DeliverOutcome = { dir: string; files: string[]; notes: string[] };

/** The answer to a request that may start a paid run. */
export type StartAnswer =
  | { ok: true; job: Job }
  | {
      ok: false;
      reason: "invalid" | "no_key" | "cancelled" | "unsupported" | "failed";
      message: string;
    };

export type MixAnswer =
  | { ok: true; n: number; file: string }
  | { ok: false; reason: "no_tracks" | "silent" | "no_ffmpeg" | "failed"; message: string };
