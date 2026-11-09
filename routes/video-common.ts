/** What the Video stages' routes share: the budget line, the tempo gate and the shots as the page sees them. */

import { readPrep } from "../project/prep";
import { budgetOf, readLedger, type Treatment } from "../project/video";
import type { Studio } from "../studio";
import { remainingUsd, spentUsd } from "../video/budget";
import { barsOf, clipSeconds, lengthOf, type Shot, type ShotList } from "../video/shotlist";
import type { MoneyView, ShotView } from "./video-views";

export async function moneyOf(
  studio: Studio,
  dir: string,
  treatment: Treatment,
): Promise<MoneyView> {
  const budgetUsd = budgetOf(treatment, studio.api().settings?.["videoBudgetUsd"]);
  const spent = spentUsd(await readLedger(dir));
  return {
    budgetUsd,
    spentUsd: spent,
    remainingUsd: remainingUsd(budgetUsd, spent),
    own: treatment.budgetUsd !== null,
  };
}

/** The tempo Prepare has for the project, or null. */
export async function tempoOf(dir: string): Promise<number | null> {
  return (await readPrep(dir))?.grid?.bpm ?? null;
}

export function shotView(list: ShotList, shot: Shot, number: number): ShotView {
  return {
    ...shot,
    number,
    bars: barsOf(shot, { bpm: list.bpm, firstBeatSec: list.firstBeatSec }),
    seconds: lengthOf(shot),
    clipSeconds: clipSeconds(shot),
  };
}

export const shotViews = (list: ShotList): ShotView[] =>
  list.shots.map((each, at) => shotView(list, each, at + 1));

export const hasGeminiKey = async (studio: Studio): Promise<boolean> =>
  (await studio.key("lyria-clip")) !== null;
