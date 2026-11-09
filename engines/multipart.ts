/**
 * A `multipart/mixed` body — what ElevenLabs' `/v1/music/detailed` answers
 * with: a JSON part and a binary audio part. Works on bytes, since the audio
 * is not text and must reach the file untouched.
 */

export type Part = { headers: Record<string, string>; body: Uint8Array };

const CRLF = Buffer.from("\r\n");
const HEADER_END = Buffer.from("\r\n\r\n");

/** The `boundary` of a `Content-Type` value, or null when it names none. */
export function boundaryOf(contentType: string | null): string | null {
  if (contentType === null) return null;
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return match?.[1] ?? match?.[2] ?? null;
}

function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return headers;
}

/** The parts of `body` between `--boundary` lines, in order. Throws when the body holds none. */
export function parseMultipart(body: Uint8Array, boundary: string): Part[] {
  const bytes = Buffer.from(body);
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: Part[] = [];
  let at = bytes.indexOf(delimiter);
  while (at >= 0) {
    const after = at + delimiter.length;
    // `--` after a delimiter closes the body.
    if (bytes.subarray(after, after + 2).toString() === "--") break;
    const start = bytes.subarray(after, after + 2).equals(CRLF) ? after + 2 : after;
    const next = bytes.indexOf(delimiter, start);
    if (next < 0) break;
    // The CRLF before a delimiter belongs to the delimiter, not to the part.
    const end = next >= 2 && bytes.subarray(next - 2, next).equals(CRLF) ? next - 2 : next;
    const content = bytes.subarray(start, end);
    const split = content.indexOf(HEADER_END);
    if (split >= 0) {
      parts.push({
        headers: parseHeaders(content.subarray(0, split).toString("utf8")),
        body: new Uint8Array(content.subarray(split + HEADER_END.length)),
      });
    } else if (content.subarray(0, 2).equals(CRLF)) {
      // A part with no headers: the blank line comes first.
      parts.push({ headers: {}, body: new Uint8Array(content.subarray(2)) });
    }
    at = next;
  }
  if (parts.length === 0) throw new Error("The multipart body holds no parts.");
  return parts;
}
