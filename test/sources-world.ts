/**
 * Helpers for the source material tests: a Gemini that answers the reading
 * calls (pictures, a video's frames, its audio, the song and video ideas) the
 * way the prompts ask, no real call ever made; a folder with pictures and a
 * tiny real video made by ffmpeg.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpeg } from "../audio/ffmpeg";
import { ANALYSIS_MODEL } from "../sources/constants";
import { elevenlabs } from "./stage-world";
import { interaction, PNG } from "./video-world";
import { type Call, type Handler, type World, world } from "./world";

/** The ideas the fake Gemini writes; the tests look for these words. */
export const SYNTH = {
  song: {
    brief: "Warm acoustic summer pop about a beach holiday with friends",
    mood: "sunny",
    genre: "acoustic pop",
    tempo: 96,
    key: "G major",
    story: "Friends spend a last summer weekend by the sea.",
    lyrics: "[Verse]\nSolen går ner vid havet\n[Chorus]\nSommar för alltid",
    language: "Swedish",
  },
  video: {
    concept: "A last weekend at the beach, told in postcards",
    look: "Faded film, warm light",
    cast: [] as { name: string; description: string; source: string }[],
  },
};

export type SourceGemini = {
  /** Every analysis call, as the kind of call it was. */
  calls: ("pictures" | "frames" | "audio" | "synthesis")[];
  /** The text of every synthesis call. */
  synthesisPrompts: string[];
  /** Whether the audio call is refused (a model that does not take audio). */
  refuseAudio: boolean;
  handler: (call: Call) => Response | null;
};

const item = (name: string) => ({
  name,
  people: "two friends",
  place: "a beach",
  actions: "laughing by the water",
  mood: "happy",
  colours: "warm orange",
  text: name.endsWith(".png") ? "SUMMER 2026" : "",
});

const textReply = (value: unknown): Response =>
  Response.json(interaction([{ type: "text", text: JSON.stringify(value) }]));

export function sourceGemini(synth: typeof SYNTH = SYNTH): SourceGemini {
  const state: SourceGemini = {
    calls: [],
    synthesisPrompts: [],
    refuseAudio: false,
    handler: () => null,
  };
  state.handler = (call) => {
    if (!call.url.endsWith("/v1beta/interactions") || call.method !== "POST") return null;
    const body = JSON.parse(call.body) as {
      model?: string;
      input?: { type: string; text?: string }[];
    };
    if (body.model !== ANALYSIS_MODEL) return null;
    const input = body.input ?? [];
    const text = input
      .filter((each) => each.type === "text")
      .map((each) => each.text ?? "")
      .join("\n");
    if (input.some((each) => each.type === "audio")) {
      state.calls.push("audio");
      return state.refuseAudio
        ? Response.json(
            { error: { code: "invalid_argument", message: "Audio input is not supported." } },
            { status: 400 },
          )
        : textReply({ mood: "upbeat", genre: "beach pop", language: "Swedish", said: "hej" });
    }
    if (text.includes("Turn them into the start of a song")) {
      state.calls.push("synthesis");
      state.synthesisPrompts.push(text);
      return textReply(synth);
    }
    if (text.includes("frames of one video")) {
      state.calls.push("frames");
      return textReply({ items: [item("clip.mp4")] });
    }
    state.calls.push("pictures");
    const names = [...text.matchAll(/^Picture: (.+)$/gm)].map((each) => each[1] ?? "");
    return textReply({ items: names.map(item) });
  };
  return state;
}

/** A world whose ElevenLabs and Gemini are faked, the Gemini answering the reading calls. */
export function sourcesWorld(
  options: Parameters<typeof world>[1] = {},
  synth: typeof SYNTH = SYNTH,
): World & { sg: SourceGemini } {
  const sg = sourceGemini(synth);
  const eleven = elevenlabs();
  const handler: Handler = async (call) => sg.handler(call) ?? (await eleven(call));
  return Object.assign(world(handler, { ffmpegPath: "", ...options }), { sg });
}

/** A tiny real video with a sound, `seconds` long. */
export async function makeVideo(path: string, seconds = 3): Promise<void> {
  const ran = await runFfmpeg("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=160x90:rate=10:duration=${seconds}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${seconds}`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    path,
  ]);
  if (!ran.ok) throw new Error(ran.message);
}

/** A folder with `pictures` PNGs (a.png, b.png…), and with `video` a clip.mp4, a notes.txt and a hidden file. */
export async function album(pictures = 2, video = true): Promise<string> {
  const folder = mkdtempSync(join(tmpdir(), "music-studio-album-"));
  for (let at = 0; at < pictures; at += 1)
    writeFileSync(join(folder, `${String.fromCharCode(97 + at)}.png`), PNG);
  writeFileSync(join(folder, "notes.txt"), "not a picture");
  writeFileSync(join(folder, ".hidden.png"), PNG);
  mkdirSync(join(folder, "sub"));
  writeFileSync(join(folder, "sub", "deep.png"), PNG);
  if (video) await makeVideo(join(folder, "clip.mp4"));
  return folder;
}
