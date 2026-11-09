/**
 * rekordbox XML (`DJ_PLAYLISTS`), written to the format Pioneer DJ publishes
 * ("XML file format for playlists sharing": cdn.rekordbox.com/files/20200410160904/xml_format_list.pdf).
 * A COLLECTION of TRACKs, each with a TEMPO (the beatgrid), POSITION_MARKs
 * (Type 0 is a cue, Type 4 a loop; Num 0 to 7 is the hot cue A to H, -1 a
 * memory loop) and a PLAYLISTS tree with one playlist per crate. Times are in
 * seconds, `Location` is a file URL, strings are UTF-8 with XML entities.
 */

import { type Cue, type Grid, type Loop, loopEnd, SLOTS } from "../prep/grid";

export type RekordboxTrack = {
  id: number;
  name: string;
  /** The absolute path of the audio file. */
  file: string;
  /** The file extension without the dot, for `Kind`. */
  ext: string;
  size: number;
  totalSec: number;
  grid: Grid;
  /** rekordbox's spelling: "Am", "Ebm"; null when the key is not known. */
  tonality: string | null;
  cues: Cue[];
  loop: Loop | null;
};

export type RekordboxPlaylist = { name: string; trackIds: number[] };

/** XML 1.0 has no place for control characters other than tab, newline and carriage return. */
function withoutControls(text: string): string {
  return Array.from(text)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 32 || code === 9 || code === 10 || code === 13;
    })
    .join("");
}

/** Text safe inside an XML attribute. */
export function xmlEscape(text: string): string {
  return withoutControls(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** `file://localhost/` and the path, each part percent-encoded as UTF-8 (a drive letter stays as it is). */
export function fileUrl(path: string): string {
  const parts = path.replaceAll("\\", "/").split("/");
  const encoded = parts.map((part, at) =>
    at === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part),
  );
  const joined = encoded.join("/");
  return `file://localhost/${joined.startsWith("/") ? joined.slice(1) : joined}`;
}

const KINDS: Record<string, string> = {
  wav: "WAV File",
  mp3: "MP3 File",
  ogg: "OGG File",
  flac: "FLAC File",
  m4a: "M4A File",
};

const fixed = (value: number, places: number): string => value.toFixed(places);

function cueMarks(track: RekordboxTrack): string[] {
  const lines = track.cues.map((cue) => {
    const num = SLOTS.indexOf(cue.slot);
    return `      <POSITION_MARK Name="${xmlEscape(cue.name)}" Type="0" Start="${fixed(cue.sec, 3)}" Num="${num}"/>`;
  });
  if (track.loop !== null)
    lines.push(
      `      <POSITION_MARK Name="Loop ${track.loop.bars} bars" Type="4" Start="${fixed(track.loop.startSec, 3)}" End="${fixed(loopEnd(track.grid, track.loop), 3)}" Num="-1"/>`,
    );
  return lines;
}

function trackXml(track: RekordboxTrack): string {
  const attrs = [
    `TrackID="${track.id}"`,
    `Name="${xmlEscape(track.name)}"`,
    `Kind="${xmlEscape(KINDS[track.ext.toLowerCase()] ?? `${track.ext.toUpperCase()} File`)}"`,
    `Size="${Math.round(track.size)}"`,
    `TotalTime="${Math.round(track.totalSec)}"`,
    `AverageBpm="${fixed(track.grid.bpm, 2)}"`,
    `Location="${xmlEscape(fileUrl(track.file))}"`,
    ...(track.tonality === null ? [] : [`Tonality="${xmlEscape(track.tonality)}"`]),
  ];
  return [
    `    <TRACK ${attrs.join(" ")}>`,
    `      <TEMPO Inizio="${fixed(track.grid.firstBeatSec, 3)}" Bpm="${fixed(track.grid.bpm, 2)}" Metro="4/4" Battito="1"/>`,
    ...cueMarks(track),
    "    </TRACK>",
  ].join("\n");
}

function playlistXml(list: RekordboxPlaylist): string {
  return [
    `      <NODE Name="${xmlEscape(list.name)}" Type="1" KeyType="0" Entries="${list.trackIds.length}">`,
    ...list.trackIds.map((id) => `        <TRACK Key="${id}"/>`),
    "      </NODE>",
  ].join("\n");
}

/** The whole document. */
export function rekordboxXml(tracks: RekordboxTrack[], playlists: RekordboxPlaylist[]): string {
  return `${[
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<DJ_PLAYLISTS Version="1.0.0">',
    '  <PRODUCT Name="Music Studio" Version="0.1.0" Company="prifly"/>',
    `  <COLLECTION Entries="${tracks.length}">`,
    ...tracks.map(trackXml),
    "  </COLLECTION>",
    "  <PLAYLISTS>",
    `    <NODE Type="0" Name="ROOT" Count="${playlists.length}">`,
    ...playlists.map(playlistXml),
    "    </NODE>",
    "  </PLAYLISTS>",
    "</DJ_PLAYLISTS>",
  ].join("\n")}\n`;
}
