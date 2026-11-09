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

const URL_INTERACTIONS = "https://generativelanguage.googleapis.com/v1beta/interactions";
const API_REVISION = "2026-05-20";

export type LyriaModel = "lyria-3-clip-preview" | "lyria-3.5";

/** The text Lyria is asked: it has no instrumental switch, so the prompt says so. */
export function lyriaInput(request: SketchRequest): string {
  return request.instrumental ? `${request.prompt}\nInstrumental only, no vocals.` : request.prompt;
}

/** The error a Gemini reply that is not 200 stands for. */
export function errorFrom(status: number, text: string): EngineError {
  let message = `Gemini answered ${status}.`;
  try {
    const body: unknown = JSON.parse(text);
    const error = isRecord(body) ? body["error"] : null;
    if (isRecord(error)) message = asString(error["message"]) ?? message;
  } catch {
    // Not JSON: the status line says enough.
  }
  if (status === 401 || status === 403) return new EngineError("auth", message);
  if (status === 429) return new EngineError("credits", message);
  return new EngineError("http", message);
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
    headers: {
      "x-goog-api-key": key,
      "api-revision": API_REVISION,
      "content-type": "application/json",
    },
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
    lyrics: text === "" ? null : text,
  };
}
