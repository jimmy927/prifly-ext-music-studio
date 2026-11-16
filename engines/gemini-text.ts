/**
 * Gemini reading pictures and audio and answering in text, through the same
 * Interactions API as engines/gemini.ts: `input` is a list of `{type:"text"}`,
 * `{type:"image", mime_type, data}` and `{type:"audio", mime_type, data}`
 * blocks; the answer's text is in the `model_output` steps. Paid on the key's
 * billing.
 */

import { ANALYSIS_MODEL } from "../sources/constants";
import { errorFrom, geminiHeaders, URL_INTERACTIONS } from "./gemini";
import { interactionError, textOf } from "./gemini-video";
import { EngineError, type Fetch } from "./types";

export type Part =
  | { kind: "text"; text: string }
  | { kind: "image"; bytes: Uint8Array; mime: string }
  | { kind: "audio"; bytes: Uint8Array; mime: string };

const block = (part: Part): Record<string, string> =>
  part.kind === "text"
    ? { type: "text", text: part.text }
    : {
        type: part.kind,
        mime_type: part.mime,
        data: Buffer.from(part.bytes).toString("base64"),
      };

/** The body of one call. */
export const textBody = (parts: Part[]): Record<string, unknown> => ({
  model: ANALYSIS_MODEL,
  input: parts.map(block),
});

/** Asks the model; its text answer. */
export async function askGemini(
  fetchFn: Fetch,
  key: string,
  parts: Part[],
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetchFn(URL_INTERACTIONS, {
    method: "POST",
    headers: geminiHeaders(key),
    body: JSON.stringify(textBody(parts)),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw errorFrom(response.status, await response.text());
  const body: unknown = await response.json();
  const failure = interactionError(body);
  if (failure !== null) throw failure;
  const text = textOf(body);
  if (text.trim() === "") throw new EngineError("bad_response", "Gemini's answer holds no text.");
  return text;
}

/** The JSON object in a model's answer (it may sit in a code fence or after a sentence); null when there is none. */
export function jsonIn(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}
