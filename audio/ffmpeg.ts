/** Running ffmpeg: awaited, window hidden on Windows, its stderr kept as the error text. */

/** `output` is stdout as text, `log` is stderr (where ffmpeg prints its filter results). */
export type Ran = { ok: true; output: string; log: string } | { ok: false; message: string };
export type RanBytes = { ok: true; bytes: Uint8Array } | { ok: false; message: string };

/** The program to start: the `ffmpegPath` setting, or `ffmpeg` from the PATH when it is empty. */
export function ffmpegBinary(setting: unknown): string {
  return typeof setting === "string" && setting.trim() !== "" ? setting.trim() : "ffmpeg";
}

const missing = (binary: string): string =>
  binary === "ffmpeg"
    ? "ffmpeg is not installed, or not on the PATH. Install it, or set its path in Settings → Extensions → Music Studio."
    : `ffmpeg was not found at ${binary}. Check the path in Settings → Extensions → Music Studio.`;

type Finished = { out: Uint8Array; errors: string; code: number };

async function spawnAll(
  binary: string,
  args: string[],
  signal?: AbortSignal,
): Promise<Finished | null> {
  try {
    const child = Bun.spawn([binary, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      ...(signal === undefined ? {} : { signal }),
    });
    const [out, errors, code] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { out: new Uint8Array(out), errors, code };
  } catch {
    return null;
  }
}

function stopped(done: Finished): string {
  const last = done.errors.trim().split("\n").slice(-3).join(" ").trim();
  return `ffmpeg stopped with code ${done.code}${last === "" ? "." : `: ${last}`}`;
}

/** Runs `binary args`; the result says why it failed in words. */
export async function runFfmpeg(
  binary: string,
  args: string[],
  signal?: AbortSignal,
): Promise<Ran> {
  const done = await spawnAll(binary, args, signal);
  if (done === null) return { ok: false, message: missing(binary) };
  if (done.code !== 0) return { ok: false, message: stopped(done) };
  return { ok: true, output: new TextDecoder().decode(done.out), log: done.errors };
}

/** Like `runFfmpeg`, for a command whose stdout is binary (raw PCM). */
export async function runFfmpegBytes(
  binary: string,
  args: string[],
  signal?: AbortSignal,
): Promise<RanBytes> {
  const done = await spawnAll(binary, args, signal);
  if (done === null) return { ok: false, message: missing(binary) };
  return done.code === 0 ? { ok: true, bytes: done.out } : { ok: false, message: stopped(done) };
}

/** Whether ffmpeg starts, and the first line of its version. */
export async function probeFfmpeg(binary: string): Promise<Ran> {
  const ran = await runFfmpeg(binary, ["-version"]);
  return ran.ok ? { ok: true, output: ran.output.split("\n")[0] ?? "", log: "" } : ran;
}
