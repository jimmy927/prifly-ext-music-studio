/**
 * Crates: named lists of tracks (project ids) for a DJ set, kept in
 * `api.state` under `crates`. A track is in a crate once. Mistakes (an empty
 * or taken name, an unknown crate or project) throw an Error with the
 * sentence for the reader.
 */

import type { ExtensionStateApi } from "@prifly/extension-api";
import { isRecord } from "../engines/types";
import { isProjectId } from "./store";

export type Crate = { id: string; name: string; tracks: string[]; created: string };

const KEY = "crates";
const MAX_NAME = 60;

const isCrate = (value: unknown): value is Crate =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  typeof value["name"] === "string" &&
  Array.isArray(value["tracks"]) &&
  typeof value["created"] === "string";

/** The name the reader typed, tidied; throws when it is empty or too long. */
export function crateName(text: unknown): string {
  const name = typeof text === "string" ? text.trim().replace(/\s+/g, " ") : "";
  if (name === "") throw new Error("A crate needs a name.");
  if (name.length > MAX_NAME) throw new Error(`A crate name is at most ${MAX_NAME} characters.`);
  return name;
}

export class Crates {
  private readonly state: ExtensionStateApi;

  constructor(state: ExtensionStateApi) {
    this.state = state;
  }

  async list(): Promise<Crate[]> {
    const raw = await this.state.get<unknown>(KEY);
    return (Array.isArray(raw) ? raw.filter(isCrate) : []).map((each) => ({
      ...each,
      tracks: each.tracks.filter(isProjectId),
    }));
  }

  async find(id: unknown): Promise<Crate | null> {
    return (await this.list()).find((each) => each.id === id) ?? null;
  }

  /** The crate with this id, else the one with this name (any case). */
  async lookup(idOrName: string): Promise<Crate | null> {
    const all = await this.list();
    const wanted = idOrName.trim().toLowerCase();
    return (
      all.find((each) => each.id === idOrName) ??
      all.find((each) => each.name.toLowerCase() === wanted) ??
      null
    );
  }

  private async change(make: (all: Crate[]) => Crate[]): Promise<void> {
    await this.state.update<Crate[]>(KEY, (now) =>
      make((Array.isArray(now) ? now : []).filter(isCrate)),
    );
  }

  async create(text: unknown): Promise<Crate> {
    const name = crateName(text);
    if ((await this.list()).some((each) => each.name.toLowerCase() === name.toLowerCase()))
      throw new Error(`There is a crate called "${name}" already.`);
    const crate: Crate = {
      id: crypto.randomUUID().replaceAll("-", "").slice(0, 8),
      name,
      tracks: [],
      created: new Date().toISOString(),
    };
    await this.change((all) => [...all, crate]);
    return crate;
  }

  async rename(id: unknown, text: unknown): Promise<Crate> {
    const name = crateName(text);
    const all = await this.list();
    const crate = all.find((each) => each.id === id);
    if (crate === undefined) throw new Error("No such crate.");
    if (all.some((each) => each.id !== crate.id && each.name.toLowerCase() === name.toLowerCase()))
      throw new Error(`There is a crate called "${name}" already.`);
    await this.change((now) =>
      now.map((each) => (each.id === crate.id ? { ...each, name } : each)),
    );
    return { ...crate, name };
  }

  async remove(id: unknown): Promise<void> {
    if ((await this.find(id)) === null) throw new Error("No such crate.");
    await this.change((all) => all.filter((each) => each.id !== id));
  }

  async add(id: unknown, project: unknown): Promise<Crate> {
    if (!isProjectId(project)) throw new Error("No such project.");
    const crate = await this.find(id);
    if (crate === null) throw new Error("No such crate.");
    if (crate.tracks.includes(project)) return crate;
    await this.change((all) =>
      all.map((each) =>
        each.id === crate.id ? { ...each, tracks: [...each.tracks, project] } : each,
      ),
    );
    return { ...crate, tracks: [...crate.tracks, project] };
  }

  async take(id: unknown, project: unknown): Promise<Crate> {
    const crate = await this.find(id);
    if (crate === null) throw new Error("No such crate.");
    const tracks = crate.tracks.filter((each) => each !== project);
    await this.change((all) =>
      all.map((each) => (each.id === crate.id ? { ...each, tracks } : each)),
    );
    return { ...crate, tracks };
  }
}
