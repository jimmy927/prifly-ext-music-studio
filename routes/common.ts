/** What every stage's routes share. */

import type { PanelRequest } from "@prifly/extension-api";
import { isRecord } from "../engines/types";
import { type IndexEntry, isProjectId } from "../project/store";
import type { Started, Studio } from "../studio";

export type Handler = (studio: Studio, request: PanelRequest) => Promise<unknown>;

export const bodyOf = (request: PanelRequest): Record<string, unknown> =>
  isRecord(request.body) ? request.body : {};

export async function entryOf(studio: Studio, id: unknown): Promise<IndexEntry> {
  const entry = isProjectId(id) ? await studio.store().find(id) : null;
  if (entry === null) throw new Error("No such project.");
  return entry;
}

/** What the panel is told about a run that did or did not start. */
export function startedAnswer(started: Started) {
  return started.ok
    ? { ok: true as const, job: started.job }
    : { ok: false as const, reason: started.reason, message: started.message };
}
