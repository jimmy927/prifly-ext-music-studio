/**
 * A fake world for the tests: a fake prifly api with keys and a temporary
 * library folder, a Studio over a faked `fetch` (no real request is ever
 * sent), and builders for the replies the two services give.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allTools } from "../all-tools";
import type { Fetch } from "../engines/types";
import { Studio } from "../studio";
import { type FakeApi, fakeApi } from "./fake-api";

export type Call = {
  url: string;
  method: string;
  headers: Headers;
  body: string;
  /** The form a multipart request sent, else null. */
  form: FormData | null;
  signal: AbortSignal | undefined;
};

/** Audio-ish bytes with a CRLF, a NUL and 0xFF inside, which a text parser would corrupt. */
export const AUDIO = new Uint8Array([
  0x49, 0x44, 0x33, 0x0d, 0x0a, 0x00, 0xff, 0xfb, 0x90, 0x0d, 0x0a, 0x2d, 0x2d,
]);

export function multipart(
  json: unknown,
  audio: Uint8Array,
  options: { boundary?: string; songId?: string } = {},
): Response {
  const boundary = options.boundary ?? "----boundaryXYZ";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(json)}\r\n--${boundary}\r\nContent-Type: audio/mpeg\r\nContent-Disposition: attachment; filename="music.mp3"\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return new Response(Buffer.concat([head, Buffer.from(audio), tail]), {
    headers: {
      "content-type": `multipart/mixed; boundary=${boundary}`,
      ...(options.songId === undefined ? {} : { "song-id": options.songId }),
    },
  });
}

/** The JSON part as ElevenLabs sends it (checked against a real reply): no song id in it. */
export const detailedJson = (text = "[Instrumental Main]") => ({
  composition_plan: {
    chunks: [
      {
        text,
        duration_ms: 30000,
        positive_styles: ["122 BPM"],
        negative_styles: [],
        context_adherence: "high",
        conditioning_ref: null,
        condition_strength: null,
      },
    ],
  },
  song_metadata: {
    title: "Minor Lift",
    description: "d",
    genres: ["pop"],
    languages: [],
    is_explicit: false,
  },
  words_timestamps: [],
  waveform_visual: null,
});

export const detailedReply = (songId = "song123"): Response =>
  multipart(detailedJson(), AUDIO, { songId });

/** A real reply recorded from /v1/music/detailed, its MP3 cut to 64 bytes. */
export const REAL_SONG_ID = "uWQ2BbJ4wWtp6GVbkNi4";
export const REAL_BOUNDARY = "----boundary05c71529117a4ed2bb9c7fe36dfaaa70";
export const realReply = async (): Promise<Response> =>
  new Response(
    await Bun.file(join(import.meta.dir, "fixtures", "detailed-reply.bin")).arrayBuffer(),
    {
      headers: {
        "content-type": `multipart/mixed; boundary=${REAL_BOUNDARY}`,
        "song-id": REAL_SONG_ID,
      },
    },
  );

export const lyriaReply = (): Response =>
  Response.json({
    steps: [
      { type: "user_input", content: [{ type: "text", text: "prompt" }] },
      {
        type: "model_output",
        content: [
          { type: "text", text: "[Verse]\nhello" },
          { type: "audio", mime_type: "audio/mpeg", data: Buffer.from(AUDIO).toString("base64") },
        ],
      },
    ],
  });

export const subscription = (used: number, limit: number): Response =>
  Response.json({ tier: "starter", character_count: used, character_limit: limit });

export type Handler = (call: Call) => Response | Promise<Response>;

export type World = {
  fake: FakeApi;
  studio: Studio;
  calls: Call[];
  folder: string;
  callTool: FakeApi["callTool"];
};

/**
 * `handler` answers every request the extension makes. `keys` are the stored
 * secrets; `confirm` is the reader's answer to every card.
 */
export function world(
  handler: Handler,
  options: {
    keys?: Record<string, string>;
    confirm?: boolean;
    ffmpegPath?: string;
    /** As prifly does: `api.confirm` outside a tool call and with no session answers no. */
    confirmNeedsSession?: boolean;
    /** What the reader answers `api.dialog`; null (the default) is a cancel. */
    dialog?: string | null;
  } = {},
): World {
  const folder = mkdtempSync(join(tmpdir(), "music-studio-library-"));
  const fake = fakeApi({
    settings: {
      libraryFolder: folder,
      elevenlabsKey: true,
      geminiKey: true,
      ffmpegPath: options.ffmpegPath ?? "",
    },
    secrets: options.keys ?? { elevenlabsKey: "xi-test", geminiKey: "g-test" },
    confirm: options.confirm ?? true,
    ...(options.confirmNeedsSession === undefined
      ? {}
      : { confirmNeedsSession: options.confirmNeedsSession }),
    ...(options.dialog === undefined ? {} : { dialog: options.dialog }),
  });
  const calls: Call[] = [];
  const fetchFn: Fetch = async (input, init) => {
    const call: Call = {
      url: input,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
      form: init?.body instanceof FormData ? init.body : null,
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    return await handler(call);
  };
  // Polls come a millisecond apart and renders are 160x90, so a test runs a whole edit in a blink.
  const studio = new Studio({
    api: () => fake.api,
    fetch: fetchFn,
    pollMs: 1,
    renderSize: { width: 160, height: 90 },
  });
  fake.api.tools?.register(allTools(studio));
  return { fake, studio, calls, folder, callTool: fake.callTool };
}

/** A handler that answers like the services do when all is well. */
export const happy: Handler = (call) => {
  if (call.url.endsWith("/v1/user/subscription")) return subscription(1000, 40000);
  if (call.url.endsWith("/v1/music/detailed")) return detailedReply();
  return lyriaReply();
};

export const BRIEF = {
  text: "A dusty lo-fi beat for studying",
  preset: "lofi",
  tempo: 80,
  key: "F major",
};
