/**
 * Gemini: Lyria 3 Clip (30 s) and Lyria 3.5 through the Interactions API
 * (https://aistudio.google.com/docs/music-generation). The answer holds
 * `steps`; the `model_output` ones carry `content` blocks, `audio` (base64
 * `data`) and `text` (the lyrics or a description of the structure).
 */

import {
  asString,
  EngineError,
  type Fetch,
  isRecord,
  type Sketched,
  type SketchRequest,
} from "./types";

export const URL_INTERACTIONS = "https://generativelanguage.googleapis.com/v1beta/interactions";
export const API_REVISION = "2026-05-20";

/** The headers every Interactions API call carries. */
export const geminiHeaders = (key: string): Record<string, string> => ({
  "x-goog-api-key": key,
  "api-revision": API_REVISION,
  "content-type": "application/json",
});

export type LyriaModel = "lyria-3-clip-preview" | "lyria-3.5";

/** The text Lyria is asked: it has no instrumental switch, so the prompt says so. */
export function lyriaInput(request: SketchRequest): string {
  return request.instrumental ? `${request.prompt}\nInstrumental only, no vocals.` : request.prompt;
}

/** Error codes with which Google says the project cannot pay: billing off, or the free tier. */
const BILLING_CODES = new Set(["failed_precondition", "payment_required"]);
/** Error codes with which Google says a safety or content rule stopped the output. */
const BLOCKED_CODES = new Set([
  "safety",
  "recitation",
  "language",
  "prohibited_content",
  "spii",
  "blocklist",
  "image_safety",
  "image_prohibited_content",
  "image_recitation",
  "image_other",
  "content_blocked",
  "no_image",
]);

const BILLING_WORDS = /billing|paid tier|free tier|prepay|credit balance/i;

/** Google's `error` object, `{ code, message }`, from a reply body or an interaction. */
export function errorFields(body: unknown): { code: string | null; message: string | null } {
  const error = isRecord(body) ? body["error"] : null;
  if (!isRecord(error)) return { code: null, message: null };
  return { code: asString(error["code"]), message: asString(error["message"]) };
}

/** The error a Gemini failure stands for: an HTTP status with the body, or an interaction's own `error`. */
export function errorOf(status: number, code: string | null, text: string | null): EngineError {
  const message = text ?? `Gemini answered ${status}.`;
  if (code !== null && BLOCKED_CODES.has(code)) return new EngineError("blocked", message);
  const billing =
    (code !== null && BILLING_CODES.has(code)) ||
    status === 402 ||
    ((status === 400 || status === 403) && BILLING_WORDS.test(message));
  if (billing) {
    return new EngineError(
      "billing",
      `This Gemini key cannot pay for the call: video and image generation need a paid tier (billing turned on) in Google AI Studio. Google says: ${message}`,
    );
  }
  if (status === 401 || status === 403) return new EngineError("auth", message);
  if (status === 429) return new EngineError("credits", message);
  return new EngineError("http", message);
}

/** The error a Gemini reply that is not 200 stands for. */
export function errorFrom(status: number, text: string): EngineError {
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: the status line says enough.
  }
  const { code, message } = errorFields(body);
  return errorOf(status, code, message);
}

/** The content blocks of an answer's `model_output` steps, in order. */
function outputBlocks(body: unknown): Record<string, unknown>[] {
  const steps = isRecord(body) ? body["steps"] : null;
  if (!Array.isArray(steps)) throw new EngineError("bad_response", "Gemini's answer has no steps.");
  return steps
    .filter(isRecord)
    .filter((step) => step["type"] === "model_output" && Array.isArray(step["content"]))
    .flatMap((step) => (step["content"] as unknown[]).filter(isRecord));
}

/** The audio and the text of an answer's `model_output` steps. */
export function decodeInteraction(body: unknown): { audio: Uint8Array; text: string } {
  const blocks = outputBlocks(body);
  const data = blocks
    .filter((block) => block["type"] === "audio")
    .map((block) => asString(block["data"]))
    .findLast((each) => each !== null);
  if (data === undefined || data === null) {
    throw new EngineError("bad_response", "Gemini's answer holds no audio.");
  }
  const texts = blocks
    .filter((block) => block["type"] === "text")
    .map((block) => asString(block["text"]))
    .filter((each): each is string => each !== null);
  return { audio: new Uint8Array(Buffer.from(data, "base64")), text: texts.join("\n") };
}

/** Generates one track with Lyria; paid on the key's billing. */
export async function lyria(
  fetchFn: Fetch,
  key: string,
  model: LyriaModel,
  request: SketchRequest,
  signal?: AbortSignal,
): Promise<Sketched> {
  const response = await fetchFn(URL_INTERACTIONS, {
    method: "POST",
    headers: geminiHeaders(key),
    body: JSON.stringify({ model, input: lyriaInput(request) }),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw errorFrom(response.status, await response.text());
  const { audio, text } = decodeInteraction(await response.json());
  return {
    audio,
    ext: "mp3",
    songId: null,
    plan: text === "" ? null : { text },
    timestamps: null,
    title: null,
    lyrics: text === "" ? null : text,
  };
}
