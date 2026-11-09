/**
 * ElevenLabs stem separation: `POST /v1/music/stem-separation`, a multipart
 * form with the audio as `file`, answered with a ZIP archive of one audio
 * file per stem. The stem names are whatever the archive holds.
 */

import { errorFrom } from "./elevenlabs";
import { EngineError, type Fetch } from "./types";
import { readZip } from "./zip";

const BASE = "https://api.elevenlabs.io";

export type Stem = { name: string; ext: string; audio: Uint8Array };

const AUDIO_NAME = /^(?:.*\/)?([^/]+)\.(mp3|wav|opus|ogg|flac|m4a|pcm)$/i;

/** The stems in the archive: `vocals.mp3` is stem "vocals". Entries that are not audio are skipped. */
export function parseStems(archive: Uint8Array): Stem[] {
  let entries: ReturnType<typeof readZip>;
  try {
    entries = readZip(archive);
  } catch (caught) {
    throw new EngineError(
      "bad_response",
      caught instanceof Error ? caught.message : String(caught),
    );
  }
  const stems: Stem[] = [];
  for (const entry of entries) {
    const match = AUDIO_NAME.exec(entry.name);
    if (match?.[1] === undefined || match[2] === undefined || entry.name.includes("__MACOSX"))
      continue;
    const name = match[1]
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (name !== "" && entry.bytes.length > 0)
      stems.push({ name, ext: match[2].toLowerCase(), audio: entry.bytes });
  }
  if (stems.length === 0) throw new EngineError("bad_response", "ElevenLabs sent no stems.");
  return stems;
}

/** Splits one audio file into stems; paid. `variation` is `stem_variation_id`, left out unless given. */
export async function separateStems(
  fetchFn: Fetch,
  key: string,
  file: { audio: Uint8Array; name: string },
  variation: string | null,
  signal?: AbortSignal,
): Promise<Stem[]> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(file.audio)]), file.name);
  if (variation !== null) form.append("stem_variation_id", variation);
  const response = await fetchFn(`${BASE}/v1/music/stem-separation`, {
    method: "POST",
    headers: { "xi-api-key": key },
    body: form,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw errorFrom(response.status, await response.text());
  return parseStems(new Uint8Array(await response.arrayBuffer()));
}
