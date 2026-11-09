import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpeg } from "../audio/ffmpeg";
import { isInside } from "../export/run";
import { audioProject, dj, localJob, song } from "./dj-world";
import { ask, runJob } from "./stage-world";
import type { World } from "./world";

type DeliverView = {
  folder: string;
  stems: number;
  master: { n: number; format: string } | null;
  prepared: boolean;
  cues: number;
  loop: boolean;
};

async function ready(w: World, mp3 = false) {
  const project = await audioProject(w, song(120, 30));
  await runJob(w, "stems-split", { project: project.id });
  await localJob(w, "prepare-analyse", { project: project.id });
  await ask(w, "prep-loop", {}, { project: project.id, startSec: 0.3, bars: 1 });
  if (mp3)
    await localJob(w, "master-render", { project: project.id, target: "streaming", format: "mp3" });
  return project;
}

const outcome = (result: string | null) =>
  JSON.parse(result ?? "{}") as { dir: string; files: string[]; notes: string[] };

test("Deliver says what can be delivered now", async () => {
  const w = dj();
  const project = await audioProject(w, song(120, 30));
  const none = (await ask(w, "deliver", { project: project.id })) as DeliverView;
  expect(none).toMatchObject({ stems: 0, master: null, prepared: false, cues: 0, loop: false });
  expect(none.folder).toBe(join(project.dir, "deliver"));
  const all = await ready(w, true);
  const view = (await ask(w, "deliver", { project: all.id })) as DeliverView;
  expect(view).toMatchObject({
    stems: 4,
    master: { n: 1, format: "mp3" },
    prepared: true,
    loop: true,
  });
  expect(view.cues).toBe(4);
});

test("Deliver writes stems named tempo, key, stem, the tagged master, rekordbox XML and loops JSON into <project>/deliver", async () => {
  const w = dj();
  const { id, dir } = await ready(w, true);
  const job = await localJob(w, "deliver-run", {
    project: id,
    items: ["stems", "master", "rekordbox", "loops"],
  });
  expect(job).toMatchObject({ status: "done", work: "deliver" });
  expect(job.done).toEqual(["stems", "master", "rekordbox", "loops"]);
  const made = outcome(job.result);
  expect(made.dir).toBe(join(dir, "deliver"));

  const stems = readdirSync(join(dir, "deliver", "stems")).sort();
  expect(stems).toHaveLength(4);
  expect(
    stems.every((name) => /^1\d\dbpm \d{1,2}[AB] (Vocals|Drums|Bass|Other)\.wav$/.test(name)),
  ).toBe(true);
  const header = new DataView(
    await Bun.file(join(dir, "deliver", "stems", stems[0] ?? "")).arrayBuffer(),
  );
  expect(header.getUint16(34, true)).toBe(24);

  const master = made.files.find((file) => file.endsWith("master.mp3")) ?? "";
  const tags = await runFfmpeg("ffmpeg", ["-hide_banner", "-i", master, "-f", "ffmetadata", "-"]);
  if (!tags.ok) throw new Error(tags.message);
  expect(tags.output).toMatch(/TBPM=12\d/);
  expect(tags.output).toMatch(/TKEY=\w+/);
  expect(made.notes.join(" ")).toContain("tagged ID3 TBPM");

  const xml = await Bun.file(made.files.find((file) => file.endsWith(".xml")) ?? "").text();
  expect(xml).toContain("<DJ_PLAYLISTS");
  expect(xml).toMatch(/AverageBpm="1[12]\d\.\d\d"/);
  expect(xml).toContain('Type="0"');
  expect(xml).toContain('Type="4"');
  expect(xml).toContain("Tonality=");
  expect(xml).toContain(`Location="file://localhost${dir}/`);

  const loops = JSON.parse(
    await Bun.file(made.files.find((file) => file.endsWith(".loops.json")) ?? "").text(),
  ) as {
    file: string;
    bpm: number;
    cues: { slot: string }[];
    loop: { bars: number; endSec: number; startSec: number };
  };
  expect(loops.cues.map((each) => each.slot)).toEqual(["A", "B", "C", "D"]);
  expect(loops.loop.bars).toBe(1);
  expect(loops.loop.endSec).toBeGreaterThan(loops.loop.startSec);
  expect(existsSync(join(dir, "deliver", loops.file))).toBe(true);
});

test("a WAV master carries no BPM tag from ffmpeg 4.2 and says so", async () => {
  const w = dj();
  const { id, dir } = await ready(w);
  await localJob(w, "master-render", { project: id, target: "streaming", format: "wav" });
  const job = await localJob(w, "deliver-run", { project: id, items: ["master"] });
  const made = outcome(job.result);
  expect(made.files[0]).toEndWith("master.wav");
  expect(made.notes.join(" ")).toContain("WAV from ffmpeg 4.2 carries no BPM or key tag");
  expect(existsSync(join(dir, "deliver"))).toBe(true);
});

test("rekordbox writes one playlist per crate, with every analysed track, and says which it left out", async () => {
  const w = dj();
  const one = await ready(w);
  const two = await audioProject(w, song(128, 6));
  await localJob(w, "prepare-analyse", { project: two.id });
  const three = await audioProject(w, song(100, 6));
  const crate = ((await ask(w, "crate-create", {}, { name: "Friday" })) as { id: string }).id;
  for (const project of [one.id, two.id, three.id])
    await ask(w, "crate-add", {}, { crate, project });
  const job = await localJob(w, "deliver-run", { project: one.id, items: ["rekordbox"], crate });
  const made = outcome(job.result);
  const xml = await Bun.file(made.files[0] ?? "").text();
  expect(made.files[0]).toEndWith("rekordbox Friday.xml");
  expect(xml).toContain('<COLLECTION Entries="2">');
  expect(xml).toContain('<NODE Name="Friday" Type="1" KeyType="0" Entries="2">');
  expect(made.notes.join(" ")).toContain("is not analysed yet");
  expect(isInside(one.dir, made.dir)).toBe(true);
});

test("a chosen folder gets the files and nothing is written for items that cannot be made", async () => {
  const w = dj();
  const { id } = await audioProject(w, song(120, 30));
  const folder = mkdtempSync(join(tmpdir(), "music-studio-out-"));
  const empty = await localJob(w, "deliver-run", {
    project: id,
    items: ["stems", "rekordbox"],
    dest: folder,
  });
  expect(empty.status).toBe("failed");
  expect(empty.error).toContain("Split stems");
  await localJob(w, "prepare-analyse", { project: id });
  const done = await localJob(w, "deliver-run", { project: id, items: ["loops"], dest: folder });
  expect(outcome(done.result).dir).toBe(folder);
  expect(
    readdirSync(folder)
      .sort()
      .some((name) => name.endsWith(".loops.json")),
  ).toBe(true);
});

test("Deliver refuses a relative folder, an empty choice, and says when ffmpeg is missing", async () => {
  const w = dj();
  const { id } = await audioProject(w, song(120, 30));
  await expect(
    ask(w, "deliver-run", {}, { project: id, items: ["loops"], dest: "out" }),
  ).rejects.toThrow("full path");
  await expect(ask(w, "deliver-run", {}, { project: id, items: [] })).rejects.toThrow(
    "at least one",
  );
  const bad = dj({ ffmpegPath: "/nonexistent/ffmpeg" });
  const other = await audioProject(bad, song(120, 30));
  const job = await localJob(bad, "deliver-run", { project: other.id, items: ["loops"] });
  expect(job.status).toBe("failed");
  expect(job.error).toContain("ffmpeg was not found");
  const view = (await ask(bad, "deliver", { project: other.id })) as { ffmpeg: { ok: boolean } };
  expect(view.ffmpeg.ok).toBe(false);
});
