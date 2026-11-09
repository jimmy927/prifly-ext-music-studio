/**
 * The Prepare stage's routes: the analysis with its grid, cues and loop, the
 * waveform, and each edit (tempo, nudge, cues, loop, crate). An edit that the
 * track cannot take answers `{ ok: false, message }`, never an error.
 */

import { compatibleKeys, keyName, keyOfCode } from "../audio/camelot";
import { probeFfmpeg } from "../audio/ffmpeg";
import { launchLocal } from "../jobs";
import {
  autoCues,
  clearLoop,
  deleteCue,
  setCue,
  setLoop,
  withBpm,
  withFirstBeat,
  withNudge,
} from "../prep/edit";
import { isSlot, loopEnd } from "../prep/grid";
import { analyseProject, sectionStarts } from "../prep/run";
import { sourceToPrepare } from "../project/audio-source";
import { keyInfo, type Prep, readPeaks, readPrep, writePrep } from "../project/prep";
import type { IndexEntry } from "../project/store";
import type { Studio } from "../studio";
import { bodyOf, entryOf, type Handler, startedAnswer } from "./common";

/** A prepared track as the page and the tools describe it. */
export function describe(prep: Prep) {
  const key = prep.analysis.key === null ? null : keyInfo(prep.analysis.key);
  return {
    source: { kind: prep.source.kind, id: prep.source.id, label: prep.source.label },
    analysis: { ...prep.analysis, key },
    grid: prep.grid,
    manualBpm: prep.manualBpm,
    cues: prep.cues,
    loop:
      prep.loop === null || prep.grid === null
        ? null
        : { ...prep.loop, endSec: loopEnd(prep.grid, prep.loop) },
    compatible:
      key === null
        ? []
        : compatibleKeys(key.camelot).map((each) => ({
            ...each,
            name: keyName(keyOfCode(each.code) ?? { tonic: 0, mode: "major" }),
          })),
  };
}

async function viewOf(studio: Studio, entry: IndexEntry) {
  const store = studio.store();
  const dir = store.pathOf(entry);
  const probe = await probeFfmpeg(studio.ffmpeg());
  const source = await sourceToPrepare(store, entry);
  const prep = await readPrep(dir);
  const crates = await studio.crates().list();
  return {
    ffmpeg: probe.ok ? { ok: true, message: probe.output } : { ok: false, message: probe.message },
    source: source === null ? null : { kind: source.kind, id: source.id, label: source.label },
    /** The newest master or mix is not the file that was analysed. */
    stale: prep !== null && source !== null && prep.source.file !== source.file,
    prep: prep === null ? null : describe(prep),
    peaks: prep === null ? null : await readPeaks(dir),
    hasPlan: (await sectionStarts(studio, entry)).length > 0,
    crates: crates.map((each) => ({
      id: each.id,
      name: each.name,
      has: each.tracks.includes(entry.id),
    })),
  };
}

const view: Handler = async (studio, request) =>
  await viewOf(studio, await entryOf(studio, request.query["project"]));

const analyse: Handler = async (studio, request) => {
  const entry = await entryOf(studio, bodyOf(request)["project"]);
  return startedAnswer(
    launchLocal(studio, entry.id, {
      work: "analyse",
      label: "Analysing the track",
      total: 4,
      run: async ({ signal, job }) => {
        const done = await analyseProject(studio, entry, signal, (name) => job.done.push(name));
        if (!done.ok) throw new Error(done.message);
        return "analysed";
      },
    }),
  );
};

type Edit = (
  prep: Prep,
  body: Record<string, unknown>,
  studio: Studio,
  entry: IndexEntry,
) => Promise<Prep | string> | Prep | string;

/** Loads the track's prep, applies the edit, saves it, answers the new description. */
function editing(change: Edit): Handler {
  return async (studio, request) => {
    const body = bodyOf(request);
    const entry = await entryOf(studio, body["project"]);
    const dir = studio.store().pathOf(entry);
    const prep = await readPrep(dir);
    if (prep === null)
      return { ok: false, message: "This track is not analysed yet. Analyse it first." };
    const next = await change(prep, body, studio, entry);
    if (typeof next === "string") return { ok: false, message: next };
    await writePrep(dir, next);
    return { ok: true, prep: describe(next) };
  };
}

const cue: Edit = (prep, body) => {
  const slot = body["slot"];
  return isSlot(slot) ? setCue(prep, slot, body["sec"], body["name"]) : "Pick a cue from A to H.";
};

const uncue: Edit = (prep, body) => {
  const slot = body["slot"];
  return isSlot(slot) ? deleteCue(prep, slot) : "Pick a cue from A to H.";
};

const crateToggle: Handler = async (studio, request) => {
  const body = bodyOf(request);
  const entry = await entryOf(studio, body["project"]);
  const crates = studio.crates();
  if (body["in"] === false) await crates.take(body["crate"], entry.id);
  else await crates.add(body["crate"], entry.id);
  return { ok: true, crates: (await viewOf(studio, entry)).crates };
};

export const prepareRoutes: Record<string, Handler> = {
  prepare: view,
  "prepare-analyse": analyse,
  "prep-bpm": editing((prep, body) => withBpm(prep, body["bpm"])),
  "prep-nudge": editing((prep, body) => withNudge(prep, body["ms"])),
  "prep-first-beat": editing((prep, body) => withFirstBeat(prep, body["sec"])),
  "prep-cue": editing(cue),
  "prep-cue-delete": editing(uncue),
  "prep-auto-cues": editing(async (prep, _body, studio, entry) =>
    autoCues(prep, await sectionStarts(studio, entry)),
  ),
  "prep-loop": editing((prep, body) => setLoop(prep, body["startSec"], body["bars"])),
  "prep-loop-clear": editing((prep) => clearLoop(prep)),
  "prep-crate": crateToggle,
};
