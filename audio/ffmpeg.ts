/** Running ffmpeg: awaited, window hidden on Windows, its stderr kept as the error text. */

export type Ran = { ok: true; output: string } | { ok: false; message: string };

/** The program to start: the `ffmpegPath` setting, or `ffmpeg` from the PATH when it is empty. */
export function ffmpegBinary(setting: unknown): string {
  return typeof setting === "string" && setting.trim() !== "" ? setting.trim() : "ffmpeg";
}

const missing = (binary: string): string =>
  binary === "ffmpeg"
    ? "ffmpeg is not installed, or not on the PATH. Install it, or set its path in Settings → Extensions → Music Studio."
    : `ffmpeg was not found at ${binary}. Check the path in Settings → Extensions → Music Studio.`;

/** Runs `binary args`; the result says why it failed in words. */
export async function runFfmpeg(
  binary: string,
  args: string[],
  signal?: AbortSignal,
): Promise<Ran> {
  try {
    const child = Bun.spawn([binary, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      ...(signal === undefined ? {} : { signal }),
    });
    const [output, errors, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code === 0) return { ok: true, output };
    const last = errors.trim().split("\n").slice(-3).join(" ").trim();
    return {
      ok: false,
      message: `ffmpeg stopped with code ${code}${last === "" ? "." : `: ${last}`}`,
    };
  } catch {
    return { ok: false, message: missing(binary) };
  }
}

/** Whether ffmpeg starts, and the first line of its version. */
export async function probeFfmpeg(binary: string): Promise<Ran> {
  const ran = await runFfmpeg(binary, ["-version"]);
  return ran.ok ? { ok: true, output: ran.output.split("\n")[0] ?? "" } : ran;
}
