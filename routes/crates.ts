/** Crates for the Library sidebar: list, create, rename, delete, and add or remove a track. */

import type { Crate } from "../project/crates";
import type { Studio } from "../studio";
import { bodyOf, type Handler } from "./common";

const shown = (crate: Crate) => ({ id: crate.id, name: crate.name, count: crate.tracks.length });

export type CrateItem = ReturnType<typeof shown>;

const all = async (studio: Studio) => ({
  crates: (await studio.crates().list()).map(shown),
});

export const crateRoutes: Record<string, Handler> = {
  crates: async (studio) => await all(studio),
  "crate-create": async (studio, request) => {
    const made = await studio.crates().create(bodyOf(request)["name"]);
    return { ...(await all(studio)), id: made.id };
  },
  "crate-rename": async (studio, request) => {
    const body = bodyOf(request);
    await studio.crates().rename(body["crate"], body["name"]);
    return await all(studio);
  },
  "crate-delete": async (studio, request) => {
    await studio.crates().remove(bodyOf(request)["crate"]);
    return await all(studio);
  },
  "crate-add": async (studio, request) => {
    const body = bodyOf(request);
    await studio.crates().add(body["crate"], body["project"]);
    return await all(studio);
  },
  "crate-remove": async (studio, request) => {
    const body = bodyOf(request);
    await studio.crates().take(body["crate"], body["project"]);
    return await all(studio);
  },
};
