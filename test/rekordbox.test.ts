import { expect, test } from "bun:test";
import { sanitiseFileName, stemFileNames } from "../export/names";
import { fileUrl, type RekordboxTrack, rekordboxXml, xmlEscape } from "../export/rekordbox";

const track = (over: Partial<RekordboxTrack> = {}): RekordboxTrack => ({
  id: 1,
  name: "Minor Lift",
  file: "/home/jimmy/Music/prifly-music-studio/minor-lift-1a2b3c4d/master/master-1.wav",
  ext: "wav",
  size: 31_800_000,
  totalSec: 180.4,
  grid: { bpm: 122, firstBeatSec: 0.25 },
  tonality: "Am",
  cues: [
    { slot: "A", sec: 0.25, name: "Intro" },
    { slot: "C", sec: 31.25, name: "Chorus" },
  ],
  loop: { startSec: 31.25, bars: 4 },
  ...over,
});

test("the XML has the fields rekordbox reads, exactly", () => {
  const xml = rekordboxXml([track()], [{ name: "Friday", trackIds: [1] }]);
  expect(xml).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="Music Studio" Version="0.1.0" Company="prifly"/>
  <COLLECTION Entries="1">
    <TRACK TrackID="1" Name="Minor Lift" Kind="WAV File" Size="31800000" TotalTime="180" AverageBpm="122.00" Location="file://localhost/home/jimmy/Music/prifly-music-studio/minor-lift-1a2b3c4d/master/master-1.wav" Tonality="Am">
      <TEMPO Inizio="0.250" Bpm="122.00" Metro="4/4" Battito="1"/>
      <POSITION_MARK Name="Intro" Type="0" Start="0.250" Num="0"/>
      <POSITION_MARK Name="Chorus" Type="0" Start="31.250" Num="2"/>
      <POSITION_MARK Name="Loop 4 bars" Type="4" Start="31.250" End="39.119" Num="-1"/>
    </TRACK>
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="ROOT" Count="1">
      <NODE Name="Friday" Type="1" KeyType="0" Entries="1">
        <TRACK Key="1"/>
      </NODE>
    </NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>
`);
});

test("one playlist per crate, each listing its tracks by id", () => {
  const xml = rekordboxXml(
    [track({ id: 1 }), track({ id: 2, name: "B" })],
    [
      { name: "Warm up", trackIds: [1, 2] },
      { name: "Peak", trackIds: [2] },
    ],
  );
  expect(xml).toContain('<COLLECTION Entries="2">');
  expect(xml).toContain('<NODE Type="0" Name="ROOT" Count="2">');
  expect(xml).toContain('<NODE Name="Warm up" Type="1" KeyType="0" Entries="2">');
  expect(xml).toContain('<NODE Name="Peak" Type="1" KeyType="0" Entries="1">');
  expect(xml.match(/<TRACK Key=/g)).toHaveLength(3);
});

test("names and cue labels are escaped for XML, and invalid control characters dropped", () => {
  expect(xmlEscape(`Tom & "Jerry" <live> it's\u0001`)).toBe(
    "Tom &amp; &quot;Jerry&quot; &lt;live&gt; it&apos;s",
  );
  const xml = rekordboxXml(
    [track({ name: 'A & B <"x">', cues: [{ slot: "A", sec: 1, name: "Drop <1>" }], loop: null })],
    [{ name: "R&B", trackIds: [1] }],
  );
  expect(xml).toContain('Name="A &amp; B &lt;&quot;x&quot;&gt;"');
  expect(xml).toContain('Name="Drop &lt;1&gt;"');
  expect(xml).toContain('<NODE Name="R&amp;B"');
  expect(xml).not.toContain('Type="4"');
});

test("the file URL percent-encodes spaces and non-ASCII as UTF-8", () => {
  expect(fileUrl("/home/jimmy/Music/My Songs/Bjørk – Jóga #1.wav")).toBe(
    "file://localhost/home/jimmy/Music/My%20Songs/Bj%C3%B8rk%20%E2%80%93%20J%C3%B3ga%20%231.wav",
  );
  expect(fileUrl("C:\\Users\\Jimmy Å\\Music\\a b.wav")).toBe(
    "file://localhost/C:/Users/Jimmy%20%C3%85/Music/a%20b.wav",
  );
});

test("cue and loop positions are in seconds with three decimals; hot cue numbers follow A to H", () => {
  const xml = rekordboxXml(
    [
      track({
        cues: [
          { slot: "A", sec: 12.3456, name: "" },
          { slot: "H", sec: 99, name: "" },
        ],
        loop: { startSec: 10, bars: 1 },
        grid: { bpm: 128, firstBeatSec: 0.1 },
      }),
    ],
    [],
  );
  expect(xml).toContain('Type="0" Start="12.346" Num="0"');
  expect(xml).toContain('Type="0" Start="99.000" Num="7"');
  expect(xml).toContain('Type="4" Start="10.000" End="11.875" Num="-1"');
  expect(xml).toContain('<TEMPO Inizio="0.100" Bpm="128.00"');
});

test("Tonality is written when the key is known and left out when it is not", () => {
  expect(rekordboxXml([track({ tonality: "Ebm" })], [])).toContain('Tonality="Ebm"');
  expect(rekordboxXml([track({ tonality: null })], [])).not.toContain("Tonality");
});

test("DAW stems are named tempo, key, stem", () => {
  expect(stemFileNames(["vocals", "drums", "bass", "other"], 122, "8A")).toEqual([
    "122bpm 8A Vocals.wav",
    "122bpm 8A Drums.wav",
    "122bpm 8A Bass.wav",
    "122bpm 8A Other.wav",
  ]);
  expect(stemFileNames(["vocals"], 122.46, "5B")).toEqual(["122.5bpm 5B Vocals.wav"]);
  expect(stemFileNames(["vocals"], null, null)).toEqual(["Vocals.wav"]);
  expect(stemFileNames(["backing-vocals"], 90, null)).toEqual(["90bpm Backing Vocals.wav"]);
});

test("stem names that come out the same are numbered, and unsafe characters go", () => {
  expect(stemFileNames(["vocals", "vocals"], 120, "1A")).toEqual([
    "120bpm 1A Vocals.wav",
    "120bpm 1A Vocals 2.wav",
  ]);
  expect(sanitiseFileName('a<b>c:d"e/f\\g|h?i*j')).toBe("a b c d e f g h i j");
  expect(sanitiseFileName("  ..Song.. ")).toBe("..Song");
  expect(sanitiseFileName("CON")).toBe("CON_");
  expect(sanitiseFileName("///")).toBe("untitled");
  expect(sanitiseFileName("x".repeat(300))).toHaveLength(100);
});
