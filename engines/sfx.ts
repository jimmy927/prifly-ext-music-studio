/** ElevenLabs sound effects: `POST /v1/sound-generation`, text in, one MP3 out. */

import { errorFrom } from "./elevenlabs";
import { EngineError, type Fetch } from "./types";

const BASE = "https://api.elevenlabs.io";

export const SFX_MODEL = "eleven_text_to_sound_v2";
export const SFX_MIN_SEC = 0.5;
export const SFX_MAX_SEC = 30;

export type SfxRequest = {
  text: string;
  durationSec: number;
  loop: boolean;
  /** 0 to 1; higher follows the prompt more closely. */
  promptInfluence: number;
};

/** The body `/v1/sound-generation` is sent. */
export function sfxBody(request: SfxRequest): Record<string, unknown> {
  return {
    text: request.text,
    duration_seconds: request.durationSec,
    loop: request.loop,
    prompt_influence: request.promptInfluence,
    model_id: SFX_MODEL,
  };
}

/** Why a request cannot be sent, or null. */
export function sfxProblem(request: SfxRequest): string | null {
  if (request.text.trim() === "") return "Describe the sound first.";
  if (
    !Number.isFinite(request.durationSec) ||
    request.durationSec < SFX_MIN_SEC ||
    request.durationSec > SFX_MAX_SEC
  )
    return `A sound effect lasts ${SFX_MIN_SEC} to ${SFX_MAX_SEC} seconds.`;
  return null;
}

/** Makes one sound effect; paid. */
export async function soundEffect(
  fetchFn: Fetch,
  key: string,
  request: SfxRequest,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const response = await fetchFn(`${BASE}/v1/sound-generation`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json" },
    body: JSON.stringify(sfxBody(request)),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw errorFrom(response.status, await response.text());
  const audio = new Uint8Array(await response.arrayBuffer());
  if (audio.length === 0) throw new EngineError("bad_response", "ElevenLabs sent no audio.");
  return audio;
}
