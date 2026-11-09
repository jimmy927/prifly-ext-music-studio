/**
 * The project store: one folder per project in the library folder,
 * `<slug>-<id>/brief.json` and `sketches/<a|b|c>.mp3` with `sketches/<x>.json`
 * beside each. The index (title, engine, length, created) lives in
 * `api.state` under `library`, so the Library lists without reading folders.
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionStateApi } from "@prifly/extension-api";
import type { Sketched } from "../engines/types";
import { isRecord } from "../engines/types";
import { type Brief, ENGINES, type EngineId, SKETCH_IDS, type SketchId } from "./brief";

export const DEFAULT_LIBRARY = "~/Music/prifly-music-studio";
const INDEX = "library";
const ID = /^[0-9a-f]{8}$/;

export type IndexEntry = {
  id: string;
  /** The project's folder name inside the library folder. */
  dir: string;
  title: string;
  engine: EngineId;
  lengthSec: number;
  created: string;
  sketches: number;
  chosen: SketchId | null;
};

/** What `brief.json` holds. */
export type ProjectRecord = {
  id: string;
  title: string;
  created: string;
  brief: Brief;
  chosen: SketchId | null;
};

/** What `sketches/<x>.json` holds. */
export type SketchRecord = {
  id: SketchId;
  engine: EngineId;
  songId: string | null;
  plan: unknown;
  timestamps: unknown;
  lyrics: string | null;
  file: string;
  created: string;
};

/** The library folder a setting names; `~` is the home folder. */
export function libraryFolder(setting: unknown): string {
  const raw =
    typeof setting === "string" && setting.trim() !== "" ? setting.trim() : DEFAULT_LIBRARY;
  if (raw === "~") return homedir();
  return raw.startsWith("~/") || raw.startsWith("~\\") ? join(homedir(), raw.slice(2)) : raw;
}

export function slugOf(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return slug === "" ? "untitled" : slug;
}

export const isProjectId = (value: unknown): value is string =>
  typeof value === "string" && ID.test(value);
export const isSketchId = (value: unknown): value is SketchId =>
  SKETCH_IDS.some((each) => each === value);

function isEntry(value: unknown): value is IndexEntry {
  return (
    isRecord(value) &&
    isProjectId(value["id"]) &&
    typeof value["dir"] === "string" &&
    typeof value["title"] === "string" &&
    ENGINES.some((each) => each === value["engine"]) &&
    typeof value["lengthSec"] === "number" &&
    typeof value["created"] === "string" &&
    typeof value["sketches"] === "number"
  );
}

export class Store {
  private readonly root: string;
  private readonly state: ExtensionStateApi;

  constructor(root: string, state: ExtensionStateApi) {
    this.root = root;
    this.state = state;
  }

  /** The folder of a project, by its index entry. */
  pathOf(entry: IndexEntry): string {
    return join(this.root, entry.dir);
  }

  async entries(): Promise<IndexEntry[]> {
    const raw = await this.state.get<unknown>(INDEX);
    return Array.isArray(raw) ? raw.filter(isEntry) : [];
  }

  async find(id: string): Promise<IndexEntry | null> {
    if (!isProjectId(id)) return null;
    return (await this.entries()).find((each) => each.id === id) ?? null;
  }

  /** Newest first; `query` keeps the projects whose title, engine or brief text hold every word. */
  async list(query = ""): Promise<IndexEntry[]> {
    const words = query
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word !== "");
    const all = (await this.entries()).sort((a, b) => b.created.localeCompare(a.created));
    if (words.length === 0) return all;
    const kept: IndexEntry[] = [];
    for (const entry of all) {
      const brief = await this.readBrief(entry);
      const haystack = `${entry.title} ${entry.engine} ${brief?.brief.text ?? ""}`.toLowerCase();
      if (words.every((word) => haystack.includes(word))) kept.push(entry);
    }
    return kept;
  }

  async create(brief: Brief, title: string): Promise<IndexEntry> {
    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
    const entry: IndexEntry = {
      id,
      dir: `${slugOf(title)}-${id}`,
      title,
      engine: brief.engine,
      lengthSec: brief.lengthSec,
      created: new Date().toISOString(),
      sketches: 0,
      chosen: null,
    };
    await mkdir(join(this.pathOf(entry), "sketches"), { recursive: true });
    const record: ProjectRecord = { id, title, created: entry.created, brief, chosen: null };
    await writeFile(join(this.pathOf(entry), "brief.json"), `${JSON.stringify(record, null, 2)}\n`);
    await this.state.update<IndexEntry[]>(INDEX, (now) => [...(now ?? []).filter(isEntry), entry]);
    return entry;
  }

  async remove(entry: IndexEntry): Promise<void> {
    await this.state.update<IndexEntry[]>(INDEX, (now) =>
      (now ?? []).filter((each) => !isEntry(each) || each.id !== entry.id),
    );
    await rm(this.pathOf(entry), { recursive: true, force: true });
  }

  async saveSketch(
    entry: IndexEntry,
    id: SketchId,
    made: Sketched,
    engine: EngineId,
  ): Promise<SketchRecord> {
    const file = `sketches/${id}.${made.ext}`;
    await writeFile(join(this.pathOf(entry), file), made.audio);
    const record: SketchRecord = {
      id,
      engine,
      songId: made.songId,
      plan: made.plan,
      timestamps: made.timestamps,
      lyrics: made.lyrics,
      file,
      created: new Date().toISOString(),
    };
    await writeFile(
      join(this.pathOf(entry), "sketches", `${id}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    const count = (await this.sketches(entry)).length;
    await this.state.update<IndexEntry[]>(INDEX, (now) =>
      (now ?? []).map((each) =>
        isEntry(each) && each.id === entry.id ? { ...each, sketches: count } : each,
      ),
    );
    return record;
  }

  async readBrief(entry: IndexEntry): Promise<ProjectRecord | null> {
    try {
      const parsed: unknown = JSON.parse(
        await readFile(join(this.pathOf(entry), "brief.json"), "utf8"),
      );
      if (!isRecord(parsed) || !isRecord(parsed["brief"])) return null;
      return parsed as ProjectRecord;
    } catch {
      return null;
    }
  }

  /** The sketches on disk, in a, b, c order. */
  async sketches(entry: IndexEntry): Promise<SketchRecord[]> {
    const dir = join(this.pathOf(entry), "sketches");
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const out: SketchRecord[] = [];
    for (const id of SKETCH_IDS) {
      if (!names.includes(`${id}.json`)) continue;
      try {
        const parsed: unknown = JSON.parse(await readFile(join(dir, `${id}.json`), "utf8"));
        if (isRecord(parsed) && typeof parsed["file"] === "string")
          out.push(parsed as SketchRecord);
      } catch {
        // A half-written record is skipped; the sketch shows once it is whole.
      }
    }
    return out;
  }

  /** Marks one sketch as the chosen one. */
  async choose(entry: IndexEntry, sketch: SketchId): Promise<void> {
    const record = await this.readBrief(entry);
    if (record === null) throw new Error("The project's brief.json is missing.");
    const next: ProjectRecord = { ...record, chosen: sketch };
    await writeFile(join(this.pathOf(entry), "brief.json"), `${JSON.stringify(next, null, 2)}\n`);
    await this.state.update<IndexEntry[]>(INDEX, (now) =>
      (now ?? []).map((each) =>
        isEntry(each) && each.id === entry.id ? { ...each, chosen: sketch } : each,
      ),
    );
  }

  /** The bytes of a sketch's audio file. */
  async audio(entry: IndexEntry, sketch: SketchRecord): Promise<Buffer> {
    return await readFile(join(this.pathOf(entry), sketch.file));
  }
}
