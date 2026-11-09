import { expect, test } from "bun:test";
import {
  autoCues,
  deleteCue,
  setCue,
  setLoop,
  withBpm,
  withFirstBeat,
  withNudge,
} from "../prep/edit";
import {
  beatsBetween,
  cuesFromSections,
  loopEnd,
  nudged,
  resnapped,
  snapToBeat,
  withCue,
} from "../prep/grid";
import type { Prep } from "../project/prep";

const grid = { bpm: 120, firstBeatSec: 0.25 };

test("a time snaps to the nearest beat of the grid", () => {
  expect(snapToBeat(0.25, grid)).toBe(0.25);
  expect(snapToBeat(0.74, grid)).toBe(0.75);
  expect(snapToBeat(0.6, grid)).toBe(0.75);
  expect(snapToBeat(0.49, grid)).toBe(0.25);
  expect(snapToBeat(10.0, grid)).toBe(10.25);
});

test("snapping never goes before the start of the track, even when the first beat is late", () => {
  expect(snapToBeat(0, grid)).toBe(0.25);
  expect(snapToBeat(0, { bpm: 120, firstBeatSec: 1.1 })).toBe(0.1);
  expect(snapToBeat(-3, { bpm: 90, firstBeatSec: 0 })).toBe(0);
});

test("snapping a fractional tempo keeps millisecond precision", () => {
  const odd = { bpm: 127.5, firstBeatSec: 0.1 };
  expect(snapToBeat(30, odd)).toBe(30.218);
});

test("beats between two times are numbered by bar and beat", () => {
  const beats = beatsBetween(grid, 0, 2.3);
  expect(beats.map((each) => each.sec)).toEqual([0.25, 0.75, 1.25, 1.75, 2.25]);
  expect(beats.map((each) => `${each.bar}.${each.beat}`)).toEqual([
    "1.1",
    "1.2",
    "1.3",
    "1.4",
    "2.1",
  ]);
});

test("a nudge moves the grid, not below zero", () => {
  expect(nudged(grid, 10)).toEqual({ bpm: 120, firstBeatSec: 0.26 });
  expect(nudged(grid, -500)).toEqual({ bpm: 120, firstBeatSec: 0 });
});

test("a cue lands on a beat, and setting the same slot again moves it and keeps its name", () => {
  const one = withCue([], "A", 3.1, grid, "Drop");
  expect(one).toEqual([{ slot: "A", sec: 3.25, name: "Drop" }]);
  const moved = withCue(one, "A", 8.0, grid);
  expect(moved).toEqual([{ slot: "A", sec: 8.25, name: "Drop" }]);
  const two = withCue(moved, "C", 1, grid);
  expect(two.map((each) => each.slot)).toEqual(["A", "C"]);
});

test("a loop is bars long and ends on a beat", () => {
  expect(loopEnd(grid, { startSec: 0.25, bars: 4 })).toBe(8.25);
  expect(loopEnd({ bpm: 128, firstBeatSec: 0 }, { startSec: 0, bars: 1 })).toBe(1.875);
});

test("cues and loop follow the grid when it changes", () => {
  const moved = resnapped(
    [{ slot: "A", sec: 0.75, name: "" }],
    { startSec: 0.25, bars: 2 },
    nudged(grid, 20),
  );
  expect(moved.cues[0]?.sec).toBe(0.77);
  expect(moved.loop?.startSec).toBe(0.27);
});

test("cues from sections take the first eight starts, snapped, with the section names", () => {
  const sections = Array.from({ length: 10 }, (_v, at) => ({ name: `S${at}`, startSec: at * 8.1 }));
  const cues = cuesFromSections(sections, grid);
  expect(cues).toHaveLength(8);
  expect(cues[0]).toEqual({ slot: "A", sec: 0.25, name: "S0" });
  expect(cues[1]).toEqual({ slot: "B", sec: 8.25, name: "S1" });
  expect(cues[7]?.slot).toBe("H");
});

const prep = (over: Partial<Prep> = {}): Prep => ({
  source: { kind: "sketch", id: "a", label: "Sketch A", file: "sketches/a.mp3" },
  analysis: {
    bpm: 120,
    strength: 9,
    key: null,
    energy: 5,
    lufs: -14,
    truePeak: -1,
    durationSec: 60,
    analysedAt: "",
  },
  grid,
  manualBpm: false,
  cues: [],
  loop: null,
  ...over,
});

test("prep edits: a typed tempo, nudge and first beat re-snap cues; mistakes answer a sentence", () => {
  const base = prep({
    cues: [{ slot: "A", sec: 0.75, name: "x" }],
    loop: { startSec: 0.25, bars: 1 },
  });
  const typed = withBpm(base, 125.5);
  expect(typeof typed).not.toBe("string");
  if (typeof typed === "string") throw new Error(typed);
  expect(typed.manualBpm).toBe(true);
  expect(typed.grid).toEqual({ bpm: 125.5, firstBeatSec: 0.25 });
  expect(withBpm(base, 500)).toContain("between 40 and 240");
  expect(withBpm(base, "fast")).toContain("between 40 and 240");
  const nudge = withNudge(base, -10);
  if (typeof nudge === "string") throw new Error(nudge);
  expect(nudge.grid?.firstBeatSec).toBe(0.24);
  expect(nudge.cues[0]?.sec).toBe(0.74);
  expect(withNudge(base, 5000)).toContain("up to a second");
  const first = withFirstBeat(base, 1.5);
  if (typeof first === "string") throw new Error(first);
  expect(first.grid?.firstBeatSec).toBe(1.5);
  expect(withNudge(prep({ grid: null }), 5)).toContain("no tempo yet");
});

test("prep edits: cues snap, can be deleted, and stay inside the track", () => {
  const withA = setCue(prep(), "A", 5.1);
  if (typeof withA === "string") throw new Error(withA);
  expect(withA.cues).toEqual([{ slot: "A", sec: 5.25, name: "" }]);
  expect(deleteCue(withA, "A").cues).toEqual([]);
  expect(setCue(prep(), "A", 90)).toContain("past the end");
  expect(setCue(prep(), "A", -1)).toContain("time in the track");
});

test("prep edits: one loop, snapped, with a set length and inside the track", () => {
  const looped = setLoop(prep(), 4.1, 8);
  if (typeof looped === "string") throw new Error(looped);
  expect(looped.loop).toEqual({ startSec: 4.25, bars: 8 });
  expect(setLoop(prep(), 4, 3)).toContain("bars long");
  expect(setLoop(prep(), 50, 16)).toContain("past the end");
});

test("auto cues need a plan", () => {
  expect(autoCues(prep(), [])).toContain("no section plan");
  const done = autoCues(prep(), [
    { name: "Intro", startSec: 0 },
    { name: "Verse", startSec: 15.9 },
  ]);
  if (typeof done === "string") throw new Error(done);
  expect(done.cues.map((each) => each.name)).toEqual(["Intro", "Verse"]);
});
