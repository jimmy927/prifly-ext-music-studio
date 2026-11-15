/**
 * The page behind the status bar's Music Studio button. prifly can only open a
 * panel from there, so this page does the one thing the click is for and gets
 * out of the way: it asks `api/open`, then either lands the reader on their
 * Music Studio session (`prifly-open-session`, which closes the window) or asks
 * prifly to start one (`prifly-launch`) and waits for it. It says what it is
 * doing, and why it could not.
 */

import type { OpenAnswer, StartedAnswer } from "../../open";

export type Shown =
  | { kind: "busy"; text: string }
  | { kind: "info"; text: string }
  | { kind: "error"; text: string };

export type OpenerDeps = {
  get(path: string): Promise<unknown>;
  post(message: Record<string, string>): void;
  sleep(ms: number): Promise<void>;
  show(shown: Shown): void;
};

export const OPENING_TEXT = "Opening your Music Studio session…";
export const STARTING_TEXT = "Starting a Music Studio session…";
export const TIMEOUT_TEXT =
  "Prifly did not start a session. Try again; if it keeps failing, prifly's log (ext.launch_failed) says why.";
export const POLL_MS = 1000;
export const POLL_TRIES = 30;

const errorText = (caught: unknown): string =>
  caught instanceof Error ? caught.message : String(caught);

/** Lands on `session`, or says where it is when this prifly cannot open one from here. */
function land(deps: OpenerDeps, answer: OpenAnswer, session: string, title: string): void {
  if (answer.canOpen) {
    deps.post({ type: "prifly-open-session", session });
    deps.show({ kind: "busy", text: `Opening ${title}…` });
  } else {
    deps.show({
      kind: "info",
      text: `Your Music Studio session "${title}" is running: find it in the sidebar.`,
    });
  }
}

/** One go: reuse the session or start one. Never throws; a failure is shown. */
export async function run(deps: OpenerDeps): Promise<void> {
  deps.show({ kind: "busy", text: OPENING_TEXT });
  try {
    const answer = (await deps.get("open")) as OpenAnswer;
    if (answer.action === "open" && answer.session !== null) {
      land(deps, answer, answer.session, answer.title ?? "Music Studio");
      return;
    }
    deps.show({ kind: "busy", text: STARTING_TEXT });
    deps.post({ type: "prifly-launch", launcher: answer.launcher, key: answer.key });
    for (let tries = 0; tries < POLL_TRIES; tries += 1) {
      await deps.sleep(POLL_MS);
      const started = (await deps.get(`started?since=${answer.since}`)) as StartedAnswer;
      if (started.state === "started") {
        land(deps, answer, started.session, started.title);
        return;
      }
    }
    deps.show({ kind: "error", text: TIMEOUT_TEXT });
  } catch (caught) {
    deps.show({ kind: "error", text: `Could not open Music Studio: ${errorText(caught)}` });
  }
}

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(`api/${path}`);
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = (body as { error?: unknown } | null)?.error;
    throw new Error(typeof message === "string" ? message : `HTTP ${response.status}`);
  }
  return body;
}

function mount(): void {
  const params = new URLSearchParams(location.search);
  if (params.get("theme") === "dark") document.documentElement.classList.add("dark");
  const line = document.createElement("p");
  line.className = "opener-text";
  const again = document.createElement("button");
  again.type = "button";
  again.className = "btn";
  again.textContent = "Try again";
  const box = document.createElement("main");
  box.className = "opener";
  box.append(line, again);
  document.body.replaceChildren(box);
  const go = (): Promise<void> =>
    run({
      get: getJson,
      post: (message) => parent.postMessage(message, "*"),
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      show: (shown) => {
        line.textContent = shown.text;
        line.dataset["kind"] = shown.kind;
        again.hidden = shown.kind !== "error";
      },
    });
  again.addEventListener("click", () => void go());
  void go();
}

if (typeof document !== "undefined" && document.body !== null && typeof location !== "undefined")
  mount();
