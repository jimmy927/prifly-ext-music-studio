/** The Mix stage's routes: the tracks with their levels, saving them to mix.json, and rendering the mix. */

import { probeFfmpeg } from "../audio/ffmpeg";
import { DEFAULT_TRACK, parseMix } from "../audio/mixgraph";
import { renderMix } from "../mix/render";
import { mixes, readMix, writeMix } from "../project/stage";
import { tracksOf } from "../project/tracks";
import { bodyOf, entryOf, type Handler } from "./common";

export const mixView: Handler = async (studio, request) => {
  const entry = await entryOf(studio, request.query["project"]);
  const store = studio.store();
  const dir = store.pathOf(entry);
  const { tempo, tracks, stemSource } = await tracksOf(store, entry);
  const saved = await readMix(dir);
  const probe = await probeFfmpeg(studio.ffmpeg());
  return {
    ffmpeg: probe.ok ? { ok: true, message: probe.output } : { ok: false, message: probe.message },
    tempo,
    stemSource,
    tracks: tracks.map((each) => ({ ...each, mix: saved.tracks[each.key] ?? DEFAULT_TRACK })),
    renders: await mixes(dir),
  };
};

const save: Handler = async (studio, request) => {
  const body = bodyOf(request);
  const entry = await entryOf(studio, body["project"]);
  await writeMix(studio.store().pathOf(entry), parseMix(body["mix"]));
  return { ok: true };
};

const render: Handler = async (studio, request) => {
  const body = bodyOf(request);
  const entry = await entryOf(studio, body["project"]);
  const settings = body["mix"] === undefined ? undefined : parseMix(body["mix"]);
  if (settings !== undefined) await writeMix(studio.store().pathOf(entry), settings);
  const done = await renderMix(studio, entry, settings);
  return done.ok ? { ok: true, n: done.n, file: done.file } : done;
};

export const mixRoutes: Record<string, Handler> = {
  mix: mixView,
  "mix-save": save,
  "mix-render": render,
};
