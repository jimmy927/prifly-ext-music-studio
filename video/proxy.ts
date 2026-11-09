/**
 * Small MP4 stand-ins for the page. Video reaches the page as base64 in JSON,
 * so a 15-second clip is shown as a 360p copy without sound (about a
 * megabyte), made once and kept beside the clip. The renders are never sent:
 * the preview is already 540p, the others are refused.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { runFfmpeg } from "../audio/ffmpeg";
import type { Studio } from "../studio";

/** The proxy of a clip (relative path), made if it is not there yet. */
export async function proxyOf(
  studio: Studio,
  dir: string,
  file: string,
): Promise<{ ok: true; file: string } | { ok: false; message: string }> {
  const proxy = file.replace(/\.mp4$/, ".proxy.mp4");
  try {
    await stat(join(dir, proxy));
    return { ok: true, file: proxy };
  } catch {
    // Not made yet.
  }
  const ran = await runFfmpeg(studio.ffmpeg(), [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    join(dir, file),
    "-an",
    "-vf",
    "scale=-2:360",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "32",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    join(dir, proxy),
  ]);
  return ran.ok ? { ok: true, file: proxy } : { ok: false, message: ran.message };
}
