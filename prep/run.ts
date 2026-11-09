/** Prepare as a run: analyse a project's track and keep the result in prep.json, with cues from the plan's sections. */

import { labelOf } from "../arrange/plan";
import { sourceToPrepare } from "../project/audio-source";
import { type Prep, readPrep, writePeaks, writePrep } from "../project/prep";
import { baseOf } from "../project/source";
import type { IndexEntry } from "../project/store";
import type { Studio } from "../studio";
import { analyseAudio } from "./analyse";
import { startingInside } from "./edit";
import { cuesFromSections, resnapped, type SectionStart } from "./grid";

export type Prepared =
  | { ok: true; prep: Prep }
  | { ok: false; reason: "no_source" | "no_ffmpeg" | "failed" | "cancelled"; message: string };

/** Where each section of the song's plan starts, in seconds; empty when the song has no plan. */
export async function sectionStarts(studio: Studio, entry: IndexEntry): Promise<SectionStart[]> {
  const base = await baseOf(studio.store(), entry);
  if (!base.ok) return [];
  let at = 0;
  return base.sections.map((section) => {
    const start = { name: labelOf(section.text), startSec: at / 1000 };
    at += section.durationMs;
    return start;
  });
}

/**
 * Analyses the track Prepare works on (the newest master, else what Master
 * takes). Re-analysing the same file keeps its cues (moved onto the new
 * grid) and a typed-in tempo when no tempo was found; a new file starts with
 * cues from the plan's sections.
 */
export async function analyseProject(
  studio: Studio,
  entry: IndexEntry,
  signal: AbortSignal,
  step?: (name: string) => void,
): Promise<Prepared> {
  const store = studio.store();
  const dir = store.pathOf(entry);
  const source = await sourceToPrepare(store, entry);
  if (source === null)
    return {
      ok: false,
      reason: "no_source",
      message: "There is nothing to analyse yet. Choose a sketch on the Idea stage first.",
    };
  const analysed = await analyseAudio(studio, dir, source, signal, step);
  if (!analysed.ok) return analysed;
  const before = await readPrep(dir);
  const same = before !== null && before.source.file === source.file;
  const typed = same && before.manualBpm && analysed.analysis.bpm === null ? before.grid : null;
  const grid =
    analysed.analysis.bpm === null
      ? typed
      : { bpm: analysed.analysis.bpm, firstBeatSec: analysed.firstBeatSec };
  let cues = same && before !== null ? before.cues : [];
  let loop = same && before !== null ? before.loop : null;
  if (grid !== null) {
    const moved = resnapped(cues, loop, grid);
    cues = moved.cues;
    loop = moved.loop;
    if (cues.length === 0) {
      const starts = startingInside(
        await sectionStarts(studio, entry),
        analysed.analysis.durationSec,
      );
      cues = cuesFromSections(starts, grid);
    }
  }
  const prep: Prep = {
    source,
    analysis: analysed.analysis,
    grid,
    manualBpm: typed !== null,
    cues,
    loop,
  };
  await writePrep(dir, prep);
  await writePeaks(dir, analysed.peaks);
  return { ok: true, prep };
}
