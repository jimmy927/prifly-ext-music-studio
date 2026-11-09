/** Starting a render as a cancellable local job: the 540p preview straight away, the heavy ones after the reader says yes on the card. */

import { launchLocal, localBusy } from "../jobs";
import type { IndexEntry } from "../project/store";
import type { RenderKind } from "../project/video-media";
import { fail, type Started, type Studio } from "../studio";
import { loadEdit } from "./edit-model";
import { renderProject, unrenderable } from "./render";
import { askToRender } from "./render-card";

const LABELS: Record<RenderKind, string> = {
  preview: "Rendering the 540p preview",
  final: "Rendering the 1080p music video",
  vertical: "Rendering the vertical cut",
};

export async function startRender(
  studio: Studio,
  entry: IndexEntry,
  kind: RenderKind,
  linked?: AbortSignal,
): Promise<Started> {
  if (localBusy(studio))
    return fail("invalid", "Another local run is still going. Wait for it or cancel it.");
  const state = await loadEdit(studio, entry);
  const problem = unrenderable(state, state.slots);
  if (problem !== null) return fail("invalid", problem);
  if (kind !== "preview") {
    const seconds =
      kind === "vertical"
        ? (state.vertical?.endSec ?? 0) - (state.vertical?.startSec ?? 0)
        : (state.slots.at(-1)?.endSec ?? 0);
    const said = await askToRender(studio, kind, seconds);
    if (typeof said === "string") return fail("unsupported", said);
    if (!said) return fail("cancelled", "Not done: you cancelled.");
    if (localBusy(studio))
      return fail("invalid", "Another local run is still going. Wait for it or cancel it.");
  }
  return launchLocal(
    studio,
    entry.id,
    {
      work: kind === "preview" ? "preview" : "render",
      label: LABELS[kind],
      total: 2,
      run: async ({ signal, job }) => {
        const done = await renderProject(studio, entry, { kind, signal }, (name) =>
          job.done.push(name),
        );
        if (!done.ok) throw new Error(done.message);
        return JSON.stringify({
          kind,
          n: done.record.n,
          seconds: done.record.seconds,
          warnings: done.warnings,
        });
      },
    },
    linked,
  );
}
