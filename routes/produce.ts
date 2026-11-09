/** The Produce stage's routes: the stems and layers view, stem separation, sound-effect layers. */

import { startSfx, startStems } from "../produce/run";
import { sourceOf } from "../project/source";
import { layers, removeLayer } from "../project/stage";
import { tracksOf } from "../project/tracks";
import { bodyOf, entryOf, type Handler, startedAnswer } from "./common";

export const produceView: Handler = async (studio, request) => {
  const entry = await entryOf(studio, request.query["project"]);
  const store = studio.store();
  const source = await sourceOf(store, entry);
  const { tempo, tracks, stemSource } = await tracksOf(store, entry);
  const made = await layers(store.pathOf(entry));
  return {
    source: source === null ? null : { id: source.id, label: source.label },
    stemSource,
    tempo,
    stems: tracks.filter((each) => each.kind === "stem").map((each) => ({ name: each.label })),
    layers: made.map((each) => ({
      id: each.id,
      prompt: each.prompt,
      startBar: each.startBar,
      lengthSec: each.lengthSec,
      loop: each.loop,
    })),
  };
};

const split: Handler = async (studio, request) =>
  startedAnswer(await startStems(studio, bodyOf(request)["project"]));

const add: Handler = async (studio, request) => {
  const body = bodyOf(request);
  return startedAnswer(await startSfx(studio, body["project"], body));
};

const again: Handler = async (studio, request) => {
  const body = bodyOf(request);
  return startedAnswer(
    await startSfx(studio, body["project"], body, undefined, String(body["layer"] ?? "")),
  );
};

const remove: Handler = async (studio, request) => {
  const body = bodyOf(request);
  const entry = await entryOf(studio, body["project"]);
  const removed = await removeLayer(studio.store().pathOf(entry), String(body["layer"] ?? ""));
  if (!removed) throw new Error("No such layer.");
  return { ok: true };
};

export const produceRoutes: Record<string, Handler> = {
  produce: produceView,
  "stems-split": split,
  "sfx-add": add,
  "sfx-regenerate": again,
  "sfx-remove": remove,
};
