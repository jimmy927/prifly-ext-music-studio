/** The Master stage's routes: the source's loudness and the masters made so far, and "Master" as a local job. */

import { probeFfmpeg } from "../audio/ffmpeg";
import { FORMATS, isFormatId, isLossy, isTargetId, LOSSY_NOTE, TARGETS } from "../audio/loudness";
import { launchLocal } from "../jobs";
import { measureFile, renderMaster } from "../master/render";
import { sourceToMaster } from "../project/audio-source";
import { masters } from "../project/master";
import { bodyOf, entryOf, type Handler, startedAnswer } from "./common";

const view: Handler = async (studio, request) => {
  const entry = await entryOf(studio, request.query["project"]);
  const store = studio.store();
  const dir = store.pathOf(entry);
  const probe = await probeFfmpeg(studio.ffmpeg());
  const source = await sourceToMaster(store, entry);
  let loudness = null;
  let measureError: string | null = null;
  if (source !== null && probe.ok) {
    const measured = await measureFile(studio, dir, source.file);
    if (measured.ok) loudness = measured.loudness;
    else measureError = measured.message;
  }
  return {
    ffmpeg: probe.ok ? { ok: true, message: probe.output } : { ok: false, message: probe.message },
    source:
      source === null
        ? null
        : { kind: source.kind, id: source.id, label: source.label, lossy: isLossy(source.file) },
    lossyNote: LOSSY_NOTE,
    loudness,
    measureError,
    targets: Object.values(TARGETS),
    formats: Object.entries(FORMATS).map(([id, each]) => ({ id, label: each.label })),
    masters: (await masters(dir)).map((each) => ({
      n: each.n,
      file: each.file,
      target: each.target,
      format: each.format,
      from: each.from,
      input: each.input,
      output: each.output,
      type: each.type,
      created: each.created,
    })),
  };
};

const render: Handler = async (studio, request) => {
  const body = bodyOf(request);
  const entry = await entryOf(studio, body["project"]);
  const { target, format } = body;
  if (!isTargetId(target)) throw new Error("Pick Club, Streaming or Game.");
  if (!isFormatId(format)) throw new Error("Pick WAV, MP3 or OGG.");
  return startedAnswer(
    launchLocal(studio, entry.id, {
      work: "master",
      label: `Mastering to ${TARGETS[target].label} (${TARGETS[target].lufs} LUFS)`,
      total: 3,
      run: async ({ signal, job }) => {
        const done = await renderMaster(studio, entry, { target, format }, signal, (name) =>
          job.done.push(name),
        );
        if (!done.ok) throw new Error(done.message);
        return `master-${done.record.n}`;
      },
    }),
  );
};

export const masterRoutes: Record<string, Handler> = {
  master: view,
  "master-render": render,
};
