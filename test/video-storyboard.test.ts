/**
 * Treatment and Storyboard through the panel's routes: the budget, the cast,
 * the shot list drafted from the sections (with and without a model), frames
 * drawn in one paid batch, and the edits to a shot. Gemini is faked.
 */

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readLedger, readShots, readTreatment } from "../project/video";
import type { StoryboardView, TreatmentView } from "../routes/video-views";
import type { StartAnswer } from "../routes/views";
import { spentUsd } from "../video/budget";
import { IMAGE_USD } from "../video/constants";
import { ask, chosenProject, declineCards, finished, runJob } from "./stage-world";
import { gemini, googleError, PNG, preparedProject, videoWorld } from "./video-world";

const b64 = Buffer.from(PNG).toString("base64");

async function setup(options: Parameters<typeof videoWorld>[1] = {}) {
  const g = gemini();
  const w = videoWorld(g, options);
  const { project, dir } = await preparedProject(w);
  return { w, g, project, dir };
}

test("the treatment starts empty with the extension's budget, and saving it keeps what was typed", async () => {
  const { w, project } = await setup();
  const first = (await ask(w, "treatment", { project })) as TreatmentView;
  expect(first.treatment).toMatchObject({ concept: "", vertical: false, shotBars: 4, cast: [] });
  expect(first.money).toMatchObject({ budgetUsd: 25, spentUsd: 0, remainingUsd: 25, own: false });
  expect(first.tempo).toBe(120);
  expect(first.geminiKey).toBe(true);
  const saved = (await ask(
    w,
    "treatment-save",
    {},
    {
      project,
      concept: "A night drive",
      look: "neon",
      vertical: true,
      shotBars: 2,
      budgetUsd: 7.5,
    },
  )) as TreatmentView;
  expect(saved.treatment).toMatchObject({
    concept: "A night drive",
    look: "neon",
    vertical: true,
    shotBars: 2,
  });
  expect(saved.money).toMatchObject({ budgetUsd: 7.5, own: true });
  const again = (await ask(w, "treatment", { project })) as TreatmentView;
  expect(again.treatment.concept).toBe("A night drive");
  // null goes back to the extension's setting.
  const reset = (await ask(w, "treatment-save", {}, { project, budgetUsd: null })) as TreatmentView;
  expect(reset.money).toMatchObject({ budgetUsd: 25, own: false });
});

test("the default budget is the videoBudgetUsd setting", async () => {
  const { w, project } = await setup();
  (w.fake.api.settings as Record<string, unknown>)["videoBudgetUsd"] = 12;
  expect(((await ask(w, "treatment", { project })) as TreatmentView).money.budgetUsd).toBe(12);
});

test("a picture dropped on the cast is checked by its bytes and kept; six is the most", async () => {
  const { w, project, dir } = await setup();
  const added = (await ask(w, "cast-add", {}, { project, name: "Mia", base64: b64 })) as {
    ok: true;
    view: TreatmentView;
  };
  expect(added.ok).toBe(true);
  expect(added.view.treatment.cast[0]).toMatchObject({ name: "Mia", source: "file" });
  const file = (await readTreatment(dir)).cast[0]?.file ?? "";
  expect(file).toEndWith(".png");
  expect(existsSync(join(dir, file))).toBe(true);
  const text = (await ask(
    w,
    "cast-add",
    {},
    { project, name: "x", base64: Buffer.from("not a picture").toString("base64") },
  )) as { ok: boolean; message: string };
  expect(text).toMatchObject({ ok: false, message: "Use a PNG, JPEG or WebP picture." });
  for (let count = 1; count < 6; count += 1)
    await ask(w, "cast-add", {}, { project, name: `c${count}`, base64: b64 });
  const seventh = (await ask(w, "cast-add", {}, { project, name: "7", base64: b64 })) as {
    ok: boolean;
    message: string;
  };
  expect(seventh.ok).toBe(false);
  expect(seventh.message).toContain("at most 6");
  const after = (await ask(
    w,
    "cast-remove",
    {},
    { project, id: (await readTreatment(dir)).cast[0]?.id },
  )) as TreatmentView;
  expect(after.treatment.cast).toHaveLength(5);
  expect(existsSync(join(dir, file))).toBe(false);
});

test("a cast picture is drawn from a prompt after a card with the dollars, and costs one image", async () => {
  const { w, g, project, dir } = await setup();
  const answer = (await ask(
    w,
    "cast-draw",
    {},
    { project, name: "Mia", prompt: "a girl in a red coat" },
  )) as StartAnswer;
  expect(answer.ok).toBe(true);
  if (!answer.ok) return;
  const card = w.fake.confirms.at(-1);
  expect(card?.title).toBe("Draw a cast picture");
  expect(card?.summary).toContain("$0.07");
  expect(card?.summary).toContain("estimate");
  const job = await finished(w, answer.job.id);
  expect(job.status).toBe("done");
  expect(g.images).toBe(1);
  const treatment = await readTreatment(dir);
  expect(treatment.cast[0]).toMatchObject({
    name: "Mia",
    source: "generated",
    prompt: "a girl in a red coat",
  });
  expect(spentUsd(await readLedger(dir))).toBeCloseTo(IMAGE_USD);
});

test("cancelling the card spends nothing and calls nothing", async () => {
  const { w, g, project, dir } = await setup();
  declineCards(w);
  const answer = (await ask(
    w,
    "cast-draw",
    {},
    { project, name: "x", prompt: "y" },
  )) as StartAnswer;
  expect(answer).toMatchObject({ ok: false, reason: "cancelled" });
  expect(g.images).toBe(0);
  expect(spentUsd(await readLedger(dir))).toBe(0);
});

test("no Gemini key stops every paid step with words", async () => {
  const { w, project } = await setup({ keys: { elevenlabsKey: "xi" } });
  const answer = (await ask(
    w,
    "cast-draw",
    {},
    { project, name: "x", prompt: "y" },
  )) as StartAnswer;
  expect(answer).toMatchObject({ ok: false, reason: "no_key" });
  expect(answer.ok ? "" : answer.message).toContain("Gemini");
  expect(((await ask(w, "storyboard", { project })) as StoryboardView).geminiKey).toBe(false);
});

test("without a tempo the shot list is not drafted and the message points at Prepare", async () => {
  const w = videoWorld();
  const project = await chosenProject(w);
  const answer = (await ask(w, "storyboard-draft", {}, { project })) as StartAnswer;
  expect(answer.ok).toBe(false);
  expect(answer.ok ? "" : answer.message).toContain("Prepare");
});

test("Draft shot list cuts the sections into shots on the beat and a model writes the descriptions", async () => {
  const { w, project, dir } = await setup();
  const asked: string[] = [];
  w.fake.api.llm = {
    ask: async (request) => {
      asked.push(request.prompt);
      const count = (request.prompt.match(/^\d+\./gm) ?? []).length;
      return {
        ok: true,
        text: JSON.stringify({
          shots: Array.from({ length: count }, (_each, at) => `Shot ${at + 1} looks like this`),
        }),
        model: "m",
        backend: "claude",
      };
    },
  };
  await ask(w, "treatment-save", {}, { project, concept: "A night drive", look: "neon" });
  const job = await runJob(w, "storyboard-draft", { project });
  expect("status" in job && job.status).toBe("done");
  const list = await readShots(dir);
  expect(list?.shots.map((each) => [each.section, each.startSec, each.endSec])).toEqual([
    ["Intro", 0, 8],
    ["Verse", 8, 16],
    ["Verse", 16, 20],
    ["Chorus", 20, 26],
    ["Outro", 26, 30],
  ]);
  expect(list?.shots[1]?.text).toBe("Shot 2 looks like this");
  expect(asked[0]).toContain("Concept: A night drive");
  expect(asked[0]).toContain("Chorus, 6 s");
  const view = (await ask(w, "storyboard", { project })) as StoryboardView;
  expect(view.problems).toEqual([]);
  expect(view.list?.shots[0]).toMatchObject({ number: 1, bars: 4, clipSeconds: 8 });
  expect(view.missing).toEqual({ count: 5, usd: Math.round(5 * IMAGE_USD * 10000) / 10000 });
});

test("with no model the descriptions are left blank and the answer says why", async () => {
  const { w, project, dir } = await setup();
  w.fake.api.llm = {
    ask: async () => ({
      ok: false,
      code: "no-model",
      reason: "No model is set for the fast tier.",
    }),
  };
  const job = await runJob(w, "storyboard-draft", { project });
  expect("result" in job ? job.result : "").toContain("No model is set for the fast tier");
  expect((await readShots(dir))?.shots.every((each) => each.text === "")).toBe(true);
  // No api.llm at all (an older prifly) is the same.
  const other = await setup();
  const done = await runJob(other.w, "storyboard-draft", { project: other.project });
  expect("result" in done ? done.result : "").toContain("blank");
  // An answer that does not fit the shots is not used.
  w.fake.api.llm = {
    ask: async () => ({
      ok: true,
      text: JSON.stringify({ shots: ["only one"] }),
      model: "m",
      backend: "claude",
    }),
  };
  const again = await runJob(w, "storyboard-draft", { project, replace: true });
  expect("result" in again ? again.result : "").toContain("did not fit");
});

test("drafting again over work needs the replace flag", async () => {
  const { w, project, dir } = await setup();
  await runJob(w, "storyboard-draft", { project });
  await ask(
    w,
    "shot-edit",
    {},
    { project, shot: (await readShots(dir))?.shots[0]?.id, text: "mine" },
  );
  expect(((await ask(w, "storyboard", { project })) as StoryboardView).hasWork).toBe(true);
  const refused = (await ask(w, "storyboard-draft", {}, { project })) as StartAnswer;
  expect(refused.ok).toBe(false);
  expect((await readShots(dir))?.shots[0]?.text).toBe("mine");
  const done = await runJob(w, "storyboard-draft", { project, replace: true });
  expect("status" in done && done.status).toBe("done");
});

async function drafted(options: Parameters<typeof videoWorld>[1] = {}) {
  const made = await setup(options);
  await runJob(made.w, "storyboard-draft", { project: made.project });
  const list = await readShots(made.dir);
  for (const shot of list?.shots ?? [])
    await ask(
      made.w,
      "shot-edit",
      {},
      { project: made.project, shot: shot.id, text: `A shot of ${shot.section}` },
    );
  return made;
}

test("Draw frames asks once for the batch with the dollar estimate, draws each shot with the cast as references, and counts the spend", async () => {
  const { w, g, project, dir } = await drafted();
  await ask(w, "cast-add", {}, { project, name: "Mia", base64: b64 });
  const answer = (await ask(w, "storyboard-frames", {}, { project, shots: null })) as StartAnswer;
  expect(answer.ok).toBe(true);
  if (!answer.ok) return;
  const cards = w.fake.confirms.filter((each) => each.title.startsWith("Draw"));
  expect(cards).toHaveLength(1);
  expect(cards[0]?.title).toBe("Draw 5 still frames");
  expect(cards[0]?.summary).toContain("$0.34");
  expect(cards[0]?.summary).toContain("1 cast picture");
  expect(cards[0]?.summary).toContain("of the $25.00 budget");
  const job = await finished(w, answer.job.id);
  expect(job.status).toBe("done");
  expect(g.images).toBe(5);
  const list = await readShots(dir);
  expect(list?.shots.every((each) => each.frame !== null && !each.approved)).toBe(true);
  expect(spentUsd(await readLedger(dir))).toBeCloseTo(5 * IMAGE_USD);
  const request = w.calls.filter((each) => each.body.includes("gemini-3.1-flash-image")).at(-1);
  const body = JSON.parse(request?.body ?? "{}") as {
    input: { type: string }[];
    response_format: Record<string, string>;
  };
  expect(body.input.map((each) => each.type)).toEqual(["text", "image"]);
  expect(body.response_format).toMatchObject({ aspect_ratio: "16:9", image_size: "1K" });
});

test("a redrawn frame replaces the old file and needs approving again; approve and approve-all work", async () => {
  const { w, project, dir } = await drafted();
  await runJob(w, "storyboard-frames", { project, shots: null });
  const first = (await readShots(dir))?.shots[0];
  if (first === undefined) throw new Error("no shot");
  const approved = (await ask(w, "shot-edit", {}, { project, shot: first.id, approved: true })) as {
    ok: boolean;
  };
  expect(approved.ok).toBe(true);
  expect((await readShots(dir))?.shots[0]?.approved).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 3));
  await runJob(w, "storyboard-frames", { project, shots: [first.id] });
  const after = (await readShots(dir))?.shots[0];
  expect(after?.approved).toBe(false);
  expect(after?.frame).not.toBe(first.frame);
  expect(existsSync(join(dir, first.frame ?? ""))).toBe(false);
  expect(existsSync(join(dir, after?.frame ?? ""))).toBe(true);
  await ask(w, "shot-edit", {}, { project, approveAll: true });
  expect((await readShots(dir))?.shots.every((each) => each.approved)).toBe(true);
});

test("a shot with no frame cannot be approved, and a shot with no description cannot be drawn", async () => {
  const { w, project, dir } = await setup();
  await runJob(w, "storyboard-draft", { project });
  const first = (await readShots(dir))?.shots[0];
  const approve = (await ask(w, "shot-edit", {}, { project, shot: first?.id, approved: true })) as {
    ok: boolean;
    message: string;
  };
  expect(approve.ok).toBe(false);
  expect(approve.message).toContain("no frame");
  const draw = (await ask(w, "storyboard-frames", {}, { project, shots: null })) as StartAnswer;
  expect(draw.ok).toBe(false);
  expect(draw.ok ? "" : draw.message).toContain("no description");
});

test("a frame over the budget is refused with the numbers before any card is shown", async () => {
  const { w, g, project } = await drafted();
  await ask(w, "treatment-save", {}, { project, budgetUsd: 0.1 });
  const cards = w.fake.confirms.length;
  const draw = (await ask(w, "storyboard-frames", {}, { project, shots: null })) as StartAnswer;
  expect(draw.ok).toBe(false);
  expect(draw.ok ? "" : draw.message).toContain("Over budget");
  expect(draw.ok ? "" : draw.message).toContain("$0.34");
  expect(w.fake.confirms).toHaveLength(cards);
  expect(g.images).toBe(0);
});

test("a frame the model refuses keeps its reason on the shot and the batch goes on; a billing error stops it", async () => {
  const { w, g, project, dir } = await drafted();
  let calls = 0;
  const original = g.handler;
  g.handler = (call) => {
    if (call.body.includes("gemini-3.1-flash-image")) {
      calls += 1;
      if (calls === 2) return googleError(400, "image_safety", "That picture was blocked.");
    }
    return original(call);
  };
  const job = await runJob(w, "storyboard-frames", { project, shots: null });
  expect("status" in job && job.status).toBe("done");
  const list = await readShots(dir);
  expect(list?.shots.filter((each) => each.frame !== null)).toHaveLength(4);
  expect(list?.shots[1]?.frameError).toBe("That picture was blocked.");
  // Billing stops the whole batch and says so in words.
  g.handler = (call) =>
    call.body.includes("gemini-3.1-flash-image")
      ? googleError(400, "failed_precondition", "Billing is not enabled.")
      : original(call);
  const stopped = await runJob(w, "storyboard-frames", {
    project,
    shots: [list?.shots[1]?.id ?? ""],
  });
  expect("status" in stopped && stopped.status).toBe("failed");
  expect("error" in stopped ? stopped.error : "").toContain("paid tier");
});

test("split on a beat and join with the next keep the shots tiling the song", async () => {
  const { w, project, dir } = await drafted();
  const list = await readShots(dir);
  const second = list?.shots[1];
  const split = (await ask(w, "shot-edit", {}, { project, shot: second?.id, splitAt: 12.2 })) as {
    ok: boolean;
    view: StoryboardView;
  };
  expect(split.ok).toBe(true);
  expect(split.view.list?.shots).toHaveLength(6);
  expect(split.view.problems).toEqual([]);
  expect(split.view.list?.shots[1]?.endSec).toBe(12);
  expect(split.view.list?.shots[2]).toMatchObject({ startSec: 12, endSec: 16, text: "" });
  const merged = (await ask(w, "shot-edit", {}, { project, shot: second?.id, merge: true })) as {
    ok: boolean;
    view: StoryboardView;
  };
  expect(merged.view.list?.shots).toHaveLength(5);
  expect(merged.view.problems).toEqual([]);
  const refused = (await ask(
    w,
    "shot-edit",
    {},
    { project, shot: list?.shots[0]?.id, merge: true },
  )) as { ok: boolean; message: string };
  expect(refused.message).toContain("15 seconds");
});
