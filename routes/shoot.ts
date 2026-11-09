/** The Shoot stage's routes: the shots with their takes and the running spend, shooting, choosing a take. */

import { readShots, readTreatment, writeShots } from "../project/video";
import { isTakeId, readTakes, takesOf } from "../project/video-media";
import { takeUsd } from "../video/budget";
import { SHOOT_RESOLUTION, VIDEO_USD_PER_SECOND } from "../video/constants";
import { parseShootRequest, startRecover, startShoot } from "../video/shoot";
import { bodyOf, entryOf, type Handler, startedAnswer } from "./common";
import { hasGeminiKey, moneyOf, shotView, tempoOf } from "./video-common";
import type { ShootView } from "./video-views";

async function viewOf(studio: Parameters<Handler>[0], projectId: unknown): Promise<ShootView> {
  const entry = await entryOf(studio, projectId);
  const dir = studio.store().pathOf(entry);
  const list = await readShots(dir);
  const treatment = await readTreatment(dir);
  const takes = await readTakes(dir);
  const shots =
    list === null
      ? []
      : list.shots.map((each, at) => ({
          ...shotView(list, each, at + 1),
          takes: takesOf(takes, each.id).map((take) => ({
            id: take.id,
            n: take.n,
            status: take.status,
            reason: take.reason,
            failure: take.failure,
            seconds: take.seconds,
            usd: take.usd,
            chosen: each.take === take.id,
          })),
        }));
  const open = shots.filter(
    (each) =>
      each.approved && each.frame !== null && !each.takes.some((take) => take.status === "done"),
  );
  const running = [...studio.jobs.values()].some(
    (job) => job.status === "running" && job.project === entry.id && job.work === "shoot",
  );
  return {
    geminiKey: await hasGeminiKey(studio),
    tempo: await tempoOf(dir),
    shots,
    money: await moneyOf(studio, dir, treatment),
    waiting: {
      count: open.length,
      usd:
        Math.round(open.reduce((sum, each) => sum + takeUsd(each.clipSeconds), 0) * 10000) / 10000,
    },
    orphans: running ? 0 : takes.filter((each) => each.status === "pending").length,
    prices: {
      videoPerSecondUsd: VIDEO_USD_PER_SECOND[SHOOT_RESOLUTION],
      resolution: SHOOT_RESOLUTION,
    },
  };
}

const view: Handler = async (studio, request) => await viewOf(studio, request.query["project"]);

const run: Handler = async (studio, request) => {
  const body = bodyOf(request);
  const entry = await entryOf(studio, body["project"]);
  return startedAnswer(await startShoot(studio, entry, parseShootRequest(body)));
};

const recover: Handler = async (studio, request) => {
  const entry = await entryOf(studio, bodyOf(request)["project"]);
  return startedAnswer(await startRecover(studio, entry));
};

/** Makes a done take the one the edit cuts from. */
const choose: Handler = async (studio, request) => {
  const body = bodyOf(request);
  const entry = await entryOf(studio, body["project"]);
  const dir = studio.store().pathOf(entry);
  const take = isTakeId(body["take"])
    ? (await readTakes(dir)).find((each) => each.id === body["take"])
    : undefined;
  const list = await readShots(dir);
  if (take === undefined || take.status !== "done" || list === null)
    throw new Error("That take is not a finished clip.");
  await writeShots(dir, {
    ...list,
    shots: list.shots.map((each) => (each.id === take.shot ? { ...each, take: take.id } : each)),
  });
  return await viewOf(studio, entry.id);
};

export const shootRoutes: Record<string, Handler> = {
  shoot: view,
  "shoot-run": run,
  "shoot-recover": recover,
  "shoot-choose": choose,
};
