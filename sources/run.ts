/**
 * "Read the source material" as a run on an existing project: plan, ask the
 * reader (when something is not cached yet), read in the background, and keep
 * the result in the project's sources.json. The Treatment tool and the
 * panel's Add source material and Try again use it; a sketch run that starts
 * from sources reads inside its own run (studio.ts).
 */

import { launch } from "../jobs";
import { readSources as readProjectSources, saveSources } from "../project/sources";
import type { IndexEntry } from "../project/store";
import { fail, type Started, type Studio } from "../studio";
import { cardLine, planSources, readSources } from "./analyse";
import { ANALYSIS_MODEL } from "./constants";

/** The paths of the files a project's sources came from, for reading them again. */
export async function originalsOf(dir: string): Promise<string[]> {
  return (await readProjectSources(dir)).sources.map((each) => each.original);
}

/** Reads `input` (files and folders) as the project's source material. Nothing is called before the reader confirms. */
export async function startSources(
  studio: Studio,
  entry: IndexEntry,
  input: unknown,
  linked?: AbortSignal,
): Promise<Started> {
  const planned = await planSources(studio, input);
  if (!planned.ok) return fail(planned.reason === "no_key" ? "no_key" : "invalid", planned.message);
  const { plan } = planned;
  const dir = studio.store().pathOf(entry);
  return await launch(
    studio,
    entry,
    {
      work: "sources",
      provider: "gemini",
      label: "Reading the source material",
      total: plan.files.length,
      confirm:
        plan.usd === 0
          ? null
          : {
              title: "Read the source material",
              summary: cardLine(plan),
              content: plan.files.map((each) => each.path).join("\n"),
              details: `POST /v1beta/interactions, model ${ANALYSIS_MODEL}, up to ${plan.calls} calls`,
            },
      run: async ({ signal, job }) => {
        try {
          const read = await readSources(studio, plan, signal, (text) => {
            job.label = text;
          });
          await saveSources(studio, dir, plan.files, read.described, read.synthesis, read.notes);
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : String(caught);
          if (!signal.aborted)
            await saveSources(studio, dir, plan.files, plan.cached, null, [], message).catch(
              () => undefined,
            );
          throw caught;
        }
        job.done.push("sources");
        return "sources";
      },
    },
    linked,
  );
}
