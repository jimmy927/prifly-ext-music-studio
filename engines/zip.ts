/** A reader for the ZIP archive the stem separation answers with: stored or deflated entries, no encryption, no ZIP64. */

import { inflateRawSync } from "node:zlib";

export type ZipEntry = { name: string; bytes: Uint8Array };

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_ENTRY = 0x04034b50;

/** The directory entry at `at`: where the next one starts, and the file when it is one. */
function entryAt(data: Buffer, at: number): { next: number; file: ZipEntry | null } {
  if (data.readUInt32LE(at) !== DIRECTORY_ENTRY) throw new Error("The ZIP directory is damaged.");
  const method = data.readUInt16LE(at + 10);
  const size = data.readUInt32LE(at + 20);
  const nameLength = data.readUInt16LE(at + 28);
  const next = at + 46 + nameLength + data.readUInt16LE(at + 30) + data.readUInt16LE(at + 32);
  const local = data.readUInt32LE(at + 42);
  const name = data.subarray(at + 46, at + 46 + nameLength).toString("utf8");
  if (name.endsWith("/")) return { next, file: null };
  if (data.readUInt32LE(local) !== LOCAL_ENTRY) throw new Error("The ZIP is damaged.");
  if (method !== 0 && method !== 8) throw new Error(`The ZIP uses compression ${method}.`);
  const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
  const packed = data.subarray(start, start + size);
  const bytes = new Uint8Array(method === 0 ? packed : inflateRawSync(packed));
  return { next, file: { name, bytes } };
}

/** Where the end-of-directory record starts, or -1. */
function endOf(data: Buffer): number {
  for (let at = data.length - 22; at >= Math.max(0, data.length - 22 - 65535); at -= 1) {
    if (data.readUInt32LE(at) === END_OF_DIRECTORY) return at;
  }
  return -1;
}

/** The files in a ZIP archive, in directory order. Throws a plain message when the bytes are no ZIP. */
export function readZip(bytes: Uint8Array): ZipEntry[] {
  const data = Buffer.from(bytes);
  const end = endOf(data);
  if (end < 0) throw new Error("The answer is not a ZIP archive.");
  const count = data.readUInt16LE(end + 10);
  let at = data.readUInt32LE(end + 16);
  const out: ZipEntry[] = [];
  for (let each = 0; each < count; each += 1) {
    const found = entryAt(data, at);
    at = found.next;
    if (found.file !== null) out.push(found.file);
  }
  return out;
}
