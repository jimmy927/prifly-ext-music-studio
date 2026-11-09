/** "Render mix": the stems and layers with the saved levels, through ffmpeg, into `mix/mix-N.wav`. Local, free, no confirm card. */

import { join } from "node:path";
import { barStartMs } from "../audio/bars";
import { probeFfmpeg, runFfmpeg } from "../audio/ffmpeg";
import { DEFAULT_TRACK, type MixInput, type MixSettings, mixArgv } from "../audio/mixgraph";
import { nextMix, readMix } from "../project/stage";
import type { IndexEntry } from "../project/store";
import { tracksOf } from "../project/tracks";
import type { Studio } from "../studio";

export type MixRender =
  | { ok: true; n: number; file: string; path: string }
  | { ok: false; reason: "no_tracks" | "silent" | "no_ffmpeg" | "failed"; message: string };

/** What ffmpeg is given for the project's tracks under `settings`. */
export async function mixInputs(
  studio: Studio,
  entry: IndexEntry,
  settings: MixSettings,
): Promise<MixInput[]> {
  const store = studio.store();
  const { tempo, tracks } = await tracksOf(store, entry);
  return tracks.map((each) => ({
    ...(settings.tracks[each.key] ?? DEFAULT_TRACK),
    key: each.key,
    file: join(store.pathOf(entry), each.file),
    startMs: each.startBar === null ? 0 : barStartMs(each.startBar, tempo),
  }));
}

export async function renderMix(
  studio: Studio,
  entry: IndexEntry,
  settings?: MixSettings,
  signal?: AbortSignal,
): Promise<MixRender> {
  const dir = studio.store().pathOf(entry);
  const inputs = await mixInputs(studio, entry, settings ?? (await readMix(dir)));
  if (inputs.length === 0)
    return {
      ok: false,
      reason: "no_tracks",
      message: "There are no stems yet. Split stems on the Produce stage first.",
    };
  const binary = studio.ffmpeg();
  const probe = await probeFfmpeg(binary);
  if (!probe.ok) return { ok: false, reason: "no_ffmpeg", message: probe.message };
  const next = await nextMix(dir);
  const argv = mixArgv(inputs, join(dir, next.file));
  if (argv === null)
    return {
      ok: false,
      reason: "silent",
      message: "Every track is muted, or others are soloed. Unmute one to render.",
    };
  const ran = await runFfmpeg(binary, argv, signal);
  if (!ran.ok) return { ok: false, reason: "failed", message: ran.message };
  return { ok: true, n: next.n, file: next.file, path: join(dir, next.file) };
}
