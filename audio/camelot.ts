/** Musical keys: names, the Camelot wheel code, rekordbox's Tonality, and which keys mix with which. */

export type Mode = "major" | "minor";
export type MusicalKey = { tonic: number; mode: Mode };

const SHOWN = ["C", "D♭", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
const MINOR_SHOWN = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "G♯", "A", "B♭", "B"];
const ASCII_MAJOR = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const ASCII_MINOR = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"];

/** "A minor", "E♭ major". `tonic` is a pitch class, 0 = C. */
export const keyName = (key: MusicalKey): string =>
  `${(key.mode === "major" ? SHOWN : MINOR_SHOWN)[key.tonic] ?? "?"} ${key.mode}`;

/** rekordbox's and ID3's spelling: "Am", "Ebm", "F#m", "Eb". */
export const tonality = (key: MusicalKey): string =>
  key.mode === "major" ? (ASCII_MAJOR[key.tonic] ?? "") : `${ASCII_MINOR[key.tonic] ?? ""}m`;

/** The Camelot wheel code: 8A is A minor, 8B is C major, 5B is E♭ major. */
export function camelot(key: MusicalKey): string {
  const major = key.mode === "major" ? key.tonic : (key.tonic + 3) % 12;
  const number = ((major * 7 + 7) % 12) + 1;
  return `${number}${key.mode === "major" ? "B" : "A"}`;
}

/** The code of text such as "8a" or "12B"; null when it is none. */
export function parseCamelot(text: string): string | null {
  const match = /^\s*(1[0-2]|[1-9])\s*([ab])\s*$/i.exec(text);
  return match === null ? null : `${match[1]}${(match[2] ?? "").toUpperCase()}`;
}

/** Every key's code, to look one up by its Tonality text ("am", "f#m", "eb"). */
export function keyFromTonality(text: string): MusicalKey | null {
  const wanted = text.trim().toLowerCase();
  for (const mode of ["major", "minor"] as const) {
    for (let tonic = 0; tonic < 12; tonic += 1) {
      const key = { tonic, mode };
      if (tonality(key).toLowerCase() === wanted) return key;
    }
  }
  return null;
}

/** The key a Camelot code stands for; null when it is none. */
export function keyOfCode(code: string): MusicalKey | null {
  for (const mode of ["major", "minor"] as const) {
    for (let tonic = 0; tonic < 12; tonic += 1) {
      if (camelot({ tonic, mode }) === code) return { tonic, mode };
    }
  }
  return null;
}

export type Compatible = { code: string; relation: "same" | "up one" | "down one" | "relative" };

/** The codes that mix cleanly with `code`: itself, one step either way round the wheel, and its relative. */
export function compatibleKeys(code: string): Compatible[] {
  const parsed = parseCamelot(code);
  if (parsed === null) return [];
  const number = Number(parsed.slice(0, -1));
  const letter = parsed.slice(-1);
  const wrap = (value: number): number => ((value - 1 + 12) % 12) + 1;
  return [
    { code: parsed, relation: "same" },
    { code: `${wrap(number + 1)}${letter}`, relation: "up one" },
    { code: `${wrap(number - 1)}${letter}`, relation: "down one" },
    { code: `${number}${letter === "A" ? "B" : "A"}`, relation: "relative" },
  ];
}
