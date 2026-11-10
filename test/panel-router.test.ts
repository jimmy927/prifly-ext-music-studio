import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { route } from "../panel-router";
import type { Job } from "../studio";
import { AUDIO, BRIEF, detailedReply, happy, subscription, world } from "./world";

const ask = (
  w: ReturnType<typeof world>,
  path: string,
  query: Record<string, string> = {},
  body: unknown = null,
) => route(w.studio, { path, query: { session: "docked-session", ...query }, body });

/** Waits until the job is no longer running. */
async function finished(w: ReturnType<typeof world>, id: string): Promise<Job> {
  for (let tries = 0; tries < 200; tries += 1) {
    const job = (await ask(w, "job", { id })) as Job;
    if (job.status !== "running") return job;
    await Bun.sleep(5);
  }
  throw new Error("the job never finished");
}

type Started = { ok: true; job: Job } | { ok: false; reason: string; message: string };

test("status shows the keys and the credits left", async () => {
  const w = world(happy);
  const status = (await ask(w, "status")) as {
    elevenlabs: { keySet: boolean; credits: { left: number } };
    gemini: { keySet: boolean };
    library: string;
  };
  expect(status.elevenlabs.keySet).toBe(true);
  expect(status.elevenlabs.credits.left).toBe(39000);
  expect(status.gemini.keySet).toBe(true);
  expect(status.library).toBe(w.folder);
});

test("status with no keys makes no request and says both are missing", async () => {
  const w = world(happy, { keys: {} });
  const status = (await ask(w, "status")) as {
    elevenlabs: { keySet: boolean };
    gemini: { keySet: boolean };
  };
  expect(status.elevenlabs.keySet).toBe(false);
  expect(status.gemini.keySet).toBe(false);
  expect(w.calls).toHaveLength(0);
});

test("the library starts empty", async () => {
  const w = world(happy);
  expect(await ask(w, "library")).toEqual({ projects: [] });
});

test("Sketch 3 ideas: one confirm card with the cost, three sketches, playable, one chosen", async () => {
  const w = world(happy);
  const started = (await ask(w, "sketch", {}, BRIEF)) as Started;
  if (!started.ok) throw new Error(started.message);
  expect(w.fake.confirms).toHaveLength(1);
  expect(w.fake.confirms[0]?.title).toBe("Sketch 3 ideas");
  expect(w.fake.confirms[0]?.summary).toContain("billed by ElevenLabs to your plan");
  expect(w.fake.confirms[0]?.summary).toContain("no per-track price");
  const job = await finished(w, started.job.id);
  expect(job.status).toBe("done");
  expect(job.done).toEqual(["a", "b", "c"]);
  expect(w.calls.filter((c) => c.url.endsWith("/v1/music/detailed"))).toHaveLength(3);

  const project = (await ask(w, "project", { id: job.project ?? "" })) as {
    sketchList: { id: string }[];
    folder: string;
  };
  expect(project.sketchList.map((s) => s.id)).toEqual(["a", "b", "c"]);
  expect(existsSync(`${project.folder}/brief.json`)).toBe(true);
  expect(existsSync(`${project.folder}/sketches/b.mp3`)).toBe(true);
  expect(existsSync(`${project.folder}/sketches/b.json`)).toBe(true);

  const media = (await ask(w, "media", { project: job.project ?? "", sketch: "b" })) as {
    mime: string;
    base64: string;
  };
  expect(media.mime).toBe("audio/mpeg");
  expect(Array.from(Buffer.from(media.base64, "base64"))).toEqual(Array.from(AUDIO));

  const chosen = (await ask(w, "choose", {}, { project: job.project, sketch: "c" })) as {
    chosen: string;
  };
  expect(chosen.chosen).toBe("c");
  const listed = (await ask(w, "library")) as {
    projects: { title: string; engine: string; chosen: string }[];
  };
  expect(listed.projects).toHaveLength(1);
  expect(listed.projects[0]).toMatchObject({
    engine: "elevenlabs",
    chosen: "c",
    title: "A dusty lo-fi beat for studying",
  });
});

test("library search matches title, engine and brief words", async () => {
  const w = world(happy);
  for (const text of ["A dusty lo-fi beat", "Thumping techno for a club"]) {
    const started = (await ask(w, "sketch", {}, { text })) as Started;
    if (started.ok) await finished(w, started.job.id);
  }
  const names = async (q: string) =>
    ((await ask(w, "library", { q })) as { projects: { title: string }[] }).projects.map(
      (p) => p.title,
    );
  expect(await names("")).toHaveLength(2);
  expect(await names("techno")).toEqual(["Thumping techno for a club"]);
  expect(await names("elevenlabs club")).toEqual(["Thumping techno for a club"]);
  expect(await names("nothing like this")).toEqual([]);
});

test("a cancelled confirm card spends nothing and keeps no project", async () => {
  const w = world(happy, { confirm: false });
  const answer = (await ask(w, "sketch", {}, BRIEF)) as Started;
  expect(answer).toMatchObject({ ok: false, reason: "cancelled" });
  expect(w.calls.some((c) => c.url.endsWith("/v1/music/detailed"))).toBe(false);
  expect(await ask(w, "library")).toEqual({ projects: [] });
});

test("no key: the answer points at Settings and nothing is asked or sent", async () => {
  const w = world(happy, { keys: { geminiKey: "g" } });
  const answer = (await ask(w, "sketch", {}, BRIEF)) as Started;
  expect(answer).toMatchObject({ ok: false, reason: "no_key" });
  expect((answer as { message: string }).message).toContain("Settings → Extensions");
  expect(w.fake.confirms).toHaveLength(0);
  expect(w.calls).toHaveLength(0);
});

test("low credits are information only: the card is still asked and the run goes on", async () => {
  const w = world((call) =>
    call.url.endsWith("/v1/user/subscription") ? subscription(39990, 40000) : detailedReply(),
  );
  const answer = (await ask(w, "sketch", {}, BRIEF)) as Started;
  if (!answer.ok) throw new Error(answer.message);
  expect(w.fake.confirms).toHaveLength(1);
  expect((await finished(w, answer.job.id)).status).toBe("done");
});

test("when ElevenLabs itself says the credits are gone, the job fails with its message", async () => {
  const w = world(() =>
    Response.json(
      { detail: { status: "quota_exceeded", message: "Out of credits." } },
      { status: 401 },
    ),
  );
  const started = (await ask(w, "sketch", {}, BRIEF)) as Started;
  if (!started.ok) throw new Error(started.message);
  const job = await finished(w, started.job.id);
  expect(job).toMatchObject({
    status: "failed",
    kind: "credits",
    error: "Out of credits.",
    project: null,
  });
});

test("a refused prompt ends the job with ElevenLabs' suggestion and leaves no project", async () => {
  const w = world((call) => {
    if (call.url.endsWith("/v1/user/subscription")) return subscription(0, 40000);
    return Response.json(
      {
        detail: {
          status: "bad_prompt",
          message: "Copyrighted.",
          data: { prompt_suggestion: "An epic rock ballad." },
        },
      },
      { status: 422 },
    );
  });
  const started = (await ask(
    w,
    "sketch",
    {},
    { text: "Sounds like Bohemian Rhapsody" },
  )) as Started;
  if (!started.ok) throw new Error(started.message);
  const job = await finished(w, started.job.id);
  expect(job).toMatchObject({
    status: "failed",
    kind: "bad_prompt",
    suggestion: "An epic rock ballad.",
    project: null,
  });
  expect(await ask(w, "library")).toEqual({ projects: [] });
});

test("Cancel stops a running job and drops the empty project", async () => {
  const w = world((call) => {
    if (call.url.endsWith("/v1/user/subscription")) return subscription(0, 40000);
    return new Promise<Response>((_, reject) => {
      call.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
    });
  });
  const started = (await ask(w, "sketch", {}, BRIEF)) as Started;
  if (!started.ok) throw new Error(started.message);
  expect(((await ask(w, "job", { id: started.job.id })) as Job).status).toBe("running");
  expect(await ask(w, "cancel", {}, { job: started.job.id })).toEqual({ ok: true });
  const job = await finished(w, started.job.id);
  expect(job.status).toBe("cancelled");
  expect(job.project).toBeNull();
  expect(await ask(w, "library")).toEqual({ projects: [] });
});

test("Lyria sketches use the Gemini key and the Interactions endpoint", async () => {
  const w = world(happy);
  const started = (await ask(w, "sketch", {}, { ...BRIEF, engine: "lyria-clip" })) as Started;
  if (!started.ok) throw new Error(started.message);
  expect((await finished(w, started.job.id)).done).toEqual(["a", "b", "c"]);
  expect(w.calls.every((c) => c.url.endsWith("/v1beta/interactions"))).toBe(true);
  expect(w.fake.confirms[0]?.summary).toContain("Gemini key");
});

test("an invalid brief is refused, and ids that are not ids reach no file", async () => {
  const w = world(happy);
  expect(await ask(w, "sketch", {}, { text: "  " })).toMatchObject({
    ok: false,
    reason: "invalid",
  });
  expect(await ask(w, "sketch", {}, { text: "x", vocals: "mine" })).toMatchObject({
    ok: false,
    reason: "invalid",
  });
  await expect(ask(w, "project", { id: "../../etc" })).rejects.toThrow("No such project");
  await expect(ask(w, "media", { project: "..", sketch: "a" })).rejects.toThrow("No such project");
  await expect(ask(w, "nothing")).rejects.toThrow("No such route");
});
