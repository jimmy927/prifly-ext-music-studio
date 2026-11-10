/**
 * The confirm card for the heavy renders. Nothing is paid, but a 1080p render
 * keeps the processor busy for minutes, so the reader is told how long (a
 * rough guess) and that the machine will be loaded, and may say no. The 540p
 * preview is light and asks nothing.
 */

import { askReader } from "../confirm";
import type { Confirm } from "../jobs";
import type { RenderKind } from "../project/video-media";
import type { Studio } from "../studio";
import { FINAL_SIZE, VERTICAL_SIZE } from "./constants";
import { durationWords, estimateSeconds } from "./render";

export function renderCard(kind: Exclude<RenderKind, "preview">, videoSec: number): Confirm {
  const size = kind === "final" ? FINAL_SIZE : VERTICAL_SIZE;
  const seconds = estimateSeconds(kind, videoSec);
  const name = kind === "final" ? "the 1080p music video" : "the 9:16 vertical cut";
  return {
    title: kind === "final" ? "Render 1080p" : "Render the vertical cut",
    summary: `Render ${name} (${Math.round(videoSec)} seconds of video, ${size.width}×${size.height}) on this computer. Estimated time: ${durationWords(seconds)}, a rough guess. It will keep the processor busy while it runs, so the computer will be slower for other work. You can cancel it from the panel. It costs nothing.`,
    details: `ffmpeg, libx264 veryfast crf 20, AAC 192k, ${size.width}x${size.height} at 30 fps, soundtrack from the master`,
  };
}

/** Asks the reader; a sentence when the card could not be shown, true or false when it was answered. */
export async function askToRender(
  studio: Studio,
  kind: Exclude<RenderKind, "preview">,
  videoSec: number,
): Promise<boolean | string> {
  const answer = await askReader(studio.api(), renderCard(kind, videoSec), "Render");
  return answer ?? "This prifly cannot ask you first. Update prifly.";
}
