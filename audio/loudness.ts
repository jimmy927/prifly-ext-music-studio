/**
 * Loudness with ffmpeg 4.2: the `ebur128` summary (integrated loudness, true
 * peak, loudness range), the two-pass `loudnorm` (measure, then apply the
 * measured values) and the command that renders a master. The parsers read
 * what 4.2 prints to stderr; test/fixtures holds real captures of it.
 */

export type Loudness = { integrated: number; truePeak: number; range: number };

export const TARGET_IDS = ["club", "streaming", "game"] as const;
export type TargetId = (typeof TARGET_IDS)[number];

export type Target = { id: TargetId; label: string; lufs: number; truePeak: number; range: number };

export const TARGETS: Record<TargetId, Target> = {
  club: { id: "club", label: "Club", lufs: -9, truePeak: -1, range: 9 },
  streaming: { id: "streaming", label: "Streaming", lufs: -14, truePeak: -1, range: 11 },
  game: { id: "game", label: "Game", lufs: -16, truePeak: -1, range: 11 },
};

export const FORMAT_IDS = ["wav", "mp3", "ogg"] as const;
export type FormatId = (typeof FORMAT_IDS)[number];

export const FORMATS: Record<FormatId, { label: string; ext: string; codec: string[] }> = {
  wav: { label: "WAV 24-bit", ext: "wav", codec: ["-c:a", "pcm_s24le"] },
  mp3: { label: "MP3 320 kbps", ext: "mp3", codec: ["-c:a", "libmp3lame", "-b:a", "320k"] },
  ogg: { label: "OGG Vorbis", ext: "ogg", codec: ["-c:a", "libvorbis", "-q:a", "8"] },
};

export const isTargetId = (value: unknown): value is TargetId =>
  TARGET_IDS.some((each) => each === value);
export const isFormatId = (value: unknown): value is FormatId =>
  FORMAT_IDS.some((each) => each === value);

const READ = ["-hide_banner", "-nostats"];

/** The arguments that scan a file with ebur128 and print the summary on stderr. */
export const measureArgv = (file: string): string[] => [
  ...READ,
  "-i",
  file,
  "-filter_complex",
  "ebur128=peak=true",
  "-f",
  "null",
  "-",
];

const number = (text: string | undefined): number | null => {
  const value = Number(text);
  return text === undefined || !Number.isFinite(value) ? null : value;
};

/** The numbers of the last "Summary:" block of an ebur128 run; null when there is none or the audio is silent (-inf). */
export function parseEbur128(log: string): Loudness | null {
  const at = log.lastIndexOf("Summary:");
  if (at < 0) return null;
  const summary = log.slice(at);
  const integrated = number(/\bI:\s+(-?\d+(?:\.\d+)?)\s+LUFS/.exec(summary)?.[1]);
  const range = number(/\bLRA:\s+(-?\d+(?:\.\d+)?)\s+LU\b/.exec(summary)?.[1]);
  const truePeak = number(/\bPeak:\s+(-?\d+(?:\.\d+)?)\s+dBFS/.exec(summary)?.[1]);
  if (integrated === null || range === null || truePeak === null) return null;
  return { integrated, truePeak, range };
}

const goal = (target: Target): string =>
  `I=${target.lufs}:TP=${target.truePeak}:LRA=${target.range}`;

/** Pass one: `loudnorm` measures and prints a JSON block; nothing is written. */
export function loudnormMeasureArgv(file: string, target: Target): string[] {
  return [
    ...READ,
    "-i",
    file,
    "-af",
    `loudnorm=${goal(target)}:print_format=json`,
    "-f",
    "null",
    "-",
  ];
}

/** What `loudnorm` reports about a run: the input's values (pass one) and the output's (pass two). */
export type LoudnormReport = {
  inputI: number;
  inputTp: number;
  inputLra: number;
  inputThresh: number;
  outputI: number | null;
  outputTp: number | null;
  targetOffset: number;
  /** "linear" when the gain was applied as a straight change, "dynamic" when loudnorm had to compress. */
  type: string;
};

/** The last JSON block `loudnorm` printed; null when there is none. */
export function parseLoudnorm(log: string): LoudnormReport | null {
  const end = log.lastIndexOf("}");
  const start = log.lastIndexOf("{", end);
  if (start < 0 || end < start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(log.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const field = (name: string): number | null =>
    number(String((raw as Record<string, unknown>)[name]));
  const inputI = field("input_i");
  const inputTp = field("input_tp");
  const inputLra = field("input_lra");
  const inputThresh = field("input_thresh");
  const targetOffset = field("target_offset");
  if (inputI === null || inputTp === null || inputLra === null) return null;
  if (inputThresh === null || targetOffset === null) return null;
  const type = (raw as Record<string, unknown>)["normalization_type"];
  return {
    inputI,
    inputTp,
    inputLra,
    inputThresh,
    outputI: field("output_i"),
    outputTp: field("output_tp"),
    targetOffset,
    type: typeof type === "string" ? type : "",
  };
}

/** The linear gain a dBTP ceiling stands for. */
const ceiling = (truePeak: number): number => Math.round(10 ** (truePeak / 20) * 1000) / 1000;

/**
 * Pass two: apply the measured values with `linear=true`, catch what is left
 * with a limiter at the true-peak ceiling (`level=0`: no automatic gain), and
 * encode at 44.1 kHz.
 */
export function masterArgv(
  file: string,
  out: string,
  target: Target,
  format: FormatId,
  measured: LoudnormReport,
): string[] {
  const measuredArgs = [
    `measured_I=${measured.inputI}`,
    `measured_TP=${measured.inputTp}`,
    `measured_LRA=${measured.inputLra}`,
    `measured_thresh=${measured.inputThresh}`,
    `offset=${measured.targetOffset}`,
  ].join(":");
  return [
    "-y",
    ...READ,
    "-i",
    file,
    "-af",
    `loudnorm=${goal(target)}:${measuredArgs}:linear=true:print_format=json,alimiter=limit=${ceiling(target.truePeak)}:level=0`,
    "-ar",
    "44100",
    ...FORMATS[format].codec,
    out,
  ];
}

/** True when the source is a lossy file, so a WAV made from it is converted, not lossless. */
export const isLossy = (file: string): boolean => /\.(mp3|ogg|m4a|opus|aac)$/i.test(file);

export const LOSSY_NOTE =
  "This source is a compressed file (for example a 128 kbps MP3). A WAV made from it is converted, not lossless: it holds the same sound in a bigger file.";
