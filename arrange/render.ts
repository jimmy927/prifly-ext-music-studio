/** "Render changes": the edited sections in, one confirm card, one inpainting render, a new version out. */

import { composePlan } from "../engines/elevenlabs";
import { isRecord } from "../engines/types";
import { type Confirm, launch } from "../jobs";
import { baseOf } from "../project/source";
import { saveVersion } from "../project/stage";
import { fail, type Started, type Studio } from "../studio";
import {
  type Adherence,
  buildPlan,
  type Change,
  type Draft,
  type Section,
  stripSource,
} from "./plan";

const ADHERENCE: readonly string[] = ["low", "medium", "high"];

const list = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((each): each is string => typeof each === "string").map((each) => each.trim())
    : [];

/** The sections the panel or a tool sends, checked; a message when they are not sections. */
export function parseDrafts(raw: unknown): Draft[] | string {
  if (!Array.isArray(raw)) return "Send the sections as a list.";
  const out: Draft[] = [];
  for (const each of raw) {
    if (!isRecord(each) || typeof each["text"] !== "string")
      return "Each section needs text: its name in square brackets, then the lyrics.";
    const ms = each["durationMs"];
    if (typeof ms !== "number") return "Each section needs a length in milliseconds.";
    const source = each["source"];
    const adherence = String(each["contextAdherence"]);
    out.push({
      text: each["text"],
      durationMs: Math.round(ms),
      positiveStyles: list(each["positiveStyles"]).filter((s) => s !== ""),
      negativeStyles: list(each["negativeStyles"]).filter((s) => s !== ""),
      contextAdherence: ADHERENCE.includes(adherence) ? (adherence as Adherence) : "high",
      source: typeof source === "number" && Number.isInteger(source) ? source : null,
    });
  }
  return out;
}

const describe = (change: Change): string => {
  const fields = change.fields.length === 0 ? "" : ` (${change.fields.join(", ")})`;
  return `${change.label}: ${change.kind}${fields}`;
};

export function confirmCard(changes: Change[], generated: number, from: string): Confirm {
  const changed = changes.filter((each) => each.kind === "changed" || each.kind === "inserted");
  const kept = changes.filter((each) => each.kind === "kept").length;
  return {
    title: "Render changes",
    summary: `Generate ${generated} section${generated === 1 ? "" : "s"} with ElevenLabs Music v2.5 and reuse ${kept} kept as audio: billed by ElevenLabs to your plan (its API gives no per-render price, so none is shown). Edits ${from}; the result is a new version.`,
    content: changes.map(describe).join("\n"),
    details: `POST /v1/music/detailed, model music_v2_5, composition_plan with ${changed.length} generation chunk${changed.length === 1 ? "" : "s"} and audio references, store_for_inpainting`,
  };
}

/** Starts a render of `drafts` over the project's current version (or chosen sketch). */
export async function startArrange(
  studio: Studio,
  projectId: unknown,
  rawDrafts: unknown,
  linked?: AbortSignal,
): Promise<Started> {
  const store = studio.store();
  const entry = typeof projectId === "string" ? await store.find(projectId) : null;
  if (entry === null) return fail("invalid", "No such project.");
  const base = await baseOf(store, entry);
  if (!base.ok) return fail("unsupported", base.reason);
  const drafts = parseDrafts(rawDrafts);
  if (typeof drafts === "string") return fail("invalid", drafts);
  const built = buildPlan(base.songId, base.sections, drafts);
  if (!built.ok) return fail("invalid", built.message);
  const sections: Section[] = stripSource(drafts);
  return await launch(
    studio,
    entry,
    {
      work: "arrange",
      label: "Rendering the changed sections",
      total: 1,
      confirm: confirmCard(built.changes, built.generated, base.label),
      run: async ({ key, signal, job }) => {
        const made = await composePlan(studio.deps.fetch, key, built.chunks, signal);
        const saved = await saveVersion(
          store.pathOf(entry),
          made,
          sections,
          base.from,
          built.changes,
        );
        job.done.push(saved.id);
        return saved.id;
      },
    },
    linked,
  );
}
