import { expect, test } from "bun:test";
import { barMs, barStartMs, tempoOf } from "../audio/bars";
import {
  audible,
  DEFAULT_TRACK,
  type MixInput,
  mixArgv,
  panGains,
  parseMix,
} from "../audio/mixgraph";

const input = (key: string, changes: Partial<MixInput> = {}): MixInput => ({
  ...DEFAULT_TRACK,
  key,
  file: `/p/${key}.mp3`,
  startMs: 0,
  ...changes,
});

const graphOf = (argv: string[] | null): string =>
  argv?.[argv.indexOf("-filter_complex") + 1] ?? "";

test("bars are four beats: 120 BPM is 2 s a bar, and bar 1 is the start", () => {
  expect(barMs(120)).toBe(2000);
  expect(barStartMs(1, 120)).toBe(0);
  expect(barStartMs(3, 120)).toBe(4000);
  expect(barStartMs(2, 90)).toBe(2667);
});

test("the tempo is read from the styles, then the brief, then 120", () => {
  const sections = [
    {
      text: "[A]",
      durationMs: 1,
      positiveStyles: ["warm", "96 BPM"],
      negativeStyles: [],
      contextAdherence: "high" as const,
    },
  ];
  expect(tempoOf(sections, 80)).toBe(96);
  expect(tempoOf([], 80)).toBe(80);
  expect(tempoOf([], null)).toBe(120);
});

test("mute drops a track; solo keeps only the soloed ones", () => {
  const tracks = [input("a"), input("b", { mute: true }), input("c")];
  expect(audible(tracks).map((each) => each.key)).toEqual(["a", "c"]);
  const soloed = [input("a"), input("b", { solo: true }), input("c", { solo: true, mute: true })];
  expect(audible(soloed).map((each) => each.key)).toEqual(["b"]);
});

test("pan gains are equal power with a unity centre", () => {
  const [centreLeft, centreRight] = panGains(0);
  expect(centreLeft).toBeCloseTo(1, 6);
  expect(centreRight).toBeCloseTo(1, 6);
  const [hardLeft, none] = panGains(-1);
  expect(hardLeft).toBeCloseTo(Math.SQRT2, 6);
  expect(none).toBeCloseTo(0, 6);
  const [left, right] = panGains(0.5);
  expect(left ** 2 + right ** 2).toBeCloseTo(2, 6);
});

test("the ffmpeg arguments mix the audible tracks with level, pan and start offset", () => {
  const argv = mixArgv(
    [
      input("stem:vocals", { db: -6 }),
      input("stem:drums", { mute: true }),
      input("layer:abc", { startMs: barStartMs(3, 120), pan: -1, db: 3.5 }),
    ],
    "/p/mix/mix-1.wav",
  );
  expect(argv).not.toBeNull();
  expect(argv?.filter((each) => each === "-i")).toHaveLength(2);
  expect(argv).toContain("/p/stem:vocals.mp3");
  expect(argv).not.toContain("/p/stem:drums.mp3");
  expect(argv?.slice(-5)).toEqual(["-ar", "44100", "-c:a", "pcm_s16le", "/p/mix/mix-1.wav"]);
  const graph = graphOf(argv);
  expect(graph).toContain(
    "[0:a]aformat=channel_layouts=stereo,volume=-6dB,pan=stereo|c0=1*c0|c1=1*c1[t0]",
  );
  expect(graph).toContain("volume=3.5dB,pan=stereo|c0=1.4142*c0|c1=0*c1,adelay=4000|4000[t1]");
  expect(graph).toContain("[t0][t1]amix=inputs=2");
  expect(graph).toContain("[out]");
  expect(argv).toContain("[out]");
  expect(argv?.[argv.length - 1]).toBe("/p/mix/mix-1.wav");
});

test("one audible track skips amix; nothing audible makes no command", () => {
  expect(graphOf(mixArgv([input("a")], "/o.wav"))).toBe(
    "[0:a]aformat=channel_layouts=stereo,volume=0dB,pan=stereo|c0=1*c0|c1=1*c1[t0];[t0]alimiter=limit=0.97[out]",
  );
  expect(mixArgv([input("a", { mute: true })], "/o.wav")).toBeNull();
  expect(mixArgv([input("a"), input("b", { solo: true, mute: true })], "/o.wav")).toBeNull();
  expect(mixArgv([], "/o.wav")).toBeNull();
});

test("mix.json from outside is clamped and defaulted", () => {
  const mix = parseMix({
    tracks: { "stem:a": { db: 99, pan: -7, mute: "yes", solo: true }, "stem:b": "junk" },
  });
  expect(mix.tracks["stem:a"]).toEqual({ db: 12, pan: -1, mute: false, solo: true });
  expect(mix.tracks["stem:b"]).toEqual(DEFAULT_TRACK);
  expect(parseMix(null)).toEqual({ tracks: {} });
});
