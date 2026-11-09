/** The shapes the stage routes answer with, so the page and the routes agree. Types only. */

import type { Section } from "../arrange/plan";
import type { TrackMix } from "../audio/mixgraph";
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
