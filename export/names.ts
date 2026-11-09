/** File names for what Deliver writes: DAW stems ("122bpm 8A Vocals.wav") and the other files. */

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** A name that is safe on Windows, macOS and Linux: no path or reserved characters, no trailing dot or space. */
export function sanitiseFileName(text: string, fallback = "untitled"): string {
  const cleaned = text
    .normalize("NFC")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 100)
    .trim();
  if (cleaned === "") return fallback;
  return RESERVED.test(cleaned) ? `${cleaned}_` : cleaned;
}

/** "122" for a whole tempo, "122.5" otherwise. */
export const bpmText = (bpm: number): string => {
  const rounded = Math.round(bpm * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
};

const titled = (stem: string): string =>
  stem
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(
      /(^|\s)(\p{L})/gu,
      (_all, space: string, letter: string) => space + letter.toUpperCase(),
    );

/**
 * `122bpm 8A Vocals.wav`: tempo, Camelot key (each left out when unknown), and
 * the stem's name. Names that come out the same get " 2", " 3" …
 */
export function stemFileNames(
  stems: string[],
  bpm: number | null,
  camelotCode: string | null,
): string[] {
  const seen = new Map<string, number>();
  return stems.map((stem) => {
    const base = sanitiseFileName(
      [bpm === null ? null : `${bpmText(bpm)}bpm`, camelotCode, titled(stem)]
        .filter((part) => part !== null && part !== "")
        .join(" "),
      "Stem",
    );
    const count = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), count);
    return `${count === 1 ? base : `${base} ${count}`}.wav`;
  });
}
