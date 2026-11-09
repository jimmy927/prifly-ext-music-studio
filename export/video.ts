/**
 * Deliver's two video items: "Music video" (the newest 1080p render from the
 * Edit stage, H.264 with the master as its soundtrack, copied into the
 * folder) and "Vertical cut" (the 9:16 render of the chorus or the chosen
 * range, about 30 seconds, captions on, centre crop; rendered now).
 */

import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import type { IndexEntry } from "../project/store";
import { latestRender, readRenders } from "../project/video-media";
import type { Studio } from "../studio";
import { renderProject } from "../video/render";
import { sanitiseFileName } from "./names";

type Target = {
  studio: Studio;
  entry: IndexEntry;
  dir: string;
  out: string;
  signal: AbortSignal;
  files: string[];
  notes: string[];
};

/** Copies the newest 1080p render. */
export async function musicVideo(run: Target): Promise<void> {
  const render = latestRender(await readRenders(run.dir), "final");
  if (render === null) {
    run.notes.push(
      "Music video: there is no 1080p render yet. Render 1080p on the Edit stage first.",
    );
    return;
  }
  const target = join(run.out, `${sanitiseFileName(run.entry.title)} music video.mp4`);
  await copyFile(join(run.dir, render.file), target);
  run.files.push(target);
  if (render.gaps > 0)
    run.notes.push(
      `Music video: ${render.gaps} shot${render.gaps === 1 ? "" : "s"} had no clip and are black.`,
    );
}

/** Renders the vertical cut and copies it. */
export async function verticalCut(run: Target): Promise<void> {
  const done = await renderProject(run.studio, run.entry, { kind: "vertical", signal: run.signal });
  if (!done.ok) throw new Error(done.message);
  const target = join(run.out, `${sanitiseFileName(run.entry.title)} vertical.mp4`);
  await copyFile(done.path, target);
  run.files.push(target);
  run.notes.push(...done.warnings.map((each) => `Vertical cut: ${each}`));
}
