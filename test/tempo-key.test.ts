import { expect, test } from "bun:test";
import {
  camelot,
  compatibleKeys,
  keyFromTonality,
  keyName,
  parseCamelot,
  tonality,
} from "../audio/camelot";
import { estimateKey } from "../audio/key";
import { estimateTempo, onsetEnvelope } from "../audio/tempo";
import { A_MINOR, chords, clickTrack, E_FLAT_MAJOR, noise, tone } from "./synth";

test.each([
  [120, 0.3],
  [90, 0.25],
  [140, 0.5],
])(
  "tempo of a %d BPM click track is within 0.5 BPM and the first beat within 20 ms",
  async (bpm, offset) => {
    const found = estimateTempo(await onsetEnvelope(clickTrack(bpm, 24, offset)));
    expect(found.bpm).not.toBeNull();
    expect(Math.abs((found.bpm ?? 0) - bpm)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(found.firstBeatSec - offset)).toBeLessThanOrEqual(0.02);
  },
);

test("a long quiet start does not move the first beat: it is the first real hit", async () => {
  const found = estimateTempo(await onsetEnvelope(clickTrack(128, 24, 4.2)));
  expect(Math.abs((found.bpm ?? 0) - 128)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(found.firstBeatSec - 4.2)).toBeLessThanOrEqual(0.02);
});

test("noise and a steady tone have no clear tempo", async () => {
  expect(estimateTempo(await onsetEnvelope(noise(20))).bpm).toBeNull();
  expect(estimateTempo(await onsetEnvelope(tone(20))).bpm).toBeNull();
});

test("a cancelled analysis stops", async () => {
  const abort = new AbortController();
  abort.abort();
  await expect(onsetEnvelope(clickTrack(120, 24), abort.signal)).rejects.toThrow("Cancelled");
});

test("the key of an A-minor progression is A minor, 8A", async () => {
  const key = await estimateKey(chords(A_MINOR, 2));
  expect(key).toMatchObject({ tonic: 9, mode: "minor" });
  expect(camelot(key ?? { tonic: 0, mode: "major" })).toBe("8A");
});

test("the key of an E-flat-major progression is E♭ major, 5B", async () => {
  const key = await estimateKey(chords(E_FLAT_MAJOR, 2));
  expect(key).toMatchObject({ tonic: 3, mode: "major" });
  expect(keyName(key ?? { tonic: 0, mode: "major" })).toBe("E♭ major");
  expect(camelot(key ?? { tonic: 0, mode: "major" })).toBe("5B");
});

test("silence has no key", async () => {
  expect(await estimateKey(new Float32Array(44100))).toBeNull();
});

test("Camelot codes follow the wheel for all 24 keys", () => {
  const minors = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"];
  const wheel = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"];
  for (const [tonic, code] of wheel.entries()) {
    expect(camelot({ tonic, mode: "minor" })).toBe(code);
    expect(tonality({ tonic, mode: "minor" })).toBe(`${minors[tonic]}m`);
  }
  const majors = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"];
  for (const [tonic, code] of majors.entries())
    expect(camelot({ tonic, mode: "major" })).toBe(code);
});

test("compatible keys are the same, one step either way round the wheel, and the relative", () => {
  expect(compatibleKeys("8A")).toEqual([
    { code: "8A", relation: "same" },
    { code: "9A", relation: "up one" },
    { code: "7A", relation: "down one" },
    { code: "8B", relation: "relative" },
  ]);
  expect(compatibleKeys("12b").map((each) => each.code)).toEqual(["12B", "1B", "11B", "12A"]);
  expect(compatibleKeys("1A").map((each) => each.code)).toEqual(["1A", "2A", "12A", "1B"]);
  expect(compatibleKeys("13A")).toEqual([]);
});

test("codes and key names are read back", () => {
  expect(parseCamelot(" 8a ")).toBe("8A");
  expect(parseCamelot("0A")).toBeNull();
  expect(parseCamelot("13B")).toBeNull();
  expect(keyFromTonality("F#m")).toEqual({ tonic: 6, mode: "minor" });
  expect(keyFromTonality("eb")).toEqual({ tonic: 3, mode: "major" });
  expect(keyFromTonality("H")).toBeNull();
});
