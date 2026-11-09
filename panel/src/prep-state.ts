/** What the Prepare page shares between its parts: the loaded view, the playhead, and posting an edit. */

import { call, errorText, type PrepareView, type PrepEdit } from "./api";
import { app, redraw } from "./state";

export const ps: {
  view: PrepareView | null;
  error: string | null;
  loadedFor: string | null;
  /** Seconds into the track. */
  playhead: number;
  /** What the last edit said when it did not work. */
  message: string | null;
} = { view: null, error: null, loadedFor: null, playhead: 0, message: null };

export const prep = () => ps.view?.prep ?? null;

export async function load(): Promise<void> {
  const project = app.project;
  if (project === null) return;
  ps.loadedFor = project.id;
  try {
    ps.view = await call<PrepareView>(`prepare?project=${encodeURIComponent(project.id)}`);
    ps.error = null;
  } catch (caught) {
    ps.view = null;
    ps.error = errorText(caught);
  }
  redraw("stage");
}

/** Posts an edit to the track; the new description replaces the old, or the reason it did not work is kept in `message`. */
export async function edit(path: string, body: Record<string, unknown> = {}): Promise<void> {
  const project = app.project;
  if (project === null || ps.view === null) return;
  ps.message = null;
  try {
    const answer = await call<PrepEdit>(path, { project: project.id, ...body });
    if (answer.ok) ps.view = { ...ps.view, prep: answer.prep };
    else ps.message = answer.message;
  } catch (caught) {
    ps.message = errorText(caught);
  }
  redraw("stage");
}
