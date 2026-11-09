/**
 * ElevenLabs: Music v2.5 through `/v1/music/detailed` (a multipart/mixed
 * answer: JSON metadata and the MP3) and the subscription's credits.
 */

import { boundaryOf, type Part, parseMultipart } from "./multipart";
import {
  asString,
  EngineError,
  type Fetch,
  isRecord,
  type Sketched,
  type SketchRequest,
} from "./types";

const BASE = "https://api.elevenlabs.io";

export const ELEVENLABS_MODEL = "music_v2_5";

/** The body `/v1/music/detailed` is sent for a prompt. */
export function detailedBody(request: SketchRequest): Record<string, unknown> {
  return {
    prompt: request.prompt,
    music_length_ms: request.lengthMs,
    model_id: ELEVENLABS_MODEL,
    force_instrumental: request.instrumental,
    store_for_inpainting: true,
    with_timestamps: true,
  };
}

/** The error an ElevenLabs reply that is not 200 stands for. */
export function errorFrom(status: number, text: string): EngineError {
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: the status line says enough.
  }
  const detail = isRecord(body) ? body["detail"] : null;
  const code = isRecord(detail) ? asString(detail["status"]) : null;
  const message =
    (isRecord(detail) ? asString(detail["message"]) : null) ??
    (typeof detail === "string" ? detail : null) ??
    `ElevenLabs answered ${status}.`;
  if (code === "bad_prompt") {
    const data = isRecord(detail) ? detail["data"] : null;
    const suggestion = isRecord(data) ? asString(data["prompt_suggestion"]) : null;
    return new EngineError("bad_prompt", message, suggestion);
  }
  if (status === 402 || code === "quota_exceeded") return new EngineError("credits", message);
  if (status === 401 || code === "invalid_api_key") return new EngineError("auth", message);
  return new EngineError("http", message);
}

function jsonPart(parts: Part[]): Record<string, unknown> {
  const part = parts.find((each) => (each.headers["content-type"] ?? "").includes("json"));
  if (part === undefined) throw new EngineError("bad_response", "ElevenLabs sent no JSON part.");
  const parsed: unknown = JSON.parse(new TextDecoder().decode(part.body));
  if (!isRecord(parsed))
    throw new EngineError("bad_response", "ElevenLabs' JSON part is not an object.");
  return parsed;
}

function audioPart(parts: Part[]): Uint8Array {
  const part = parts.find((each) => (each.headers["content-type"] ?? "").startsWith("audio/"));
  const found =
    part ?? parts.find((each) => !(each.headers["content-type"] ?? "").includes("json"));
  if (found === undefined || found.body.length === 0) {
    throw new EngineError("bad_response", "ElevenLabs sent no audio part.");
  }
  return found.body;
}

/** The title ElevenLabs gave the song (`song_metadata.title`), or null. */
function titleOf(json: Record<string, unknown>): string | null {
  const meta = json["song_metadata"];
  return isRecord(meta) ? asString(meta["title"]) : null;
}

/** Composes one 30-second (or any length) track; paid. */
export async function composeDetailed(
  fetchFn: Fetch,
  key: string,
  request: SketchRequest,
  signal?: AbortSignal,
): Promise<Sketched> {
  const response = await fetchFn(`${BASE}/v1/music/detailed`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json" },
    body: JSON.stringify(detailedBody(request)),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw errorFrom(response.status, await response.text());
  const boundary = boundaryOf(response.headers.get("content-type"));
  if (boundary === null)
    throw new EngineError("bad_response", "ElevenLabs' reply is not multipart.");
  const parts = parseMultipart(new Uint8Array(await response.arrayBuffer()), boundary);
  const json = jsonPart(parts);
  const plan = json["composition_plan"] ?? null;
  return {
    audio: audioPart(parts),
    ext: "mp3",
    // The song id comes only in the response header `song-id`; the JSON has none.
    songId: response.headers.get("song-id"),
    plan,
    timestamps: json["words_timestamps"] ?? null,
    title: titleOf(json),
    lyrics: linesOf(plan),
  };
}

const SECTION_TAG = /^\s*\[[^\]]*\]\s*$/;

/** The lyrics in a composition plan's chunks, as text; null for an instrumental (chunks that are only a section tag). */
export function linesOf(plan: unknown): string | null {
  const chunks = isRecord(plan) ? plan["chunks"] : null;
  if (!Array.isArray(chunks)) return null;
  const texts = chunks
    .map((chunk) => (isRecord(chunk) ? asString(chunk["text"]) : null))
    .filter((text): text is string => text !== null)
    .filter((text) =>
      text.split("\n").some((line) => line.trim() !== "" && !SECTION_TAG.test(line)),
    );
  return texts.length === 0 ? null : texts.join("\n\n");
}

export type Credits = { left: number; limit: number; used: number; tier: string };

/** The credits the subscription has left (`character_limit` less `character_count`). Free. */
export async function credits(fetchFn: Fetch, key: string, signal?: AbortSignal): Promise<Credits> {
  const response = await fetchFn(`${BASE}/v1/user/subscription`, {
    headers: { "xi-api-key": key },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw errorFrom(response.status, await response.text());
  const body: unknown = await response.json();
  if (!isRecord(body))
    throw new EngineError("bad_response", "ElevenLabs' subscription is not an object.");
  const used = body["character_count"];
  const limit = body["character_limit"];
  if (typeof used !== "number" || typeof limit !== "number") {
    throw new EngineError("bad_response", "ElevenLabs' subscription lacks the character counts.");
  }
  return {
    left: Math.max(0, limit - used),
    limit,
    used,
    tier: asString(body["tier"]) ?? "unknown",
  };
}
