/**
 * The Video session tools: the paid ones put dollars on the card and answer
 * the plain cancel text when the reader says no (nothing is called or made);
 * results are file paths; `video_render` in plan mode writes a job folder with
 * the inputs and an argv that really runs from that folder.
 */

import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readLedger, readShots, readTreatment } from "../project/video";
import { readTakes } from "../project/video-media";
import { CANCELLED } from "../tools";
import { spentUsd } from "../video/budget";
import { chosenProject, declineCards } from "./stage-world";
import {
  gemini,
  PNG,
  prepare,
  preparedProject,
  seedClips,
  seedShots,
  videoWorld,
} from "./video-world";

async function setup(clips: number[] = []) {
  const g = gemini();
  const w = videoWorld(g);
  const { project, dir } = await preparedProject(w);
  const list = await seedShots(dir);
  if (clips.length > 0) await seedClips(dir, list, clips);
  return { w, g, project, dir, list, cards: w.fake.confirms.length };
}

test("the five video tools are registered", () => {
  const names = videoWorld()
    .fake.tools()
    .map((tool) => tool.name);
  expect(names).toEqual(
    expect.arrayContaining([
      "video_treatment",
      "video_storyboard",
      "video_shoot",
      "video_edit",
      "video_render",
    ]),
  );
});

test("video_treatment sets the treatment, adds a cast picture from a file, and returns the paths", async () => {
  const { w, project, dir, cards } = await setup();
  const picture = join(dir, "mia.png");
  writeFileSync(picture, PNG);
  const text = await w.callTool("video_treatment", {
    project,
    concept: "A night drive",
    look: "neon",
    vertical: true,
    shotBars: 2,
    budgetUsd: 9,
    castFiles: [picture],
  });
  expect(text).toContain("Concept: A night drive");
  expect(text).toContain("Vertical cut: yes; shots of 2 bars.");
  expect(text).toContain("Budget: $0.00 spent of $9.00");
  expect(text).toContain(join(dir, "video", "treatment.json"));
  const treatment = await readTreatment(dir);
  expect(treatment.cast).toHaveLength(1);
  expect(text).toContain(join(dir, treatment.cast[0]?.file ?? "none"));
  expect(w.fake.confirms).toHaveLength(cards);
});

test("video_treatment draws a cast picture after a card that names the dollars; no is the plain cancel text", async () => {
  const { w, g, project, dir } = await setup();
  const text = await w.callTool("video_treatment", {
    project,
    castDraw: { name: "Mia", prompt: "a girl in a red coat" },
  });
  expect(w.fake.confirms.at(-1)?.summary).toContain("$0.07");
  expect(text).toContain("- cast ");
  expect(g.images).toBe(1);
  expect(spentUsd(await readLedger(dir))).toBeCloseTo(0.067);
  declineCards(w);
  expect(await w.callTool("video_treatment", { project, castDraw: { prompt: "another" } })).toBe(
    CANCELLED,
  );
  expect(g.images).toBe(1);
});

test("the video tools say what is missing: a tempo, a shot list", async () => {
  const w = videoWorld();
  const project = await chosenProject(w);
  expect(await w.callTool("video_treatment", { project })).toContain("Prepare");
  await prepare(w, project);
  expect(await w.callTool("video_shoot", { project })).toContain("no shot list");
  expect(await w.callTool("video_edit", { project })).toContain("no shot list");
  expect(await w.callTool("video_render", { project, mode: "plan" })).toContain("no shot list");
});

test("video_storyboard drafts the list, edits shots by number, draws frames after a dollar card, and lists the frame paths", async () => {
  const { w, g, project, dir } = await setup();
  w.fake.api.llm = {
    ask: async (request) => ({
      ok: true,
      text: JSON.stringify({
        shots: Array.from(
          { length: (request.prompt.match(/^\d+\./gm) ?? []).length },
          (_each, at) => `Shot ${at + 1}`,
        ),
      }),
      model: "m",
      backend: "claude",
    }),
  };
  const drafted = await w.callTool("video_storyboard", { project, draft: true, replace: true });
  expect(drafted).toContain("5 shots at 120 BPM");
  expect(drafted).toContain("1. [");
  expect(drafted).toContain("Intro 0:00-0:08: Shot 1");
  const edited = await w.callTool("video_storyboard", {
    project,
    edits: [
      { shot: 2, text: "A car on the bridge" },
      { shot: 1, splitAt: 4 },
    ],
  });
  expect(edited).toContain("6 shots");
  expect(edited).toContain("A car on the bridge");
  // The half that split off is blank, and a shot with no description cannot be drawn.
  expect(await w.callTool("video_storyboard", { project, draw: "missing" })).toContain(
    "no description",
  );
  await w.callTool("video_storyboard", {
    project,
    edits: [{ shot: 2, text: "A wide shot of the street" }],
  });
  const drawn = await w.callTool("video_storyboard", { project, draw: "missing" });
  expect(w.fake.confirms.at(-1)?.title).toBe("Draw 6 still frames");
  expect(w.fake.confirms.at(-1)?.summary).toContain("$0.40");
  expect(g.images).toBe(6);
  expect(drawn).toContain("frame /");
  for (const path of drawn
    .split("\n")
    .flatMap((line) => /frame (\/\S+\.png)/.exec(line)?.[1] ?? []))
    expect(existsSync(path)).toBe(true);
  expect((await readShots(dir))?.shots.every((each) => each.frame !== null)).toBe(true);
});

test("video_storyboard: draft over work needs replace, a bad shot number is named, and no is the plain cancel text", async () => {
  const { w, g, project } = await setup();
  const refused = await w.callTool("video_storyboard", { project, draft: true });
  expect(refused).toContain("replace: true");
  expect(
    await w.callTool("video_storyboard", { project, edits: [{ shot: 99, text: "x" }] }),
  ).toContain("no shot 99");
  expect(await w.callTool("video_storyboard", { project, draw: [42] })).toContain(
    "There is no shot 42",
  );
  declineCards(w);
  expect(await w.callTool("video_storyboard", { project, draw: [1] })).toBe(CANCELLED);
  expect(g.images).toBe(0);
});

test("video_shoot puts the dollars on the card, returns the take files and the spend; no is the plain cancel text", async () => {
  const { w, g, project, dir } = await setup();
  const text = await w.callTool("video_shoot", { project, shots: [1, 2], takes: 2 });
  const card = w.fake.confirms.at(-1);
  expect(card?.title).toBe("Shoot 4 takes");
  expect(card?.summary).toContain("$2.24");
  expect(text).toContain("Made 4 take(s), 0 failed.");
  expect(g.videos).toBe(4);
  const takes = await readTakes(dir);
  for (const take of takes) expect(text).toContain(join(dir, take.file ?? "none"));
  expect(text).toContain("Budget: $2.24 spent of $25.00");
  const chosen = await w.callTool("video_shoot", {
    project,
    choose: [{ shot: 1, take: takes.find((each) => each.n === 2)?.id }],
  });
  expect(chosen).toContain("(chosen)");
  expect(g.videos).toBe(4);
  declineCards(w);
  expect(await w.callTool("video_shoot", { project, shots: [3] })).toBe(CANCELLED);
  expect(g.videos).toBe(4);
});

test("video_shoot says when the budget stopped it", async () => {
  const { w, project } = await setup();
  await w.callTool("video_treatment", { project, budgetUsd: 1.2 });
  const text = await w.callTool("video_shoot", { project });
  expect(text).toContain("Made 2 take(s)");
  expect(text).toContain("Stopped at the budget: 3 take(s) were not shot.");
});

test("video_edit sets transitions by shot number, reports gaps, and renders the preview when asked", async () => {
  const { w, project, dir, cards } = await setup([0, 1]);
  const text = await w.callTool("video_edit", {
    project,
    shots: { 2: { transition: "flash", speed: "ramp" } },
    preview: true,
  });
  expect(text).toContain("2. 0:08-0:16 flash, ramp to 50%");
  expect(text).toContain("NO CLIP (black)");
  expect(text).toContain("Warning: 3 of 5 shots have no clip yet and will render black.");
  expect(text).toContain("Captions on, but this song has no sung words");
  const path = /Preview: (\S+\.mp4)/.exec(text)?.[1] ?? "";
  expect(path).toBe(join(dir, "video", "renders", "preview-1.mp4"));
  expect(existsSync(path)).toBe(true);
  expect(w.fake.confirms).toHaveLength(cards);
  expect(
    await w.callTool("video_edit", { project, shots: { 9: { transition: "cut" } } }),
  ).toContain("no shot 9");
});

test("video_render local asks on a card with the time and the load; no is the plain cancel text; yes returns the file", async () => {
  const { w, project, dir } = await setup([0, 1]);
  declineCards(w);
  expect(await w.callTool("video_render", { project, mode: "local" })).toBe(CANCELLED);
  expect(w.fake.confirms.at(-1)?.summary).toContain("keep the processor busy");
  expect(existsSync(join(dir, "video", "renders"))).toBe(false);
  const fresh = await setup([0, 1]);
  const text = await fresh.w.callTool("video_render", { project: fresh.project, mode: "local" });
  expect(text).toContain("Rendered final (30 s, 3 black shot(s)).");
  const path = /- (\S+\.mp4)/.exec(text)?.[1] ?? "";
  expect(existsSync(path)).toBe(true);
  expect(path).toEndWith("final-1.mp4");
});

test("video_render plan writes a job folder with the inputs and the exact ffmpeg argv, and renders nothing", async () => {
  const { w, project, dir, cards } = await setup([0, 1]);
  const text = await w.callTool("video_render", { project, mode: "plan", kind: "final" });
  const folder = /Job folder: (\S+)/.exec(text)?.[1] ?? "";
  expect(folder.startsWith(join(dir, "video", "jobs"))).toBe(true);
  expect(text).toContain(join(folder, "job.json"));
  expect(w.fake.confirms).toHaveLength(cards);
  const job = JSON.parse(readFileSync(join(folder, "job.json"), "utf8")) as {
    program: string;
    argv: string[];
    output: string;
  };
  expect(job.program).toBe("ffmpeg");
  expect(job.output).toBe("output/final.mp4");
  // Every path is relative to the folder and every input is in it.
  expect(job.argv.join(" ")).not.toContain(dir);
  const inputs = job.argv.flatMap((each, at) => (job.argv[at - 1] === "-i" ? [each] : []));
  expect(inputs.length).toBe(3);
  for (const input of inputs) expect(existsSync(join(folder, input))).toBe(true);
  expect(job.argv.filter((each) => each === "-an")).toHaveLength(2);
  expect(job.argv).toContain("[vout]");
  expect(job.argv.join(" ")).not.toContain("xfade");
  expect(job.argv.at(-1)).toBe("output/final.mp4");
  expect(existsSync(join(dir, "video", "renders"))).toBe(false);
  // The argv runs as written from that folder (tiny: the test studio's 160x90).
  const run = Bun.spawn(["ffmpeg", ...job.argv], {
    cwd: folder,
    stdout: "ignore",
    stderr: "pipe",
    windowsHide: true,
  });
  expect(await run.exited).toBe(0);
  expect(existsSync(join(folder, "output", "final.mp4"))).toBe(true);
});

test("video_render plan for the vertical cut keeps captions in the folder and cuts the audio from the range's start", async () => {
  const { w, project, dir, list } = await setup([0, 1, 2, 3, 4]);
  const file = join(dir, "sketches", "a.json");
  const record = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  writeFileSync(
    file,
    JSON.stringify({ ...record, timestamps: [{ word: "Hi", start_ms: 21_000, end_ms: 21_500 }] }),
  );
  await w.callTool("video_edit", { project, vertical: { startSec: 20, endSec: 30 } });
  const text = await w.callTool("video_render", { project, mode: "plan", kind: "vertical" });
  const folder = /Job folder: (\S+)/.exec(text)?.[1] ?? "";
  const job = JSON.parse(readFileSync(join(folder, "job.json"), "utf8")) as { argv: string[] };
  expect(job.argv).toContain("-ss");
  expect(job.argv[job.argv.indexOf("-ss") + 1]).toBe("20");
  expect(readFileSync(join(folder, "inputs", "captions.ass"), "utf8")).toContain("Dialogue:");
  expect(job.argv.join(" ")).toContain("ass=filename=inputs/captions.ass");
  expect(list.shots.length).toBe(5);
});
