/**
 * A fake world for the tests: a fake prifly api with keys and a temporary
 * library folder, a Studio over a faked `fetch` (no real request is ever
 * sent), and builders for the replies the two services give.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fetch } from "../engines/types";
import { Studio } from "../studio";
import { libraryTool, sketchTool } from "../tools";
import { type FakeApi, fakeApi } from "./fake-api";

export type Call = {
  url: string;
  method: string;
  headers: Headers;
  body: string;
  signal: AbortSignal | undefined;
};

/** Audio-ish bytes with a CRLF, a NUL and 0xFF inside, which a text parser would corrupt. */
export const AUDIO = new Uint8Array([
  0x49, 0x44, 0x33, 0x0d, 0x0a, 0x00, 0xff, 0xfb, 0x90, 0x0d, 0x0a, 0x2d, 0x2d,
]);

export function multipart(json: unknown, audio: Uint8Array, boundary = "XBOUNDARYX"): Response {
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(json)}\r\n--${boundary}\r\nContent-Type: audio/mpeg\r\nContent-Disposition: attachment; filename="song.mp3"\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return new Response(Buffer.concat([head, Buffer.from(audio), tail]), {
    headers: { "content-type": `multipart/mixed; boundary=${boundary}` },
  });
}

export const detailedReply = (songId = "song123"): Response =>
  multipart(
    {
      song_id: songId,
      composition_plan: {
        sections: [{ section_name: "Verse", duration_ms: 30000, lines: ["la la", "na na"] }],
      },
      song_metadata: { title: "Test" },
      words_timestamps: [{ word: "la", start_s: 1, end_s: 1.4 }],
    },
    AUDIO,
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
  options: { keys?: Record<string, string>; confirm?: boolean } = {},
): World {
  const folder = mkdtempSync(join(tmpdir(), "music-studio-library-"));
  const fake = fakeApi({
    settings: { libraryFolder: folder, elevenlabsKey: true, geminiKey: true },
    secrets: options.keys ?? { elevenlabsKey: "xi-test", geminiKey: "g-test" },
    confirm: options.confirm ?? true,
  });
  const calls: Call[] = [];
  const fetchFn: Fetch = async (input, init) => {
    const call: Call = {
      url: input,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    return await handler(call);
  };
  const studio = new Studio({ api: () => fake.api, fetch: fetchFn });
  fake.api.tools?.register([sketchTool(studio), libraryTool(studio)]);
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
