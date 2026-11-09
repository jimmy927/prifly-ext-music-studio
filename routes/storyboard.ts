/** The Storyboard stage's routes: the shot list, drafting it, drawing frames, and editing shots. */

import { launchLocal } from "../jobs";
import { readShots, readTreatment } from "../project/video";
import { fail } from "../studio";
import { framesUsd } from "../video/budget";
import { draftProject, hasWork, NO_TEMPO } from "../video/draft";
import { startFrames } from "../video/frames";
import { approveAll, editShots, parseChange } from "../video/shot-edit";
import { tilingProblems } from "../video/shotlist";
import { bodyOf, entryOf, type Handler, startedAnswer } from "./common";
import { hasGeminiKey, moneyOf, shotViews, tempoOf } from "./video-common";
import type { StoryboardView } from "./video-views";

async function viewOf(studio: Parameters<Handler>[0], projectId: unknown): Promise<StoryboardView> {
  const entry = await entryOf(studio, projectId);
  const dir = studio.store().pathOf(entry);
  const list = await readShots(dir);
  const treatment = await readTreatment(dir);
  const missing = list?.shots.filter((each) => each.frame === null).length ?? 0;
  return {
    geminiKey: await hasGeminiKey(studio),
    tempo: await tempoOf(dir),
    list: list === null ? null : { ...list, shots: shotViews(list) },
    problems: list === null ? [] : tilingProblems(list),
    money: await moneyOf(studio, dir, treatment),
    missing: { count: missing, usd: framesUsd(missing) },
    hasWork: await hasWork(dir),
    castCount: treatment.cast.length,
  };
}

const view: Handler = async (studio, request) => await viewOf(studio, request.query["project"]);

const draft: Handler = async (studio, request) => {
  const body = bodyOf(request);
  const entry = await entryOf(studio, body["project"]);
  const dir = studio.store().pathOf(entry);
  if ((await tempoOf(dir)) === null) return startedAnswer(fail("invalid", NO_TEMPO));
  if ((await hasWork(dir)) && body["replace"] !== true)
    return startedAnswer(
      fail(
        "invalid",
        "Drafting again replaces the shot list, with its descriptions, frames and approvals. Confirm to replace it.",
      ),
    );
  return startedAnswer(
    launchLocal(studio, entry.id, {
      work: "draft",
      label: "Cutting the song into shots",
      total: 2,
      run: async ({ job }) => {
        job.done.push("sections");
        const done = await draftProject(studio, entry);
        if (!done.ok) throw new Error(done.message);
        job.done.push("described");
        return JSON.stringify({
          shots: done.list.shots.length,
          described: done.described,
          note: done.note,
        });
      },
    }),
  );
};

const frames: Handler = async (studio, request) => {
  const body = bodyOf(request);
  const entry = await entryOf(studio, body["project"]);
  const ids = Array.isArray(body["shots"])
    ? body["shots"].filter((each): each is string => typeof each === "string")
    : null;
  return startedAnswer(await startFrames(studio, entry, ids));
};

const edit: Handler = async (studio, request) => {
  const body = bodyOf(request);
  const entry = await entryOf(studio, body["project"]);
  const dir = studio.store().pathOf(entry);
  const done =
    body["approveAll"] === true
      ? await approveAll(dir)
      : await editShots(
          dir,
          (Array.isArray(body["changes"]) ? body["changes"] : [body])
            .map(parseChange)
            .filter((each) => each !== null),
        );
  return done.ok
    ? { ok: true as const, view: await viewOf(studio, entry.id) }
    : { ok: false as const, message: done.message };
};

export const storyboardRoutes: Record<string, Handler> = {
  storyboard: view,
  "storyboard-draft": draft,
  "storyboard-frames": frames,
  "shot-edit": edit,
};
