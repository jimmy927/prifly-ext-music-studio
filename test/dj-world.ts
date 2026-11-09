/** Helpers for the Master, Prepare, Crates and Deliver tests: a project whose chosen sketch holds real, analysable audio. */

import { join } from "node:path";
import { type Answer, ask, chosenProject, finished, stageWorld } from "./stage-world";
import { A_MINOR, chords, clickTrack, pcmWav } from "./synth";
import type { World } from "./world";

/** A click track at `bpm` under an A-minor chord bed, as WAV bytes (22050 Hz mono). */
export function song(bpm = 120, seconds = 30, offset = 0.3): Uint8Array<ArrayBuffer> {
  const clicks = clickTrack(bpm, seconds, offset);
  const bed = chords(A_MINOR, seconds / 4, 1);
  return pcmWav(clicks.map((sample, at) => sample * 0.6 + (bed[at] ?? 0) * 0.6));
}

/** A project (three sketches, `a` chosen) whose sketch `a` is replaced by `audio`; returns its id and folder. */
export async function audioProject(
  w: World,
  audio: Uint8Array<ArrayBuffer> = song(),
): Promise<{ id: string; dir: string }> {
  const id = await chosenProject(w);
  const entry = await w.studio.store().find(id);
  if (entry === null) throw new Error("no project");
  const dir = w.studio.store().pathOf(entry);
  await Bun.write(join(dir, "sketches", "a.mp3"), audio);
  return { id, dir };
}

export const dj = (options: Parameters<typeof stageWorld>[0] = {}) => stageWorld(options);

/** Starts a local job through a route and waits for it. */
export async function localJob(w: World, path: string, body: unknown) {
  const answer = (await ask(w, path, {}, body)) as Answer;
  if (!answer.ok) throw new Error(answer.message);
  return await finished(w, answer.job.id);
}
