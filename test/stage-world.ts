/**
 * Helpers for the Arrange, Produce and Mix tests: a world whose fake
 * ElevenLabs answers sketches, inpainting renders, stem separation and sound
 * effects, a project with a chosen sketch, and a way to wait for a job.
 */

import { deflateRawSync } from "node:zlib";
import { route } from "../panel-router";
import type { Job } from "../studio";
import {
  BRIEF,
  type Call,
  type Handler,
  lyriaReply,
  multipart,
  subscription,
  type World,
  world,
} from "./world";

export const SECTIONS = [
  { name: "Intro", ms: 8000 },
  { name: "Verse", ms: 12000 },
  { name: "Chorus", ms: 6000 },
  { name: "Outro", ms: 4000 },
];

const chunk = (name: string, ms: number, lyrics = "la la") => ({
  text: `[${name}]\n${lyrics}`,
  duration_ms: ms,
  positive_styles: ["122 BPM", "warm"],
  negative_styles: [],
  context_adherence: "high",
});

/** 16-bit mono PCM WAV of a sine, small enough to render in a blink. */
export function wav(seconds: number, frequency = 440): Uint8Array<ArrayBuffer> {
  const rate = 8000;
  const count = Math.round(seconds * rate);
  const bytes = Buffer.alloc(44 + count * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(36 + count * 2, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(count * 2, 40);
  for (let at = 0; at < count; at += 1)
    bytes.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * frequency * at) / rate) * 8000),
      44 + at * 2,
    );
  return new Uint8Array(bytes);
}

/** A ZIP of the given files (deflated), as the stem separation answers. */
export function zip(files: { name: string; bytes: Uint8Array }[]): Uint8Array<ArrayBuffer> {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const packed = deflateRawSync(file.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(file.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(file.bytes.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    directory.push(Buffer.concat([entry, name]));
    locals.push(local, name, packed);
    offset += 30 + name.length + packed.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, central, end]));
}

export const STEMS = ["vocals", "drums", "bass", "other"];

export type Fakes = { renders: number; songs: number };

/** Answers like ElevenLabs: sketches with four sections, plan renders, stems and sound effects. */
export function elevenlabs(fakes: Fakes = { renders: 0, songs: 0 }): Handler {
  return (call: Call) => {
    if (call.url.endsWith("/v1/user/subscription")) return subscription(1000, 40000);
    if (call.url.endsWith("/v1/music/stem-separation"))
      return new Response(zip(STEMS.map((name) => ({ name: `${name}.wav`, bytes: wav(0.25) }))));
    if (call.url.endsWith("/v1/sound-generation")) return new Response(wav(0.2, 880));
    if (!call.url.endsWith("/v1/music/detailed")) return lyriaReply();
    const body = JSON.parse(call.body) as { composition_plan?: { chunks: unknown[] } };
    fakes.songs += 1;
    const songId =
      body.composition_plan === undefined ? `sketch-${fakes.songs}` : `render-${fakes.songs}`;
    if (body.composition_plan !== undefined) fakes.renders += 1;
    const chunks = SECTIONS.map((each) => chunk(each.name, each.ms));
    return multipart(
      { composition_plan: { chunks }, song_metadata: { title: "Minor Lift" } },
      wav(0.1),
      {
        songId,
      },
    );
  };
}

export const ask = (
  w: World,
  path: string,
  query: Record<string, string> = {},
  body: unknown = null,
) => route(w.studio, { path, query, body });

/** Waits until the job is no longer running. */
export async function finished(w: World, id: string): Promise<Job> {
  for (let tries = 0; tries < 400; tries += 1) {
    const job = (await ask(w, "job", { id })) as Job;
    if (job.status !== "running") return job;
    await Bun.sleep(5);
  }
  throw new Error("the job never finished");
}

export type Refused = { ok: false; reason: string; message: string };
export type Answer = { ok: true; job: Job } | Refused;

/** Runs a route that starts a job and waits for the job; the answer when it did not start. */
export async function runJob(w: World, path: string, body: unknown): Promise<Job | Refused> {
  const answer = (await ask(w, path, {}, body)) as Answer;
  return answer.ok ? await finished(w, answer.job.id) : answer;
}

/** A project with three sketches, the first chosen; returns its id. */
export async function chosenProject(
  w: World,
  brief: Record<string, unknown> = BRIEF,
): Promise<string> {
  const started = (await ask(w, "sketch", {}, brief)) as Answer;
  if (!started.ok) throw new Error(started.message);
  const job = await finished(w, started.job.id);
  const project = job.project ?? "";
  await ask(w, "choose", {}, { project, sketch: "a" });
  return project;
}

/** From now on the reader answers every confirm card with Cancel (the cards are still recorded). */
export function declineCards(w: World): void {
  const original = w.fake.api.confirm?.bind(w.fake.api);
  w.fake.api.confirm = async (spec) => {
    await original?.(spec);
    return false;
  };
}

export const stageWorld = (options: Parameters<typeof world>[1] = {}, fakes?: Fakes) =>
  world(elevenlabs(fakes), options);
