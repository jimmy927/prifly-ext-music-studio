/**
 * Source material (pictures and videos the song and the video start from):
 * which files count, how much of them is read, the model that reads them and
 * what that costs. The page bundles this file too, so it imports nothing of
 * the server's.
 *
 * The prices are ESTIMATES in the same spirit as video/constants.ts: Gemini
 * bills input by token (a 1024 px picture is about 1,100 tokens, audio about
 * 32 tokens a second) and these text-model calls come to a fraction of a cent
 * each. The confirm card says so; the bill is Google's.
 */

/** The Gemini model that looks at the pictures, frames and audio and writes the song and video ideas. */
export const ANALYSIS_MODEL = "gemini-3.1-flash";

export const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp"] as const;
export const VIDEO_EXTS = ["mp4", "mov", "m4v", "webm", "mkv", "avi"] as const;

/** The most files one call reads; a folder with more is cut here and the answer says so. */
export const MAX_SOURCES = 24;
/** Pictures per Gemini call. */
export const PICTURES_PER_CALL = 8;
/** Frames sampled from one video: one every `FRAME_EVERY_SEC`, spread over the clip when it is long, never more than `MAX_FRAMES`. */
export const FRAME_EVERY_SEC = 3;
export const MAX_FRAMES = 8;
export const FRAME_WIDTH = 640;
/** The audio track is measured and sent for its first minutes only. */
export const AUDIO_TEMPO_SEC = 120;
export const AUDIO_SEND_SEC = 60;
/** A picture over this size is scaled down to `PICTURE_EDGE` px before it is sent. */
export const PICTURE_RAW_MAX_BYTES = 1_500_000;
export const PICTURE_EDGE = 1024;
/** Files over this are left out. */
export const MAX_PICTURE_FILE_BYTES = 40 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Estimated dollars: a picture or frame, a minute of audio, and the fixed part of a call. */
export const PICTURE_USD = 0.0004;
export const AUDIO_MINUTE_USD = 0.0006;
export const CALL_USD = 0.002;
/** The call that turns every description into the brief, lyrics and video ideas. */
export const SYNTHESIS_USD = 0.006;

/** Video clips kept as shot references in a treatment. */
export const MAX_REFERENCES_KEPT = 12;

export type SourceKind = "image" | "video";

const extOf = (name: string): string => name.slice(name.lastIndexOf(".") + 1).toLowerCase();

/** What a file name is, from its extension; null for anything else. */
export function kindOf(name: string): SourceKind | null {
  if (!name.includes(".")) return null;
  const ext = extOf(name);
  if ((IMAGE_EXTS as readonly string[]).includes(ext)) return "image";
  return (VIDEO_EXTS as readonly string[]).includes(ext) ? "video" : null;
}

export const imageMimeOf = (name: string): string => {
  const ext = extOf(name);
  return ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
};
