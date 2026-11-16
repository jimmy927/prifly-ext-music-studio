/**
 * Gemini pictures and video through the Interactions API, the same endpoint
 * Lyria uses (engines/gemini.ts). Built from Google's pages, read 2026-11-09:
 *
 * - Image (https://aistudio.google.com/docs/image-generation): `input` is a
 *   list of `{type:"text"}` and `{type:"image", mime_type, data}` blocks;
 *   `response_format` is `{type:"image", aspect_ratio, image_size}`; the
 *   picture is a `{type:"image", mime_type, data}` block in a `model_output`
 *   step.
 * - Video (https://aistudio.google.com/docs/omni): the same, with
 *   `response_format` `{type:"video", aspect_ratio, duration:"8s",
 *   resolution, delivery}`. Images in `input` are the first frame and the
 *   references (up to 6); the prompt says in words how each is used. The
 *   video comes back as base64 `data` or, with `delivery:"uri"`, a Google file
 *   `uri` to poll (`files/<id>` until `ACTIVE`) and download. With
 *   `background:true` the answer is `status:"in_progress"` and the finished
 *   interaction is read with `GET /interactions/<id>` (which returns the video
 *   inline); `POST /interactions/<id>/cancel` stops it.
 * - Errors are `{error:{code, message}}`; billing problems come as
 *   `failed_precondition`, `payment_required` or a 402/403 that names billing.
 */

import { IMAGE_MODEL, type Resolution, VIDEO_MODEL } from "../video/constants";
import { errorFields, errorFrom, errorOf, geminiHeaders, URL_INTERACTIONS } from "./gemini";
import { asString, EngineError, type Fetch, isRecord } from "./types";

const URL_FILES = "https://generativelanguage.googleapis.com/v1beta/files";

/** A picture as bytes and its type. */
export type Picture = { bytes: Uint8Array; mime: string };

export type Aspect = "16:9" | "9:16" | "1:1";

export type ImageRequest = {
  prompt: string;
  /** Pictures the model keeps consistent: the cast. */
  references: Picture[];
  aspect: Aspect;
};

function imageBlock(picture: Picture): Record<string, string> {
  return {
    type: "image",
    mime_type: picture.mime,
    data: Buffer.from(picture.bytes).toString("base64"),
  };
}

/** The body for one still frame or cast picture. */
export function imageBody(request: ImageRequest): Record<string, unknown> {
  return {
    model: IMAGE_MODEL,
    input: [{ type: "text", text: request.prompt }, ...request.references.map(imageBlock)],
    response_format: { type: "image", aspect_ratio: request.aspect, image_size: "1K" },
  };
}

/** The content blocks of an answer's `model_output` steps, in order. */
function outputBlocks(body: unknown): Record<string, unknown>[] {
  const steps = isRecord(body) ? body["steps"] : null;
  if (!Array.isArray(steps)) return [];
  return steps
    .filter(isRecord)
    .filter((step) => step["type"] === "model_output" && Array.isArray(step["content"]))
    .flatMap((step) => (step["content"] as unknown[]).filter(isRecord));
}

export const textOf = (body: unknown): string =>
  outputBlocks(body)
    .filter((block) => block["type"] === "text")
    .map((block) => asString(block["text"]))
    .filter((each): each is string => each !== null)
    .join(" ");

/** The last picture of an answer. */
export function decodeImage(body: unknown): Picture {
  const block = outputBlocks(body)
    .filter((each) => each["type"] === "image")
    .findLast((each) => asString(each["data"]) !== null);
  const data = block === undefined ? null : asString(block["data"]);
  if (block === undefined || data === null) {
    const said = textOf(body);
    throw new EngineError(
      "blocked",
      said === ""
        ? "Gemini's answer holds no picture."
        : `Gemini drew no picture. It said: ${said}`,
    );
  }
  return {
    bytes: new Uint8Array(Buffer.from(data, "base64")),
    mime: asString(block["mime_type"]) ?? "image/png",
  };
}

/** Draws one picture; paid on the key's billing. */
export async function drawImage(
  fetchFn: Fetch,
  key: string,
  request: ImageRequest,
  signal?: AbortSignal,
): Promise<Picture> {
  const response = await fetchFn(URL_INTERACTIONS, {
    method: "POST",
    headers: geminiHeaders(key),
    body: JSON.stringify(imageBody(request)),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw errorFrom(response.status, await response.text());
  const body: unknown = await response.json();
  const failure = interactionError(body);
  if (failure !== null) throw failure;
  return decodeImage(body);
}

export type VideoRequest = {
  prompt: string;
  /** The shot's still frame first, then the cast. */
  references: Picture[];
  aspect: "16:9" | "9:16";
  /** Whole seconds, 3 to 15. */
  seconds: number;
  resolution: Resolution;
};

/** The body for one clip. */
export function videoBody(request: VideoRequest): Record<string, unknown> {
  return {
    model: VIDEO_MODEL,
    input: [...request.references.map(imageBlock), { type: "text", text: request.prompt }],
    response_format: {
      type: "video",
      aspect_ratio: request.aspect,
      duration: `${request.seconds}s`,
      resolution: request.resolution,
      delivery: "uri",
    },
    background: true,
  };
}

/** The error an interaction that did not complete stands for, or null when it did not fail. */
export function interactionError(body: unknown): EngineError | null {
  const status = isRecord(body) ? body["status"] : null;
  const { code, message } = errorFields(body);
  if (status === "failed" || status === "cancelled" || (code !== null && status !== "completed")) {
    if (status === "cancelled" && message === null)
      return new EngineError("http", "Google stopped the run before it finished.");
    return errorOf(400, code, message ?? "Google reported that the run failed.");
  }
  return null;
}

export type VideoFound = { data: string } | { uri: string } | null;

/** The video block of a completed interaction: inline base64, or a file `uri`. */
export function decodeVideo(body: unknown): VideoFound {
  const block = outputBlocks(body)
    .filter((each) => each["type"] === "video")
    .findLast((each) => asString(each["data"]) !== null || asString(each["uri"]) !== null);
  if (block === undefined) return null;
  const data = asString(block["data"]);
  if (data !== null) return { data };
  const uri = asString(block["uri"]);
  return uri === null ? null : { uri };
}

export type VideoOptions = {
  signal?: AbortSignal;
  /** Milliseconds between two polls. */
  intervalMs: number;
  /** Give up after this long. */
  timeoutMs: number;
  /** Told the interaction's id once Google has accepted the call, so a restart can find the clip. */
  onStarted?: (id: string) => void;
};

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** A function, so a check after an await is not narrowed by one before it. */
const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

function stopError(): Error {
  return new Error("Cancelled.");
}

async function getJson(
  fetchFn: Fetch,
  key: string,
  url: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetchFn(url, {
    method: "GET",
    headers: geminiHeaders(key),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw errorFrom(response.status, await response.text());
  return await response.json();
}

/** Stops the interaction at Google; best effort, a failure is not worth reporting. */
async function cancelRemote(fetchFn: Fetch, key: string, id: string): Promise<void> {
  try {
    await fetchFn(`${URL_INTERACTIONS}/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      headers: geminiHeaders(key),
    });
  } catch {
    // Nothing to do: the local run is over either way.
  }
}

const isRunning = (body: unknown): boolean => {
  const status = isRecord(body) ? body["status"] : null;
  return status === "in_progress" || status === "queued" || status === "requires_action";
};

/** Polls an interaction until it is no longer running. */
export async function waitForInteraction(
  fetchFn: Fetch,
  key: string,
  first: unknown,
  options: VideoOptions,
): Promise<unknown> {
  const id = isRecord(first) ? asString(first["id"]) : null;
  let body = first;
  const until = Date.now() + options.timeoutMs;
  while (isRunning(body)) {
    if (id === null)
      throw new EngineError("bad_response", "Google's answer has no interaction id.");
    if (isAborted(options.signal)) {
      await cancelRemote(fetchFn, key, id);
      throw stopError();
    }
    if (Date.now() > until)
      throw new EngineError(
        "timeout",
        "Google took too long to make the clip. Try the take again.",
      );
    await sleep(options.intervalMs, options.signal);
    if (isAborted(options.signal)) continue;
    body = await getJson(
      fetchFn,
      key,
      `${URL_INTERACTIONS}/${encodeURIComponent(id)}`,
      options.signal,
    );
  }
  return body;
}

/** The id of a Google file from its `uri` ("…/v1beta/files/abc-123:download?alt=media" is "abc-123"). */
export function fileIdOf(uri: string): string | null {
  const match = /\/files\/([A-Za-z0-9_-]+)/.exec(uri);
  return match?.[1] ?? null;
}

/** Waits for a delivered file to be `ACTIVE`, then downloads it. */
async function downloadVideo(
  fetchFn: Fetch,
  key: string,
  uri: string,
  options: VideoOptions,
): Promise<Uint8Array> {
  const id = fileIdOf(uri);
  if (id === null) throw new EngineError("bad_response", "Google's video address is not a file.");
  const until = Date.now() + options.timeoutMs;
  for (;;) {
    const file = await getJson(fetchFn, key, `${URL_FILES}/${id}`, options.signal);
    const state = isRecord(file) ? file["state"] : null;
    if (state === "ACTIVE") break;
    if (state === "FAILED")
      throw new EngineError("http", "Google could not process the video file.");
    if (isAborted(options.signal)) throw stopError();
    if (Date.now() > until)
      throw new EngineError("timeout", "Google took too long to prepare the video file.");
    await sleep(options.intervalMs, options.signal);
  }
  const response = await fetchFn(`${URL_FILES}/${id}:download?alt=media`, {
    method: "GET",
    headers: { "x-goog-api-key": key },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!response.ok) throw errorFrom(response.status, await response.text());
  return new Uint8Array(await response.arrayBuffer());
}

/** The video of a finished interaction, as bytes. */
export async function videoOf(
  fetchFn: Fetch,
  key: string,
  body: unknown,
  options: VideoOptions,
): Promise<Uint8Array> {
  const failure = interactionError(body);
  if (failure !== null) throw failure;
  const found = decodeVideo(body);
  if (found === null) {
    const said = textOf(body);
    throw new EngineError(
      "blocked",
      said === "" ? "Gemini's answer holds no video." : `Gemini made no video. It said: ${said}`,
    );
  }
  if ("data" in found) return new Uint8Array(Buffer.from(found.data, "base64"));
  return await downloadVideo(fetchFn, key, found.uri, options);
}

/** Makes one clip: starts the call, polls it until it is done, and returns the MP4's bytes. Paid. */
export async function generateVideo(
  fetchFn: Fetch,
  key: string,
  request: VideoRequest,
  options: VideoOptions,
): Promise<Uint8Array> {
  const response = await fetchFn(URL_INTERACTIONS, {
    method: "POST",
    headers: geminiHeaders(key),
    body: JSON.stringify(videoBody(request)),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!response.ok) throw errorFrom(response.status, await response.text());
  const first: unknown = await response.json();
  const id = isRecord(first) ? asString(first["id"]) : null;
  if (id !== null) options.onStarted?.(id);
  const done = await waitForInteraction(fetchFn, key, first, options);
  return await videoOf(fetchFn, key, done, options);
}

/** Picks up a call that was started earlier (after a restart): polls it and downloads the clip. */
export async function resumeVideo(
  fetchFn: Fetch,
  key: string,
  id: string,
  options: VideoOptions,
): Promise<Uint8Array> {
  const first = await getJson(
    fetchFn,
    key,
    `${URL_INTERACTIONS}/${encodeURIComponent(id)}`,
    options.signal,
  );
  const done = await waitForInteraction(fetchFn, key, first, options);
  return await videoOf(fetchFn, key, done, options);
}
