/**
 * BPM and key tags on a master, where the format keeps them: MP3 gets ID3v2.3
 * `TBPM` and `TKEY`, OGG gets the Vorbis comments `BPM` and `INITIALKEY`. A WAV
 * made by ffmpeg 4.2 has no place for either, so it is copied untouched.
 */

export type Tagging = { argv: string[]; tags: string } | null;

/** The arguments that copy `file` to `out` with the tags, or null when the format keeps none. */
export function tagArgv(
  file: string,
  out: string,
  ext: string,
  bpm: number,
  tonality: string | null,
): Tagging {
  const whole = String(Math.round(bpm));
  const base = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    file,
    "-map_metadata",
    "0",
    "-c",
    "copy",
  ];
  if (ext === "mp3") {
    return {
      argv: [
        ...base,
        "-id3v2_version",
        "3",
        "-metadata",
        `TBPM=${whole}`,
        ...(tonality === null ? [] : ["-metadata", `TKEY=${tonality}`]),
        out,
      ],
      tags: `ID3 TBPM ${whole}${tonality === null ? "" : `, TKEY ${tonality}`}`,
    };
  }
  if (ext === "ogg") {
    return {
      argv: [
        ...base,
        "-metadata",
        `BPM=${whole}`,
        ...(tonality === null ? [] : ["-metadata", `INITIALKEY=${tonality}`]),
        out,
      ],
      tags: `Vorbis BPM ${whole}${tonality === null ? "" : `, INITIALKEY ${tonality}`}`,
    };
  }
  return null;
}
