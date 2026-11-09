/**
 * Analysing a track: ffmpeg decodes it to mono PCM at 22050 Hz, then tempo and
 * first beat, key, energy and the waveform come from TypeScript over that PCM,
 * and the loudness from ebur128. Cancel stops it between and inside the steps.
 */

import { join } from "node:path";
import { runFfmpegBytes } from "../audio/ffmpeg";
import { CANCELLED_MESSAGE, SAMPLE_RATE } from "../audio/fft";
import { estimateKey } from "../audio/key";
import { decodeArgv, energyOf, normalised, toFloat32, waveformPeaks } from "../audio/pcm";
import { estimateTempo, FRAME_SEC, onsetEnvelope } from "../audio/tempo";
import { measureFile } from "../master/render";
import type { AudioSource } from "../project/audio-source";
import type { Analysis, Peaks } from "../project/prep";
import type { Studio } from "../studio";

export const PEAKS_PER_SEC = 50;

export type Analysed =
  | { ok: true; analysis: Analysis; peaks: Peaks; firstBeatSec: number }
  | { ok: false; reason: "no_ffmpeg" | "failed" | "cancelled"; message: string };

const stopped = (caught: unknown, signal: AbortSignal): Analysed => ({
  ok: false,
  reason: signal.aborted ? "cancelled" : "failed",
  message: signal.aborted
    ? "Cancelled. Nothing was changed."
    : caught instanceof Error && caught.message !== CANCELLED_MESSAGE
      ? caught.message
      : "The analysis failed.",
});

/** The steps, named, for the progress the panel shows. */
export const ANALYSE_STEPS = ["decoded", "tempo", "key", "loudness"] as const;

export async function analyseAudio(
  studio: Studio,
  dir: string,
  source: AudioSource,
  signal: AbortSignal,
  step: (name: string) => void = () => undefined,
): Promise<Analysed> {
  const decoded = await runFfmpegBytes(studio.ffmpeg(), decodeArgv(join(dir, source.file)), signal);
  if (!decoded.ok)
    return signal.aborted
      ? stopped(null, signal)
      : {
          ok: false,
          reason: decoded.message.startsWith("ffmpeg stopped") ? "failed" : "no_ffmpeg",
          message: decoded.message,
        };
  const raw = toFloat32(decoded.bytes);
  if (raw.length < SAMPLE_RATE)
    return { ok: false, reason: "failed", message: "This audio is shorter than a second." };
  step("decoded");
  try {
    const pcm = normalised(raw);
    const env = await onsetEnvelope(pcm, signal);
    const tempo = estimateTempo(env);
    step("tempo");
    const key = await estimateKey(pcm, signal);
    step("key");
    const loudness = await measureFile(studio, dir, source.file, signal);
    if (signal.aborted) return stopped(null, signal);
    step("loudness");
    return {
      ok: true,
      firstBeatSec: tempo.firstBeatSec,
      peaks: { perSec: PEAKS_PER_SEC, peaks: waveformPeaks(raw, PEAKS_PER_SEC) },
      analysis: {
        bpm: tempo.bpm,
        strength: Math.round(tempo.strength * 100) / 100,
        key,
        energy: energyOf(raw, env, FRAME_SEC),
        lufs: loudness.ok ? loudness.loudness.integrated : null,
        truePeak: loudness.ok ? loudness.loudness.truePeak : null,
        durationSec: Math.round((raw.length / SAMPLE_RATE) * 1000) / 1000,
        analysedAt: new Date().toISOString(),
      },
    };
  } catch (caught) {
    return stopped(caught, signal);
  }
}
