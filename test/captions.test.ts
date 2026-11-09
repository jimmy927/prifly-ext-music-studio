import { expect, test } from "bun:test";
import { assKaraoke, assText, assTime, lineBreaks, parseWords } from "../video/captions";

const WORDS = [
  { word: "Hello", start_ms: 1000, end_ms: 1400 },
  { word: "world", start_ms: 1500, end_ms: 2100 },
  { word: "again", start_ms: 5000, end_ms: 5500 },
];

test("word timestamps are read from ElevenLabs' shape and anything else is skipped", () => {
  const words = parseWords([
    ...WORDS,
    { word: "", start_ms: 1, end_ms: 2 },
    { word: "bad", start_ms: 5, end_ms: 1 },
    { word: 3, start_ms: 1, end_ms: 2 },
    null,
    "x",
  ]);
  expect(words.map((each) => each.word)).toEqual(["Hello", "world", "again"]);
  expect(parseWords(null)).toEqual([]);
  expect(parseWords([])).toEqual([]);
});

test("times are h:mm:ss.cc", () => {
  expect(assTime(0)).toBe("0:00:00.00");
  expect(assTime(1234)).toBe("0:00:01.23");
  expect(assTime(61_500)).toBe("0:01:01.50");
  expect(assTime(3_600_000 + 5 * 60_000)).toBe("1:05:00.00");
});

test("a pause starts a new line, and each word carries a \\k tag in centiseconds", () => {
  const words = parseWords(WORDS);
  expect(lineBreaks(words).map((line) => line.map((each) => each.word))).toEqual([
    ["Hello", "world"],
    ["again"],
  ]);
  const ass = assKaraoke(words, { width: 1920, height: 1080 });
  expect(ass).not.toBeNull();
  const dialogue = (ass ?? "").split("\n").filter((line) => line.startsWith("Dialogue:"));
  expect(dialogue).toHaveLength(2);
  // 150 ms before the first word, the fill of "Hello" runs until "world" starts (100 cs), then "world" for its 60 cs.
  expect(dialogue[0]).toBe(
    "Dialogue: 0,0:00:00.85,0:00:02.50,Default,,0,0,0,,{\\k15}{\\k50}Hello {\\k60}world",
  );
  expect(dialogue[1]).toContain("{\\k50}again");
  expect(ass).toContain("PlayResX: 1920");
  expect(ass).toContain("PlayResY: 1080");
});

test("seven words or a long line start a new line too", () => {
  const many = Array.from({ length: 9 }, (_each, at) => ({
    word: `w${at}`,
    startMs: at * 300,
    endMs: at * 300 + 250,
  }));
  expect(lineBreaks(many).map((line) => line.length)).toEqual([7, 2]);
});

test("braces, backslashes and newlines in a word cannot start an override tag", () => {
  expect(assText("{\\an8}hi")).toBe("(/an8)hi");
  expect(assText("a\nb")).toBe("a b");
  expect(assText("back\\slash")).toBe("back/slash");
  const ass =
    assKaraoke(parseWords([{ word: "{\\pos(1,1)}", start_ms: 0, end_ms: 100 }]), {
      width: 100,
      height: 100,
    }) ?? "";
  expect(ass).toContain("(/pos(1,1))");
  const text = ass.split("\n").find((line) => line.startsWith("Dialogue:")) ?? "";
  expect(text.split(",,").at(-1)).not.toContain("{\\pos");
});

test("a range keeps the words inside it and moves them to start at 0 (the vertical cut)", () => {
  const ass =
    assKaraoke(parseWords(WORDS), { width: 1080, height: 1920, fromSec: 4, toSec: 6 }) ?? "";
  const dialogue = ass.split("\n").filter((line) => line.startsWith("Dialogue:"));
  expect(dialogue).toHaveLength(1);
  expect(dialogue[0]).toContain("again");
  expect(dialogue[0]).toContain("0:00:00.85");
  expect(ass).toContain("PlayResY: 1920");
});

test("no words, no file", () => {
  expect(assKaraoke([], { width: 100, height: 100 })).toBeNull();
  expect(assKaraoke(parseWords(WORDS), { width: 100, height: 100, fromSec: 100 })).toBeNull();
});
