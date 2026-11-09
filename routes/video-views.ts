/** The shapes the Video stages' routes answer with, so the page and the routes agree. Types only. */

import type { Job } from "../studio";
import type { ShotBars } from "../video/constants";
import type { Shot, ShotList } from "../video/shotlist";

export type FfmpegState = { ok: boolean; message: string };

/** What the budget shows on every Video stage. */
export type MoneyView = {
  budgetUsd: number;
  spentUsd: number;
  remainingUsd: number;
  /** The project has its own budget, not the extension setting's. */
  own: boolean;
};

export type CastView = {
  id: string;
  name: string;
  prompt: string;
  source: "generated" | "file";
};

export type TreatmentView = {
  geminiKey: boolean;
  /** The tempo Prepare found or was given; the video stages wait for one. */
  tempo: number | null;
  treatment: {
    concept: string;
    look: string;
    vertical: boolean;
    shotBars: ShotBars;
    cast: CastView[];
  };
  money: MoneyView;
  prices: { imageUsd: number; videoPerSecondUsd: number; resolution: string };
};

export type ShotView = Shot & {
  number: number;
  bars: number;
  seconds: number;
  clipSeconds: number;
};

export type StoryboardView = {
  geminiKey: boolean;
  tempo: number | null;
  list: (Omit<ShotList, "shots"> & { shots: ShotView[] }) | null;
  problems: string[];
  money: MoneyView;
  /** Frames still to draw, and what they cost. */
  missing: { count: number; usd: number };
  /** Drafting again would discard frames, takes, approvals or written text. */
  hasWork: boolean;
  castCount: number;
};

export type TakeView = {
  id: string;
  n: number;
  status: "pending" | "done" | "failed";
  reason: string | null;
  failure: string | null;
  seconds: number;
  usd: number;
  chosen: boolean;
};

export type ShootShot = ShotView & { takes: TakeView[] };

export type ShootView = {
  geminiKey: boolean;
  tempo: number | null;
  shots: ShootShot[];
  money: MoneyView;
  /** The approved shots with no clip yet, and what one take of each costs. */
  waiting: { count: number; usd: number };
  /** Takes whose call Google accepted but whose clip was not fetched (the extension stopped meanwhile). */
  orphans: number;
  prices: { videoPerSecondUsd: number; resolution: string };
};

export type SlotView = {
  shot: string;
  number: number;
  section: string;
  startSec: number;
  endSec: number;
  startBar: number;
  bars: number;
  hasClip: boolean;
  transition: "cut" | "flash" | "crossfade";
  speed: "normal" | "ramp";
  /** The image of the shot's frame, for the video lane's thumbnail. */
  frame: string | null;
};

export type RenderView = {
  n: number;
  kind: "preview" | "final" | "vertical";
  seconds: number;
  captions: boolean;
  gaps: number;
  /** The edit has changed since this was rendered. */
  stale: boolean;
  created: string;
};

export type EditView = {
  ffmpeg: FfmpegState;
  tempo: number | null;
  slots: SlotView[];
  totalSec: number;
  beatSec: number;
  gaps: number;
  warnings: string[];
  audio: { label: string; kind: string; id: string } | null;
  captions: { on: boolean; words: number; reason: string | null; burnable: boolean };
  /** ffmpeg joins with xfade (4.3 and later) or with overlays (earlier). */
  join: "xfade" | "overlay";
  vertical: { startSec: number; endSec: number; shots: number } | null;
  renders: { preview: RenderView | null; final: RenderView | null; vertical: RenderView | null };
  estimate: { finalSec: number; verticalSec: number };
};

/** What a finished render job's `result` holds, as JSON. */
export type RenderOutcome = {
  kind: "preview" | "final" | "vertical";
  n: number;
  seconds: number;
  warnings: string[];
};

export type JobsView = { jobs: Job[] };
