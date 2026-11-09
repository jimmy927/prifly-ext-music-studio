/**
 * Everything about the video stages that is a number or a name: the models, the
 * limits Google documents for them and the prices, in one place so a change of
 * price is one edit. The page bundles this file too, so it imports nothing of
 * the server's.
 *
 * The prices are ESTIMATES. They come from Google's pricing page
 * (https://aistudio.google.com/docs/pricing, read 2026-11-09): Gemini Omni 1.2
 * Flash bills video output by token, at 5,792 tokens per second of 720p video
 * and $12 per 1M tokens, which the page itself rounds to about $0.07 a second;
 * Gemini 3.1 Flash Image bills $0.067 for a 1K image. Input tokens are a few
 * cents at most and are not counted. The panel and the confirm cards call
 * every dollar figure an estimate, and the real bill is Google's.
 */

export const IMAGE_MODEL = "gemini-3.1-flash-image";
export const VIDEO_MODEL = "gemini-omni-1.2-flash";

/** Seconds of video a single Omni call may make (whole seconds). */
export const MIN_CLIP_SEC = 3;
export const MAX_CLIP_SEC = 15;

/** Reference images in one Omni call, and in a treatment's cast. */
export const MAX_REFERENCES = 6;
export const MAX_CAST = 6;

export type Resolution = "360p" | "720p" | "1080p";

/** Dollars per second of generated video, by output resolution. */
export const VIDEO_USD_PER_SECOND: Record<Resolution, number> = {
  "360p": 0.023,
  "720p": 0.07,
  "1080p": 0.104,
};

/** What the clips are asked for. The edit scales them up to 1080p, which costs nothing. */
export const SHOOT_RESOLUTION: Resolution = "720p";

/** Dollars for one 1K still frame or cast picture. */
export const IMAGE_USD = 0.067;

export const DEFAULT_BUDGET_USD = 25;
export const MAX_TAKES_PER_SHOT = 4;

/** Bars per shot the treatment offers. */
export const SHOT_BARS = [2, 4, 8] as const;
export type ShotBars = (typeof SHOT_BARS)[number];
export const DEFAULT_SHOT_BARS: ShotBars = 4;

/** The frame rate of every render, and the sizes of the two render modes. */
export const FPS = 30;
export const PREVIEW_SIZE = { width: 960, height: 540 } as const;
export const FINAL_SIZE = { width: 1920, height: 1080 } as const;
export const VERTICAL_SIZE = { width: 1080, height: 1920 } as const;

/** Roughly how long the vertical cut is, in seconds. */
export const VERTICAL_TARGET_SEC = 30;

/** The largest video file `api/media` sends to the page, in bytes (it goes as base64 in JSON). */
export const MAX_MEDIA_BYTES = 12 * 1024 * 1024;

export const money = (usd: number): string => `$${usd.toFixed(2)}`;

export const ESTIMATE_NOTE = "An estimate from Google's published prices; the bill is Google's.";
