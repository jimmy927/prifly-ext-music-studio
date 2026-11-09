/** What every music engine gives back, and how one fails. */

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** One generated sketch: the audio and what the engine said about it. */
export type Sketched = {
  audio: Uint8Array;
  /** The file extension of `audio`. */
  ext: "mp3" | "wav";
  /** ElevenLabs' id for the stored song, used later to arrange or inpaint it. */
  songId: string | null;
  /** The composition plan (ElevenLabs) or the lyrics and structure (Lyria). */
  plan: unknown;
  /** Word timestamps when the engine returned them. */
  timestamps: unknown;
  /** The engine's own name for the track, when it gave one. */
  title: string | null;
  /** The lyrics as text, when the engine wrote any. */
  lyrics: string | null;
};

export type EngineErrorKind =
  | "bad_prompt"
  | "no_key"
  | "auth"
  | "credits"
  | "http"
  | "bad_response";

export class EngineError extends Error {
  readonly kind: EngineErrorKind;
  /** A prompt the engine would accept instead, for `bad_prompt`. */
  readonly suggestion: string | null;
  constructor(kind: EngineErrorKind, message: string, suggestion: string | null = null) {
    super(message);
    this.name = "EngineError";
    this.kind = kind;
    this.suggestion = suggestion;
  }
}

export type SketchRequest = {
  /** The whole prompt, already built from the brief. */
  prompt: string;
  lengthMs: number;
  instrumental: boolean;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const asString = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;
