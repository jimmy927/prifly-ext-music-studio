/** The Deliver stage's routes: what can be delivered now, and the export as a local job. */

import { isAbsolute } from "node:path";
import { probeFfmpeg } from "../audio/ffmpeg";
import {
  DELIVER_ITEMS,
  type DeliverItem,
  deliver,
  deliverFolder,
  isDeliverItem,
} from "../export/run";
import { launchLocal } from "../jobs";
import { masters } from "../project/master";
import { readPrep } from "../project/prep";
import { readStems } from "../project/stage";
import { bodyOf, entryOf, type Handler, startedAnswer } from "./common";

const view: Handler = async (studio, request) => {
  const entry = await entryOf(studio, request.query["project"]);
  const dir = studio.store().pathOf(entry);
  const probe = await probeFfmpeg(studio.ffmpeg());
  const prep = await readPrep(dir);
  const latest = (await masters(dir)).at(-1);
  return {
    ffmpeg: probe.ok ? { ok: true, message: probe.output } : { ok: false, message: probe.message },
    title: entry.title,
    folder: deliverFolder(studio, entry, null),
    items: DELIVER_ITEMS,
    stems: (await readStems(dir))?.stems.length ?? 0,
    master: latest === undefined ? null : { n: latest.n, format: latest.format },
    prepared: prep?.grid != null,
    cues: prep?.cues.length ?? 0,
    loop: prep?.loop != null,
    crates: (await studio.crates().list()).map((each) => ({
      id: each.id,
      name: each.name,
      count: each.tracks.length,
    })),
  };
};

const run: Handler = async (studio, request) => {
  const body = bodyOf(request);
  const entry = await entryOf(studio, body["project"]);
  const items: DeliverItem[] = Array.isArray(body["items"])
    ? body["items"].filter(isDeliverItem)
    : [];
  const dest =
    typeof body["dest"] === "string" && body["dest"].trim() !== "" ? body["dest"].trim() : null;
  if (dest !== null && !isAbsolute(dest))
    throw new Error("The folder is a full path, such as C:\\Music\\deliver or /home/me/deliver.");
  const crate = typeof body["crate"] === "string" && body["crate"] !== "" ? body["crate"] : null;
  if (items.length === 0) throw new Error("Tick at least one thing to deliver.");
  return startedAnswer(
    launchLocal(studio, entry.id, {
      work: "deliver",
      label: "Writing the files",
      total: items.length,
      run: async ({ signal, job }) => {
        const done = await deliver(studio, entry, { items, dest, crate }, signal, (name) =>
          job.done.push(name),
        );
        if (!done.ok) throw new Error(done.message);
        return JSON.stringify({ dir: done.dir, files: done.files, notes: done.notes });
      },
    }),
  );
};

export const deliverRoutes: Record<string, Handler> = {
  deliver: view,
  "deliver-run": run,
};
