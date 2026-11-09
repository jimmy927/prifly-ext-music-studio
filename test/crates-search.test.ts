import { expect, test } from "bun:test";
import { matchesPrep, parseQuery } from "../prep/search";
import { type Prep, writePrep } from "../project/prep";
import { audioProject, dj } from "./dj-world";
import { ask } from "./stage-world";

test("search words and the key and tempo filters are told apart", () => {
  expect(parseQuery("key 8A")).toEqual({ text: "", key: "8A", bpm: null });
  expect(parseQuery("lofi key:8a bpm 120-128")).toEqual({
    text: "lofi",
    key: "8A",
    bpm: { min: 120, max: 128 },
  });
  expect(parseQuery("bpm 128-120").bpm).toEqual({ min: 120, max: 128 });
  expect(parseQuery("bpm 124").bpm).toEqual({ min: 124, max: 124 });
  expect(parseQuery("key Am").key).toBe("8A");
  expect(parseQuery("key Ebm").key).toBe("2A");
  expect(parseQuery("key nonsense").key).toBe("?");
  expect(parseQuery("dusty beat")).toEqual({ text: "dusty beat", key: null, bpm: null });
});

test("a track matches the filters by its key and tempo; an unprepared one matches none", () => {
  const summary = { bpm: 124.2, camelot: "8A", tonality: "Am", lufs: -9 };
  expect(matchesPrep(summary, parseQuery("key 8A"))).toBe(true);
  expect(matchesPrep(summary, parseQuery("key 9A"))).toBe(false);
  expect(matchesPrep(summary, parseQuery("bpm 120-128"))).toBe(true);
  expect(matchesPrep(summary, parseQuery("bpm 128-140"))).toBe(false);
  expect(matchesPrep(summary, parseQuery("bpm 124"))).toBe(true);
  expect(matchesPrep(summary, parseQuery("key 8A bpm 130-140"))).toBe(false);
  expect(matchesPrep(null, parseQuery("key 8A"))).toBe(false);
  expect(matchesPrep(null, parseQuery("lofi"))).toBe(true);
  expect(matchesPrep(summary, parseQuery("key nonsense"))).toBe(false);
});

type Crates = { crates: { id: string; name: string; count: number }[]; id?: string };

test("crates are created, renamed, filled, emptied and deleted, and survive in api.state", async () => {
  const w = dj();
  const made = (await ask(w, "crate-create", {}, { name: "  Friday   night " })) as Crates;
  expect(made.crates).toEqual([{ id: made.id ?? "", name: "Friday night", count: 0 }]);
  const crate = made.id ?? "";
  const { id: project } = await audioProject(w);

  expect(((await ask(w, "crate-add", {}, { crate, project })) as Crates).crates[0]?.count).toBe(1);
  // Adding twice keeps one.
  expect(((await ask(w, "crate-add", {}, { crate, project })) as Crates).crates[0]?.count).toBe(1);
  const renamed = (await ask(w, "crate-rename", {}, { crate, name: "Saturday" })) as Crates;
  expect(renamed.crates[0]?.name).toBe("Saturday");
  expect(((await ask(w, "crates")) as Crates).crates).toHaveLength(1);

  const inCrate = (await ask(w, "library", { crate })) as {
    projects: { id: string; crates: string[] }[];
  };
  expect(inCrate.projects.map((each) => each.id)).toEqual([project]);
  expect(inCrate.projects[0]?.crates).toEqual([crate]);

  expect(((await ask(w, "crate-remove", {}, { crate, project })) as Crates).crates[0]?.count).toBe(
    0,
  );
  expect(((await ask(w, "library", { crate })) as { projects: unknown[] }).projects).toHaveLength(
    0,
  );
  expect(((await ask(w, "crate-delete", {}, { crate })) as Crates).crates).toEqual([]);
  expect(await w.fake.api.state?.get("crates")).toEqual([]);
});

test("crate mistakes answer a sentence", async () => {
  const w = dj();
  await expect(ask(w, "crate-create", {}, { name: "   " })).rejects.toThrow("needs a name");
  await expect(ask(w, "crate-create", {}, { name: "x".repeat(61) })).rejects.toThrow("at most 60");
  const { id } = (await ask(w, "crate-create", {}, { name: "Warm" })) as Crates;
  await expect(ask(w, "crate-create", {}, { name: "warm" })).rejects.toThrow("already");
  const other = (await ask(w, "crate-create", {}, { name: "Peak" })) as Crates;
  await expect(ask(w, "crate-rename", {}, { crate: other.id, name: "WARM" })).rejects.toThrow(
    "already",
  );
  await expect(ask(w, "crate-add", {}, { crate: id, project: "nonsense" })).rejects.toThrow(
    "No such project",
  );
  await expect(ask(w, "crate-add", {}, { crate: "zzzzzzzz", project: "abcdef01" })).rejects.toThrow(
    "No such crate",
  );
  await expect(ask(w, "crate-delete", {}, { crate: "zzzzzzzz" })).rejects.toThrow("No such crate");
  await expect(ask(w, "library", { crate: "zzzzzzzz" })).rejects.toThrow("No such crate");
});

test("the library shows BPM, key and LUFS of prepared tracks and finds them by key and tempo", async () => {
  const w = dj();
  const first = await audioProject(w);
  const second = await audioProject(w);
  const prep = (bpm: number, tonic: number): Prep => ({
    source: { kind: "sketch", id: "a", label: "Sketch A", file: "sketches/a.mp3" },
    analysis: {
      bpm,
      strength: 9,
      key: { tonic, mode: "minor", correlation: 0.9 },
      energy: 6,
      lufs: -9.5,
      truePeak: -1,
      durationSec: 12,
      analysedAt: "",
    },
    grid: { bpm, firstBeatSec: 0.3 },
    manualBpm: false,
    cues: [],
    loop: null,
  });
  await writePrep(first.dir, prep(122, 9));
  await writePrep(second.dir, prep(140, 4));
  type Row = { id: string; prep: { bpm: number; camelot: string; lufs: number } | null };
  const rows = async (q: string) =>
    ((await ask(w, "library", { q })) as { projects: Row[] }).projects;
  expect((await rows("")).find((each) => each.id === first.id)?.prep).toMatchObject({
    bpm: 122,
    camelot: "8A",
    lufs: -9.5,
  });
  expect((await rows("key 8A")).map((each) => each.id)).toEqual([first.id]);
  expect((await rows("key 9A")).map((each) => each.id)).toEqual([second.id]);
  expect((await rows("bpm 120-128")).map((each) => each.id)).toEqual([first.id]);
  expect((await rows("bpm 130-150 key 9A")).map((each) => each.id)).toEqual([second.id]);
  expect(await rows("key 3B")).toEqual([]);
});
