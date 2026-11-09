/**
 * The Gemini picture and clip requests, built from Google's pages (image
 * generation, Gemini Omni Flash, background execution, API errors), against a
 * faked fetch: no real call is made.
 */

import { expect, test } from "bun:test";
import { errorFrom } from "../engines/gemini";
import {
  decodeImage,
  decodeVideo,
  drawImage,
  fileIdOf,
  generateVideo,
  imageBody,
  resumeVideo,
  videoBody,
} from "../engines/gemini-video";
import { EngineError, type Fetch } from "../engines/types";
import { googleError, imageReply, interaction, PNG, videoReply } from "./video-world";

const CLIP = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 1, 2, 3]);
const PICTURE = { bytes: PNG, mime: "image/png" };
const OPTIONS = { intervalMs: 1, timeoutMs: 5000 };

type Seen = { url: string; method: string; body: string; headers: Headers };

function faked(answers: (seen: Seen, count: number) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetchFn: Fetch = async (url, init) => {
    const entry: Seen = {
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : "",
      headers: new Headers(init?.headers),
    };
    seen.push(entry);
    return await answers(entry, seen.length);
  };
  return { fetchFn, seen };
}

test("a frame is asked for as the docs say: the text, the cast as images, a 16:9 1K image", () => {
  const body = imageBody({
    prompt: "a street at night",
    references: [PICTURE, PICTURE],
    aspect: "16:9",
  });
  expect(body).toEqual({
    model: "gemini-3.1-flash-image",
    input: [
      { type: "text", text: "a street at night" },
      { type: "image", mime_type: "image/png", data: Buffer.from(PNG).toString("base64") },
      { type: "image", mime_type: "image/png", data: Buffer.from(PNG).toString("base64") },
    ],
    response_format: { type: "image", aspect_ratio: "16:9", image_size: "1K" },
  });
});

test("a clip is asked for with the frame and cast first, the prompt last, and the duration, aspect and resolution in response_format", () => {
  const body = videoBody({
    prompt: "walk to camera",
    references: [PICTURE],
    aspect: "16:9",
    seconds: 8,
    resolution: "720p",
  });
  expect(body).toEqual({
    model: "gemini-omni-1.2-flash",
    input: [
      { type: "image", mime_type: "image/png", data: Buffer.from(PNG).toString("base64") },
      { type: "text", text: "walk to camera" },
    ],
    response_format: {
      type: "video",
      aspect_ratio: "16:9",
      duration: "8s",
      resolution: "720p",
      delivery: "uri",
    },
    background: true,
  });
});

test("drawing a picture posts with the key and API revision, and decodes the picture from the model_output step", async () => {
  const { fetchFn, seen } = faked(() => imageReply());
  const picture = await drawImage(fetchFn, "g-key", { prompt: "x", references: [], aspect: "1:1" });
  expect(picture.mime).toBe("image/png");
  expect([...picture.bytes]).toEqual([...PNG]);
  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
  expect(seen[0]?.headers.get("x-goog-api-key")).toBe("g-key");
  expect(seen[0]?.headers.get("api-revision")).toBe("2026-05-20");
});

test("an answer with no picture says what the model said instead", () => {
  const body = interaction([{ type: "text", text: "I cannot draw that." }]);
  expect(() => decodeImage(body)).toThrow("I cannot draw that.");
  expect(() => decodeImage({ steps: [] })).toThrow(EngineError);
});

test("a clip that comes back inline is decoded from base64", async () => {
  const { fetchFn, seen } = faked(() => videoReply(CLIP));
  const bytes = await generateVideo(
    fetchFn,
    "k",
    { prompt: "p", references: [], aspect: "16:9", seconds: 4, resolution: "720p" },
    OPTIONS,
  );
  expect([...bytes]).toEqual([...CLIP]);
  expect(seen).toHaveLength(1);
});

test("a background call is polled with GET until it completes, and its id is reported once", async () => {
  const ids: string[] = [];
  const { fetchFn, seen } = faked((_entry, count) =>
    count === 1
      ? Response.json({ id: "v1_abc", status: "in_progress", steps: [] })
      : count < 4
        ? Response.json({ id: "v1_abc", status: "in_progress", steps: [] })
        : videoReply(CLIP),
  );
  const bytes = await generateVideo(
    fetchFn,
    "k",
    { prompt: "p", references: [PICTURE], aspect: "16:9", seconds: 4, resolution: "720p" },
    { ...OPTIONS, onStarted: (id) => ids.push(id) },
  );
  expect([...bytes]).toEqual([...CLIP]);
  expect(ids).toEqual(["v1_abc"]);
  expect(seen.map((each) => each.method)).toEqual(["POST", "GET", "GET", "GET"]);
  expect(seen[1]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions/v1_abc");
});

test("a clip delivered by uri waits for the file to be ACTIVE, then downloads it with the key", async () => {
  const uri = "https://generativelanguage.googleapis.com/v1beta/files/abc-123:download?alt=media";
  expect(fileIdOf(uri)).toBe("abc-123");
  let states = 0;
  const { fetchFn, seen } = faked((entry) => {
    if (entry.method === "POST")
      return Response.json(interaction([{ type: "video", mime_type: "video/mp4", uri }]));
    if (entry.url.endsWith("/files/abc-123")) {
      states += 1;
      return Response.json({ state: states < 3 ? "PROCESSING" : "ACTIVE" });
    }
    return new Response(CLIP);
  });
  const bytes = await generateVideo(
    fetchFn,
    "k",
    { prompt: "p", references: [], aspect: "16:9", seconds: 4, resolution: "720p" },
    OPTIONS,
  );
  expect([...bytes]).toEqual([...CLIP]);
  const download = seen.at(-1);
  expect(download?.url).toBe(
    "https://generativelanguage.googleapis.com/v1beta/files/abc-123:download?alt=media",
  );
  expect(download?.headers.get("x-goog-api-key")).toBe("k");
});

test("a file that FAILED is an error with words", async () => {
  const uri = "https://generativelanguage.googleapis.com/v1beta/files/zzz:download?alt=media";
  const { fetchFn } = faked((entry) =>
    entry.method === "POST"
      ? Response.json(interaction([{ type: "video", mime_type: "video/mp4", uri }]))
      : Response.json({ state: "FAILED" }),
  );
  await expect(
    generateVideo(
      fetchFn,
      "k",
      { prompt: "p", references: [], aspect: "16:9", seconds: 4, resolution: "720p" },
      OPTIONS,
    ),
  ).rejects.toThrow("could not process the video file");
});

test("an interaction that failed carries Google's code and message", async () => {
  const { fetchFn } = faked((_entry, count) =>
    count === 1
      ? Response.json({ id: "v1_f", status: "in_progress", steps: [] })
      : Response.json({
          id: "v1_f",
          status: "failed",
          error: { code: "safety", message: "The shot was blocked." },
          steps: [],
        }),
  );
  const caught = await generateVideo(
    fetchFn,
    "k",
    { prompt: "p", references: [], aspect: "16:9", seconds: 4, resolution: "720p" },
    OPTIONS,
  ).catch((each: unknown) => each);
  expect(caught).toBeInstanceOf(EngineError);
  expect((caught as EngineError).kind).toBe("blocked");
  expect((caught as EngineError).message).toBe("The shot was blocked.");
});

test("a completed answer with only text says what the model said", async () => {
  const { fetchFn } = faked(() =>
    Response.json(interaction([{ type: "text", text: "Not allowed." }])),
  );
  await expect(
    generateVideo(
      fetchFn,
      "k",
      { prompt: "p", references: [], aspect: "16:9", seconds: 4, resolution: "720p" },
      OPTIONS,
    ),
  ).rejects.toThrow("Not allowed.");
});

test("billing problems are told in words: failed_precondition, 402, and a 403 that names the free tier", () => {
  const precondition = errorFrom(
    400,
    JSON.stringify({
      error: { code: "failed_precondition", message: "Billing is not enabled for this project." },
    }),
  );
  expect(precondition.kind).toBe("billing");
  expect(precondition.message).toContain("paid tier");
  expect(precondition.message).toContain("Billing is not enabled");
  expect(
    errorFrom(
      402,
      JSON.stringify({ error: { code: "payment_required", message: "Credits are used up." } }),
    ).kind,
  ).toBe("billing");
  expect(
    errorFrom(
      403,
      JSON.stringify({
        error: {
          code: "permission_denied",
          message: "Video generation is not available on the free tier.",
        },
      }),
    ).kind,
  ).toBe("billing");
});

test("the other statuses keep their kinds: 401 auth, 403 auth, 429 credits, 500 http, a safety code blocked", () => {
  expect(errorFrom(401, "{}").kind).toBe("auth");
  expect(
    errorFrom(
      403,
      JSON.stringify({ error: { code: "permission_denied", message: "Key not valid." } }),
    ).kind,
  ).toBe("auth");
  expect(errorFrom(429, "{}").kind).toBe("credits");
  expect(errorFrom(500, "not json").kind).toBe("http");
  expect(
    errorFrom(400, JSON.stringify({ error: { code: "image_safety", message: "Blocked." } })).kind,
  ).toBe("blocked");
});

test("a rejected call surfaces Google's error, and drawing too", async () => {
  const { fetchFn } = faked(() => googleError(400, "failed_precondition", "Billing is off."));
  await expect(
    generateVideo(
      fetchFn,
      "k",
      { prompt: "p", references: [], aspect: "16:9", seconds: 4, resolution: "720p" },
      OPTIONS,
    ),
  ).rejects.toThrow("Billing is off.");
  await expect(
    drawImage(fetchFn, "k", { prompt: "x", references: [], aspect: "1:1" }),
  ).rejects.toMatchObject({ kind: "billing" });
});

test("cancelling while the call is polled cancels it at Google and stops", async () => {
  const abort = new AbortController();
  const { fetchFn, seen } = faked((entry, count) => {
    if (entry.url.endsWith("/cancel")) return Response.json({ status: "cancelled" });
    if (count === 2) abort.abort();
    return Response.json({ id: "v1_c", status: "in_progress", steps: [] });
  });
  const caught = await generateVideo(
    fetchFn,
    "k",
    { prompt: "p", references: [], aspect: "16:9", seconds: 4, resolution: "720p" },
    { ...OPTIONS, signal: abort.signal },
  ).catch((each: unknown) => each);
  expect((caught as Error).message).toBe("Cancelled.");
  expect(seen.at(-1)?.url).toBe(
    "https://generativelanguage.googleapis.com/v1beta/interactions/v1_c/cancel",
  );
});

test("a call that never finishes times out with words", async () => {
  const { fetchFn } = faked(() => Response.json({ id: "v1_t", status: "in_progress", steps: [] }));
  const caught = await generateVideo(
    fetchFn,
    "k",
    { prompt: "p", references: [], aspect: "16:9", seconds: 4, resolution: "720p" },
    { intervalMs: 1, timeoutMs: 20 },
  ).catch((each: unknown) => each);
  expect((caught as EngineError).kind).toBe("timeout");
});

test("a call started earlier is picked up by its id", async () => {
  const { fetchFn, seen } = faked((_entry, count) =>
    count === 1
      ? Response.json({ id: "v1_r", status: "in_progress", steps: [] })
      : videoReply(CLIP),
  );
  const bytes = await resumeVideo(fetchFn, "k", "v1_r", OPTIONS);
  expect([...bytes]).toEqual([...CLIP]);
  expect(seen[0]?.method).toBe("GET");
  expect(decodeVideo(interaction([{ type: "video", data: "AAAA" }]))).toEqual({ data: "AAAA" });
});
