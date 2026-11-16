/** What reading the source material finds, as it is kept (in the cache and in a project's sources.json). */

import type { SourceKind } from "./constants";

/** What Gemini sees in a picture, or across a video's frames. */
export type Seen = {
  people: string;
  place: string;
  actions: string;
  mood: string;
  colours: string;
  /** On-screen or visible text, as written. */
  text: string;
};

/** A video's audio track: tempo and key measured here, mood and genre from Gemini. */
export type AudioFound = {
  bpm: number | null;
  key: string | null;
  mood: string;
  genre: string;
  /** Anything said or sung, in what language. */
  language: string;
  /** Why a part is missing ("no audio track", "Gemini could not take the audio"). */
  note: string | null;
};

/** One source file read: what is cached per file, so a second call costs nothing. */
export type Described = {
  version: number;
  key: string;
  name: string;
  kind: SourceKind;
  durationSec: number | null;
  seen: Seen;
  /** A picture's small copy in the cache folder; null for a video. */
  thumb: string | null;
  /** A video's sampled frames, in the cache folder. */
  frames: string[];
  audio: AudioFound | null;
  /** What could not be done for this file, in words. */
  notes: string[];
};

export type CastIdea = {
  name: string;
  description: string;
  /** The file name of the source picture that shows this person or thing best. */
  source: string;
};

/** What all the descriptions together suggest for the song and for the video. */
export type Synthesis = {
  song: {
    brief: string;
    mood: string;
    genre: string;
    tempo: number | null;
    key: string;
    story: string;
    lyrics: string;
    language: string;
  };
  video: { concept: string; look: string; cast: CastIdea[] };
};
