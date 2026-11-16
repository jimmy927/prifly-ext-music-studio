/** The page's one state object, and a way to ask for a redraw of one region. */

import { type Brief, EMPTY_BRIEF } from "../../project/brief";
import type { CrateItem, FollowView, Job, ListItem, ProjectView, Status } from "./api";

export type View =
  | "idea"
  | "library"
  | "arrange"
  | "produce"
  | "mix"
  | "master"
  | "prepare"
  | "treatment"
  | "storyboard"
  | "shoot"
  | "edit"
  | "deliver";

/** The views that work on one project's audio or video. */
export const STAGES: readonly View[] = [
  "arrange",
  "produce",
  "mix",
  "master",
  "prepare",
  "treatment",
  "storyboard",
  "shoot",
  "edit",
  "deliver",
];
export type Notice = { tone: "info" | "warn" | "error"; text: string };

export type Refusal = { message: string; suggestion: string | null };

export type App = {
  view: View;
  /** Null until the first answer; `statusError` when it never came. */
  status: Status | null;
  statusError: string | null;
  draft: Brief;
  /** Paths of source material waiting for the next sketch (no project yet). */
  sources: string[];
  project: ProjectView | null;
  job: Job | null;
  /** The sketch request is out and the reader has not answered the confirm card yet. */
  confirming: boolean;
  notice: Notice | null;
  refusal: Refusal | null;
  library: {
    projects: ListItem[] | null;
    query: string;
    error: string | null;
    /** The crate shown, "" for all projects. */
    crate: string;
    crates: CrateItem[];
  };
  /** The session view opening the project it was shown with: loading, or why it could not. */
  opening: { state: "loading" | "missing" | "error"; text: string } | null;
  /** Following the session the view is shown in; `session` is null outside a session view. */
  follow: {
    session: string | null;
    on: boolean;
    view: FollowView | null;
    error: string | null;
    /** The stamp and project last applied, so each change is acted on once. */
    stamp: number;
    project: string | null;
  };
};

export const app: App = {
  view: "idea",
  status: null,
  statusError: null,
  draft: { ...EMPTY_BRIEF },
  sources: [],
  project: null,
  job: null,
  confirming: false,
  notice: null,
  refusal: null,
  library: { projects: null, query: "", error: null, crate: "", crates: [] },
  opening: null,
  follow: { session: null, on: false, view: null, error: null, stamp: 0, project: null },
};

type Region = "all" | "head" | "idea" | "library" | "stage";
const listeners = new Set<(region: Region) => void>();

export const onRedraw = (listener: (region: Region) => void): void => void listeners.add(listener);
export const redraw = (region: Region = "all"): void => {
  for (const listener of listeners) listener(region);
};
