/** Adding a picture to the cast from a file (dropped on the page, or picked by path): free, checked by its bytes. */

import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  type CastMember,
  readTreatment,
  savePicture,
  type Treatment,
  writeTreatment,
} from "../project/video";
import { MAX_CAST } from "./constants";

export const MAX_PICTURE_BYTES = 8 * 1024 * 1024;

/** The image type the first bytes say it is (PNG, JPEG or WebP), or null; the file's name and the browser's word are not trusted. */
export function sniffImage(bytes: Uint8Array): string | null {
  const at = (start: number, text: string): boolean =>
    [...text].every((char, i) => bytes[start + i] === char.charCodeAt(0));
  if (bytes[0] === 0x89 && at(1, "PNG")) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (at(0, "RIFF") && at(8, "WEBP")) return "image/webp";
  return null;
}

export type CastAdded =
  | { ok: true; treatment: Treatment; member: CastMember }
  | { ok: false; message: string };

/** Adds a picture (its bytes) to the cast. */
export async function addCastFile(
  dir: string,
  name: string,
  bytes: Uint8Array,
): Promise<CastAdded> {
  const treatment = await readTreatment(dir);
  if (treatment.cast.length >= MAX_CAST)
    return { ok: false, message: `The cast holds at most ${MAX_CAST} pictures. Remove one first.` };
  if (bytes.length === 0) return { ok: false, message: "That file is empty." };
  if (bytes.length > MAX_PICTURE_BYTES)
    return { ok: false, message: "That picture is over 8 MB. Use a smaller one." };
  const mime = sniffImage(bytes);
  if (mime === null) return { ok: false, message: "Use a PNG, JPEG or WebP picture." };
  const id = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  const file = await savePicture(dir, "cast", id, { bytes, mime });
  const member: CastMember = {
    id,
    name: name.trim().slice(0, 60),
    prompt: "",
    file,
    source: "file",
  };
  const next = { ...treatment, cast: [...treatment.cast, member] };
  await writeTreatment(dir, next);
  return { ok: true, treatment: next, member };
}

/** The bytes of a picture file at an absolute path. */
export async function readPictureFile(path: string): Promise<Uint8Array | string> {
  if (!isAbsolute(path)) return "Give the picture's full path.";
  try {
    if ((await stat(path)).size > MAX_PICTURE_BYTES)
      return "That picture is over 8 MB. Use a smaller one.";
    return new Uint8Array(await readFile(path));
  } catch {
    return `There is no file at ${path}.`;
  }
}
