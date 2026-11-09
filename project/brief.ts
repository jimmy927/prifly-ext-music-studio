/**
 * The Idea stage's brief: what the reader fills in, how it is checked, and the
 * prompt an engine is given for it. The panel bundles this file too, so it
 * imports nothing of the server's.
 */

export const SKETCH_COUNT = 3;
export const SKETCH_MS = 30_000;
export const SKETCH_IDS = ["a", "b", "c"] as const;
export type SketchId = (typeof SKETCH_IDS)[number];

export const VOCALS = ["generated", "mine", "instrumental"] as const;
export type Vocals = (typeof VOCALS)[number];

export const ENGINES = ["elevenlabs", "lyria-clip"] as const;
export type EngineId = (typeof ENGINES)[number];

export const ENGINE_LABELS: Record<EngineId, string> = {
  elevenlabs: "ElevenLabs Music v2.5",
  "lyria-clip": "Lyria 3 Clip",
};

/** The target length of the finished song, in seconds; the sketches are always 30 s. */
export const LENGTHS = [30, 60, 120, 180, 240] as const;

export type Preset = {
  id: string;
  label: string;
  style: string;
  tempo: number;
  key: string;
  vocals: Vocals;
  lengthSec: number;
};

export const PRESETS: readonly Preset[] = [
  {
    id: "slopcore",
    label: "Slopcore",
    style:
      "slopcore: deliberately cheap internet-era collage, detuned synths, chopped samples, glitchy meme energy",
    tempo: 140,
    key: "C minor",
    vocals: "generated",
    lengthSec: 60,
  },
  {
    id: "techno-128",
    label: "Techno 128",
    style:
      "driving techno, four-on-the-floor kick, rolling bassline, hypnotic hi-hats, slow filter sweeps",
    tempo: 128,
    key: "A minor",
    vocals: "instrumental",
    lengthSec: 240,
  },
  {
    id: "lofi",
    label: "Lo-fi",
    style: "lo-fi hip hop, dusty swung drums, mellow Rhodes chords, vinyl crackle, warm and sleepy",
    tempo: 80,
    key: "F major",
    vocals: "instrumental",
    lengthSec: 120,
  },
  {
    id: "game-loop",
    label: "Game loop",
    style:
      "seamless looping video game background music, light chiptune and orchestral layers, no fade out",
    tempo: 120,
    key: "D minor",
    vocals: "instrumental",
    lengthSec: 60,
  },
  {
    id: "stinger",
    label: "Stinger",
    style:
      "short dramatic cinematic stinger, a big impact hit and a rising swell that resolves cleanly",
    tempo: 100,
    key: "E minor",
    vocals: "instrumental",
    lengthSec: 30,
  },
  {
    id: "hold-music",
    label: "Hold music",
    style:
      "friendly corporate hold music, soft electric piano, light jazz guitar, gentle brushed drums, loopable",
    tempo: 100,
    key: "G major",
    vocals: "instrumental",
    lengthSec: 120,
  },
  {
    id: "eurodance-2003",
    label: "Eurodance 2003",
    style:
      "2003 Eurodance, euphoric supersaw lead, catchy female vocal hook, pumping bassline, trance-pop build-ups",
    tempo: 138,
    key: "A minor",
    vocals: "generated",
    lengthSec: 180,
  },
];

export type Brief = {
  text: string;
  /** The preset chip the brief started from, if any. */
  preset: string | null;
  tempo: number | null;
  key: string;
  lengthSec: number;
  vocals: Vocals;
  lyrics: string;
  engine: EngineId;
};

export const EMPTY_BRIEF: Brief = {
  text: "",
  preset: null,
  tempo: null,
  key: "",
  lengthSec: 120,
  vocals: "generated",
  lyrics: "",
  engine: "elevenlabs",
};

const oneOf = <T extends string>(list: readonly T[], value: unknown): T | null =>
  list.find((each) => each === value) ?? null;

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** The problem with the free-text parts of a brief, or null. */
function textProblem(text: string, vocals: Vocals, lyrics: string): string | null {
  if (text === "") return "Write a line about the music first.";
  if (text.length > 2000) return "The brief is longer than 2000 characters.";
  if (vocals === "mine" && lyrics === "")
    return "Paste your lyrics, or pick another vocals option.";
  if (lyrics.length > 6000) return "The lyrics are longer than 6000 characters.";
  return null;
}

const tempoOk = (tempo: unknown): boolean =>
  tempo === null ||
  tempo === undefined ||
  (typeof tempo === "number" && tempo >= 40 && tempo <= 240);

/** A brief from untrusted input, or the sentence for what is wrong with it. */
export function parseBrief(raw: unknown): Brief | string {
  if (typeof raw !== "object" || raw === null) return "The brief is missing.";
  const input = raw as Record<string, unknown>;
  const text = str(input["text"]);
  const vocals = oneOf(VOCALS, input["vocals"]) ?? "generated";
  const lyrics = str(input["lyrics"]);
  const problem = textProblem(text, vocals, lyrics);
  if (problem !== null) return problem;
  const tempo = input["tempo"];
  if (!tempoOk(tempo)) return "Tempo is between 40 and 240 BPM.";
  const length = input["lengthSec"];
  return {
    text,
    preset: PRESETS.find((each) => each.id === input["preset"])?.id ?? null,
    tempo: typeof tempo === "number" ? Math.round(tempo) : null,
    key: typeof input["key"] === "string" ? input["key"].trim().slice(0, 30) : "",
    lengthSec:
      typeof length === "number" && length >= 5 && length <= 600 ? Math.round(length) : 120,
    vocals,
    lyrics,
    engine: oneOf(ENGINES, input["engine"]) ?? "elevenlabs",
  };
}

/** The prompt an engine gets for the brief. */
export function buildPrompt(brief: Brief): string {
  const preset = PRESETS.find((each) => each.id === brief.preset);
  const lines = [brief.text];
  if (preset !== undefined) lines.push(`Style: ${preset.style}.`);
  if (brief.tempo !== null) lines.push(`Tempo: ${brief.tempo} BPM.`);
  if (brief.key !== "") lines.push(`Key: ${brief.key}.`);
  if (brief.vocals === "mine") lines.push(`Sing exactly these lyrics:\n${brief.lyrics}`);
  return lines.join("\n");
}

/** A project's title: the brief's first words. */
export function titleOf(brief: Brief): string {
  const words = brief.text.split(/\s+/).slice(0, 6).join(" ");
  const clean = words.replace(/[.,;:!?]+$/, "");
  return clean.length > 48 ? `${clean.slice(0, 47)}…` : clean;
}

/**
 * About how many ElevenLabs credits three 30-second sketches use. The docs
 * give no figure ("hover over the credits remaining" in ElevenLabs' app), so
 * this is an estimate, shown as one.
 */
export const CREDITS_PER_SKETCH_ESTIMATE = 600;

export function estimateCredits(engine: EngineId): number {
  return engine === "elevenlabs" ? CREDITS_PER_SKETCH_ESTIMATE * SKETCH_COUNT : 0;
}

export function formatLength(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
