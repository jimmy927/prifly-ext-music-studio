import { expect, test } from "bun:test";
import { snapToBeat } from "../prep/grid";
import { MAX_CLIP_SEC } from "../video/constants";
import { pickRange } from "../video/range";
import {
  barsOf,
  clipSeconds,
  draftShots,
  effectiveBars,
  mergeWithNext,
  type ShotList,
  splitShot,
  tilingProblems,
} from "../video/shotlist";

const SECTIONS = [
  { name: "Intro", startSec: 0 },
  { name: "Verse", startSec: 8 },
  { name: "Chorus", startSec: 20 },
  { name: "Outro", startSec: 26 },
];
const GRID = { bpm: 120, firstBeatSec: 0 };

let counter = 0;
const ids = () => `0000${String(counter++).padStart(4, "0")}`;

const draft = (bars: 2 | 4 | 8, sections = SECTIONS, grid = GRID, durationSec = 30) =>
  draftShots({ sections, grid, durationSec, bars, makeId: ids });

test("the shots tile the song: no gap, no overlap, from 0 to the song's end", () => {
  const list = draft(4);
  expect(tilingProblems(list)).toEqual([]);
  expect(list.shots[0]?.startSec).toBe(0);
  expect(list.shots.at(-1)?.endSec).toBe(30);
  for (const [at, shot] of list.shots.entries()) {
    if (at > 0) expect(shot.startSec).toBe(list.shots[at - 1]?.endSec ?? -1);
  }
});

test("every cut lands on a beat of the grid", () => {
  for (const grid of [GRID, { bpm: 123, firstBeatSec: 0.37 }, { bpm: 90, firstBeatSec: 0.1 }]) {
    const list = draft(4, SECTIONS, grid, 41.3);
    for (const shot of list.shots.slice(1))
      expect(snapToBeat(shot.startSec, grid)).toBeCloseTo(shot.startSec, 2);
  }
});

test("the bar rule: 4 bars at 120 BPM is 8 seconds, cut from the section's start; the rest is its own shot", () => {
  const list = draft(4);
  // Intro 0-8 is one 4-bar shot; Verse 8-20 is 8 s then 4 s; Chorus 20-26 is 3 bars; Outro 26-30 is 2.
  expect(list.shots.map((each) => [each.section, each.startSec, each.endSec])).toEqual([
    ["Intro", 0, 8],
    ["Verse", 8, 16],
    ["Verse", 16, 20],
    ["Chorus", 20, 26],
    ["Outro", 26, 30],
  ]);
  expect(barsOf(list.shots[0] ?? { startSec: 0, endSec: 0 }, GRID)).toBe(4);
});

test("2, 4 and 8 bars give shots of that many bars", () => {
  const one = [{ name: "Song", startSec: 0 }];
  expect(draft(2, one).shots.map((each) => each.endSec - each.startSec)).toEqual([
    4, 4, 4, 4, 4, 4, 4, 2,
  ]);
  // 8 bars would be 16 s here, over the 15 s a clip can be, so it is halved to 4 bars.
  expect(draft(8, one).shots.map((each) => each.endSec - each.startSec)).toEqual([8, 8, 8, 6]);
  expect(draft(4, one).shots.map((each) => each.endSec - each.startSec)).toEqual([8, 8, 8, 6]);
});

test("a shot is never longer than the 15 seconds Omni makes: the bar rule is halved when it would be", () => {
  const slow = { bpm: 60, firstBeatSec: 0 };
  expect(effectiveBars(8, slow)).toBe(2);
  const list = draft(8, [{ name: "Song", startSec: 0 }], slow, 70);
  for (const shot of list.shots)
    expect(shot.endSec - shot.startSec).toBeLessThanOrEqual(MAX_CLIP_SEC);
  expect(tilingProblems(list)).toEqual([]);
});

test("a song with no sections is one section called Song; descriptions are blank", () => {
  const list = draft(4, []);
  expect(list.shots.every((each) => each.section === "Song" && each.text === "")).toBe(true);
  expect(tilingProblems(list)).toEqual([]);
});

test("what is left at the end of a section, under a bar, joins the shot before it", () => {
  const list = draft(4, [{ name: "Song", startSec: 0 }], GRID, 17);
  expect(list.shots.map((each) => each.endSec)).toEqual([8, 17]);
});

test("a clip is asked for in whole seconds from 3 to 15", () => {
  expect(clipSeconds({ startSec: 0, endSec: 8 })).toBe(8);
  expect(clipSeconds({ startSec: 0, endSec: 8.4 })).toBe(9);
  expect(clipSeconds({ startSec: 0, endSec: 2 })).toBe(3);
  expect(clipSeconds({ startSec: 0, endSec: 20 })).toBe(15);
});

const base = (): ShotList => draft(4);

test("splitting a shot on a beat keeps the tiling and gives the second half a fresh, blank shot", () => {
  const list = base();
  const first = list.shots[0];
  if (first === undefined) throw new Error("no shot");
  const done = splitShot(
    { ...list, shots: [{ ...first, text: "hello", approved: true }, ...list.shots.slice(1)] },
    first.id,
    4.9,
    () => "deadbeef",
  );
  expect(done.ok).toBe(true);
  if (!done.ok) return;
  expect(done.list.shots).toHaveLength(list.shots.length + 1);
  expect(done.list.shots[0]).toMatchObject({
    id: first.id,
    startSec: 0,
    endSec: 5,
    text: "hello",
    approved: true,
  });
  expect(done.list.shots[1]).toMatchObject({
    id: "deadbeef",
    startSec: 5,
    endSec: 8,
    text: "",
    approved: false,
    frame: null,
  });
  expect(tilingProblems(done.list)).toEqual([]);
});

test("a split closer than a beat to either end is refused", () => {
  const list = base();
  const first = list.shots[0];
  const done = splitShot(list, first?.id ?? "", 0.2);
  expect(done.ok).toBe(false);
  expect(splitShot(list, first?.id ?? "", 7.9).ok).toBe(false);
  expect(splitShot(list, "nope", 4).ok).toBe(false);
});

test("merging with the next joins the two, keeps the first frame, drops the clip, and joins the text", () => {
  const list = base();
  const [first, a, b, ...rest] = list.shots;
  if (first === undefined || a === undefined || b === undefined) throw new Error("no shots");
  const withText: ShotList = {
    ...list,
    shots: [
      first,
      { ...a, text: "one", take: "x-1", frame: "f.png" },
      { ...b, text: "two" },
      ...rest,
    ],
  };
  const done = mergeWithNext(withText, a.id);
  expect(done.ok).toBe(true);
  if (!done.ok) return;
  expect(done.list.shots[1]).toMatchObject({
    id: a.id,
    startSec: 8,
    endSec: 20,
    text: "one two",
    frame: "f.png",
    take: null,
  });
  expect(done.list.shots).toHaveLength(list.shots.length - 1);
  expect(tilingProblems(done.list)).toEqual([]);
});

test("a merge that would pass 15 seconds, or has no next shot, is refused", () => {
  const list = base();
  // The first two shots are 8 s each: 16 s together.
  expect(mergeWithNext(list, list.shots[0]?.id ?? "").ok).toBe(false);
  expect(mergeWithNext(list, list.shots.at(-1)?.id ?? "").ok).toBe(false);
});

test("tilingProblems names a gap, an overlap and a cut off the beat", () => {
  const list = base();
  const [a, b, ...rest] = list.shots;
  if (a === undefined || b === undefined) throw new Error("no shots");
  expect(
    tilingProblems({ ...list, shots: [a, { ...b, startSec: 9 }, ...rest] }).join(" "),
  ).toContain("gap");
  expect(
    tilingProblems({ ...list, shots: [a, { ...b, startSec: 7 }, ...rest] }).join(" "),
  ).toContain("overlap");
  expect(
    tilingProblems({
      ...list,
      shots: [{ ...a, endSec: 8.13 }, { ...b, startSec: 8.13 }, ...rest],
    }).join(" "),
  ).toContain("beat");
});

test("the vertical cut takes about 30 seconds of whole shots, from the chorus if there is one", () => {
  const list = draft(
    4,
    [
      { name: "Intro", startSec: 0 },
      { name: "Verse", startSec: 16 },
      { name: "Chorus 1", startSec: 48 },
      { name: "Outro", startSec: 96 },
    ],
    GRID,
    112,
  );
  const range = pickRange(list.shots, null);
  expect(range).not.toBeNull();
  const chorus = list.shots.find((each) => each.section === "Chorus 1");
  expect(range?.startSec).toBe(chorus?.startSec ?? -1);
  expect((range?.endSec ?? 0) - (range?.startSec ?? 0)).toBeGreaterThanOrEqual(24);
  expect((range?.endSec ?? 0) - (range?.startSec ?? 0)).toBeLessThanOrEqual(40);
  const chosen = pickRange(list.shots, { startSec: 17, endSec: 40 });
  expect(chosen?.startSec).toBe(16);
  expect(list.shots.some((each) => each.endSec === chosen?.endSec)).toBe(true);
});
