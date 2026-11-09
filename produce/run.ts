/** The Produce stage's paid runs: split the song into stems, make a sound-effect layer (or make it again). */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { type SfxRequest, sfxProblem, soundEffect } from "../engines/sfx";
import { separateStems } from "../engines/stems";
import { isRecord } from "../engines/types";
import { launch } from "../jobs";
import { sourceOf } from "../project/source";
import { isLayerId, layers, saveLayer, saveStems } from "../project/stage";
import type { IndexEntry } from "../project/store";
import { fail, type Started, type Studio } from "../studio";

async function entryOf(studio: Studio, projectId: unknown): Promise<IndexEntry | null> {
  return typeof projectId === "string" ? await studio.store().find(projectId) : null;
}

/** Splits the current version (or chosen sketch) into stems; the old stems are replaced. */
export async function startStems(
  studio: Studio,
  projectId: unknown,
  linked?: AbortSignal,
): Promise<Started> {
  const entry = await entryOf(studio, projectId);
  if (entry === null) return fail("invalid", "No such project.");
  const store = studio.store();
  const source = await sourceOf(store, entry);
  if (source === null)
    return fail("invalid", "There is nothing to split yet. Choose a sketch first.");
  return await launch(
    studio,
    entry,
    {
      work: "stems",
      label: `Splitting ${source.label} into stems`,
      total: 1,
      confirm: {
        title: "Split stems",
        summary: `Split ${source.label} into stems (vocals, drums, bass and the rest) with ElevenLabs: billed by ElevenLabs to your plan (its API gives no per-split price, so none is shown). Stems you have now are replaced.`,
        content: source.label,
        details: "POST /v1/music/stem-separation, multipart form, one audio file",
      },
      run: async ({ key, signal, job }) => {
        const audio = new Uint8Array(await readFile(source.file));
        const stems = await separateStems(
          studio.deps.fetch,
          key,
          { audio, name: basename(source.file) },
          null,
          signal,
        );
        const set = await saveStems(store.pathOf(entry), source.id, stems);
        job.done.push(...set.stems.map((each) => each.name));
        return "stems";
      },
    },
    linked,
  );
}

export type LayerInput = { prompt: string; startBar: number; lengthSec: number; loop: boolean };

/** A layer request from untrusted data, or a message. */
export function parseLayerInput(raw: unknown): LayerInput | string {
  const body = isRecord(raw) ? raw : {};
  const prompt = typeof body["prompt"] === "string" ? body["prompt"].trim() : "";
  const startBar = typeof body["startBar"] === "number" ? body["startBar"] : 1;
  const lengthSec = typeof body["lengthSec"] === "number" ? body["lengthSec"] : 3;
  if (!Number.isFinite(startBar) || startBar < 1) return "The start bar is 1 or later.";
  const input: LayerInput = { prompt, startBar, lengthSec, loop: body["loop"] === true };
  return sfxProblem(request(input)) ?? input;
}

const request = (input: LayerInput): SfxRequest => ({
  text: input.prompt,
  durationSec: input.lengthSec,
  loop: input.loop,
  promptInfluence: 0.3,
});

/** Makes a sound-effect layer from a text prompt; with `again`, new audio for that layer. */
export async function startSfx(
  studio: Studio,
  projectId: unknown,
  raw: unknown,
  linked?: AbortSignal,
  again?: string,
): Promise<Started> {
  const entry = await entryOf(studio, projectId);
  if (entry === null) return fail("invalid", "No such project.");
  const store = studio.store();
  const dir = store.pathOf(entry);
  let input = parseLayerInput(raw);
  if (again !== undefined) {
    const old = isLayerId(again)
      ? (await layers(dir)).find((each) => each.id === again)
      : undefined;
    if (old === undefined) return fail("invalid", "No such layer.");
    input = {
      prompt: old.prompt,
      startBar: old.startBar,
      lengthSec: old.lengthSec,
      loop: old.loop,
    };
  }
  if (typeof input === "string") return fail("invalid", input);
  const layer = input;
  const id = again ?? crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  return await launch(
    studio,
    entry,
    {
      work: "sfx",
      label: again === undefined ? "Making the sound effect" : "Making the sound effect again",
      total: 1,
      confirm: {
        title: again === undefined ? "Add a sound effect" : "Regenerate the sound effect",
        summary: `Make a ${layer.lengthSec} second sound effect with ElevenLabs, placed at bar ${layer.startBar}: billed by ElevenLabs to your plan (its API gives no per-effect price, so none is shown).`,
        content: layer.prompt,
        details: "POST /v1/sound-generation, model eleven_text_to_sound_v2",
      },
      run: async ({ key, signal, job }) => {
        const audio = await soundEffect(studio.deps.fetch, key, request(layer), signal);
        await saveLayer(dir, { id, ...layer }, audio);
        job.done.push(id);
        return id;
      },
    },
    linked,
  );
}
