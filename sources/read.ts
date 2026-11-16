/**
 * The words asked of Gemini about the source material and how its answers are
 * read: what is in each picture and video, the audio's mood and genre, and
 * the one text call that turns every description into a song brief, draft
 * lyrics and a video concept, look and cast.
 */

import { asString, isRecord } from "../engines/types";
import type { AudioFound, CastIdea, Described, Seen, Synthesis } from "./types";

const clip = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const SEEN_FIELDS =
  '"people" (who is there, how many, what they look like), "place" (where), "actions" (what happens), "mood" (the feeling), "colours" (the dominant colours and light), "text" (any text visible in the picture, copied exactly; empty when there is none)';

/** The words that ask for each of `names` (pictures, in order) to be described. */
export function picturesPrompt(names: string[]): string {
  return [
    `Describe each of these ${names.length} pictures for someone who will write a song and a music video from them. The pictures follow, in order, each after a line naming it: ${names.join(", ")}.`,
    `For each give ${SEEN_FIELDS}. Plain facts, one or two sentences a field.`,
    'Answer with JSON only: {"items": [{"name": "<the picture\'s name>", "people": "", "place": "", "actions": "", "mood": "", "colours": "", "text": ""}]}, one item per picture, in order.',
  ].join("\n");
}

/** The words that ask for one video's frames to be described as one clip. */
export function framesPrompt(name: string, count: number, intervalSec: number): string {
  return [
    `These are ${count} frames of one video, "${name}", taken about ${Math.round(intervalSec)} seconds apart, in order. Describe the video as a whole for someone who will write a song and a music video from it.`,
    `Give ${SEEN_FIELDS}; for actions say what happens from the first frame to the last; for text copy any on-screen text (titles, subtitles, signs) exactly.`,
    'Answer with JSON only: {"items": [{"name": "<the video\'s name>", "people": "", "place": "", "actions": "", "mood": "", "colours": "", "text": ""}]}.',
  ].join("\n");
}

export const AUDIO_PROMPT =
  'This is the audio track of a short video. Describe it for someone who will write a song from it. Answer with JSON only: {"mood": "", "genre": "", "language": "the language spoken or sung, or empty when none", "said": "a short summary of any words you hear"}.';

function toSeen(raw: unknown): Seen | null {
  if (!isRecord(raw)) return null;
  return {
    people: clip(raw["people"], 600),
    place: clip(raw["place"], 600),
    actions: clip(raw["actions"], 800),
    mood: clip(raw["mood"], 300),
    colours: clip(raw["colours"], 300),
    text: clip(raw["text"], 600),
  };
}

/** The descriptions in a model's JSON answer, one per name asked for; null when the answer does not fit. */
export function parseSeen(parsed: unknown, count: number): Seen[] | null {
  const items = isRecord(parsed) ? parsed["items"] : null;
  if (!Array.isArray(items) || items.length !== count) return null;
  const seen = items.map(toSeen);
  return seen.every((each) => each !== null) ? (seen as Seen[]) : null;
}

/** The audio part's mood, genre and language from a model's JSON answer; null when the answer does not fit. */
export function parseAudioMood(
  parsed: unknown,
): { mood: string; genre: string; language: string } | null {
  if (!isRecord(parsed)) return null;
  const mood = clip(parsed["mood"], 300);
  const genre = clip(parsed["genre"], 200);
  if (mood === "" && genre === "") return null;
  return { mood, genre, language: clip(parsed["language"], 80) };
}

const field = (label: string, value: string): string => (value === "" ? "" : `${label}: ${value}`);

/** What was heard in a video's audio, as one phrase; "" when nothing was. */
function heardOf(audio: AudioFound): string {
  return [
    audio.bpm === null ? "" : `measured tempo ${Math.round(audio.bpm)} BPM`,
    audio.key === null ? "" : `measured key ${audio.key}`,
    field("audio mood", audio.mood),
    field("audio genre", audio.genre),
    field("spoken or sung language", audio.language),
  ]
    .filter((part) => part !== "")
    .join("; ");
}

/** One line a description is shown as to the model that writes the song. */
function lineOf(each: Described): string {
  const seen = each.seen;
  const length = each.durationSec === null ? "" : ` (${Math.round(each.durationSec)} s)`;
  const parts = [
    `${each.kind === "video" ? "Video" : "Picture"} "${each.name}"${length}`,
    field("people", seen.people),
    field("place", seen.place),
    field("actions", seen.actions),
    field("mood", seen.mood),
    field("colours", seen.colours),
    seen.text === "" ? "" : `visible text: "${seen.text}"`,
    each.audio === null ? "" : field("audio", heardOf(each.audio)),
  ].filter((part) => part !== "");
  return `- ${parts.join(". ")}`;
}

/** The words that ask for the song and video ideas from every description. */
export function synthesisPrompt(described: Described[]): string {
  return [
    "A person has shared pictures and videos from their life (a trip, a party, a family, a project). Turn them into the start of a song and of a music video.",
    "What was found in each file:",
    ...described.map(lineOf),
    "",
    'Write: the song brief (one to three sentences a music generator can use: mood, genre, instruments, energy; no artist names), a mood and a genre in a few words, a tempo in BPM (40 to 240; use a measured tempo if one is given and fits) and a key such as "A minor" (empty when unsure; use a measured key if given), the story the song tells in two sentences, and draft lyrics (two verses and a chorus, in square-bracket section tags) in the language the material suggests (the language of visible text or of the speech; else English), naming the language. Use only what the material shows.',
    "For the video: a concept (what the video is about and how it moves, in a short paragraph), a look (colours, light, camera, in a sentence) and a cast of up to 6 people or things that recur, each with a name, a one-line description and `source`: the exact name of the one PICTURE file (not a video) that shows them best.",
    'Answer with JSON only: {"song": {"brief": "", "mood": "", "genre": "", "tempo": 120, "key": "", "story": "", "lyrics": "", "language": ""}, "video": {"concept": "", "look": "", "cast": [{"name": "", "description": "", "source": ""}]}}.',
  ].join("\n");
}

function castOf(raw: unknown): CastIdea[] {
  const out: CastIdea[] = [];
  for (const each of Array.isArray(raw) ? raw : []) {
    if (!isRecord(each)) continue;
    const source = asString(each["source"]);
    if (source === null) continue;
    out.push({
      name: clip(each["name"], 60),
      description: clip(each["description"], 300),
      source: source.trim(),
    });
  }
  return out.slice(0, 12);
}

/** The synthesis in a model's JSON answer; null when it holds no song brief. */
export function parseSynthesis(parsed: unknown): Synthesis | null {
  if (!isRecord(parsed) || !isRecord(parsed["song"])) return null;
  const song = parsed["song"];
  const video = isRecord(parsed["video"]) ? parsed["video"] : {};
  const brief = clip(song["brief"], 1200);
  if (brief === "") return null;
  const tempo = song["tempo"];
  return {
    song: {
      brief,
      mood: clip(song["mood"], 200),
      genre: clip(song["genre"], 200),
      tempo: typeof tempo === "number" && tempo >= 40 && tempo <= 240 ? Math.round(tempo) : null,
      key: clip(song["key"], 30),
      story: clip(song["story"], 800),
      lyrics: clip(song["lyrics"], 5000),
      language: clip(song["language"], 40),
    },
    video: {
      concept: clip(video["concept"], 2000),
      look: clip(video["look"], 600),
      cast: castOf(video["cast"]),
    },
  };
}

/** The audio found with a note instead of values. */
export const noAudio = (note: string): AudioFound => ({
  bpm: null,
  key: null,
  mood: "",
  genre: "",
  language: "",
  note,
});
