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
  if (status === 401 || code === "invalid_api_key") return new EngineError("auth", message);
  if (status === 402 || code === "quota_exceeded") return new EngineError("credits", message);
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

/** The song id: in the JSON (top level or `song_metadata`), else in a header of the reply or the audio part. */
function songIdOf(json: Record<string, unknown>, response: Response, parts: Part[]): string | null {
  const meta = json["song_metadata"];
  return (
    asString(json["song_id"]) ??
    (isRecord(meta) ? asString(meta["song_id"]) : null) ??
    response.headers.get("song-id") ??
    parts.map((part) => part.headers["song-id"]).find((id) => id !== undefined) ??
    null
  );
}

/** The word timestamps, under whichever key the JSON carries them. */
function timestampsOf(json: Record<string, unknown>): unknown {
  return json["words_timestamps"] ?? json["timestamps"] ?? json["word_timestamps"] ?? null;
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
    songId: songIdOf(json, response, parts),
    plan,
    timestamps: timestampsOf(json),
    lyrics: linesOf(plan),
  };
}

/** The lyric lines of a composition plan, as text, or null when it has none. */
export function linesOf(plan: unknown): string | null {
  if (!isRecord(plan)) return null;
  const sections = plan["sections"];
  if (!Array.isArray(sections)) return null;
  const out: string[] = [];
  for (const section of sections) {
    if (!isRecord(section) || !Array.isArray(section["lines"])) continue;
    const lines = section["lines"].filter((line): line is string => typeof line === "string");
    if (lines.length === 0) continue;
    const name = asString(section["section_name"]);
    out.push(name === null ? lines.join("\n") : `[${name}]\n${lines.join("\n")}`);
  }
  return out.length === 0 ? null : out.join("\n\n");
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
