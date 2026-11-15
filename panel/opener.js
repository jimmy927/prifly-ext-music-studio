// panel/src/opener.ts
var OPENING_TEXT = "Opening your Music Studio session…";
var STARTING_TEXT = "Starting a Music Studio session…";
var TIMEOUT_TEXT = "Prifly did not start a session. Try again; if it keeps failing, prifly's log (ext.launch_failed) says why.";
var POLL_MS = 1000;
var POLL_TRIES = 30;
var errorText = (caught) => caught instanceof Error ? caught.message : String(caught);
function land(deps, answer, session, title) {
  if (answer.canOpen) {
    deps.post({ type: "prifly-open-session", session });
    deps.show({ kind: "busy", text: `Opening ${title}…` });
  } else {
    deps.show({
      kind: "info",
      text: `Your Music Studio session "${title}" is running: find it in the sidebar.`
    });
  }
}
async function run(deps) {
  deps.show({ kind: "busy", text: OPENING_TEXT });
  try {
    const answer = await deps.get("open");
    if (answer.action === "open" && answer.session !== null) {
      land(deps, answer, answer.session, answer.title ?? "Music Studio");
      return;
    }
    deps.show({ kind: "busy", text: STARTING_TEXT });
    deps.post({ type: "prifly-launch", launcher: answer.launcher, key: answer.key });
    for (let tries = 0;tries < POLL_TRIES; tries += 1) {
      await deps.sleep(POLL_MS);
      const started = await deps.get(`started?since=${answer.since}`);
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
async function getJson(path) {
  const response = await fetch(`api/${path}`);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body?.error;
    throw new Error(typeof message === "string" ? message : `HTTP ${response.status}`);
  }
  return body;
}
function mount() {
  const params = new URLSearchParams(location.search);
  if (params.get("theme") === "dark")
    document.documentElement.classList.add("dark");
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
  const go = () => run({
    get: getJson,
    post: (message) => parent.postMessage(message, "*"),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    show: (shown) => {
      line.textContent = shown.text;
      line.dataset["kind"] = shown.kind;
      again.hidden = shown.kind !== "error";
    }
  });
  again.addEventListener("click", () => void go());
  go();
}
if (typeof document !== "undefined" && document.body !== null && typeof location !== "undefined")
  mount();
export {
  OPENING_TEXT,
  POLL_MS,
  POLL_TRIES,
  STARTING_TEXT,
  TIMEOUT_TEXT,
  run
};
