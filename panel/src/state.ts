/** The page's one state object, and a way to ask for a redraw of one region. */

import { type Brief, EMPTY_BRIEF } from "../../project/brief";
import type { Job, ListItem, ProjectView, Status } from "./api";

export type View = "idea" | "library";
export type Notice = { tone: "info" | "warn" | "error"; text: string };

export type Refusal = { message: string; suggestion: string | null };

export type App = {
  view: View;
  /** Null until the first answer; `statusError` when it never came. */
  status: Status | null;
  statusError: string | null;
  draft: Brief;
  project: ProjectView | null;
  job: Job | null;
  /** The sketch request is out and the reader has not answered the confirm card yet. */
  confirming: boolean;
  notice: Notice | null;
  refusal: Refusal | null;
  library: { projects: ListItem[] | null; query: string; error: string | null };
};

export const app: App = {
  view: "idea",
  status: null,
  statusError: null,
  draft: { ...EMPTY_BRIEF },
  project: null,
  job: null,
  confirming: false,
  notice: null,
  refusal: null,
  library: { projects: null, query: "", error: null },
};

type Region = "all" | "head" | "idea" | "library";
const listeners = new Set<(region: Region) => void>();

export const onRedraw = (listener: (region: Region) => void): void => void listeners.add(listener);
export const redraw = (region: Region = "all"): void => {
  for (const listener of listeners) listener(region);
};
