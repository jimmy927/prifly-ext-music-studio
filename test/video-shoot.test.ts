/**
 * The Shoot stage and the budget: batches shot against a faked Omni, the
 * spend added up as clips arrive, shooting stopping where the budget does,
 * long-running calls polled, failures kept with their reasons, a cancel, a run
 * found again after the page is reopened, and clips fetched after a restart.
 * No real call is made.
 */

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { addSpend, readLedger, readShots } from "../project/video";
import { readTakes, writeTake } from "../project/video-media";
import type { ShootView } from "../routes/video-views";
import type { Job } from "../studio";
import {
  affordable,
  fitBudget,
  framesUsd,
  parseBudget,
  remainingUsd,
  spentUsd,
  takeUsd,
} from "../video/budget";
import { ask, finished, type Refused, runJob } from "./stage-world";
import {
  type Gemini,
  gemini,
  googleError,
  preparedProject,
  seedShots,
  videoWorld,
} from "./video-world";

async function setup(g: Gemini = gemini()) {
  const w = videoWorld(g);
  const { project, dir } = await preparedProject(w);
  const list = await seedShots(dir);
  return { w, g, project, dir, list };
}

const view = async (w: Parameters<typeof ask>[0], project: string) =>
  (await ask(w, "shoot", { project })) as ShootView;

/** Waits until the fake has seen `count` polls. */
async function untilPolls(g: Gemini, count: number): Promise<void> {
  for (let tries = 0; tries < 400 && g.polls < count; tries += 1) await Bun.sleep(5);
}

const done = (job: Job | Refused): Job => {
  if (!("status" in job)) throw new Error(job.message);
  return job;
};

test("the money maths: prices by second, order-keeping fit, the budget line", () => {
  expect(takeUsd(8)).toBe(0.56);
  expect(takeUsd(15)).toBe(1.05);
  expect(framesUsd(3)).toBe(0.201);
  expect(
    spentUsd({
      entries: [
        { at: "", kind: "take", ref: "a", usd: 0.56 },
        { at: "", kind: "frame", ref: "b", usd: 0.067 },
      ],
    }),
  ).toBe(0.627);
  expect(remainingUsd(1, 0.627)).toBe(0.373);
  expect(remainingUsd(1, 5)).toBe(0);
  expect(affordable(1, 0.5, 0.5)).toBe(true);
  expect(affordable(1, 0.5, 0.51)).toBe(false);
  // The order is the reader's: a later, cheaper item is not slipped in after one that does not fit.
  const plan = fitBudget([0.6, 0.6, 0.1], (each) => each, 1, 0);
  expect(plan.fits).toEqual([0.6]);
  expect(plan.left).toEqual([0.6, 0.1]);
  expect(plan.usd).toBe(0.6);
  expect(parseBudget(undefined)).toBe(25);
  expect(parseBudget(-3, 40)).toBe(40);
  expect(parseBudget(7)).toBe(7);
});

test("Shoot asks once for the batch with the dollars, shoots each approved shot from its frame, and adds up the spend", async () => {
  const { w, g, project, dir, list } = await setup();
  const answer = (await ask(w, "shoot-run", {}, { project })) as { ok: boolean; job: Job };
  expect(answer.ok).toBe(true);
  const card = w.fake.confirms.at(-1);
  expect(card?.title).toBe("Shoot 5 takes");
  expect(card?.summary).toContain("31 seconds of video");
  expect(card?.summary).toContain("about $2.17");
  expect(card?.summary).toContain("of the $25.00 budget");
  expect(card?.summary).toContain("estimate");
  expect(card?.details).toContain("gemini-omni-1.2-flash");
  const job = await finished(w, answer.job.id);
  expect(job.status).toBe("done");
  expect(g.videos).toBe(5);
  const first = w.calls.find((each) => each.body.includes("gemini-omni-1.2-flash"));
  const body = JSON.parse(first?.body ?? "{}") as {
    input: { type: string; data?: string }[];
    response_format: Record<string, string>;
  };
  expect(body.input.map((each) => each.type)).toEqual(["image", "text"]);
  expect(body.response_format).toMatchObject({
    type: "video",
    duration: "8s",
    resolution: "720p",
    aspect_ratio: "16:9",
  });
  const takes = await readTakes(dir);
  const byShot = list.shots.map((shot) => takes.find((each) => each.shot === shot.id));
  expect(byShot.map((each) => [each?.n, each?.status, each?.seconds])).toEqual([
    [1, "done", 8],
    [1, "done", 8],
    [1, "done", 4],
    [1, "done", 8],
    [1, "done", 3],
  ]);
  expect(takes.every((each) => each.file !== null && existsSync(join(dir, each.file)))).toBe(true);
  expect(spentUsd(await readLedger(dir))).toBe(2.17);
  // Each shot's first take is its chosen one.
  const after = await readShots(dir);
  expect(after?.shots.map((each) => each.take)).toEqual(list.shots.map((each) => `${each.id}-1`));
  const shown = await view(w, project);
  expect(shown.waiting).toEqual({ count: 0, usd: 0 });
  expect(shown.money).toMatchObject({ spentUsd: 2.17, remainingUsd: 22.83 });
  // A second batch has nothing waiting.
  const again = (await ask(w, "shoot-run", {}, { project })) as Refused;
  expect(again).toMatchObject({ ok: false, reason: "invalid" });
  expect(again.message).toContain("Nothing to shoot");
});

test("several takes per shot are kept side by side and one is chosen", async () => {
  const { w, project, dir, list } = await setup();
  const second = list.shots[1];
  const run = done(await runJob(w, "shoot-run", { project, shots: [second?.id], takes: 3 }));
  expect(run.status).toBe("done");
  const takes = (await readTakes(dir)).filter((each) => each.shot === second?.id);
  expect(takes.map((each) => each.n)).toEqual([1, 2, 3]);
  expect(w.fake.confirms.at(-1)?.title).toBe("Shoot 3 takes");
  const chosen = (await ask(
    w,
    "shoot-choose",
    {},
    { project, take: `${second?.id}-3` },
  )) as ShootView;
  const row = chosen.shots.find((each) => each.id === second?.id);
  expect(row?.takes.map((each) => each.chosen)).toEqual([false, false, true]);
  const bad = await ask(w, "shoot-choose", {}, { project, take: "nope" }).catch(
    (caught: unknown) => caught,
  );
  expect(String(bad)).toContain("not a finished clip");
});

test("a shot that is not approved is refused with words, and nothing is asked", async () => {
  const { w, project, dir, list } = await setup();
  const shots = list.shots.map((each, at) => (at === 0 ? { ...each, approved: false } : each));
  const { writeShots } = await import("../project/video");
  await writeShots(dir, { ...list, shots });
  const cards = w.fake.confirms.length;
  const refused = (await ask(
    w,
    "shoot-run",
    {},
    { project, shots: [list.shots[0]?.id] },
  )) as Refused;
  expect(refused.ok).toBe(false);
  expect(refused.message).toContain("not approved");
  expect(w.fake.confirms).toHaveLength(cards);
});

test("shooting stops at the budget and says so: only the takes that fit are shot", async () => {
  const { w, g, project, dir } = await setup();
  await ask(w, "treatment-save", {}, { project, budgetUsd: 1.2 });
  const answer = (await ask(w, "shoot-run", {}, { project })) as { ok: boolean; job: Job };
  expect(w.fake.confirms.at(-1)?.title).toBe("Shoot 2 takes");
  expect(w.fake.confirms.at(-1)?.summary).toContain("room for 2 of 5 takes");
  const job = await finished(w, answer.job.id);
  const result = JSON.parse(job.result ?? "{}") as {
    made: number;
    left: number;
    stoppedBy: string;
    spentUsd: number;
  };
  expect(result).toMatchObject({ made: 2, left: 3, stoppedBy: "budget", spentUsd: 1.12 });
  expect(g.videos).toBe(2);
  expect(spentUsd(await readLedger(dir))).toBe(1.12);
  const shown = await view(w, project);
  expect(shown.money.remainingUsd).toBe(0.08);
  // What is left cannot be bought: the next batch is refused before any card.
  const cards = w.fake.confirms.length;
  const refused = (await ask(w, "shoot-run", {}, { project })) as Refused;
  expect(refused.message).toContain("Over budget");
  expect(w.fake.confirms).toHaveLength(cards);
});

test("the budget is checked again before every take, so a spend made meanwhile stops the batch", async () => {
  const { w, g, project, dir } = await setup();
  await ask(w, "treatment-save", {}, { project, budgetUsd: 3 });
  // While the first clip is being made, something else spends the rest of the budget.
  g.onVideo = async (count) => {
    if (count === 1) await addSpend(dir, "frame", "elsewhere", 2.5);
  };
  const job = done(await runJob(w, "shoot-run", { project }));
  const result = JSON.parse(job.result ?? "{}") as {
    made: number;
    left: number;
    stoppedBy: string;
  };
  expect(result).toMatchObject({ made: 1, left: 4, stoppedBy: "budget" });
  expect(g.videos).toBe(1);
});

test("a long-running call is polled until it is done, and its id is written down on the take", async () => {
  const g = gemini();
  g.mode = { kind: "background", polls: 3 };
  const { w, project, dir, list } = await setup(g);
  const seen: string[] = [];
  const one = list.shots[2]?.id;
  const started = (await ask(w, "shoot-run", {}, { project, shots: [one] })) as {
    ok: boolean;
    job: Job;
  };
  const finishedJob = await finished(w, started.job.id);
  expect(finishedJob.status).toBe("done");
  expect(g.polls).toBeGreaterThanOrEqual(3);
  const take = (await readTakes(dir)).find((each) => each.shot === one);
  expect(take).toMatchObject({ status: "done", interaction: "v1_1" });
  expect(seen).toEqual([]);
});

test("a failed take keeps Google's reason and is shot again with a new take number", async () => {
  const g = gemini();
  const original = g.handler;
  let video = 0;
  g.handler = (call) => {
    if (call.method === "POST" && call.body.includes("gemini-omni-1.2-flash")) {
      video += 1;
      if (video === 2)
        return googleError(400, "prohibited_content", "The shot was blocked by the safety filter.");
    }
    return original(call);
  };
  const { w, project, dir, list } = await setup(g);
  const run = done(await runJob(w, "shoot-run", { project }));
  expect(run.status).toBe("done");
  expect(JSON.parse(run.result ?? "{}")).toMatchObject({ made: 4, failed: 1 });
  const shown = await view(w, project);
  const failed = shown.shots[1]?.takes[0];
  expect(failed).toMatchObject({
    status: "failed",
    reason: "The shot was blocked by the safety filter.",
    failure: "blocked",
  });
  expect(shown.shots[1]?.takes[0]?.usd).toBe(0);
  expect(spentUsd(await readLedger(dir))).toBe(1.61);
  // Retry shoots the shot again as take 2.
  const retried = done(await runJob(w, "shoot-run", { project, shots: [list.shots[1]?.id] }));
  expect(retried.status).toBe("done");
  const takes = (await readTakes(dir)).filter((each) => each.shot === list.shots[1]?.id);
  expect(takes.map((each) => [each.n, each.status])).toEqual([
    [1, "failed"],
    [2, "done"],
  ]);
  expect((await readShots(dir))?.shots[1]?.take).toBe(`${list.shots[1]?.id}-2`);
});

test("a paid-tier error stops the batch, is shown in words, and is kept on the take", async () => {
  const g = gemini();
  g.mode = {
    kind: "fail",
    status: 400,
    code: "failed_precondition",
    message: "Billing is not enabled for this project.",
  };
  const { w, project, dir } = await setup(g);
  const job = done(await runJob(w, "shoot-run", { project }));
  expect(job.status).toBe("failed");
  expect(job.error).toContain("paid tier");
  expect(job.error).toContain("Billing is not enabled for this project.");
  expect(job.kind).toBe("billing");
  expect(g.videos).toBe(1);
  expect((await readTakes(dir))[0]).toMatchObject({ status: "failed", failure: "billing" });
  expect(spentUsd(await readLedger(dir))).toBe(0);
});

test("an interaction that failed after it was accepted is a failed take with Google's words", async () => {
  const g = gemini();
  g.mode = { kind: "failed-interaction", code: "safety", message: "Blocked for safety." };
  const { w, project, dir } = await setup(g);
  const job = done(await runJob(w, "shoot-run", { project }));
  expect(job.status).toBe("done");
  expect(JSON.parse(job.result ?? "{}")).toMatchObject({ made: 0, failed: 5 });
  expect((await readTakes(dir))[0]).toMatchObject({
    status: "failed",
    reason: "Blocked for safety.",
  });
});

test("cancelling a run cancels the call at Google, keeps the take as failed, and the page can find the run while it goes", async () => {
  const g = gemini();
  g.mode = { kind: "background", polls: 1_000_000 };
  const { w, project, dir } = await setup(g);
  const started = (await ask(w, "shoot-run", {}, { project })) as { ok: boolean; job: Job };
  await untilPolls(g, 2);
  // A reopened page asks what is running for the project and picks the run up.
  const running = (await ask(w, "jobs", { project })) as { jobs: Job[] };
  expect(running.jobs.map((each) => [each.id, each.work, each.status])).toEqual([
    [started.job.id, "shoot", "running"],
  ]);
  expect((await view(w, project)).orphans).toBe(0);
  await ask(w, "cancel", {}, { job: started.job.id });
  const job = await finished(w, started.job.id);
  expect(job.status).toBe("cancelled");
  expect(g.cancels).toHaveLength(1);
  expect((await readTakes(dir))[0]).toMatchObject({
    status: "failed",
    reason: "Cancelled before the clip came back.",
  });
  expect(((await ask(w, "jobs", { project })) as { jobs: Job[] }).jobs).toEqual([]);
  expect(g.videos).toBe(1);
});

test("a call Google accepted before the extension stopped is fetched afterwards, and only then paid for", async () => {
  const { w, g, project, dir, list } = await setup();
  const [a, b] = list.shots;
  const base = {
    n: 1,
    status: "pending" as const,
    file: null,
    reason: null,
    failure: null,
    seconds: 8,
    usd: 0.56,
    created: new Date().toISOString(),
  };
  await writeTake(dir, { ...base, id: `${a?.id}-1`, shot: a?.id ?? "", interaction: "v1_old" });
  await writeTake(dir, { ...base, id: `${b?.id}-1`, shot: b?.id ?? "", interaction: null });
  expect((await view(w, project)).orphans).toBe(2);
  const cards = w.fake.confirms.length;
  const job = done(await runJob(w, "shoot-recover", { project }));
  expect(job.status).toBe("done");
  // Nothing new was bought, so there is no card.
  expect(w.fake.confirms).toHaveLength(cards);
  expect(g.videos).toBe(0);
  const takes = await readTakes(dir);
  expect(takes.find((each) => each.shot === a?.id)).toMatchObject({
    status: "done",
    interaction: "v1_old",
  });
  expect(takes.find((each) => each.shot === b?.id)).toMatchObject({ status: "failed" });
  expect(takes.find((each) => each.shot === b?.id)?.reason).toContain("before Google accepted");
  expect(spentUsd(await readLedger(dir))).toBe(0.56);
  expect((await view(w, project)).orphans).toBe(0);
});

test("with no tempo or no shot list the Shoot page has nothing to shoot and says so", async () => {
  const w = videoWorld();
  const { project } = await preparedProject(w);
  const shown = await view(w, project);
  expect(shown.shots).toEqual([]);
  const refused = (await ask(w, "shoot-run", {}, { project })) as Refused;
  expect(refused.message).toContain("no shot list");
});
