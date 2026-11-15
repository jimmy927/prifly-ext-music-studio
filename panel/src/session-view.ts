/**
 * The session view (the App tab beside a chat): it opens the project and stage
 * it was shown with (`api/view`), then `follow.ts` keeps it with the session's
 * tool calls. While that runs the page says so; a project that is gone gets a
 * line and a way to the Library, and a view shown with no project opens on the
 * Library.
 */

import { call, errorText, type ViewAnswer } from "./api";
import { openProject } from "./follow";
import { go } from "./header";
import type { View } from "./state";
import { app, redraw } from "./state";

export const LOADING_TEXT = "Opening the project…";
export const MISSING_TEXT = "This project is not in the library any more.";

/** Opens what the view was shown with; every failure is said on the page. */
export async function openSessionView(): Promise<void> {
  app.opening = { state: "loading", text: LOADING_TEXT };
  redraw("head");
  try {
    const answer = await call<ViewAnswer>("view");
    if (answer.state === "none") {
      // No project yet: the Library, to open one or start a new one from Idea.
      app.opening = null;
      go("library");
    } else if (answer.state === "missing") {
      app.opening = { state: "missing", text: MISSING_TEXT };
    } else {
      await openProject(answer.project, answer.stage as View | null);
      // What the session did before the page opened is not news: jump only on a later call.
      app.follow.project = answer.project;
      app.follow.stamp = answer.stamp;
    }
  } catch (caught) {
    app.opening = { state: "error", text: `Could not open the project: ${errorText(caught)}` };
  }
  redraw("head");
}
