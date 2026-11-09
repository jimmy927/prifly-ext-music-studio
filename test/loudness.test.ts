import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpeg } from "../audio/ffmpeg";
import {
  isLossy,
  loudnormMeasureArgv,
  masterArgv,
  measureArgv,
  parseEbur128,
  parseLoudnorm,
  TARGETS,
} from "../audio/loudness";
import { chords, E_FLAT_MAJOR, pcmWav } from "./synth";

const fixture = (name: string): Promise<string> =>
  Bun.file(join(import.meta.dir, "fixtures", name)).text();

test("the ebur128 summary of a real ffmpeg 4.2 run is read", async () => {
  expect(parseEbur128(await fixture("ffmpeg-4.2-ebur128.txt"))).toEqual({
    integrated: -35.4,
    truePeak: -26.5,
    range: 0,
  });
});

test("only the last summary counts, and a silent file (-inf) has no loudness", () => {
  const summary = (i: string, lra: string, peak: string) =>
    `Summary:\n\n  Integrated loudness:\n    I:         ${i} LUFS\n    Threshold: -70.0 LUFS\n\n  Loudness range:\n    LRA:         ${lra} LU\n\n  True peak:\n    Peak:      ${peak} dBFS\n`;
  expect(
    parseEbur128(`${summary("-20.0", "3.0", "-1.0")}\n${summary("-9.4", "5.5", "-0.3")}`),
  ).toEqual({
    integrated: -9.4,
    truePeak: -0.3,
    range: 5.5,
  });
  expect(parseEbur128(summary("-inf", "0.0", "-inf"))).toBeNull();
  expect(parseEbur128("nothing here")).toBeNull();
});

test("loudnorm's first pass is read from a real ffmpeg 4.2 run", async () => {
  expect(parseLoudnorm(await fixture("ffmpeg-4.2-loudnorm-pass1.txt"))).toEqual({
    inputI: -35.46,
    inputTp: -26.45,
    inputLra: 0,
    inputThresh: -45.46,
    outputI: -13.98,
    outputTp: -5.02,
    targetOffset: -0.02,
    type: "dynamic",
  });
});

test("loudnorm's second pass reports what the file came out at", async () => {
  const report = parseLoudnorm(await fixture("ffmpeg-4.2-loudnorm-pass2.txt"));
  expect(report?.outputI).toBeCloseTo(-14, 0);
  expect(report?.type).toBe("dynamic");
  expect(parseLoudnorm("no json here")).toBeNull();
  expect(parseLoudnorm('{ "input_i" : "abc" }')).toBeNull();
});

test("the measure and master commands use only what ffmpeg 4.2 has", async () => {
  expect(measureArgv("in.wav")).toEqual([
    "-hide_banner",
    "-nostats",
    "-i",
    "in.wav",
    "-filter_complex",
    "ebur128=peak=true",
    "-f",
    "null",
    "-",
  ]);
  const first = loudnormMeasureArgv("in.wav", TARGETS.streaming);
  expect(first).toContain("loudnorm=I=-14:TP=-1:LRA=11:print_format=json");
  const measured = parseLoudnorm(await fixture("ffmpeg-4.2-loudnorm-pass1.txt"));
  if (measured === null) throw new Error("fixture");
  const argv = masterArgv("in.wav", "out.wav", TARGETS.club, "wav", measured);
  const filter = argv[argv.indexOf("-af") + 1] ?? "";
  expect(filter).toBe(
    "loudnorm=I=-9:TP=-1:LRA=9:measured_I=-35.46:measured_TP=-26.45:measured_LRA=0:measured_thresh=-45.46:offset=-0.02:linear=true:print_format=json,alimiter=limit=0.891:level=0",
  );
  expect(argv.slice(-5)).toEqual(["-ar", "44100", "-c:a", "pcm_s24le", "out.wav"]);
  const mp3 = masterArgv("in.wav", "out.mp3", TARGETS.game, "mp3", measured);
  expect(mp3.slice(-4)).toEqual(["libmp3lame", "-b:a", "320k", "out.mp3"]);
  expect(masterArgv("in.wav", "out.ogg", TARGETS.game, "ogg", measured)).toContain("libvorbis");
});

test("a compressed source is lossy, a WAV is not", () => {
  expect(isLossy("sketches/a.mp3")).toBe(true);
  expect(isLossy("versions/v1.MP3")).toBe(true);
  expect(isLossy("mix/mix-1.wav")).toBe(false);
});

test("a real tiny two-pass render lands near the target and writes a WAV", async () => {
  const dir = mkdtempSync(join(tmpdir(), "music-studio-loud-"));
  const source = join(dir, "in.wav");
  await Bun.write(source, pcmWav(chords(E_FLAT_MAJOR, 1, 1).map((sample) => sample * 0.3)));
  const first = await runFfmpeg("ffmpeg", loudnormMeasureArgv(source, TARGETS.streaming));
  if (!first.ok) throw new Error(first.message);
  const measured = parseLoudnorm(first.log);
  if (measured === null) throw new Error("no loudnorm report");
  const out = join(dir, "out.wav");
  const made = await runFfmpeg(
    "ffmpeg",
    masterArgv(source, out, TARGETS.streaming, "wav", measured),
  );
  expect(made.ok).toBe(true);
  const after = await runFfmpeg("ffmpeg", measureArgv(out));
  if (!after.ok) throw new Error(after.message);
  const result = parseEbur128(after.log);
  expect(Math.abs((result?.integrated ?? 0) - -14)).toBeLessThan(1.5);
  expect(result?.truePeak ?? 0).toBeLessThanOrEqual(-0.9);
});
