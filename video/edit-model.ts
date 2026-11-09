/**
 * Everything the Edit stage and the renders work from, read once: the shot
 * list, which take is chosen for each shot, the reader's per-shot choices,
 * the soundtrack, and the words for captions. From these come the timeline's
 * slots, the gaps, the warnings and a signature that changes when the edit does.
 */

import { access } from "node:fs/promises";
import { join } from "node:path";
import { type AudioSource, sourceToPrepare } from "../project/audio-source";
import { activeVersion } from "../project/stage";
import type { IndexEntry } from "../project/store";
import { readShots } from "../project/video";
import {
  type EditSettings,
  readEdit,
  readTakes,
  shotEditOf,
  type TakeRecord,
} from "../project/video-media";
import type { Studio } from "../studio";
import { parseWords, type Word } from "./captions";
import { pickRange, type Range } from "./range";
import { type ShotList, tilingProblems } from "./shotlist";
import type { Slot } from "./timeline";

export type EditState = {
  dir: string;
  list: ShotList | null;
  takes: TakeRecord[];
  settings: EditSettings;
  slots: Slot[];
  /** Absolute path of the soundtrack. */
  audio: (AudioSource & { path: string }) | null;
  words: Word[];
  /** The vertical cut's range. */
  vertical: Range | null;
  warnings: string[];
  gaps: number;
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/** The take a shot is cut from: the chosen one, if its clip is on disk. */
function chosenTake(takes: TakeRecord[], shot: string, chosen: string | null): TakeRecord | null {
  const take = takes.find((each) => each.id === chosen && each.shot === shot);
  return take?.status === "done" && take.file !== null ? take : null;
}

/** The words of the active version, else of the chosen sketch (a sketch's or version's `words_timestamps`). */
export async function captionWords(studio: Studio, entry: IndexEntry): Promise<Word[]> {
  const store = studio.store();
  const version = await activeVersion(store.pathOf(entry));
  if (version !== null) return parseWords(version.timestamps);
  const chosen = (await store.sketches(entry)).find((each) => each.id === entry.chosen);
  return parseWords(chosen?.timestamps);
}

async function slotsOf(dir: string, list: ShotList, takes: TakeRecord[], settings: EditSettings) {
  const slots: Slot[] = [];
  for (const shot of list.shots) {
    const take = chosenTake(takes, shot.id, shot.take);
    const path = take?.file == null ? null : join(dir, take.file);
    const have = path !== null && (await exists(path));
    const mine = shotEditOf(settings, shot.id);
    slots.push({
      shot: shot.id,
      startSec: shot.startSec,
      endSec: shot.endSec,
      clip: have ? path : null,
      transition: mine.transition,
      speed: mine.speed,
    });
  }
  return slots;
}

/** Reads the project's edit. */
export async function loadEdit(studio: Studio, entry: IndexEntry): Promise<EditState> {
  const store = studio.store();
  const dir = store.pathOf(entry);
  const list = await readShots(dir);
  const takes = await readTakes(dir);
  const settings = await readEdit(dir);
  const slots = list === null ? [] : await slotsOf(dir, list, takes, settings);
  const source = await sourceToPrepare(store, entry);
  const audio = source === null ? null : { ...source, path: join(dir, source.file) };
  const words = await captionWords(studio, entry);
  const warnings: string[] = [];
  const gaps = slots.filter((each) => each.clip === null).length;
  if (list !== null) warnings.push(...tilingProblems(list));
  if (gaps > 0)
    warnings.push(
      `${gaps} of ${slots.length} shots ${gaps === 1 ? "has" : "have"} no clip yet and will render black.`,
    );
  if (audio === null) warnings.push("There is no soundtrack: the video would be silent.");
  const vertical = pickRange(list?.shots ?? [], settings.vertical);
  return { dir, list, takes, settings, slots, audio, words, vertical, warnings, gaps };
}

/** A fingerprint of what a render shows, to tell later whether the edit has changed since. */
export function signatureOf(state: EditState, captions: boolean): string {
  const parts = state.slots.map(
    (each) =>
      `${each.shot}:${each.startSec}-${each.endSec}:${each.clip ?? "-"}:${each.transition}:${each.speed}`,
  );
  parts.push(`audio:${state.audio?.path ?? "-"}`, `captions:${captions ? state.words.length : 0}`);
  return Bun.hash(parts.join("|")).toString(16);
}
