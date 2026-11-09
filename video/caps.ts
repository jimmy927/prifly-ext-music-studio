/**
 * What the installed ffmpeg can do. `xfade` came with ffmpeg 4.3, so it is
 * asked for by name instead of guessed from a version number (a distribution
 * may carry it back, a snapshot build may lack it); the edit falls back to
 * overlaying faded clips when it is absent. Captions need the `ass` filter
 * (libass) and the video needs `libx264`.
 */

import { probeFfmpeg, runFfmpeg } from "../audio/ffmpeg";

export type Caps =
  | { ok: true; version: string; xfade: boolean; ass: boolean; x264: boolean }
  | { ok: false; message: string };

/** The filter names in the output of `ffmpeg -filters`. */
export function filterNames(listing: string): Set<string> {
  const names = new Set<string>();
  for (const line of listing.split("\n")) {
    const match = /^\s[A-Z.]{3}\s+(\S+)\s/.exec(line);
    if (match?.[1] !== undefined) names.add(match[1]);
  }
  return names;
}

const cache = new Map<string, Caps>();

/** Asks ffmpeg once per program, and remembers the answer. */
export async function probeCaps(binary: string): Promise<Caps> {
  const known = cache.get(binary);
  if (known !== undefined) return known;
  const version = await probeFfmpeg(binary);
  if (!version.ok) return { ok: false, message: version.message };
  const filters = await runFfmpeg(binary, ["-hide_banner", "-filters"]);
  const encoders = await runFfmpeg(binary, ["-hide_banner", "-encoders"]);
  const names = filters.ok ? filterNames(filters.output) : new Set<string>();
  const caps: Caps = {
    ok: true,
    version: version.output,
    xfade: names.has("xfade"),
    ass: names.has("ass"),
    x264: encoders.ok && /\blibx264\b/.test(encoders.output),
  };
  cache.set(binary, caps);
  return caps;
}

/** Forgets what was learnt (a test that points at another ffmpeg). */
export const forgetCaps = (): void => cache.clear();
