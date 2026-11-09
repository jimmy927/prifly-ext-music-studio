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
import type { IndexEntry } from "../project/store";
import { latestRender, readRenders } from "../project/video-media";
import { fail, type Studio } from "../studio";
import { loadEdit, signatureOf } from "../video/edit-model";
import { askToRender } from "../video/render-card";
import { bodyOf, entryOf, type Handler, startedAnswer } from "./common";
import type { DeliverView } from "./views";

/** What the two video items need: a 1080p render, and clips to cut the vertical from. */
async function videoState(studio: Studio, entry: IndexEntry): Promise<DeliverView["video"]> {
  const state = await loadEdit(studio, entry);
  const render = latestRender(await readRenders(state.dir), "final");
  const clips = state.slots.filter((each) => each.clip !== null).length;
  const range = state.vertical;
  return {
    render:
      render === null
        ? null
        : {
            n: render.n,
            seconds: render.seconds,
            stale: render.signature !== signatureOf(state, state.settings.captions),
          },
    clips,
    verticalSec: range === null ? null : Math.round(range.endSec - range.startSec),
    captions: state.words.length > 0,
  };
}

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
    video: await videoState(studio, entry),
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
  if (items.includes("vertical")) {
    const state = await loadEdit(studio, entry);
    const range = state.vertical;
    const said = await askToRender(
      studio,
      "vertical",
      range === null ? 30 : range.endSec - range.startSec,
    );
    if (typeof said === "string") return startedAnswer(fail("unsupported", said));
    if (!said) return startedAnswer(fail("cancelled", "Not done: you cancelled."));
  }
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
