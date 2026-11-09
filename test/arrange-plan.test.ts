import { expect, test } from "bun:test";
import {
  buildPlan,
  type Draft,
  MAX_CHUNKS,
  offsetsOf,
  parseSections,
  type Section,
  toDraft,
} from "../arrange/plan";

const section = (name: string, ms: number, styles = ["warm"]): Section => ({
  text: `[${name}]\nla`,
  durationMs: ms,
  positiveStyles: styles,
  negativeStyles: [],
  contextAdherence: "high",
});

const BASE = [
  section("Intro", 8000),
  section("Verse", 12000),
  section("Chorus", 6000),
  section("Outro", 4000),
];

const edited = (changes: Partial<Draft>, at: number): Draft[] =>
  toDraft(BASE).map((each, index) => (index === at ? { ...each, ...changes } : each));

test("parseSections reads a stored plan and refuses anything that is not one", () => {
  const plan = {
    chunks: [
      {
        text: "[Intro]",
        duration_ms: 30000,
        positive_styles: ["a"],
        negative_styles: [],
        context_adherence: "medium",
      },
    ],
  };
  expect(parseSections(plan)).toEqual([
    {
      text: "[Intro]",
      durationMs: 30000,
      positiveStyles: ["a"],
      negativeStyles: [],
      contextAdherence: "medium",
    },
  ]);
  expect(parseSections(null)).toBeNull();
  expect(parseSections({ chunks: [] })).toBeNull();
  expect(
    parseSections({ chunks: [{ song_id: "x", range: { start_ms: 0, end_ms: 5 } }] }),
  ).toBeNull();
});

test("offsets come from the chunk durations", () => {
  expect(offsetsOf(BASE)).toEqual([0, 8000, 20000, 26000]);
});

test("kept, changed, inserted and deleted sections are told apart", () => {
  const draft: Draft[] = [
    ...edited({ positiveStyles: ["bright"] }, 1).slice(0, 3),
    { ...section("Bridge", 5000), source: null },
  ];
  const built = buildPlan("song", BASE, draft);
  expect(built.changes.map((each) => `${each.label}:${each.kind}`)).toEqual([
    "Intro:kept",
    "Verse:changed",
    "Chorus:kept",
    "Bridge:inserted",
    "Outro:deleted",
  ]);
  expect(built.changes[1]?.fields).toEqual(["styles"]);
  if (!built.ok) throw new Error(built.message);
  expect(built.generated).toBe(2);
  expect(built.kept).toBe(2);
});

test("a changed section is a generation chunk; kept ones are audio references into the old song", () => {
  const built = buildPlan("song", BASE, edited({ text: "[Verse]\nnew words" }, 1));
  if (!built.ok) throw new Error(built.message);
  expect(built.chunks).toEqual([
    { song_id: "song", range: { start_ms: 0, end_ms: 8000 } },
    {
      text: "[Verse]\nnew words",
      duration_ms: 12000,
      positive_styles: ["warm"],
      negative_styles: [],
      context_adherence: "high",
    },
    { song_id: "song", range: { start_ms: 20000, end_ms: 30000 } },
  ]);
});

test("neighbouring kept sections are one range, and a gap splits them", () => {
  const changedLast = buildPlan("song", BASE, edited({ durationMs: 5000 }, 3));
  if (!changedLast.ok) throw new Error(changedLast.message);
  expect(changedLast.chunks[0]).toEqual({
    song_id: "song",
    range: { start_ms: 0, end_ms: 26000 },
  });
  expect(changedLast.chunks).toHaveLength(2);
  // Deleting the Verse leaves Intro and Chorus next to each other in the new song, but not in the old one.
  const deleted = buildPlan(
    "song",
    BASE,
    toDraft(BASE).filter((_each, at) => at !== 1),
  );
  if (!deleted.ok) throw new Error(deleted.message);
  expect(deleted.chunks).toEqual([
    { song_id: "song", range: { start_ms: 0, end_ms: 8000 } },
    { song_id: "song", range: { start_ms: 20000, end_ms: 30000 } },
  ]);
});

test("a section inserted between two kept ones splits the range", () => {
  const draft = toDraft(BASE);
  draft.splice(2, 0, { ...section("Break", 4000), source: null });
  const built = buildPlan("song", BASE, draft);
  if (!built.ok) throw new Error(built.message);
  expect(built.chunks.map((each) => ("range" in each ? "keep" : "make"))).toEqual([
    "keep",
    "make",
    "keep",
  ]);
});

test("ranges follow the previous version's durations, not the first sketch's", () => {
  const second = [section("Intro", 8000), section("Verse", 20000), section("Chorus", 6000)];
  const built = buildPlan("v1", second, [
    ...toDraft(second).slice(0, 2),
    { ...toDraft(second)[2], text: "[Chorus]\nbig", source: 2 } as Draft,
  ]);
  if (!built.ok) throw new Error(built.message);
  expect(built.chunks[0]).toEqual({ song_id: "v1", range: { start_ms: 0, end_ms: 28000 } });
});

test("nothing changed is refused, with every section still listed as kept", () => {
  const built = buildPlan("song", BASE, toDraft(BASE));
  expect(built.ok).toBe(false);
  if (built.ok) return;
  expect(built.message).toBe("Nothing changed.");
  expect(built.changes.every((each) => each.kind === "kept")).toBe(true);
});

test("a generation chunk lasts 3000 to 120000 ms", () => {
  expect(buildPlan("s", BASE, edited({ durationMs: 2999 }, 1)).ok).toBe(false);
  expect(buildPlan("s", BASE, edited({ durationMs: 3000 }, 1)).ok).toBe(true);
  expect(buildPlan("s", BASE, edited({ durationMs: 120000 }, 1)).ok).toBe(true);
  expect(buildPlan("s", BASE, edited({ durationMs: 120001 }, 1)).ok).toBe(false);
  expect(buildPlan("s", BASE, edited({ text: "  " }, 1)).ok).toBe(false);
});

test("a plan has at most 30 chunks", () => {
  const many = Array.from({ length: MAX_CHUNKS + 1 }, (_each, at) => section(`S${at}`, 4000));
  const draft = toDraft(many).map((each) => ({ ...each, source: null }));
  const built = buildPlan("s", many, draft);
  expect(built.ok).toBe(false);
  if (!built.ok) expect(built.message).toContain("at most 30");
  const exact = toDraft(many.slice(0, MAX_CHUNKS)).map((each) => ({ ...each, source: null }));
  expect(buildPlan("s", many, exact).ok).toBe(true);
});

test("a song needs a section", () => {
  expect(buildPlan("s", BASE, []).ok).toBe(false);
});
