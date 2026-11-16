/** Which files a `sources` argument names: files, or folders that expand to the pictures and videos in them. */

import { readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { kindOf, MAX_PICTURE_FILE_BYTES, MAX_SOURCES, type SourceKind } from "./constants";

export type SourceFile = {
  path: string;
  name: string;
  kind: SourceKind;
  size: number;
  mtimeMs: number;
};

export type Skipped = { path: string; reason: string };

export type Expanded = { files: SourceFile[]; skipped: Skipped[] };

/** The paths a call gave: a string, or a list of strings; anything else is none. */
export function pathsOf(input: unknown): string[] {
  const list = Array.isArray(input) ? input : typeof input === "string" ? [input] : [];
  return list.filter((each): each is string => typeof each === "string" && each.trim() !== "");
}

async function fileOf(path: string, skipped: Skipped[]): Promise<SourceFile | null> {
  const name = basename(path);
  const kind = kindOf(name);
  if (kind === null) {
    skipped.push({
      path,
      reason: "not a picture (PNG, JPEG, WebP) or video (MP4, MOV, M4V, WebM, MKV, AVI)",
    });
    return null;
  }
  try {
    const found = await stat(path);
    if (!found.isFile()) {
      skipped.push({ path, reason: "not a file" });
      return null;
    }
    if (found.size === 0) {
      skipped.push({ path, reason: "empty" });
      return null;
    }
    if (kind === "image" && found.size > MAX_PICTURE_FILE_BYTES) {
      skipped.push({ path, reason: "a picture over 40 MB" });
      return null;
    }
    return { path, name, kind, size: found.size, mtimeMs: Math.round(found.mtimeMs) };
  } catch {
    skipped.push({ path, reason: "there is no such file" });
    return null;
  }
}

/**
 * The files `input` names, in order: a file as it is, a folder as the
 * pictures and videos directly in it (by name, no hidden files, no subfolders).
 * Everything left out is in `skipped` with the reason; more than
 * `MAX_SOURCES` files are cut there.
 */
export async function expandSources(input: unknown): Promise<Expanded> {
  const skipped: Skipped[] = [];
  const files: SourceFile[] = [];
  const seen = new Set<string>();
  const add = async (path: string): Promise<void> => {
    if (seen.has(path)) return;
    seen.add(path);
    const found = await fileOf(path, skipped);
    if (found === null) return;
    if (files.length >= MAX_SOURCES)
      skipped.push({ path, reason: `more than ${MAX_SOURCES} files` });
    else files.push(found);
  };
  for (const path of pathsOf(input)) {
    if (!isAbsolute(path)) {
      skipped.push({ path, reason: "not a full path" });
      continue;
    }
    let folder = false;
    try {
      folder = (await stat(path)).isDirectory();
    } catch {
      // A file that is not there is said by fileOf.
    }
    if (!folder) {
      await add(path);
      continue;
    }
    const names = (await readdir(path)).filter((name) => !name.startsWith(".")).sort();
    for (const name of names) {
      // A folder's other files are not named by the reader: only pictures and videos count.
      if (kindOf(name) !== null) await add(join(path, name));
    }
  }
  return { files, skipped };
}
