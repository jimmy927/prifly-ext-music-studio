// arrange/plan.ts
var MIN_CHUNK_MS = 3000;
var MAX_CHUNK_MS = 120000;
var MAX_CHUNKS = 30;
var MAX_STYLES = 50;
var toDraft = (sections) => sections.map((each, source) => ({ ...each, source }));
function labelOf(text) {
  const tag = /^\s*\[([^\]]+)\]/.exec(text);
  if (tag?.[1] !== undefined)
    return tag[1].trim();
  const first = text.trim().split(`
`)[0] ?? "";
  return first === "" ? "Section" : first.slice(0, 24);
}
var same = (a, b) => a.length === b.length && a.every((each, at) => each === b[at]);
function fieldsChanged(before, after) {
  const out = [];
  if (!same(before.positiveStyles, after.positiveStyles))
    out.push("styles");
  if (!same(before.negativeStyles, after.negativeStyles))
    out.push("negative styles");
  if (before.text !== after.text)
    out.push("lyrics");
  if (before.durationMs !== after.durationMs)
    out.push("length");
  if (before.contextAdherence !== after.contextAdherence)
    out.push("context");
  return out;
}
function diff(base, draft) {
  const changes = [];
  const used = new Set;
  draft.forEach((each, index) => {
    const before = each.source === null ? undefined : base[each.source];
    if (each.source === null || before === undefined) {
      changes.push({
        kind: "inserted",
        index,
        source: null,
        label: labelOf(each.text),
        fields: []
      });
      return;
    }
    used.add(each.source);
    const fields = fieldsChanged(before, each);
    changes.push({
      kind: fields.length === 0 ? "kept" : "changed",
      index,
      source: each.source,
      label: labelOf(each.text),
      fields
    });
  });
  base.forEach((each, source) => {
    if (!used.has(source))
      changes.push({ kind: "deleted", index: null, source, label: labelOf(each.text), fields: [] });
  });
  return changes;
}
function problemWith(section) {
  const name = labelOf(section.text);
  if (section.text.trim() === "")
    return "A section has no text. Give it a name in square brackets.";
  if (!Number.isFinite(section.durationMs))
    return `${name}: the length is not a number.`;
  if (section.durationMs < MIN_CHUNK_MS || section.durationMs > MAX_CHUNK_MS)
    return `${name}: a section lasts 3 to 120 seconds.`;
  if (section.positiveStyles.length > MAX_STYLES || section.negativeStyles.length > MAX_STYLES)
    return `${name}: at most ${MAX_STYLES} styles.`;
  return null;
}
var chunkOf = (section) => ({
  text: section.text,
  duration_ms: Math.round(section.durationMs),
  positive_styles: section.positiveStyles,
  negative_styles: section.negativeStyles,
  context_adherence: section.contextAdherence
});
function offsetsOf(base) {
  const out = [];
  let at = 0;
  for (const each of base) {
    out.push(at);
    at += each.durationMs;
  }
  return out;
}
function keepSlice(chunks, songId, range, joins) {
  const previous = chunks[chunks.length - 1];
  if (joins && previous !== undefined && "range" in previous)
    previous.range.end_ms = range.end_ms;
  else
    chunks.push({ song_id: songId, range });
}
function chunksFor(songId, base, draft, changes) {
  const offsets = offsetsOf(base);
  const chunks = [];
  let lastKept = null;
  for (const [index, each] of draft.entries()) {
    const start = each.source === null ? undefined : offsets[each.source];
    const length = each.source === null ? undefined : base[each.source]?.durationMs;
    if (changes[index]?.kind === "kept" && each.source !== null) {
      if (start === undefined || length === undefined)
        return "A kept section is missing.";
      const range = { start_ms: start, end_ms: start + length };
      keepSlice(chunks, songId, range, lastKept !== null && each.source === lastKept + 1);
      lastKept = each.source;
      continue;
    }
    lastKept = null;
    const problem = problemWith(each);
    if (problem !== null)
      return problem;
    chunks.push(chunkOf(each));
  }
  return chunks;
}
function buildPlan(songId, base, draft) {
  const changes = diff(base, draft);
  const refuse = (message) => ({ ok: false, message, changes });
  if (draft.length === 0)
    return refuse("A song needs at least one section.");
  const chunks = chunksFor(songId, base, draft, changes);
  if (typeof chunks === "string")
    return refuse(chunks);
  if (changes.every((each) => each.kind === "kept"))
    return refuse("Nothing changed.");
  if (chunks.length > MAX_CHUNKS)
    return refuse(`That makes ${chunks.length} chunks; ElevenLabs takes at most ${MAX_CHUNKS}.`);
  return {
    ok: true,
    chunks,
    changes,
    generated: chunks.filter((each) => ("text" in each)).length,
    kept: changes.filter((each) => each.kind === "kept").length
  };
}

// audio/bars.ts
var BEATS_PER_BAR = 4;
var barMs = (tempo) => BEATS_PER_BAR * 60000 / tempo;
var barStartMs = (bar, tempo) => Math.max(0, Math.round((bar - 1) * barMs(tempo)));
var barsIn = (ms, tempo) => Math.round(ms / barMs(tempo) * 10) / 10;

// panel/src/api.ts
function panelSession() {
  const id = new URLSearchParams(location.search).get("session");
  return id === null || id === "" ? null : id;
}
function withSession(path) {
  const session = panelSession();
  if (session === null)
    return path;
  return `${path}${path.includes("?") ? "&" : "?"}session=${encodeURIComponent(session)}`;
}
async function call(path, body) {
  const response = await fetch(`api/${withSession(path)}`, {
    method: body === undefined ? "GET" : "POST",
    ...body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
  });
  const data = await response.json();
  if (!response.ok) {
    const error = typeof data === "object" && data !== null ? data.error : null;
    throw new Error(typeof error === "string" ? error : `The request failed (${response.status}).`);
  }
  return data;
}
var errorText = (caught) => caught instanceof Error ? caught.message : String(caught);

// panel/src/dom.ts
function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (typeof value === "function")
      node.addEventListener(name.slice(2), value);
    else if (name === "class")
      node.className = String(value);
    else if (typeof value === "boolean")
      node.toggleAttribute(name, value);
    else
      node.setAttribute(name, String(value));
  }
  for (const child of children) {
    if (child === null || child === false || child === undefined)
      continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}
function fill(parent, ...children) {
  parent.replaceChildren(...children.filter((child) => child !== null && child !== false && child !== undefined));
}
var PATHS = {
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" stroke="none"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  library: '<path d="M5 4v16M10 4v16M15 6l4 14"/>',
  wave: '<path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 11v2"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  lock: '<rect x="6" y="11" width="12" height="9" rx="2"/><path d="M9 11V8a3 3 0 016 0v3"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>'
};
function icon(name, size = 16) {
  const wrap = document.createElement("span");
  wrap.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] ?? ""}</svg>`;
  return wrap.firstElementChild;
}

// panel/src/player.ts
var playing = null;
var clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
function blobUrl(base64, mime) {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}
async function fetchMedia(project, kind, id) {
  return await call(`media?project=${encodeURIComponent(project)}&kind=${kind}&id=${encodeURIComponent(id)}`);
}
function player(project, id, kind = "sketch", label = "") {
  const audio = new Audio;
  const button = h("button", {
    type: "button",
    class: "play",
    "aria-label": `Play ${label === "" ? `sketch ${id.toUpperCase()}` : label}`
  }, icon("play", 18));
  const seek = h("input", {
    type: "range",
    min: 0,
    max: 1000,
    value: 0,
    class: "seek",
    "aria-label": "Position"
  });
  const time = h("span", { class: "time" }, "0:00");
  const note = h("span", { class: "player-note", role: "status" });
  let loaded = false;
  const show = (name) => button.replaceChildren(icon(name, 18));
  audio.addEventListener("timeupdate", () => {
    if (audio.duration > 0)
      seek.value = String(Math.round(audio.currentTime / audio.duration * 1000));
    time.textContent = `${clock(audio.currentTime)} / ${clock(audio.duration || 0)}`;
  });
  audio.addEventListener("ended", () => show("play"));
  seek.addEventListener("input", () => {
    if (audio.duration > 0)
      audio.currentTime = Number(seek.value) / 1000 * audio.duration;
  });
  button.addEventListener("click", async () => {
    if (!loaded) {
      button.disabled = true;
      note.textContent = "Loading…";
      try {
        const media = await fetchMedia(project, kind, id);
        audio.src = blobUrl(media.base64, media.mime);
        loaded = true;
        note.textContent = "";
      } catch (caught) {
        note.textContent = errorText(caught);
        return;
      } finally {
        button.disabled = false;
      }
    }
    if (audio.paused) {
      if (playing !== null && playing !== audio)
        playing.pause();
      playing = audio;
      await audio.play();
      show("pause");
    } else {
      audio.pause();
      show("play");
    }
  });
  audio.addEventListener("pause", () => show("play"));
  return h("div", { class: "player" }, button, seek, time, note);
}
function claimPlayback(audio) {
  if (playing !== null && playing !== audio)
    playing.pause();
  playing = audio;
}
function stopPlayers() {
  playing?.pause();
}

// project/brief.ts
var SKETCH_IDS = ["a", "b", "c"];
var ENGINES = ["elevenlabs", "lyria-clip"];
var ENGINE_LABELS = {
  elevenlabs: "ElevenLabs Music v2.5",
  "lyria-clip": "Lyria 3 Clip"
};
var LENGTHS = [30, 60, 120, 180, 240];
var PRESETS = [
  {
    id: "slopcore",
    label: "Slopcore",
    style: "slopcore: deliberately cheap internet-era collage, detuned synths, chopped samples, glitchy meme energy",
    tempo: 140,
    key: "C minor",
    vocals: "generated",
    lengthSec: 60
  },
  {
    id: "techno-128",
    label: "Techno 128",
    style: "driving techno, four-on-the-floor kick, rolling bassline, hypnotic hi-hats, slow filter sweeps",
    tempo: 128,
    key: "A minor",
    vocals: "instrumental",
    lengthSec: 240
  },
  {
    id: "lofi",
    label: "Lo-fi",
    style: "lo-fi hip hop, dusty swung drums, mellow Rhodes chords, vinyl crackle, warm and sleepy",
    tempo: 80,
    key: "F major",
    vocals: "instrumental",
    lengthSec: 120
  },
  {
    id: "game-loop",
    label: "Game loop",
    style: "seamless looping video game background music, light chiptune and orchestral layers, no fade out",
    tempo: 120,
    key: "D minor",
    vocals: "instrumental",
    lengthSec: 60
  },
  {
    id: "stinger",
    label: "Stinger",
    style: "short dramatic cinematic stinger, a big impact hit and a rising swell that resolves cleanly",
    tempo: 100,
    key: "E minor",
    vocals: "instrumental",
    lengthSec: 30
  },
  {
    id: "hold-music",
    label: "Hold music",
    style: "friendly corporate hold music, soft electric piano, light jazz guitar, gentle brushed drums, loopable",
    tempo: 100,
    key: "G major",
    vocals: "instrumental",
    lengthSec: 120
  },
  {
    id: "eurodance-2003",
    label: "Eurodance 2003",
    style: "2003 Eurodance, euphoric supersaw lead, catchy female vocal hook, pumping bassline, trance-pop build-ups",
    tempo: 138,
    key: "A minor",
    vocals: "generated",
    lengthSec: 180
  }
];
var EMPTY_BRIEF = {
  text: "",
  preset: null,
  tempo: null,
  key: "",
  lengthSec: 120,
  vocals: "generated",
  lyrics: "",
  engine: "elevenlabs"
};
function formatLength(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// panel/src/state.ts
var STAGES = [
  "arrange",
  "produce",
  "mix",
  "master",
  "prepare",
  "treatment",
  "storyboard",
  "shoot",
  "edit",
  "deliver"
];
var app = {
  view: "idea",
  status: null,
  statusError: null,
  draft: { ...EMPTY_BRIEF },
  project: null,
  job: null,
  confirming: false,
  notice: null,
  refusal: null,
  library: { projects: null, query: "", error: null, crate: "", crates: [] },
  follow: { session: null, on: false, view: null, error: null, stamp: 0, project: null }
};
var listeners = new Set;
var onRedraw = (listener) => void listeners.add(listener);
var redraw = (region = "all") => {
  for (const listener of listeners)
    listener(region);
};

// project/reasons.ts
var LYRIA_REASON = "Lyria has no section plan, so there is nothing to arrange.";

// panel/src/header.ts
async function loadStatus() {
  try {
    app.status = await call("status");
    app.statusError = null;
  } catch (caught) {
    app.statusError = errorText(caught);
  }
  redraw("head");
  redraw("idea");
}
var SETTINGS = "Settings → Extensions → Music Studio";
function eleven() {
  const status = app.status;
  if (status === null)
    return h("span", { class: "pill muted" }, app.statusError === null ? "Checking keys…" : "Keys unknown");
  if (!status.elevenlabs.keySet) {
    return h("span", { class: "pill warn", title: `Add the key in ${SETTINGS}` }, icon("lock", 13), "ElevenLabs: no key");
  }
  const credits = status.elevenlabs.credits;
  if (credits === null) {
    return h("span", { class: "pill warn", title: status.elevenlabs.error ?? "" }, icon("alert", 13), "ElevenLabs: credits unavailable");
  }
  return h("span", {
    class: "pill ok",
    title: `${credits.used.toLocaleString("en-US")} of ${credits.limit.toLocaleString("en-US")} used, plan ${credits.tier}`
  }, `ElevenLabs: ${credits.left.toLocaleString("en-US")} credits left`);
}
function renderHeader() {
  const gemini = app.status?.gemini.keySet;
  return h("div", { class: "status-line", "data-part": "status" }, eleven(), gemini === undefined ? null : h("span", {
    class: `pill ${gemini ? "ok" : "warn"}`,
    title: gemini ? "" : `Add the key in ${SETTINGS}`
  }, gemini ? "Gemini key set" : "Gemini key not set"));
}
var GROUPS = [
  {
    name: "Song",
    tabs: [
      { id: "idea", label: "Idea" },
      { id: "arrange", label: "Arrange" },
      { id: "produce", label: "Produce" },
      { id: "mix", label: "Mix" },
      { id: "master", label: "Master" }
    ]
  },
  { name: "DJ", tabs: [{ id: "prepare", label: "Prepare" }] },
  {
    name: "Video",
    tabs: [
      { id: "treatment", label: "Treatment" },
      { id: "storyboard", label: "Storyboard" },
      { id: "shoot", label: "Shoot" },
      { id: "edit", label: "Edit" }
    ]
  },
  { name: "", tabs: [{ id: "deliver", label: "Deliver" }] }
];
function tab(each) {
  const view = each.id;
  const gated = STAGES.includes(view) ? gate(view) : { enabled: true, reason: null };
  const on = app.view === view;
  return h("button", {
    type: "button",
    class: `tab${on ? " on" : ""}`,
    "aria-current": on ? "page" : "false",
    "data-stage": each.id,
    disabled: !gated.enabled,
    "aria-disabled": String(!gated.enabled),
    ...gated.reason === null ? {} : { title: gated.reason },
    onclick: () => go(view)
  }, each.label);
}
var NO_TEMPO_REASON = "The video stages need a tempo. Analyse the track on the Prepare stage (or type its BPM in) first.";
var VIDEO_VIEWS = ["treatment", "storyboard", "shoot", "edit"];
function gate(view) {
  const project = app.project;
  if (project === null || project.chosen === null)
    return { enabled: false, reason: "Choose a sketch on the Idea stage first." };
  if (view === "arrange") {
    const engine = project.sketchList.find((each) => each.id === project.chosen)?.engine;
    if (engine !== "elevenlabs")
      return { enabled: false, reason: LYRIA_REASON };
  }
  if (VIDEO_VIEWS.includes(view) && project.tempo === null)
    return { enabled: false, reason: NO_TEMPO_REASON };
  return { enabled: true, reason: null };
}
function stageNote() {
  if (app.project === null)
    return "Open a project from the Library to use the stages after Idea.";
  return gate("arrange").reason ?? gate("treatment").reason ?? "";
}
async function refreshProject() {
  const id = app.project?.id;
  if (id === undefined)
    return;
  try {
    app.project = await call(`project?id=${encodeURIComponent(id)}`);
    redraw("head");
  } catch {}
}
function go(view) {
  app.view = view;
  redraw("all");
  refreshProject();
}
function renderStageBar() {
  const library = app.view === "library";
  const nav = h("nav", { class: "stagebar", "aria-label": "Stages", "data-part": "stagebar" }, ...GROUPS.map((group) => h("div", { class: "group", "data-group": group.name === "" ? "deliver" : group.name.toLowerCase() }, group.name === "" ? null : h("span", { class: "group-name" }, group.name), h("div", { class: "tabs" }, ...group.tabs.map(tab)))), h("span", { class: "grow" }), h("button", {
    type: "button",
    class: `tab library${library ? " on" : ""}`,
    "aria-current": library ? "page" : "false",
    onclick: () => go("library")
  }, icon("library", 15), "Library"));
  const note = h("p", { class: "stage-note", "data-part": "stage-note", role: "status" }, stageNote());
  return h("div", { class: "bar-wrap" }, nav, note);
}

// panel/src/work.ts
var POLL_MS = 1500;
var work = { confirming: false, job: null, cancelling: false, notice: null, refusal: null };
var busy = () => work.confirming || work.job?.status === "running";
function clearWork() {
  if (busy())
    return;
  work.job = null;
  work.notice = null;
  work.refusal = null;
}
function ended(job) {
  work.cancelling = false;
  if (job.status === "failed") {
    if (job.kind === "bad_prompt")
      work.refusal = {
        message: job.error ?? "ElevenLabs refused the prompt.",
        suggestion: job.suggestion
      };
    else
      work.notice = { tone: "error", text: job.error ?? "The run failed." };
  } else if (job.status === "cancelled") {
    work.notice = {
      tone: "info",
      text: "Cancelled. Nothing was added; anything already made is kept."
    };
  }
  loadStatus();
}
async function poll(id, after) {
  try {
    const job = await call(`job?id=${encodeURIComponent(id)}`);
    work.job = job;
    if (job.status === "running") {
      redraw("stage");
      setTimeout(() => void poll(id, after), POLL_MS);
      return;
    }
    ended(job);
    if (job.status === "done")
      await after();
  } catch (caught) {
    work.notice = { tone: "error", text: errorText(caught) };
    work.job = null;
  }
  redraw("stage");
}
async function follow(job, after) {
  work.notice = null;
  work.refusal = null;
  work.job = job;
  redraw("stage");
  await poll(job.id, after);
}
async function startWork(path, body, after) {
  work.notice = null;
  work.refusal = null;
  work.job = null;
  work.confirming = true;
  redraw("stage");
  try {
    const answer = await call(path, body);
    work.confirming = false;
    if (answer.ok) {
      work.job = answer.job;
      redraw("stage");
      await poll(answer.job.id, after);
      return;
    }
    work.notice = answer.reason === "cancelled" ? { tone: "info", text: "Cancelled. Nothing was made and nothing was spent." } : { tone: "warn", text: answer.message };
  } catch (caught) {
    work.confirming = false;
    work.notice = { tone: "error", text: errorText(caught) };
  }
  redraw("stage");
}
async function cancel() {
  if (work.job === null)
    return;
  work.cancelling = true;
  redraw("stage");
  try {
    await call("cancel", { job: work.job.id });
  } catch (caught) {
    work.notice = { tone: "error", text: errorText(caught) };
  }
}
function progress() {
  if (work.confirming) {
    return h("div", { class: "progress", role: "status", "data-state": "confirming" }, h("span", null, "Waiting for you to confirm the cost in prifly…"));
  }
  const job = work.job;
  if (job === null || job.status !== "running")
    return null;
  return h("div", { class: "progress", role: "status", "data-state": "running" }, h("span", null, `${job.label}. This can take a minute or more.`), h("div", { class: "track" }, h("div", { class: "fill indeterminate" })), h("button", {
    type: "button",
    class: "btn small",
    disabled: work.cancelling,
    onclick: () => void cancel()
  }, work.cancelling ? "Cancelling…" : "Cancel"));
}
function refusal() {
  if (work.refusal === null)
    return null;
  const { message, suggestion } = work.refusal;
  return h("div", { class: "notice warn", role: "alert", "data-state": "refused" }, icon("alert"), h("div", { class: "notice-body" }, h("strong", null, "ElevenLabs refused this."), h("p", null, message), suggestion === null ? null : h("div", { class: "suggestion" }, h("p", null, "Suggested instead:"), h("blockquote", null, suggestion))));
}
function renderWork() {
  const notice = work.notice;
  return h("div", { class: "work", "data-part": "work" }, progress(), refusal(), notice === null ? null : h("div", { class: `notice ${notice.tone}`, role: notice.tone === "error" ? "alert" : "status" }, icon(notice.tone === "info" ? "info" : "alert"), h("div", { class: "notice-body" }, notice.text)));
}

// panel/src/arrange.ts
var view = null;
var loadError = null;
var loadedFor = null;
var draft = [];
var selected = 0;
var dirty = false;
var projectKey = () => `${app.project?.id ?? ""}:${app.project?.chosen ?? ""}`;
var clock2 = (ms) => {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
var styles = (text) => text.split(",").map((each) => each.trim()).filter((each) => each !== "");
function resetDraft() {
  draft = view?.base ? toDraft(view.base.sections) : [];
  selected = 0;
}
async function load() {
  const project = app.project;
  if (project === null)
    return;
  loadedFor = projectKey();
  try {
    view = await call(`arrange?project=${encodeURIComponent(project.id)}`);
    loadError = null;
    resetDraft();
  } catch (caught) {
    view = null;
    loadError = errorText(caught);
  }
  dirty = true;
  redraw("stage");
}
var planned = () => buildPlan("preview", view?.base?.sections ?? [], draft);
var heading = h("h2", null);
var unavailable = h("div", { class: "notice warn", "data-state": "unavailable" });
var strip = h("div", { class: "strip", "data-part": "strip" });
var editor = h("div", { class: "editor", "data-part": "editor" });
var changesBox = h("div", { class: "changes", "data-part": "changes" });
var versionsBox = h("div", { class: "versions", "data-part": "versions" });
var workSlot = h("div", { class: "work-slot" });
var why = h("p", { class: "why", role: "status" });
var insert = h("button", { type: "button", class: "btn small", onclick: () => insertAfter() }, "Insert section");
var remove = h("button", { type: "button", class: "btn small", onclick: () => removeSelected() }, "Delete section");
var revert = h("button", { type: "button", class: "btn", onclick: () => revertAll() }, "Revert edits");
var render = h("button", {
  type: "button",
  class: "btn primary big",
  id: "render-changes",
  onclick: () => void renderChanges()
}, icon("spark"), "Render changes");
function blocker() {
  if (view === null)
    return loadError ?? "Loading the song…";
  if (!view.available)
    return view.reason;
  if (busy())
    return "A run is in progress.";
  const built = planned();
  return built.ok ? null : built.message;
}
function setButtons() {
  const editable = view?.available === true && !busy();
  const reason = blocker();
  render.disabled = reason !== null;
  insert.disabled = !editable;
  remove.disabled = !editable || draft.length <= 1;
  revert.disabled = !editable || !edited();
  for (const control of editor.querySelectorAll("input, textarea"))
    control.disabled = !editable;
  for (const control of versionsBox.querySelectorAll("button.pick"))
    control.disabled = !editable;
  why.textContent = reason ?? "";
}
var edited = () => planned().changes.some((each) => each.kind !== "kept");
function insertAfter() {
  const near = draft[selected];
  const section = {
    text: `[New section]
`,
    durationMs: 15000,
    positiveStyles: near?.positiveStyles ?? [],
    negativeStyles: [],
    contextAdherence: "high",
    source: null
  };
  draft.splice(selected + 1, 0, section);
  selected += 1;
  drawEdit();
}
function removeSelected() {
  if (draft.length <= 1)
    return;
  draft.splice(selected, 1);
  selected = Math.min(selected, draft.length - 1);
  drawEdit();
}
function revertAll() {
  resetDraft();
  drawEdit();
}
async function renderChanges() {
  const project = app.project;
  if (project === null)
    return;
  await startWork("arrange-render", { project: project.id, sections: draft }, async () => {
    await load();
    redraw("head");
  });
}
function drawStrip() {
  const tempo = view?.tempo ?? 120;
  const changes = planned().changes;
  fill(strip, ...draft.map((each, at) => {
    const kind = changes[at]?.kind ?? "kept";
    return h("button", {
      type: "button",
      class: `sec ${kind}${at === selected ? " on" : ""}`,
      style: `flex:${each.durationMs} 1 0`,
      "aria-pressed": String(at === selected),
      "data-kind": kind,
      "data-section": String(at),
      onclick: () => {
        selected = at;
        drawEdit();
      }
    }, h("span", { class: "sec-name" }, labelOf(each.text)), h("span", { class: "sec-bars" }, `${barsIn(each.durationMs, tempo)} bars`));
  }));
}
function drawChanges() {
  const built = planned();
  const list = built.changes;
  const count = (kind) => list.filter((each) => each.kind === kind).length;
  fill(changesBox, h("h3", null, "Changes"), list.every((each) => each.kind === "kept") ? h("p", { class: "empty" }, "Nothing changed yet. Select a section and edit it.") : h("ul", { class: "change-list" }, ...list.filter((each) => each.kind !== "kept").map((each) => h("li", { class: `change ${each.kind}`, "data-kind": each.kind }, h("span", { class: "tag" }, each.kind), `${each.label}${each.fields.length === 0 ? "" : ` (${each.fields.join(", ")})`}`))), h("p", { class: "meta" }, `${count("changed") + count("inserted")} to generate, ${count("kept")} kept as audio, ${count("deleted")} deleted`));
}
function field(label, control) {
  return h("label", { class: "field" }, h("span", { class: "field-label" }, label), control);
}
function drawEditor() {
  const section = draft[selected];
  if (section === undefined) {
    fill(editor, h("p", { class: "empty" }, "No section to edit."));
    return;
  }
  const tempo = view?.tempo ?? 120;
  const bars = h("span", { class: "meta" }, `${barsIn(section.durationMs, tempo)} bars at ${tempo} BPM`);
  const edit = (apply) => (event) => {
    apply(event.target.value);
    drawStrip();
    drawChanges();
    setButtons();
  };
  fill(editor, h("h3", null, `Section ${selected + 1}: ${labelOf(section.text)}`), field("Positive styles (comma separated)", h("input", {
    type: "text",
    name: "positive",
    value: section.positiveStyles.join(", "),
    oninput: edit((v) => {
      section.positiveStyles = styles(v);
    })
  })), field("Negative styles (comma separated)", h("input", {
    type: "text",
    name: "negative",
    value: section.negativeStyles.join(", "),
    oninput: edit((v) => {
      section.negativeStyles = styles(v);
    })
  })), field("Lyrics, starting with the [Section name]", h("textarea", {
    name: "lyrics",
    rows: 6,
    oninput: edit((v) => {
      section.text = v;
    })
  }, section.text)), field("Length (seconds)", h("input", {
    type: "number",
    name: "length",
    min: MIN_CHUNK_MS / 1000,
    max: MAX_CHUNK_MS / 1000,
    step: 0.5,
    value: String(section.durationMs / 1000),
    oninput: edit((v) => {
      section.durationMs = Math.round(Number(v) * 1000);
      bars.textContent = `${barsIn(section.durationMs, tempo)} bars at ${tempo} BPM`;
    })
  })), bars);
}
function drawVersions() {
  const project = app.project;
  const all = [...view?.versions ?? []].reverse();
  fill(versionsBox, h("h3", null, "Versions"), all.length === 0 ? h("p", { class: "empty" }, "No version yet. Render changes to make Version 1; the sketch stays as it is.") : h("ul", { class: "version-list" }, ...all.map((each) => versionRow(each, project?.id ?? ""))));
}
function versionRow(each, project) {
  const current = view?.active === each.id;
  const c = each.counts;
  return h("li", { class: `version${current ? " current" : ""}`, "data-version": each.id }, h("div", { class: "card-head" }, h("div", { class: "card-title" }, `Version ${each.n}`), current ? h("span", { class: "badge" }, icon("check", 14), "Current") : h("button", { type: "button", class: "btn small pick", onclick: () => void pick(each.id) }, "Use this version")), player(project, each.id, "version", `version ${each.n}`), h("div", { class: "meta" }, `${clock2(each.durationMs)} · ${each.sectionCount} sections · ${c.changed} changed, ${c.inserted} inserted, ${c.kept} kept, ${c.deleted} deleted`));
}
async function pick(id) {
  const project = app.project;
  if (project === null)
    return;
  try {
    view = await call("version-pick", { project: project.id, version: id });
    resetDraft();
  } catch (caught) {
    loadError = errorText(caught);
  }
  drawEdit();
}
function drawEdit() {
  drawStrip();
  drawEditor();
  drawChanges();
  drawVersions();
  setButtons();
}
function update() {
  const title = app.project?.title ?? "";
  heading.textContent = title === "" ? "Arrange" : `Arrange — ${title}`;
  unavailable.hidden = true;
  fill(unavailable);
  const reason = view?.available === false ? view.reason : loadError;
  if (reason !== null && reason !== undefined) {
    unavailable.hidden = false;
    fill(unavailable, icon("info"), h("div", { class: "notice-body" }, reason));
  }
  fill(workSlot, renderWork());
  if (dirty) {
    dirty = false;
    drawEdit();
  }
  setButtons();
}
function mountArrange() {
  const root = h("div", { class: "stage arrange", "data-stage": "arrange" }, h("section", { class: "main wide" }, heading, unavailable, strip, h("div", { class: "row" }, insert, remove), editor, changesBox, h("div", { class: "actions" }, render, revert, h("p", { class: "cost" }, "Billed by ElevenLabs to your plan. You confirm first.")), why, workSlot, versionsBox));
  return {
    root,
    update,
    sync: () => {
      if (app.project !== null && (loadedFor !== projectKey() || view === null)) {
        view = null;
        draft = [];
        load();
      }
      dirty = true;
      update();
    }
  };
}

// panel/src/local.ts
var POLL_MS2 = 600;
var local = { kind: null, job: null, starting: false, cancelling: false, notice: null };
var localBusy = () => local.starting || local.job?.status === "running";
async function ended2(kind, job, done) {
  local.cancelling = false;
  if (job.status === "failed")
    local.notice = { kind, tone: "error", text: job.error ?? "The run failed." };
  else if (job.status === "cancelled")
    local.notice = {
      kind,
      tone: "info",
      text: "Cancelled. Nothing was changed; anything already written is kept."
    };
  else
    local.notice = { kind, tone: "info", text: await done(job) };
}
async function poll2(kind, id, done) {
  try {
    const job = await call(`job?id=${encodeURIComponent(id)}`);
    local.job = job;
    if (job.status === "running") {
      redraw("stage");
      setTimeout(() => void poll2(kind, id, done), POLL_MS2);
      return;
    }
    await ended2(kind, job, done);
  } catch (caught) {
    local.notice = { kind, tone: "error", text: errorText(caught) };
    local.job = null;
    local.cancelling = false;
  }
  redraw("stage");
}
async function startLocal(kind, path, body, done) {
  local.notice = null;
  local.job = null;
  local.kind = kind;
  local.starting = true;
  redraw("stage");
  try {
    const answer = await call(path, body);
    local.starting = false;
    if (answer.ok) {
      local.job = answer.job;
      redraw("stage");
      await poll2(kind, answer.job.id, done);
      return;
    }
    local.notice = { kind, tone: "warn", text: answer.message };
  } catch (caught) {
    local.starting = false;
    local.notice = { kind, tone: "error", text: errorText(caught) };
  }
  redraw("stage");
}
async function followLocal(kind, job, done) {
  local.notice = null;
  local.kind = kind;
  local.job = job;
  redraw("stage");
  await poll2(kind, job.id, done);
}
async function cancelLocal() {
  if (local.job === null)
    return;
  local.cancelling = true;
  redraw("stage");
  try {
    await call("cancel", { job: local.job.id });
  } catch (caught) {
    local.cancelling = false;
    local.notice = {
      kind: local.kind ?? "master",
      tone: "error",
      text: errorText(caught)
    };
  }
}
var STEP_WORDS = {
  measured: "measured",
  rendered: "rendered",
  checked: "checked",
  decoded: "decoded",
  tempo: "tempo found",
  key: "key found",
  loudness: "loudness measured",
  stems: "stems written",
  master: "master written",
  rekordbox: "rekordbox written",
  loops: "loop points written",
  video: "music video copied",
  vertical: "vertical cut written",
  sections: "cut on the beats",
  described: "described",
  graph: "edit built"
};
function localProgress(kind) {
  const job = local.job;
  const running = job !== null && job.work === kind && job.status === "running";
  const step = running ? Math.min(job.done.length + 1, job.total) : 0;
  const last = running ? job.done.at(-1) : undefined;
  return h("div", { class: "local-progress", role: "status", "data-state": running ? "running" : "idle" }, h("span", { class: "local-step" }, running ? `${job.label}: step ${step} of ${job.total}${last === undefined ? "" : ` (${STEP_WORDS[last] ?? last})`}` : ""), h("div", { class: "track", "aria-hidden": "true" }, h("div", {
    class: "fill",
    style: `width:${running ? Math.round(job.done.length / Math.max(1, job.total) * 100) : 0}%`
  })));
}
function localNotice(kind) {
  const notice = local.notice;
  return h("div", { class: "local-notice", "data-part": `${kind}-notice` }, notice === null || notice.kind !== kind ? null : h("div", { class: `notice ${notice.tone}`, role: notice.tone === "error" ? "alert" : "status" }, icon(notice.tone === "info" ? "info" : "alert"), h("div", { class: "notice-body" }, notice.text)));
}

// panel/src/deliver.ts
var view2 = null;
var loadError2 = null;
var loadedFor2 = null;
var written = null;
var picked = new Set(["stems", "master", "rekordbox", "loops"]);
var elsewhere = false;
async function load2() {
  const project = app.project;
  if (project === null)
    return;
  loadedFor2 = project.id;
  try {
    view2 = await call(`deliver?project=${encodeURIComponent(project.id)}`);
    loadError2 = null;
  } catch (caught) {
    view2 = null;
    loadError2 = errorText(caught);
  }
  redraw("stage");
}
var heading2 = h("h2", null);
var banner = h("div", { class: "notice warn", role: "alert", "data-state": "no-ffmpeg" });
var rows = h("div", { class: "deliver-rows", "data-part": "items" });
var why2 = h("p", { class: "why", role: "status" });
var slot = h("div", { class: "slot", "data-part": "run-status" });
var resultBox = h("div", { class: "written", "data-part": "written" });
var folder = h("input", {
  type: "text",
  id: "deliver-folder",
  class: "folder-input",
  placeholder: "Full path, for example C:\\Music\\deliver",
  "aria-label": "Folder"
});
var crate = h("select", { id: "deliver-crate", "aria-label": "Rekordbox scope" });
var deliverButton = h("button", { type: "button", class: "btn primary big", id: "deliver", onclick: () => void run() }, icon("check"), "Deliver");
var cancelButton = h("button", { type: "button", class: "btn", id: "deliver-cancel", onclick: () => void cancelLocal() }, "Cancel");
var hereText = h("span", null, "In the project: deliver");
var here = h("input", { type: "radio", name: "where", id: "where-project", checked: true });
var there = h("input", { type: "radio", name: "where", id: "where-folder" });
for (const radio of [here, there])
  radio.addEventListener("change", () => {
    elsewhere = there.checked;
    buttons();
  });
function rowsOf() {
  const v = view2;
  return [
    {
      item: "stems",
      title: "Stems for a DAW",
      detail: "WAV 24-bit, named like 122bpm 8A Vocals.wav",
      available: (v?.stems ?? 0) > 0,
      why: "No stems yet. Split them on the Produce stage."
    },
    {
      item: "master",
      title: "Master with BPM and key tags",
      detail: "ID3 TBPM and TKEY in an MP3, Vorbis tags in an OGG; a WAV carries none",
      available: v?.master != null,
      why: "No master yet. Make one on the Master stage."
    },
    {
      item: "rekordbox",
      title: "rekordbox XML",
      detail: "Tempo grid, cues A to H and the loop; one playlist per crate",
      available: v?.prepared === true,
      why: "Not analysed yet. Analyse it on the Prepare stage."
    },
    {
      item: "loops",
      title: "Track with cue and loop points as JSON",
      detail: "A copy of the analysed audio and a .loops.json beside it",
      available: v?.prepared === true,
      why: "Not analysed yet. Analyse it on the Prepare stage."
    },
    {
      item: "video",
      title: "Music video",
      detail: `MP4, H.264, 1080p, the master as sound${v?.video.render?.stale === true ? ". The edit has changed since this render" : ""}`,
      available: v?.video.render != null,
      why: "No 1080p render yet. Render 1080p on the Edit stage first."
    },
    {
      item: "vertical",
      title: "Vertical cut",
      detail: `9:16, about ${v?.video.verticalSec ?? 30} seconds of the chorus or the range you chose, ${v?.video.captions === true ? "captions on" : "no captions (no sung words)"}, centre crop. Rendered now: you confirm first`,
      available: (v?.video.clips ?? 0) > 0,
      why: "No shot has a clip yet. Shoot on the Shoot stage first."
    }
  ];
}
function itemRow(row) {
  const box = h("input", {
    type: "checkbox",
    id: `item-${row.item}`,
    checked: picked.has(row.item) && row.available,
    disabled: !row.available
  });
  box.addEventListener("change", () => {
    if (box.checked)
      picked.add(row.item);
    else
      picked.delete(row.item);
    buttons();
  });
  return h("label", { class: `deliver-row${row.available ? "" : " off"}`, "data-item": row.item }, box, h("span", { class: "deliver-text" }, h("span", { class: "card-title" }, row.title), h("span", { class: "meta" }, row.available ? row.detail : row.why)), row.item === "rekordbox" ? crate : null);
}
function drawRows() {
  const v = view2;
  const keep = crate.value;
  fill(crate, h("option", { value: "" }, "This track"), ...(v?.crates ?? []).map((each) => h("option", { value: each.id }, `Crate: ${each.name} (${each.count})`)));
  if ((v?.crates ?? []).some((each) => each.id === keep))
    crate.value = keep;
  fill(rows, ...rowsOf().map(itemRow));
}
function blocker2() {
  if (view2 === null)
    return loadError2 ?? "Loading…";
  if (!view2.ffmpeg.ok)
    return view2.ffmpeg.message;
  const items = rowsOf().filter((each) => each.available && picked.has(each.item));
  if (items.length === 0)
    return "Tick something that is ready to deliver.";
  if (elsewhere && folder.value.trim() === "")
    return "Type the folder to write into.";
  return null;
}
function buttons() {
  const reason = blocker2();
  const busy = localBusy();
  deliverButton.disabled = reason !== null || busy;
  cancelButton.disabled = !(local.job?.status === "running" && local.job.work === "deliver") || local.cancelling;
  cancelButton.textContent = local.cancelling ? "Cancelling…" : "Cancel";
  folder.disabled = !elsewhere || busy;
  here.disabled = busy;
  there.disabled = busy;
  crate.disabled = busy || !(view2?.prepared ?? false);
  why2.textContent = reason ?? (busy ? "" : "Written on this computer. Files with the same name in the folder are replaced.");
  const bad = view2 !== null && !view2.ffmpeg.ok;
  banner.hidden = !bad;
  fill(banner, icon("alert"), h("div", { class: "notice-body" }, h("strong", null, "Delivering needs ffmpeg. "), view2?.ffmpeg.message ?? ""));
}
async function run() {
  const project = app.project;
  if (project === null || view2 === null)
    return;
  const items = rowsOf().filter((each) => each.available && picked.has(each.item)).map((each) => each.item);
  written = null;
  await startLocal("deliver", "deliver-run", {
    project: project.id,
    items,
    dest: elsewhere ? folder.value.trim() : null,
    crate: crate.value === "" ? null : crate.value
  }, async (job) => {
    try {
      written = JSON.parse(job.result ?? "");
    } catch {
      written = null;
    }
    await load2();
    return written === null ? "Done." : `Wrote ${written.files.length} files to ${written.dir}`;
  });
}
function drawWritten() {
  fill(resultBox, h("h3", null, "Written"), written === null ? h("p", { class: "empty", "data-state": "none-written" }, "Nothing written in this session yet.") : h("div", null, h("ul", { class: "files" }, ...written.files.map((file) => h("li", null, file))), ...written.notes.map((each) => h("p", { class: "meta" }, each))));
}
function update2() {
  heading2.textContent = app.project === null ? "Deliver" : `Deliver — ${app.project.title}`;
  hereText.textContent = `In the project: ${view2?.folder ?? "deliver"}`;
  drawRows();
  drawWritten();
  buttons();
  fill(slot, localProgress("deliver"), localNotice("deliver"));
}
function mountDeliver() {
  const root = h("div", { class: "stage deliver", "data-stage": "deliver" }, h("section", { class: "main wide" }, heading2, banner, rows, h("div", { class: "where", "data-part": "where" }, h("span", { class: "field-label" }, "Folder"), h("label", { class: "seg" }, here, hereText), h("label", { class: "seg" }, there, "Another folder"), folder), h("div", { class: "actions" }, deliverButton, cancelButton, why2), slot, resultBox));
  return {
    root,
    update: update2,
    sync: () => {
      if (loadedFor2 !== app.project?.id) {
        view2 = null;
        written = null;
      }
      load2();
      update2();
    }
  };
}

// prep/grid.ts
var SLOTS = ["A", "B", "C", "D", "E", "F", "G", "H"];
var LOOP_BARS = [1, 2, 4, 8, 16, 32];
var BEATS_PER_BAR2 = 4;
var ms = (value) => Math.round(value * 1000) / 1000;
var beatSeconds = (grid) => 60 / grid.bpm;
function beatsBetween(grid, from, to) {
  const beat = beatSeconds(grid);
  const out = [];
  const start = Math.ceil((Math.max(from, 0) - grid.firstBeatSec) / beat - 0.000000001);
  for (let index = start;; index += 1) {
    const sec = grid.firstBeatSec + index * beat;
    if (sec > to)
      break;
    const inBar = (index % BEATS_PER_BAR2 + BEATS_PER_BAR2) % BEATS_PER_BAR2;
    out.push({ sec: ms(sec), bar: Math.floor(index / BEATS_PER_BAR2) + 1, beat: inBar + 1 });
  }
  return out;
}
var clockText = (sec) => {
  const whole = Math.max(0, sec);
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${(whole - minutes * 60).toFixed(2).padStart(5, "0")}`;
};

// video/constants.ts
var MAX_CAST = 6;
var MAX_TAKES_PER_SHOT = 4;
var SHOT_BARS = [2, 4, 8];
var MAX_MEDIA_BYTES = 12 * 1024 * 1024;
var money = (usd) => `$${usd.toFixed(2)}`;

// panel/src/video.ts
var usd = money;
var LOCAL_WORK = ["draft", "preview", "render", "master", "analyse", "deliver"];
function moneyLine(m) {
  const share = m === null || m.budgetUsd <= 0 ? 0 : Math.min(1, m.spentUsd / m.budgetUsd);
  const over = m !== null && m.remainingUsd <= 0;
  return h("div", { class: `money${over ? " over" : ""}`, "data-part": "money", role: "status" }, h("span", { class: "money-text" }, m === null ? "Budget: loading…" : `${usd(m.spentUsd)} spent of the ${usd(m.budgetUsd)} budget${m.own ? "" : " (the extension's setting)"}, ${usd(m.remainingUsd)} left. Estimates from Google's prices; the bill is Google's.`), h("div", { class: "track", "aria-hidden": "true" }, h("div", { class: "fill", style: `width:${Math.round(share * 100)}%` })));
}
var urls = new Map;
var loading = new Map;
async function mediaUrl(project, kind, id, key) {
  const cacheKey = `${project}:${kind}:${id}:${key}`;
  const known = urls.get(cacheKey);
  if (known !== undefined)
    return known;
  let pending = loading.get(cacheKey);
  if (pending === undefined) {
    pending = fetchMedia(project, kind, id).then((media) => {
      const url = blobUrl(media.base64, media.mime);
      urls.set(cacheKey, url);
      return url;
    });
    loading.set(cacheKey, pending);
    pending.finally(() => loading.delete(cacheKey)).catch(() => {
      return;
    });
  }
  return await pending;
}
function picture(project, kind, id, key, alt) {
  const img = h("img", { alt, class: "pic", loading: "lazy" });
  const wrap = h("div", { class: "pic-wrap", "data-kind": kind }, img);
  mediaUrl(project, kind, id, key).then((url) => {
    img.src = url;
  }, (caught) => {
    wrap.classList.add("failed");
    wrap.title = errorText(caught);
  });
  return wrap;
}
function clip(project, kind, id, label) {
  const note = h("span", { class: "player-note", role: "status" });
  const video = h("video", { controls: true, preload: "none", class: "clip", "aria-label": label });
  const button = h("button", { type: "button", class: "btn small" }, "Load clip");
  button.addEventListener("click", async () => {
    button.disabled = true;
    note.textContent = "Loading…";
    try {
      video.src = await mediaUrl(project, kind, id, id);
      note.textContent = "";
      button.textContent = "Reload";
    } catch (caught) {
      note.textContent = errorText(caught);
    }
    button.disabled = false;
  });
  return h("div", { class: "clip-box", "data-kind": kind }, video, h("div", { class: "clip-bar" }, button, note));
}
async function reattach(kinds, after, done) {
  const project = app.project;
  if (project === null || busy() || localBusy())
    return;
  try {
    const answer = await call(`jobs?project=${encodeURIComponent(project.id)}`);
    const job = answer.jobs.find((each) => kinds.includes(each.work));
    if (job === undefined)
      return;
    if (job.work === "draft" || job.work === "preview" || job.work === "render")
      followLocal(job.work, job, done);
    else if (!LOCAL_WORK.includes(job.work))
      follow(job, after);
  } catch {}
}
function setLabel(button, text) {
  button.lastChild?.replaceWith(document.createTextNode(text));
}
var plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
var keyHint = "No Gemini key. Add it in Settings → Extensions → Music Studio.";

// panel/src/timeline.ts
var pct = (value, total) => `${Math.round(value / Math.max(total, 0.001) * 1e4) / 100}%`;
var TRANSITION_WORDS = { cut: "cut", flash: "flash", crossfade: "crossfade" };
function ruler(view) {
  const first = view.slots[0];
  const bars = first === undefined ? 0 : Math.max(1, Math.round(view.totalSec / (view.beatSec * 4)));
  const every = Math.max(1, Math.ceil(bars / 16));
  const ticks = [];
  for (let bar = 1;bar <= bars; bar += every) {
    ticks.push(h("span", { class: "tick", style: `left:${pct((bar - 1) * view.beatSec * 4, view.totalSec)}` }, String(bar)));
  }
  return h("div", { class: "ruler", "aria-label": "Bars" }, ...ticks);
}
function block(project, slot, view) {
  const marks = [
    slot.number > 1 && slot.transition !== "cut" ? TRANSITION_WORDS[slot.transition] : null,
    slot.speed === "ramp" ? "ramp 50%" : null
  ].filter((each) => each !== null);
  return h("div", {
    class: `block${slot.hasClip ? "" : " gap"}${slot.transition !== "cut" && slot.number > 1 ? ` t-${slot.transition}` : ""}`,
    style: `left:${pct(slot.startSec, view.totalSec)};width:${pct(slot.endSec - slot.startSec, view.totalSec)}`,
    "data-shot": slot.shot,
    title: `Shot ${slot.number}, ${slot.section}: bar ${slot.startBar}, ${slot.bars} bars${slot.hasClip ? "" : ", no clip: renders black"}`
  }, slot.frame === null || !slot.hasClip ? null : picture(project, "frame", slot.shot, slot.frame, ""), h("span", { class: "block-label" }, `${slot.number}`), slot.hasClip ? null : h("span", { class: "block-gap" }, "no clip"), marks.length === 0 ? null : h("span", { class: "block-mark" }, marks.join(", ")));
}
function captionsLane(view) {
  const c = view.captions;
  const text = !c.on ? "Captions off" : c.words === 0 ? "No captions: this song has no sung words" : `Karaoke captions from the word timestamps (${c.words} words)${c.burnable ? "" : ", but this ffmpeg cannot burn them in"}`;
  return h("div", { class: `lane-band captions${c.on && c.words > 0 ? " on" : ""}` }, text);
}
function audioLane(view) {
  return h("div", { class: `lane-band audio${view.audio === null ? "" : " on"}` }, view.audio === null ? "No soundtrack" : `Soundtrack: ${view.audio.label}. Clip sound is muted.`);
}
function drawTimeline(into, project, view) {
  if (view === null || view.slots.length === 0) {
    fill(into, h("p", { class: "empty", "data-state": "no-timeline" }, "No timeline yet: draft the shot list on the Storyboard stage."));
    return;
  }
  const width = Math.max(100, Math.round(view.totalSec * 9));
  fill(into, h("div", { class: "timeline-scroll" }, h("div", { class: "timeline", style: `min-width:${width}px` }, h("div", { class: "lane-name" }, "Bars"), ruler(view), h("div", { class: "lane-name" }, "Video"), h("div", { class: "lane video" }, ...view.slots.map((slot) => block(project, slot, view))), h("div", { class: "lane-name" }, "Captions"), captionsLane(view), h("div", { class: "lane-name" }, "Audio"), audioLane(view))));
}

// panel/src/edit.ts
var view3 = null;
var loadError3 = null;
var loadedFor3 = null;
var dirty2 = false;
var message = null;
var previewShown = 0;
var heading3 = h("h2", null);
var banner2 = h("div", { class: "notice warn", role: "alert", "data-state": "no-ffmpeg" });
var why3 = h("p", { class: "why", role: "status", "data-part": "why" });
var timelineBox = h("div", { class: "timeline-box", "data-part": "timeline" });
var shotsBox = h("div", { class: "edit-rows", "data-part": "shots" });
var warnBox = h("ul", { class: "warnings", "data-part": "warnings", role: "status" });
var slot2 = h("div", { class: "slot", "data-part": "run-status" });
var rendersBox = h("div", { class: "renders", "data-part": "renders" });
var previewBox = h("div", { class: "preview-box", "data-part": "preview" });
var actionWhy = h("p", { class: "why", role: "status", "data-part": "action-why" });
var captionsBox = h("input", {
  type: "checkbox",
  name: "captions",
  "aria-label": "Karaoke captions"
});
var captionsNote = h("span", { class: "meta" });
var prepareButton = h("button", { type: "button", class: "btn", id: "open-storyboard", onclick: () => go("storyboard") }, "Open Storyboard");
var previewButton = h("button", {
  type: "button",
  class: "btn primary big",
  id: "edit-preview",
  onclick: () => void render2("preview")
}, icon("play"), "Preview 540p");
var finalButton = h("button", { type: "button", class: "btn big", id: "edit-render", onclick: () => void render2("render") }, icon("check"), "Render 1080p");
var cancelButton2 = h("button", { type: "button", class: "btn", id: "edit-cancel", onclick: () => void cancelLocal() }, "Cancel");
async function load3() {
  const project = app.project;
  if (project === null)
    return;
  loadedFor3 = project.id;
  try {
    view3 = await call(`edit?project=${encodeURIComponent(project.id)}`);
    loadError3 = null;
  } catch (caught) {
    view3 = null;
    loadError3 = errorText(caught);
  }
  dirty2 = true;
  redraw("stage");
}
async function save(body) {
  const project = app.project;
  if (project === null)
    return;
  message = null;
  try {
    view3 = await call("edit-save", { project: project.id, ...body });
    dirty2 = true;
  } catch (caught) {
    message = errorText(caught);
  }
  redraw("stage");
}
function done(job) {
  try {
    const out = JSON.parse(job.result ?? "");
    const extra = out.warnings.length === 0 ? "" : ` ${out.warnings.join(" ")}`;
    const name = out.kind === "preview" ? "540p preview" : "1080p video";
    return `Rendered the ${name}, ${clockText(out.seconds)} long.${extra}`;
  } catch {
    return "Rendered.";
  }
}
async function render2(kind) {
  const project = app.project;
  if (project === null)
    return;
  message = null;
  await startLocal(kind, kind === "preview" ? "edit-preview" : "edit-render", { project: project.id }, async (job) => {
    await load3();
    return done(job);
  });
}
function choice(value, options, label, onChange, disabled) {
  const select = h("select", { "aria-label": label, disabled }, ...options.map((each) => h("option", { value: each.value }, each.label)));
  select.value = value;
  select.addEventListener("change", () => onChange(select.value));
  return select;
}
function shotRow(slotView, locked) {
  const first = slotView.number === 1;
  return h("div", { class: `edit-row${slotView.hasClip ? "" : " gap"}`, "data-shot": slotView.shot }, h("span", { class: "card-title" }, `${slotView.number}. ${slotView.section}`), h("span", { class: "meta" }, `bar ${slotView.startBar}, ${slotView.bars} bars`), choice(slotView.transition, [
    { value: "cut", label: "Cut" },
    { value: "flash", label: "Flash on the beat" },
    { value: "crossfade", label: "Crossfade, 1 beat" }
  ], `Shot ${slotView.number} transition in`, (next) => void save({ shots: { [slotView.shot]: { transition: next } } }), locked || first), choice(slotView.speed, [
    { value: "normal", label: "Speed 100%" },
    { value: "ramp", label: "Ramp to 50% at the end" }
  ], `Shot ${slotView.number} speed`, (next) => void save({ shots: { [slotView.shot]: { speed: next } } }), locked), h("span", { class: `meta${slotView.hasClip ? "" : " error-text"}` }, slotView.hasClip ? "Clip ready" : "No clip: renders black"));
}
function renderLine(label, r, folder) {
  if (r === null)
    return h("p", { class: "meta", "data-render": label }, `${label}: not rendered yet.`);
  const where = `${folder}/video/renders/${r.kind}-${r.n}.mp4`;
  return h("p", { class: "meta", "data-render": label }, `${label}: ${clockText(r.seconds)}, ${r.captions ? "with captions" : "no captions"}${r.gaps > 0 ? `, ${r.gaps} black shot${r.gaps === 1 ? "" : "s"}` : ""}${r.stale ? ". The edit has changed since this was rendered" : ""}. ${where}`);
}
function draw() {
  const project = app.project;
  if (project === null)
    return;
  drawTimeline(timelineBox, project.id, view3);
  const locked = busy() || localBusy();
  fill(shotsBox, ...(view3?.slots ?? []).map((each) => shotRow(each, locked)));
  fill(warnBox, ...(view3?.warnings ?? []).map((each) => h("li", null, icon("alert", 13), each)));
  const r = view3?.renders;
  fill(rendersBox, renderLine("540p preview", r?.preview ?? null, project.folder), renderLine("1080p video", r?.final ?? null, project.folder), renderLine("Vertical cut (made on Deliver)", r?.vertical ?? null, project.folder), view3?.vertical == null ? null : h("p", { class: "meta" }, `The vertical cut takes ${view3.vertical.shots} shots, ${clockText(view3.vertical.startSec)} to ${clockText(view3.vertical.endSec)}, 9:16 from the centre of the frame.`));
  const latest = r?.preview ?? null;
  fill(previewBox, latest === null ? h("p", { class: "empty", "data-state": "no-preview" }, "No preview yet. Preview 540p renders the cuts, captions and sound on this computer.") : clip(project.id, "preview", String(latest.n), "Preview of the edit"));
  previewShown = latest?.n ?? 0;
}
function blocker3() {
  if (view3 === null)
    return loadError3 ?? "Loading…";
  if (!view3.ffmpeg.ok)
    return view3.ffmpeg.message;
  if (view3.tempo === null)
    return "There is no tempo yet. Analyse the track on the Prepare stage first.";
  if (view3.slots.length === 0)
    return "There are no shots yet. Draft the shot list on the Storyboard stage.";
  if (view3.slots.every((each) => !each.hasClip))
    return "Nothing is shot yet. Shoot at least one shot on the Shoot stage.";
  return busy() || localBusy() ? "A run is in progress." : null;
}
function captionControls() {
  const c = view3?.captions;
  captionsBox.checked = c?.on ?? false;
  captionsBox.disabled = view3 === null || (c?.words ?? 0) === 0 || busy() || localBusy();
  if (c === undefined)
    captionsNote.textContent = "";
  else if (c.reason !== null)
    captionsNote.textContent = c.reason;
  else
    captionsNote.textContent = c.burnable ? `${c.words} words` : `${c.words} words, but this ffmpeg has no ass filter`;
}
function buttons2() {
  const reason = blocker3();
  previewButton.disabled = reason !== null;
  finalButton.disabled = reason !== null;
  const running = local.job?.status === "running" && (local.job.work === "preview" || local.job.work === "render");
  cancelButton2.disabled = !running || local.cancelling;
  cancelButton2.textContent = local.cancelling ? "Cancelling…" : "Cancel";
  prepareButton.disabled = view3 === null || view3.slots.length > 0;
  captionControls();
  banner2.hidden = view3 === null || view3.ffmpeg.ok;
  fill(banner2, icon("alert"), h("div", { class: "notice-body" }, h("strong", null, "Rendering needs ffmpeg. "), view3?.ffmpeg.message ?? ""));
  why3.textContent = "";
  const estimate = view3 === null ? "" : ` Rendering 1080p takes roughly ${Math.max(1, Math.round(view3.estimate.finalSec / 60))} min here (a guess) and loads the processor; you confirm first.`;
  actionWhy.textContent = message ?? (local.starting ? "Waiting for you to confirm on the card in prifly…" : reason ?? `Joins with ${view3?.join === "xfade" ? "xfade" : "fade overlays (this ffmpeg has no xfade)"}.${estimate}`);
}
function update3() {
  heading3.textContent = app.project === null ? "Edit" : `Edit — ${app.project.title}`;
  fill(slot2, localProgress(local.job?.work === "render" ? "render" : "preview"), localNotice(local.kind === "render" ? "render" : "preview"));
  if (dirty2 || previewShown !== (view3?.renders.preview?.n ?? 0)) {
    dirty2 = false;
    draw();
  }
  buttons2();
}
function mountEdit() {
  captionsBox.addEventListener("change", () => void save({ captions: captionsBox.checked }));
  const root = h("div", { class: "stage edit", "data-stage": "edit" }, h("section", { class: "main wide" }, heading3, banner2, why3, timelineBox, h("div", { class: "edit-options" }, h("label", { class: "seg" }, captionsBox, "Karaoke captions"), captionsNote), warnBox, h("div", { class: "actions" }, previewButton, finalButton, cancelButton2, prepareButton), actionWhy, slot2, previewBox, rendersBox, h("h3", null, "Shots"), shotsBox));
  return {
    root,
    update: update3,
    sync: () => {
      if (loadedFor3 !== app.project?.id)
        view3 = null;
      load3();
      reattach(["preview", "render"], load3, async (job) => {
        await load3();
        return done(job);
      });
      dirty2 = true;
      update3();
    }
  };
}

// panel/src/follow.ts
var POLL_MS3 = 2000;
var NO_PROJECT_TEXT = "This session has no Music Studio project yet. Ask Claude to start one.";
var UNKNOWN_TEXT = "Prifly does not know this session, so there is no project to follow.";
var DELETED_TEXT = "The project this session was working on has been deleted.";
function noteFor(view, error) {
  if (error !== null)
    return `Could not ask which project the session works on: ${error}`;
  if (view?.state === "none")
    return NO_PROJECT_TEXT;
  if (view?.state === "unknown")
    return UNKNOWN_TEXT;
  if (view?.state === "deleted")
    return DELETED_TEXT;
  return "";
}
var busy2 = false;
var timer;
async function openProject(id, stage) {
  const project = await call(`project?id=${encodeURIComponent(id)}`);
  app.project = project;
  if (project.brief !== null)
    app.draft = { ...project.brief };
  app.job = null;
  app.notice = null;
  app.refusal = null;
  go(stage !== null && gate(stage).enabled ? stage : "idea");
}
async function apply(view) {
  const follow = app.follow;
  const called = view.stamp > 0 && view.stamp !== follow.stamp;
  const changed = view.project !== null && view.project !== follow.project;
  follow.stamp = view.stamp;
  follow.project = view.project;
  if (view.project === null)
    return;
  if (changed) {
    await openProject(view.project, view.stage);
  } else if (called && view.stage !== null) {
    app.project = await call(`project?id=${encodeURIComponent(view.project)}`);
    go(gate(view.stage).enabled ? view.stage : app.view);
  }
}
async function pollFollow() {
  const follow = app.follow;
  const session = follow.session;
  if (session === null || busy2)
    return;
  busy2 = true;
  try {
    follow.view = await call(`follow?session=${encodeURIComponent(session)}`);
    follow.error = null;
    if (follow.on)
      await apply(follow.view);
  } catch (caught) {
    follow.error = errorText(caught);
  } finally {
    busy2 = false;
  }
  redraw("head");
}
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (document.visibilityState === "visible" && app.follow.on)
      pollFollow();
    schedule();
  }, POLL_MS3);
}
function startFollowing() {
  const session = panelSession();
  if (session === null)
    return;
  app.follow = { session, on: true, view: null, error: null, stamp: 0, project: null };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && app.follow.on)
      pollFollow();
  });
  pollFollow();
  schedule();
}
function toggle() {
  const follow = app.follow;
  follow.on = !follow.on;
  follow.stamp = 0;
  follow.project = null;
  redraw("head");
  if (follow.on)
    pollFollow();
}
function label() {
  const { on, view } = app.follow;
  const title = view?.session?.title;
  if (title === undefined)
    return on ? "Following this session" : "Not following this session";
  return `${on ? "Following" : "Not following"} ${title}`;
}
function renderFollow() {
  const follow = app.follow;
  if (follow.session === null)
    return null;
  const project = follow.view?.projectTitle;
  return h("div", { class: "follow", "data-part": "follow" }, h("button", {
    type: "button",
    class: `btn small follow-toggle${follow.on ? " on" : ""}`,
    "aria-pressed": String(follow.on),
    title: follow.on ? "Stop moving with the session" : "Move with the session again",
    onclick: toggle
  }, follow.on ? "Follow: on" : "Follow: off"), h("span", { class: "follow-line", ...project == null ? {} : { title: `Project: ${project}` } }, label()));
}
function renderFollowNote() {
  const follow = app.follow;
  if (follow.session === null)
    return null;
  return h("p", { class: "follow-note", "data-part": "follow-note", role: "status" }, follow.on ? noteFor(follow.view, follow.error) : "");
}

// panel/src/form.ts
var NOTES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
var KEYS = NOTES.flatMap((note) => [`${note} major`, `${note} minor`]);
var VOCAL_LABELS = {
  generated: "Generated lyrics",
  mine: "My lyrics",
  instrumental: "Instrumental"
};
function field2(label, control, hint) {
  return h("label", { class: "field" }, h("span", { class: "field-label" }, label), control, hint === undefined ? null : h("span", { class: "hint" }, hint));
}
function applyPreset(preset) {
  const draft = app.draft;
  draft.preset = preset.id;
  draft.tempo = preset.tempo;
  draft.key = preset.key;
  draft.lengthSec = preset.lengthSec;
  draft.vocals = preset.vocals;
  if (draft.text.trim() === "")
    draft.text = `${preset.label} track`;
}
function buildForm(onChange) {
  const text = h("textarea", {
    id: "brief",
    rows: 4,
    maxlength: 2000,
    placeholder: "Describe the music: mood, instruments, what it is for."
  });
  const chips = PRESETS.map((preset) => h("button", {
    type: "button",
    class: "chip",
    "data-preset": preset.id,
    onclick: () => {
      applyPreset(preset);
      sync();
      onChange();
    }
  }, preset.label));
  const tempo = h("input", { id: "tempo", type: "number", min: 40, max: 240, placeholder: "Any" });
  const key = h("select", { id: "key" }, h("option", { value: "" }, "Any"), ...KEYS.map((each) => h("option", { value: each }, each)));
  const length = h("select", { id: "length" }, ...LENGTHS.map((each) => h("option", { value: each }, formatLength(each))));
  const engine = h("select", { id: "engine" }, ...ENGINES.map((each) => h("option", { value: each }, ENGINE_LABELS[each])));
  const lyrics = h("textarea", {
    id: "lyrics",
    rows: 5,
    maxlength: 6000,
    placeholder: `[Verse]
Your lines here`
  });
  const lyricsField = field2("Lyrics", lyrics);
  const vocals = ["generated", "mine", "instrumental"].map((each) => h("label", { class: "seg" }, h("input", { type: "radio", name: "vocals", value: each }), h("span", null, VOCAL_LABELS[each])));
  const sync = () => {
    const draft = app.draft;
    text.value = draft.text;
    tempo.value = draft.tempo === null ? "" : String(draft.tempo);
    key.value = draft.key;
    length.value = String(draft.lengthSec);
    engine.value = draft.engine;
    lyrics.value = draft.lyrics;
    lyricsField.hidden = draft.vocals !== "mine";
    for (const radio of vocals) {
      const input = radio.querySelector("input");
      if (input !== null)
        input.checked = input.value === draft.vocals;
    }
    for (const chip of chips)
      chip.classList.toggle("on", chip.getAttribute("data-preset") === draft.preset);
  };
  const read = () => {
    const draft = app.draft;
    draft.text = text.value;
    draft.tempo = tempo.value === "" ? null : Number(tempo.value);
    draft.key = key.value;
    draft.lengthSec = Number(length.value);
    draft.engine = ENGINES.find((each) => each === engine.value) ?? "elevenlabs";
    draft.lyrics = lyrics.value;
    const picked = vocals.map((each) => each.querySelector("input")).find((input) => input?.checked === true);
    draft.vocals = ["generated", "mine", "instrumental"].find((each) => each === picked?.value) ?? "generated";
    lyricsField.hidden = draft.vocals !== "mine";
    onChange();
  };
  for (const control of [text, tempo, key, length, engine, lyrics, ...vocals]) {
    control.addEventListener("input", read);
    control.addEventListener("change", read);
  }
  const root = h("div", { class: "form" }, field2("Brief", text), h("div", { class: "field" }, h("span", { class: "field-label" }, "Presets"), h("div", { class: "chips" }, ...chips)), h("div", { class: "row" }, field2("Tempo (BPM)", tempo), field2("Key", key), field2("Length", length, "Of the finished song")), h("div", { class: "field" }, h("span", { class: "field-label" }, "Vocals"), h("div", { class: "segs" }, ...vocals)), lyricsField, field2("Engine", engine));
  sync();
  return { root, sync };
}

// panel/src/sketches.ts
async function choose(project, sketch) {
  try {
    app.project = await call("choose", { project, sketch });
  } catch (caught) {
    app.notice = { tone: "error", text: errorText(caught) };
  }
  redraw("head");
  redraw("idea");
}
var cardTitle = (letter, title) => title === null ? `Sketch ${letter}` : `Sketch ${letter} · ${title}`;
function slot3(id, index) {
  const letter = id.toUpperCase();
  const project = app.project;
  const made = project?.sketchList.find((each) => each.id === id);
  if (project === null || made === undefined) {
    const job = app.job;
    const running = job?.status === "running" || app.confirming;
    const now = job?.status === "running" && job.done.length === index;
    const text = now ? `Making sketch ${letter}…` : running ? `Sketch ${letter} is next` : `Sketch ${letter} was not made`;
    return h("li", { class: `card ghost${now ? " busy" : ""}`, "data-sketch": id }, h("div", { class: "card-title" }, text), now && h("div", { class: "bar-busy" }));
  }
  const chosen = project.chosen === id;
  return h("li", { class: `card${chosen ? " chosen" : ""}`, "data-sketch": id }, h("div", { class: "card-head" }, h("div", { class: "card-title" }, cardTitle(letter, made.title)), chosen ? h("span", { class: "badge" }, icon("check", 14), "Chosen") : h("button", { type: "button", class: "btn small", onclick: () => void choose(project.id, id) }, "Mark as chosen")), player(project.id, id), h("div", { class: "meta" }, ENGINE_LABELS[made.engine], " · 0:30"), made.lyrics === null ? null : h("details", { class: "lyrics" }, h("summary", null, "Lyrics"), h("pre", null, made.lyrics)));
}
function progress2(cancel, cancelling) {
  if (app.confirming) {
    return h("div", { class: "progress", role: "status" }, h("span", null, "Waiting for you to confirm the cost in prifly…"));
  }
  const job = app.job;
  if (job === null || job.status !== "running")
    return null;
  const step = Math.min(job.done.length + 1, job.total);
  return h("div", { class: "progress", role: "status" }, h("span", null, `Making sketch ${step} of ${job.total} with ${job.engine === null ? "the engine" : ENGINE_LABELS[job.engine]}. A sketch takes about half a minute.`), h("div", { class: "track" }, h("div", {
    class: "fill",
    style: `width:${Math.round(job.done.length / job.total * 100)}%`
  })), h("button", { type: "button", class: "btn small", disabled: cancelling, onclick: cancel }, cancelling ? "Cancelling…" : "Cancel"));
}
function renderSketches(cancel, cancelling) {
  const project = app.project;
  const heading = project === null ? "Sketches" : `Sketches — ${project.title}`;
  const empty = project === null && app.job === null && !app.confirming;
  return h("section", { class: "side", "data-part": "sketches" }, h("h2", null, heading), progress2(cancel, cancelling), empty ? h("p", { class: "empty" }, "Nothing sketched yet. Write a brief, pick a preset if you like, and press Sketch 3 ideas.") : h("ul", { class: "cards" }, ...SKETCH_IDS.map((id, index) => slot3(id, index))), project === null ? null : h("p", { class: "meta folder" }, `Saved in ${project.folder}`));
}

// panel/src/idea.ts
var POLL_MS4 = 1500;
var timer2 = null;
var cancelling = false;
function blocker4() {
  const status = app.status;
  if (status === null)
    return app.statusError === null ? "Loading your keys…" : "Cannot reach the extension.";
  if (app.confirming || app.job?.status === "running")
    return "A run is in progress.";
  if (app.draft.text.trim() === "")
    return "Write a brief first.";
  if (app.draft.vocals === "mine" && app.draft.lyrics.trim() === "")
    return "Paste your lyrics, or pick another vocals option.";
  if (app.draft.engine === "elevenlabs") {
    if (!status.elevenlabs.keySet)
      return "No ElevenLabs key. Add it in Settings → Extensions → Music Studio.";
  } else if (!status.gemini.keySet) {
    return "No Gemini key. Add it in Settings → Extensions → Music Studio.";
  }
  return null;
}
async function showProject(id) {
  app.project = await call(`project?id=${encodeURIComponent(id)}`);
}
function ended3(job) {
  if (job.status === "failed") {
    if (job.kind === "bad_prompt")
      app.refusal = {
        message: job.error ?? "ElevenLabs refused the prompt.",
        suggestion: job.suggestion
      };
    else
      app.notice = { tone: "error", text: job.error ?? "The run failed." };
  } else if (job.status === "cancelled") {
    app.notice = {
      tone: "info",
      text: `Cancelled after ${job.done.length} of ${job.total} sketches. Anything made is kept.`
    };
  }
  loadStatus();
}
async function poll3() {
  const current = app.job;
  if (current === null)
    return;
  try {
    const job = await call(`job?id=${encodeURIComponent(current.id)}`);
    app.job = job;
    if (job.project !== null)
      await showProject(job.project);
    else
      app.project = null;
    if (job.status === "running")
      timer2 = setTimeout(() => void poll3(), POLL_MS4);
    else {
      cancelling = false;
      ended3(job);
    }
  } catch (caught) {
    app.notice = { tone: "error", text: errorText(caught) };
    app.job = null;
  }
  redraw("idea");
}
function startPolling() {
  if (timer2 !== null)
    clearTimeout(timer2);
  poll3();
}
async function sketch() {
  app.notice = null;
  app.refusal = null;
  app.project = null;
  app.job = null;
  app.confirming = true;
  redraw("idea");
  try {
    const answer = await call("sketch", app.draft);
    app.confirming = false;
    if (answer.ok) {
      app.job = answer.job;
      startPolling();
      return;
    }
    const tone = answer.reason === "cancelled" ? "info" : "warn";
    app.notice = {
      tone,
      text: answer.reason === "cancelled" ? "Cancelled. Nothing was made and nothing was spent." : answer.message
    };
  } catch (caught) {
    app.confirming = false;
    app.notice = { tone: "error", text: errorText(caught) };
  }
  redraw("idea");
}
async function cancel2() {
  if (app.job === null)
    return;
  cancelling = true;
  redraw("idea");
  try {
    await call("cancel", { job: app.job.id });
  } catch (caught) {
    app.notice = { tone: "error", text: errorText(caught) };
  }
}
function notices() {
  const out = [];
  if (app.refusal !== null) {
    const { message, suggestion } = app.refusal;
    out.push(h("div", { class: "notice warn", role: "alert", "data-state": "refused" }, icon("alert"), h("div", { class: "notice-body" }, h("strong", null, "ElevenLabs refused this brief."), h("p", null, message), suggestion === null ? h("p", null, "It named no alternative. Try describing the sound instead of an artist, a band or a song.") : h("div", { class: "suggestion" }, h("p", null, "Suggested instead:"), h("blockquote", null, suggestion), h("button", {
      type: "button",
      class: "btn small",
      onclick: () => {
        app.draft.text = suggestion;
        app.draft.preset = null;
        app.refusal = null;
        redraw("all");
      }
    }, "Use suggestion")))));
  }
  if (app.notice !== null) {
    out.push(h("div", { class: `notice ${app.notice.tone}`, role: "status" }, icon(app.notice.tone === "info" ? "info" : "alert"), h("div", { class: "notice-body" }, app.notice.text)));
  }
  return out;
}
function mountIdea() {
  const side = h("div", { class: "side-wrap" });
  const messages = h("div", { class: "notices" });
  const button = h("button", { type: "button", class: "btn primary big", id: "sketch", onclick: () => void sketch() }, icon("spark"), "Sketch 3 ideas");
  const why = h("p", { class: "why", role: "status" });
  const cost = h("p", { class: "cost" });
  const form = buildForm(() => update());
  function update() {
    const reason = blocker4();
    button.disabled = reason !== null;
    why.textContent = reason ?? "";
    cost.textContent = app.draft.engine === "elevenlabs" ? "Billed by ElevenLabs to your plan. You confirm first." : "Billed to your Gemini key. You confirm first.";
    fill(messages, ...notices());
    fill(side, renderSketches(() => void cancel2(), cancelling));
  }
  const root = h("div", { class: "idea", "data-stage": "idea" }, h("section", { class: "main" }, h("h2", null, "Idea"), messages, form.root, h("div", { class: "actions" }, button, cost), why), side);
  update();
  return {
    root,
    update,
    sync: () => {
      form.sync();
      update();
    }
  };
}

// panel/src/crates.ts
var renaming = null;
var deleting = null;
var problem = null;
async function change(path, body) {
  try {
    app.library.crates = (await call(path, body)).crates;
    problem = null;
    if (!app.library.crates.some((each) => each.id === app.library.crate))
      app.library.crate = "";
    renaming = null;
    deleting = null;
    await loadLibrary();
    return true;
  } catch (caught) {
    problem = errorText(caught);
    redraw("library");
    return false;
  }
}
function pick2(id) {
  app.library.crate = id;
  loadLibrary();
}
var newName = h("input", {
  type: "text",
  id: "new-crate",
  placeholder: "New crate",
  "aria-label": "New crate name"
});
var create = h("button", { type: "button", class: "btn small", id: "crate-create", onclick: () => void make() }, "Create");
var note = h("p", { class: "crate-note", role: "alert" });
var list = h("ul", { class: "crate-list", "data-part": "crates" });
async function make() {
  if (await change("crate-create", { name: newName.value }))
    newName.value = "";
}
function crateRow(crate) {
  const on = app.library.crate === crate.id;
  if (renaming === crate.id) {
    const input = h("input", {
      type: "text",
      class: "rename",
      value: crate.name,
      "aria-label": `Rename ${crate.name}`
    });
    return h("li", { class: "crate on", "data-crate": crate.id }, input, h("button", {
      type: "button",
      class: "btn small",
      onclick: () => void change("crate-rename", { crate: crate.id, name: input.value })
    }, "Save"), h("button", {
      type: "button",
      class: "btn small",
      onclick: () => {
        renaming = null;
        redraw("library");
      }
    }, "Cancel"));
  }
  return h("li", { class: `crate${on ? " on" : ""}`, "data-crate": crate.id }, h("button", {
    type: "button",
    class: "crate-pick",
    "aria-pressed": String(on),
    onclick: () => pick2(crate.id)
  }, h("span", { class: "crate-name" }, crate.name), h("span", { class: "meta" }, String(crate.count))), deleting === crate.id ? h("button", {
    type: "button",
    class: "btn small danger",
    onclick: () => void change("crate-delete", { crate: crate.id })
  }, "Delete crate") : h("button", {
    type: "button",
    class: "btn small",
    "aria-label": `Rename ${crate.name}`,
    onclick: () => {
      renaming = crate.id;
      deleting = null;
      redraw("library");
    }
  }, "Rename"), h("button", {
    type: "button",
    class: "btn small",
    "aria-label": `${deleting === crate.id ? "Keep" : "Delete"} ${crate.name}`,
    onclick: () => {
      deleting = deleting === crate.id ? null : crate.id;
      redraw("library");
    }
  }, deleting === crate.id ? "Keep" : "Delete"));
}
function update4() {
  const all = app.library.crate === "";
  note.textContent = problem ?? "";
  fill(list, h("li", { class: `crate${all ? " on" : ""}`, "data-crate": "" }, h("button", {
    type: "button",
    class: "crate-pick",
    "aria-pressed": String(all),
    onclick: () => pick2("")
  }, h("span", { class: "crate-name" }, "All projects"), h("span", { class: "meta" }, String(app.library.projects?.length ?? "")))), ...app.library.crates.map(crateRow));
}
function mountCrates() {
  newName.addEventListener("keydown", (event) => {
    if (event.key === "Enter")
      make();
  });
  const root = h("aside", { class: "side crates", "data-part": "crate-sidebar" }, h("h2", null, "Crates"), list, h("div", { class: "crate-new" }, newName, create), note);
  update4();
  return { root, update: update4 };
}

// panel/src/library.ts
async function loadLibrary() {
  try {
    const answer = await call(`library?q=${encodeURIComponent(app.library.query)}&crate=${encodeURIComponent(app.library.crate)}`);
    app.library.projects = answer.projects;
    app.library.crates = (await call("crates")).crates;
    app.library.error = null;
  } catch (caught) {
    app.library.error = errorText(caught);
  }
  redraw("library");
}
async function open(id) {
  try {
    const project = await call(`project?id=${encodeURIComponent(id)}`);
    app.project = project;
    if (project.brief !== null)
      app.draft = { ...project.brief };
    app.job = null;
    app.notice = null;
    app.refusal = null;
    go("idea");
  } catch (caught) {
    app.library.error = errorText(caught);
    redraw("library");
  }
}
var day = (iso) => iso.slice(0, 10);
async function crateChange(path, crate, project) {
  try {
    await call(path, { crate, project });
    app.library.error = null;
  } catch (caught) {
    app.library.error = errorText(caught);
  }
  await loadLibrary();
}
function crateCell(item) {
  const open = app.library.crates.filter((each) => !item.crates.includes(each.id));
  const add = h("select", {
    class: "crate-add",
    "aria-label": `Add ${item.title} to a crate`,
    disabled: open.length === 0
  }, h("option", { value: "" }, "Add to crate"), ...open.map((each) => h("option", { value: each.id }, each.name)));
  add.addEventListener("change", () => {
    if (add.value !== "")
      crateChange("crate-add", add.value, item.id);
  });
  const shown = app.library.crate !== "";
  return h("td", { class: "crate-cell" }, add, h("button", {
    type: "button",
    class: "btn small",
    disabled: !shown,
    title: shown ? "Take it out of this crate" : "Pick a crate to take tracks out of it",
    onclick: () => void crateChange("crate-remove", app.library.crate, item.id)
  }, "Remove"));
}
var bpmText = (item) => item.prep?.bpm == null ? "—" : String(item.prep.bpm);
var lufsText = (item) => item.prep?.lufs == null ? "—" : item.prep.lufs.toFixed(1);
function table(projects) {
  return h("table", { class: "projects" }, h("thead", null, h("tr", null, ...[
    "Title",
    "Engine",
    "Length",
    "Created",
    "BPM",
    "Key",
    "LUFS",
    "Sketches",
    "",
    "Crates"
  ].map((each) => h("th", null, each)))), h("tbody", null, ...projects.map((each) => h("tr", { "data-project": each.id }, h("td", { class: "title" }, each.title), h("td", null, ENGINE_LABELS[each.engine]), h("td", null, formatLength(each.lengthSec)), h("td", null, day(each.created)), h("td", { class: "num" }, bpmText(each)), h("td", { class: "num" }, each.prep?.camelot ?? "—"), h("td", { class: "num" }, lufsText(each)), h("td", null, `${each.sketches}${each.chosen === null ? "" : `, ${each.chosen.toUpperCase()} chosen`}`), h("td", null, h("button", { type: "button", class: "btn small", onclick: () => void open(each.id) }, "Open")), crateCell(each)))));
}
function mountLibrary() {
  const body = h("div", { class: "library-body" });
  let wait = null;
  const search = h("input", {
    type: "search",
    class: "search",
    placeholder: "Search, or try key 8A, bpm 120-128",
    "aria-label": "Search the library"
  });
  search.addEventListener("input", () => {
    app.library.query = search.value;
    if (wait !== null)
      clearTimeout(wait);
    wait = setTimeout(() => void loadLibrary(), 250);
  });
  function update() {
    const { projects, error, query } = app.library;
    if (error !== null)
      fill(body, h("div", { class: "notice error", role: "alert" }, icon("alert"), h("div", { class: "notice-body" }, error)));
    else if (projects === null)
      fill(body, h("p", { class: "empty", role: "status" }, "Loading the library…"));
    else if (projects.length === 0 && query.trim() === "" && app.library.crate === "") {
      fill(body, h("div", { class: "empty-state", "data-state": "empty" }, icon("wave", 28), h("p", null, "The library is empty."), h("p", { class: "meta" }, "Sketch an idea and it is saved here."), h("button", { type: "button", class: "btn primary", onclick: () => go("idea") }, "Go to Idea")));
    } else if (projects.length === 0)
      fill(body, h("p", { class: "empty" }, `No project matches "${query}".`));
    else
      fill(body, table(projects));
  }
  const crates = mountCrates();
  const root = h("div", { class: "library with-crates", "data-stage": "library" }, crates.root, h("section", { class: "main wide" }, h("div", { class: "lib-head" }, h("h2", null, "Library"), h("div", { class: "search-wrap" }, icon("search", 15), search)), body));
  update();
  return {
    root,
    update: () => {
      update();
      crates.update();
    }
  };
}

// panel/src/deck.ts
class Deck {
  audio = new Audio;
  project;
  kind;
  id;
  loading = null;
  error = null;
  constructor(project, kind, id) {
    this.project = project;
    this.kind = kind;
    this.id = id;
  }
  load() {
    this.loading ??= (async () => {
      try {
        const media = await fetchMedia(this.project, this.kind, this.id);
        this.audio.src = blobUrl(media.base64, media.mime);
        this.error = null;
      } catch (caught) {
        this.error = errorText(caught);
        this.loading = null;
        throw caught;
      }
    })();
    return this.loading;
  }
  get playing() {
    return !this.audio.paused;
  }
  async play() {
    await this.load();
    claimPlayback(this.audio);
    await this.audio.play();
  }
  pause() {
    this.audio.pause();
  }
  seek(sec) {
    if (Number.isFinite(sec))
      this.audio.currentTime = Math.max(0, sec);
  }
  dispose() {
    this.audio.pause();
    if (this.audio.src.startsWith("blob:"))
      URL.revokeObjectURL(this.audio.src);
    this.audio.removeAttribute("src");
  }
}
var clock3 = (seconds) => {
  const whole = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  return `${Math.floor(whole / 60)}:${(whole % 60).toFixed(1).padStart(4, "0")}`;
};

// panel/src/master.ts
var view4 = null;
var loadError4 = null;
var loadedFor4 = null;
var target = "streaming";
var format = "wav";
var dirty3 = false;
var db = (value, unit) => value === null || value === undefined ? "—" : `${value.toFixed(1)} ${unit}`;
async function load4() {
  const project = app.project;
  if (project === null)
    return;
  loadedFor4 = project.id;
  try {
    view4 = await call(`master?project=${encodeURIComponent(project.id)}`);
    loadError4 = null;
  } catch (caught) {
    view4 = null;
    loadError4 = errorText(caught);
  }
  dirty3 = true;
  redraw("stage");
}
var ab = {
  source: null,
  master: null,
  side: "a",
  compare: null,
  match: true
};
var current = () => ab.side === "a" ? ab.source : ab.master;
var masterOf = (n) => view4?.masters.find((each) => each.n === n);
function resetDecks() {
  ab.source?.dispose();
  ab.master?.dispose();
  ab.source = null;
  ab.master = null;
  const project = app.project;
  const compared = masterOf(ab.compare);
  if (project === null || view4 === null || view4.source === null || compared === undefined)
    return;
  ab.source = new Deck(project.id, view4.source.kind, view4.source.id);
  ab.master = new Deck(project.id, "master", String(compared.n));
  for (const deck of [ab.source, ab.master]) {
    deck.audio.addEventListener("timeupdate", abTime);
    deck.audio.addEventListener("pause", abButtons);
    deck.audio.addEventListener("play", abButtons);
  }
  applyMatch();
}
function applyMatch() {
  const compared = masterOf(ab.compare);
  const source = view4?.loudness?.integrated;
  const mastered = compared?.output?.integrated;
  const lowest = source === undefined || mastered === undefined ? null : Math.min(source, mastered);
  const volume = (own) => !ab.match || lowest === null || own === undefined ? 1 : Math.min(1, 10 ** ((lowest - own) / 20));
  if (ab.source !== null)
    ab.source.audio.volume = volume(source);
  if (ab.master !== null)
    ab.master.audio.volume = volume(mastered);
}
async function switchTo(side) {
  const from = current();
  if (side === ab.side || from === null)
    return;
  const at = from.audio.currentTime;
  const wasPlaying = from.playing;
  from.pause();
  ab.side = side;
  const to = current();
  if (to === null)
    return;
  try {
    await to.load();
    to.seek(at);
    if (wasPlaying)
      await to.play();
  } catch (caught) {
    note2.textContent = errorText(caught);
  }
  abButtons();
}
async function togglePlay() {
  const deck = current();
  if (deck === null)
    return;
  try {
    if (deck.playing)
      deck.pause();
    else
      await deck.play();
    note2.textContent = "";
  } catch (caught) {
    note2.textContent = errorText(caught);
  }
  abButtons();
}
var heading4 = h("h2", null);
var slot4 = h("div", { class: "slot", "data-part": "run-status" });
var banner3 = h("div", { class: "notice warn", role: "alert", "data-state": "no-ffmpeg" });
var facts = h("div", { class: "facts", "data-part": "source-loudness" });
var lossy = h("p", { class: "why lossy-note", role: "note" });
var why4 = h("p", { class: "why", role: "status" });
var list2 = h("div", { class: "masters", "data-part": "masters" });
var note2 = h("span", { class: "player-note", role: "status" });
var seek = h("input", {
  type: "range",
  min: 0,
  max: 1000,
  value: 0,
  class: "seek",
  "aria-label": "Position"
});
var time = h("span", { class: "time" }, "0:00.0");
var sideA = h("button", { type: "button", class: "btn toggle", id: "ab-source", onclick: () => void switchTo("a") }, "A  Source");
var sideB = h("button", { type: "button", class: "btn toggle", id: "ab-master", onclick: () => void switchTo("b") }, "B  Master");
var playButton = h("button", { type: "button", class: "btn", id: "ab-play", onclick: () => void togglePlay() }, icon("play", 14), "Play");
var matchBox = h("input", { type: "checkbox", id: "ab-match", checked: true });
var masterButton = h("button", { type: "button", class: "btn primary big", id: "master", onclick: () => void run2() }, icon("wave"), "Master");
var cancelButton3 = h("button", { type: "button", class: "btn", id: "master-cancel", onclick: () => void cancelLocal() }, "Cancel");
var targets = h("div", {
  class: "segs",
  role: "radiogroup",
  "aria-label": "Target",
  "data-part": "targets"
});
var formats = h("div", {
  class: "segs",
  role: "radiogroup",
  "aria-label": "Format",
  "data-part": "formats"
});
matchBox.addEventListener("change", () => {
  ab.match = matchBox.checked;
  applyMatch();
});
seek.addEventListener("input", () => {
  const deck = current();
  if (deck !== null && deck.audio.duration > 0)
    deck.seek(Number(seek.value) / 1000 * deck.audio.duration);
});
function abTime() {
  const audio = current()?.audio;
  if (audio === undefined)
    return;
  if (audio.duration > 0)
    seek.value = String(Math.round(audio.currentTime / audio.duration * 1000));
  time.textContent = `${clock3(audio.currentTime)} / ${clock3(audio.duration || 0)}`;
}
function abButtons() {
  const ready = ab.source !== null && ab.master !== null;
  sideA.disabled = !ready;
  sideB.disabled = !ready;
  sideA.setAttribute("aria-pressed", String(ab.side === "a"));
  sideB.setAttribute("aria-pressed", String(ab.side === "b"));
  playButton.disabled = !ready;
  seek.disabled = !ready;
  matchBox.disabled = !ready;
  playButton.replaceChildren(icon(current()?.playing === true ? "pause" : "play", 14), current()?.playing === true ? "Pause" : "Play");
}
function radios(holder, name, options, picked, pick) {
  fill(holder, ...options.map((option) => {
    const input = h("input", {
      type: "radio",
      name,
      value: option.id,
      checked: picked() === option.id
    });
    input.addEventListener("change", () => {
      pick(option.id);
      buttons3();
    });
    return h("label", { class: "seg" }, input, option.label);
  }));
}
function blocker5() {
  if (view4 === null)
    return loadError4 ?? "Loading…";
  if (!view4.ffmpeg.ok)
    return view4.ffmpeg.message;
  if (view4.source === null)
    return "There is nothing to master yet. Choose a sketch on the Idea stage first.";
  if (view4.loudness === null)
    return view4.measureError ?? "Measuring the source…";
  return null;
}
function buttons3() {
  const reason = blocker5();
  const busy = localBusy() || local.starting;
  masterButton.disabled = reason !== null || busy;
  cancelButton3.disabled = !(local.job?.status === "running" && local.job.work === "master") || local.cancelling;
  cancelButton3.textContent = local.cancelling ? "Cancelling…" : "Cancel";
  why4.textContent = reason ?? (busy ? "" : "Rendered on this computer with ffmpeg. Free, no confirm.");
  const bad = view4 !== null && !view4.ffmpeg.ok;
  banner3.hidden = !bad;
  fill(banner3, icon("alert"), h("div", { class: "notice-body" }, h("strong", null, "Mastering needs ffmpeg. "), view4?.ffmpeg.message ?? ""));
  lossy.textContent = format === "wav" && view4?.source?.lossy === true ? view4.lossyNote : "";
}
function loudnessTile(label, value) {
  return h("div", { class: "fact" }, h("span", { class: "field-label" }, label), h("span", { class: "big-number" }, value));
}
function drawFacts() {
  const loudness = view4?.loudness ?? null;
  const measuring = view4 !== null && view4.source !== null && loudness === null && view4.measureError === null;
  fill(facts, h("div", { class: "fact wide" }, h("span", { class: "field-label" }, "Source"), h("span", null, view4?.source?.label ?? (view4 === null ? "…" : "none"))), loudnessTile("Integrated", measuring ? "Measuring…" : db(loudness?.integrated, "LUFS")), loudnessTile("True peak", measuring ? "…" : db(loudness?.truePeak, "dBTP")), loudnessTile("Loudness range", measuring ? "…" : db(loudness?.range, "LU")));
}
var targetLine = (item) => {
  const wanted = view4?.targets.find((each) => each.id === item.target);
  return `${wanted?.label ?? item.target} ${wanted?.lufs ?? ""} LUFS`;
};
function drawMasters() {
  const items = [...view4?.masters ?? []].reverse();
  fill(list2, h("h3", null, "Masters"), items.length === 0 ? h("p", { class: "empty", "data-state": "no-masters" }, "Nothing mastered yet. Pick a target and a format, then press Master.") : h("ul", { class: "version-list" }, ...items.map((item) => {
    const radio = h("input", {
      type: "radio",
      name: "compare",
      checked: item.n === ab.compare
    });
    radio.addEventListener("change", () => {
      ab.compare = item.n;
      ab.side = "a";
      resetDecks();
      abButtons();
    });
    return h("li", {
      class: `version${item.n === ab.compare ? " current" : ""}`,
      "data-master": String(item.n)
    }, h("label", { class: "master-row" }, radio, h("span", { class: "card-title" }, `master-${item.n}.${item.format}`), h("span", { class: "meta" }, `${targetLine(item)}, from ${item.from}`)), h("div", { class: "meta" }, item.output === null ? "Result not measured." : `Result ${db(item.output.integrated, "LUFS")}, true peak ${db(item.output.truePeak, "dBTP")}, range ${db(item.output.range, "LU")}.${item.type === "dynamic" ? " The target could not be reached by gain alone, so the dynamics were compressed a little." : ""}`));
  })));
}
async function run2() {
  const project = app.project;
  if (project === null)
    return;
  await startLocal("master", "master-render", { project: project.id, target, format }, async () => {
    await load4();
    ab.compare = view4?.masters.at(-1)?.n ?? null;
    ab.side = "a";
    dirty3 = true;
    const latest = masterOf(ab.compare);
    return latest === undefined ? "Mastered." : `Made master-${latest.n}.${latest.format}.`;
  });
}
function draw2() {
  if (view4 !== null && (ab.compare === null || masterOf(ab.compare) === undefined))
    ab.compare = view4.masters.at(-1)?.n ?? null;
  resetDecks();
  drawFacts();
  drawMasters();
  if (view4 !== null) {
    radios(targets, "target", view4.targets.map((each) => ({ id: each.id, label: `${each.label}  ${each.lufs} LUFS` })), () => target, (id) => {
      target = id;
    });
    radios(formats, "format", view4.formats, () => format, (id) => {
      format = id;
    });
  }
  abButtons();
}
function update5() {
  heading4.textContent = app.project === null ? "Master" : `Master — ${app.project.title}`;
  if (dirty3) {
    dirty3 = false;
    draw2();
  }
  drawFacts();
  buttons3();
  fill(slot4, localProgress("master"), localNotice("master"));
}
function mountMaster() {
  const root = h("div", { class: "stage master", "data-stage": "master" }, h("section", { class: "main wide" }, heading4, banner3, facts, h("div", { class: "choice-row" }, h("div", { class: "field" }, h("span", { class: "field-label" }, "Target"), targets), h("div", { class: "field" }, h("span", { class: "field-label" }, "Format"), formats)), lossy, h("div", { class: "actions" }, masterButton, cancelButton3, why4), slot4, list2, h("div", { class: "ab", "data-part": "ab" }, h("h3", null, "A/B against the source"), h("div", { class: "player" }, sideA, sideB, playButton, seek, time, h("label", { class: "check" }, matchBox, "Match loudness")), note2)));
  return {
    root,
    update: update5,
    sync: () => {
      if (loadedFor4 !== app.project?.id) {
        view4 = null;
        ab.compare = null;
      }
      const deck = current();
      deck?.pause();
      load4();
      dirty3 = true;
      update5();
    }
  };
}

// audio/mixgraph.ts
var MIN_DB = -60;
var MAX_DB = 12;
var DEFAULT_TRACK = { db: 0, pan: 0, mute: false, solo: false };
function audible(tracks) {
  const soloing = tracks.some((each) => each.solo);
  return tracks.filter((each) => !each.mute && (!soloing || each.solo));
}
var gainOf = (db) => 10 ** (db / 20);

// panel/src/preview.ts
async function decode(context, project, track) {
  const media = await fetchMedia(project, track.kind === "stem" ? "stem" : "layer", track.key.slice(track.key.indexOf(":") + 1));
  const bytes = Uint8Array.from(atob(media.base64), (char) => char.charCodeAt(0));
  return await context.decodeAudioData(bytes.buffer);
}

class Preview {
  context = null;
  voices = [];
  sources = [];
  loadedFor = "";
  playing = false;
  reset() {
    this.stop();
    this.voices = [];
    this.loadedFor = "";
  }
  async load(project, tracks, tempo) {
    const id = `${project}|${tracks.map((each) => each.key).join(",")}|${tempo}`;
    if (id === this.loadedFor && this.voices.length > 0)
      return;
    this.stop();
    this.context ??= new AudioContext;
    const context = this.context;
    const voices = [];
    for (const track of tracks) {
      const gain = context.createGain();
      const pan = context.createStereoPanner();
      gain.connect(pan).connect(context.destination);
      voices.push({
        key: track.key,
        buffer: await decode(context, project, track),
        startSec: track.startBar === null ? 0 : barStartMs(track.startBar, tempo) / 1000,
        gain,
        pan
      });
    }
    this.voices = voices;
    this.loadedFor = id;
  }
  apply(mix) {
    const items = this.voices.map((voice) => ({
      key: voice.key,
      db: mix[voice.key]?.db ?? 0,
      pan: mix[voice.key]?.pan ?? 0,
      mute: mix[voice.key]?.mute === true,
      solo: mix[voice.key]?.solo === true
    }));
    const heard = new Set(audible(items).map((each) => each.key));
    for (const [at, voice] of this.voices.entries()) {
      const item = items[at];
      voice.gain.gain.value = heard.has(voice.key) && item ? gainOf(item.db) : 0;
      voice.pan.pan.value = item?.pan ?? 0;
    }
  }
  async play(mix, onEnd) {
    const context = this.context;
    if (context === null || this.voices.length === 0)
      return;
    this.stop();
    await context.resume();
    this.apply(mix);
    const begin = context.currentTime + 0.05;
    this.sources = this.voices.map((voice) => {
      const source = context.createBufferSource();
      source.buffer = voice.buffer;
      source.connect(voice.gain);
      source.start(begin + voice.startSec);
      return source;
    });
    this.playing = true;
    const longest = Math.max(...this.voices.map((voice) => voice.startSec + voice.buffer.duration));
    const last = this.sources.find((_each, at) => {
      const voice = this.voices[at];
      return voice !== undefined && voice.startSec + voice.buffer.duration === longest;
    });
    if (last !== undefined)
      last.onended = () => {
        if (this.sources.includes(last)) {
          this.playing = false;
          onEnd();
        }
      };
  }
  stop() {
    const stopping = this.sources;
    this.sources = [];
    for (const source of stopping) {
      try {
        source.stop();
      } catch {}
    }
    this.playing = false;
  }
}

// panel/src/mix.ts
var view5 = null;
var loadError5 = null;
var loadedFor5 = null;
var dirty4 = false;
var mix = {};
var preview = new Preview;
async function load5() {
  const project = app.project;
  if (project === null)
    return;
  loadedFor5 = project.id;
  try {
    view5 = await call(`mix?project=${encodeURIComponent(project.id)}`);
    mix = Object.fromEntries(view5.tracks.map((each) => [each.key, { ...each.mix }]));
    loadError5 = null;
  } catch (caught) {
    view5 = null;
    loadError5 = errorText(caught);
  }
  dirty4 = true;
  redraw("stage");
}
var dbText = (db) => `${db > 0 ? "+" : ""}${db.toFixed(1)} dB`;
var panText = (pan) => Math.abs(pan) < 0.025 ? "C" : `${pan < 0 ? "L" : "R"}${Math.round(Math.abs(pan) * 100)}`;
var heading5 = h("h2", null);
var banner4 = h("div", { class: "notice warn", role: "alert", "data-state": "no-ffmpeg" });
var tracksBox = h("div", { class: "tracks", "data-part": "tracks" });
var rendersBox2 = h("div", { class: "renders", "data-part": "renders" });
var status = h("p", { class: "why", role: "status" });
var previewState = "idle";
var rendering = false;
var renderNote = null;
var saveTimer = null;
var play = h("button", { type: "button", class: "btn", id: "play-preview", onclick: () => void startPreview() }, icon("play", 14), "Play preview");
var stop = h("button", { type: "button", class: "btn", id: "stop-preview", onclick: () => stopPreview() }, icon("pause", 14), "Stop");
var render3 = h("button", { type: "button", class: "btn primary big", id: "render-mix", onclick: () => void renderNow() }, icon("wave"), "Render mix");
var note3 = h("div", { class: "notices", "data-part": "mix-note" });
var hasTracks = () => (view5?.tracks.length ?? 0) > 0;
function renderBlocker() {
  if (view5 === null)
    return loadError5 ?? "Loading the tracks…";
  if (!hasTracks())
    return "There are no stems yet. Split stems on the Produce stage first.";
  if (!view5.ffmpeg.ok)
    return view5.ffmpeg.message;
  if (rendering)
    return "Rendering…";
  if (audible(Object.values(mix)).length === 0)
    return "Every track is muted, or others are soloed.";
  return null;
}
function buttons4() {
  const reason = renderBlocker();
  render3.disabled = reason !== null || busy();
  play.disabled = !hasTracks() || previewState !== "idle";
  stop.disabled = previewState !== "playing";
  status.textContent = previewState === "loading" ? "Loading the tracks for the preview…" : reason ?? "";
  banner4.hidden = view5 === null || view5.ffmpeg.ok;
  const shown = view5?.ffmpeg.ok === false ? view5.ffmpeg.message : "";
  fill(banner4, icon("alert"), h("div", { class: "notice-body" }, h("strong", null, "Mix cannot be rendered. "), shown, " Playing the preview still works."));
  fill(note3, renderNote === null ? null : h("div", { class: `notice ${renderNote.tone}`, role: "status" }, icon(renderNote.tone === "info" ? "check" : "alert"), h("div", { class: "notice-body" }, renderNote.text)));
}
function changed() {
  preview.apply(mix);
  if (saveTimer !== null)
    clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save2(), 400);
  dimRows();
  buttons4();
}
async function save2() {
  const project = app.project;
  if (project === null)
    return;
  try {
    await call("mix-save", { project: project.id, mix: { tracks: mix } });
  } catch (caught) {
    renderNote = { tone: "error", text: errorText(caught) };
    buttons4();
  }
}
function dimRows() {
  const heard = new Set(audible(Object.entries(mix).map(([key, each]) => ({ key, ...each }))).map((each) => each.key));
  for (const row of tracksBox.querySelectorAll("[data-track]"))
    row.classList.toggle("silent", !heard.has(row.dataset["track"] ?? ""));
}
async function startPreview() {
  const project = app.project;
  if (project === null || view5 === null)
    return;
  previewState = "loading";
  buttons4();
  try {
    await preview.load(project.id, view5.tracks, view5.tempo);
    stopPlayers();
    await preview.play(mix, () => {
      previewState = "idle";
      buttons4();
    });
    previewState = "playing";
  } catch (caught) {
    previewState = "idle";
    renderNote = { tone: "error", text: `The preview could not play: ${errorText(caught)}` };
  }
  buttons4();
}
function stopPreview() {
  preview.stop();
  previewState = "idle";
  buttons4();
}
async function renderNow() {
  const project = app.project;
  if (project === null)
    return;
  rendering = true;
  renderNote = null;
  buttons4();
  try {
    const answer = await call("mix-render", {
      project: project.id,
      mix: { tracks: mix }
    });
    renderNote = answer.ok ? { tone: "info", text: `Rendered ${answer.file}.` } : { tone: "error", text: answer.message };
  } catch (caught) {
    renderNote = { tone: "error", text: errorText(caught) };
  }
  rendering = false;
  await load5();
}
function row(track) {
  const settings = mix[track.key] ?? { ...DEFAULT_TRACK };
  mix[track.key] = settings;
  const dbOut = h("output", { class: "readout" }, dbText(settings.db));
  const panOut = h("output", { class: "readout" }, panText(settings.pan));
  const toggle = (name, label) => {
    const button = h("button", {
      type: "button",
      class: `btn small toggle ${name}`,
      "aria-pressed": String(settings[name]),
      "aria-label": `${label} ${track.label}`,
      onclick: () => {
        settings[name] = !settings[name];
        button.setAttribute("aria-pressed", String(settings[name]));
        changed();
      }
    }, label);
    return button;
  };
  return h("div", { class: "mixrow", "data-track": track.key }, h("div", { class: "track-name" }, track.label, track.startBar === null ? null : h("span", { class: "meta" }, ` bar ${track.startBar}`)), h("label", { class: "knob" }, h("span", { class: "field-label" }, "Level"), h("input", {
    type: "range",
    name: "level",
    min: MIN_DB,
    max: MAX_DB,
    step: 0.5,
    value: String(settings.db),
    "aria-label": `Level of ${track.label}`,
    oninput: (event) => {
      settings.db = Number(event.target.value);
      dbOut.textContent = dbText(settings.db);
      changed();
    }
  }), dbOut), h("label", { class: "knob" }, h("span", { class: "field-label" }, "Pan"), h("input", {
    type: "range",
    name: "pan",
    min: -1,
    max: 1,
    step: 0.05,
    value: String(settings.pan),
    "aria-label": `Pan of ${track.label}`,
    oninput: (event) => {
      settings.pan = Number(event.target.value);
      panOut.textContent = panText(settings.pan);
      changed();
    }
  }), panOut), toggle("mute", "Mute"), toggle("solo", "Solo"));
}
function draw3() {
  const project = app.project;
  if (project === null || view5 === null) {
    fill(tracksBox, h("p", { class: "empty" }, loadError5 ?? "Open a project from the Library first."));
    fill(rendersBox2);
    return;
  }
  if (view5.tracks.length === 0) {
    fill(tracksBox, h("div", { class: "empty-state", "data-state": "no-stems" }, h("p", null, "No stems yet. Split the song into stems on the Produce stage, then mix them here."), h("button", { type: "button", class: "btn", onclick: () => go("produce") }, "Go to Produce")));
  } else {
    fill(tracksBox, ...view5.tracks.map(row));
    dimRows();
  }
  const list = [...view5.renders].reverse();
  fill(rendersBox2, h("h3", null, "Rendered mixes"), list.length === 0 ? h("p", { class: "empty" }, "No mix rendered yet.") : h("ul", { class: "version-list" }, ...list.map((each) => h("li", { class: "version", "data-mix": String(each.n) }, h("div", { class: "card-title" }, `mix-${each.n}.wav`), player(project.id, String(each.n), "mix", `mix ${each.n}`)))));
}
function update6() {
  heading5.textContent = app.project === null ? "Mix" : `Mix — ${app.project.title}`;
  if (dirty4) {
    dirty4 = false;
    draw3();
  }
  buttons4();
}
function mountMix() {
  const root = h("div", { class: "stage mix", "data-stage": "mix" }, h("section", { class: "main wide" }, heading5, banner4, tracksBox, h("div", { class: "actions" }, play, stop, render3, h("p", { class: "cost" }, "Rendered on this computer with ffmpeg. Free, no confirm.")), status, note3, rendersBox2));
  return {
    root,
    update: update6,
    sync: () => {
      if (loadedFor5 !== app.project?.id)
        view5 = null;
      preview.reset();
      previewState = "idle";
      load5();
      dirty4 = true;
      update6();
    }
  };
}

// panel/src/prep-state.ts
var ps = { view: null, error: null, loadedFor: null, playhead: 0, message: null };
var prep = () => ps.view?.prep ?? null;
async function load6() {
  const project = app.project;
  if (project === null)
    return;
  ps.loadedFor = project.id;
  try {
    ps.view = await call(`prepare?project=${encodeURIComponent(project.id)}`);
    ps.error = null;
  } catch (caught) {
    ps.view = null;
    ps.error = errorText(caught);
  }
  redraw("stage");
}
async function edit(path, body = {}) {
  const project = app.project;
  if (project === null || ps.view === null)
    return;
  ps.message = null;
  try {
    const answer = await call(path, { project: project.id, ...body });
    if (answer.ok)
      ps.view = { ...ps.view, prep: answer.prep };
    else
      ps.message = answer.message;
  } catch (caught) {
    ps.message = errorText(caught);
  }
  redraw("stage");
}

// panel/src/prep-controls.ts
var hooks = { seek: () => {
  return;
} };
var gridOf = () => prep()?.grid ?? null;
var editable = () => gridOf() !== null && !localBusy();
function button(label, onClick, enabled, extra = "") {
  return h("button", { type: "button", class: `btn small ${extra}`.trim(), disabled: !enabled, onclick: onClick }, label);
}
var bpmInput = h("input", {
  type: "number",
  min: 40,
  max: 240,
  step: 0.01,
  id: "bpm-input",
  "aria-label": "BPM",
  placeholder: "BPM"
});
function gridControls() {
  const nudge = (ms) => button(`${ms > 0 ? "+" : "−"}${Math.abs(ms)} ms`, () => void edit("prep-nudge", { ms }), editable());
  const typed = () => {
    const bpm = Number(bpmInput.value);
    edit("prep-bpm", { bpm: bpmInput.value.trim() === "" ? null : bpm });
  };
  bpmInput.disabled = prep() === null || localBusy();
  return h("div", { class: "controls-row", "data-part": "grid" }, h("span", { class: "field-label" }, "Grid"), nudge(-10), nudge(-1), nudge(1), nudge(10), button("First beat here", () => void edit("prep-first-beat", { sec: ps.playhead }), editable()), h("span", { class: "field-label sep" }, "BPM"), bpmInput, button("Set BPM", typed, prep() !== null && !localBusy()));
}
function cueRow(slot) {
  const cue = prep()?.cues.find((each) => each.slot === slot);
  const beat = gridOf() === null ? 0 : 60 / (gridOf()?.bpm ?? 120);
  const name = h("input", {
    type: "text",
    class: "cue-name",
    value: cue?.name ?? "",
    placeholder: cue === undefined ? "" : "Name",
    "aria-label": `Name of cue ${slot}`,
    disabled: cue === undefined || localBusy()
  });
  name.addEventListener("change", () => {
    if (cue !== undefined)
      edit("prep-cue", { slot, sec: cue.sec, name: name.value });
  });
  const move = (by) => () => {
    if (cue !== undefined)
      edit("prep-cue", { slot, sec: cue.sec + by * beat });
  };
  return h("div", { class: `cue-row${cue === undefined ? "" : " set"}`, "data-slot": slot }, h("span", { class: "cue-slot" }, slot), h("span", { class: "cue-time" }, cue === undefined ? "—" : clockText(cue.sec)), name, button("Set here", () => void edit("prep-cue", { slot, sec: ps.playhead }), editable()), button("Go", () => cue !== undefined && hooks.seek(cue.sec), cue !== undefined), button("−1 beat", move(-1), cue !== undefined && editable()), button("+1 beat", move(1), cue !== undefined && editable()), button("Delete", () => void edit("prep-cue-delete", { slot }), cue !== undefined && !localBusy()));
}
function cuesBox() {
  const auto = button("Cues from sections", () => void edit("prep-auto-cues"), editable() && ps.view?.hasPlan === true);
  auto.title = ps.view?.hasPlan === true ? "Replace the cues with one per section start" : "This song has no section plan";
  return h("div", { class: "cues", "data-part": "cues" }, h("div", { class: "cues-head" }, h("h3", null, "Cues"), auto), ...SLOTS.map(cueRow));
}
var loopBars = h("select", { id: "loop-bars", "aria-label": "Loop length in bars" }, ...LOOP_BARS.map((bars) => h("option", { value: String(bars), selected: bars === 4 }, `${bars} ${bars === 1 ? "bar" : "bars"}`)));
function loopControls() {
  const loop = prep()?.loop ?? null;
  return h("div", { class: "controls-row", "data-part": "loop" }, h("span", { class: "field-label" }, "Loop"), loopBars, button("Set loop here", () => void edit("prep-loop", { startSec: ps.playhead, bars: Number(loopBars.value) }), editable()), button("Clear loop", () => void edit("prep-loop-clear"), loop !== null && !localBusy()), button("Go to loop", () => loop !== null && hooks.seek(loop.startSec), loop !== null), h("span", { class: "meta" }, loop === null ? "No loop. It starts on the beat nearest the playhead." : `${clockText(loop.startSec)} to ${clockText(loop.endSec)}, ${loop.bars} ${loop.bars === 1 ? "bar" : "bars"}`));
}
function compatibleRow() {
  const list = prep()?.compatible ?? [];
  return h("div", { class: "controls-row", "data-part": "compatible" }, h("span", { class: "field-label" }, "Mixes with"), list.length === 0 ? h("span", { class: "meta" }, "The key is not known yet.") : h("span", { class: "chips" }, ...list.map((each) => h("span", { class: "key-chip", title: each.name }, `${each.code} ${each.name}, ${each.relation}`))));
}
var crateSelect = h("select", { id: "crate-pick", "aria-label": "Crate" });
async function toggleCrate(crate, inCrate) {
  const project = app.project?.id;
  if (project === undefined || ps.view === null)
    return;
  try {
    const answer = await call("prep-crate", {
      project,
      crate,
      in: inCrate
    });
    ps.view = { ...ps.view, crates: answer.crates };
  } catch (caught) {
    ps.message = errorText(caught);
  }
  redraw("stage");
}
function crateControls() {
  const crates = ps.view?.crates ?? [];
  const open = crates.filter((each) => !each.has);
  const keep = crateSelect.value;
  fill(crateSelect, ...open.map((each) => h("option", { value: each.id }, each.name)));
  if (open.some((each) => each.id === keep))
    crateSelect.value = keep;
  crateSelect.disabled = open.length === 0 || prep() === null;
  return h("div", { class: "controls-row", "data-part": "crates" }, h("span", { class: "field-label" }, "Crates"), crateSelect, button("Add to crate", () => void toggleCrate(crateSelect.value, true), open.length > 0 && prep() !== null), crates.length === 0 ? h("span", { class: "meta" }, "No crates yet. Make one in the Library.") : h("span", { class: "chips" }, ...crates.filter((each) => each.has).map((each) => h("span", { class: "crate-chip" }, each.name, h("button", {
    type: "button",
    class: "chip-x",
    "aria-label": `Remove from ${each.name}`,
    onclick: () => void toggleCrate(each.id, false)
  }, icon("close", 12))))));
}

// panel/src/waveform.ts
var NS = "http://www.w3.org/2000/svg";
var WIDTH = 1000;
var HEIGHT = 150;
var MID = HEIGHT / 2;
function svg(tag, attrs, text) {
  const node = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attrs))
    node.setAttribute(name, String(value));
  if (text !== undefined)
    node.textContent = text;
  return node;
}

class Waveform {
  root;
  canvas;
  playhead = null;
  data = null;
  span = 0;
  start = 0;
  head = 0;
  seekTo;
  constructor(seekTo) {
    this.seekTo = seekTo;
    this.canvas = svg("svg", {
      viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
      preserveAspectRatio: "none",
      class: "wf",
      role: "img",
      "aria-label": "Waveform with beatgrid and cues"
    });
    this.canvas.addEventListener("click", (event) => this.click(event));
    this.root = document.createElement("div");
    this.root.className = "wave";
    this.root.append(this.canvas);
  }
  get window() {
    const duration = this.data?.durationSec ?? 0;
    const length = this.span === 0 ? duration : Math.min(this.span, duration);
    const from = this.span === 0 ? 0 : Math.min(this.start, Math.max(0, duration - length));
    return { from, to: from + length };
  }
  setData(data) {
    this.data = data;
    this.draw();
  }
  setWindow(span, start) {
    this.span = span;
    this.start = start;
    this.draw();
  }
  setPlayhead(sec) {
    this.head = sec;
    this.moveHead();
  }
  x(sec) {
    const { from, to } = this.window;
    return to > from ? (sec - from) / (to - from) * WIDTH : 0;
  }
  moveHead() {
    if (this.playhead === null)
      return;
    const x = this.x(this.head);
    this.playhead.setAttribute("x1", String(x));
    this.playhead.setAttribute("x2", String(x));
    this.playhead.setAttribute("visibility", x >= 0 && x <= WIDTH ? "visible" : "hidden");
  }
  click(event) {
    const box = this.canvas.getBoundingClientRect();
    if (box.width === 0)
      return;
    const { from, to } = this.window;
    this.seekTo(from + (event.clientX - box.left) / box.width * (to - from));
  }
  outline() {
    const data = this.data;
    if (data === null || data.peaks.length === 0)
      return "";
    const { from, to } = this.window;
    const top = [];
    const bottom = [];
    for (let column = 0;column < WIDTH; column += 1) {
      const a = Math.floor((from + (to - from) * column / WIDTH) * data.perSec);
      const b = Math.max(a + 1, Math.floor((from + (to - from) * (column + 1) / WIDTH) * data.perSec));
      let peak = 0;
      for (let at = a;at < b; at += 1)
        peak = Math.max(peak, data.peaks[at] ?? 0);
      const half = peak / 255 * (MID - 14);
      top.push(`${column},${(MID - half).toFixed(1)}`);
      bottom.unshift(`${column},${(MID + half).toFixed(1)}`);
    }
    return [...top, ...bottom].join(" ");
  }
  grid() {
    const data = this.data;
    if (data === null || data.grid === null)
      return [];
    const { from, to } = this.window;
    const beats = beatsBetween(data.grid, from, to);
    const every = beats.length > 360 ? 4 : 1;
    return beats.filter((each) => every === 1 || each.beat === 1).map((each) => svg("line", {
      x1: this.x(each.sec),
      x2: this.x(each.sec),
      y1: each.beat === 1 ? 0 : 18,
      y2: HEIGHT,
      class: each.beat === 1 ? "wf-bar" : "wf-beat"
    }));
  }
  marks() {
    const data = this.data;
    if (data === null)
      return [];
    const { from, to } = this.window;
    const out = [];
    if (data.loop !== null) {
      const left = this.x(Math.max(from, data.loop.startSec));
      const right = this.x(Math.min(to, data.loop.endSec));
      if (right > left)
        out.push(svg("rect", { x: left, y: 0, width: right - left, height: HEIGHT, class: "wf-loop" }));
    }
    for (const cue of data.cues) {
      if (cue.sec < from || cue.sec > to)
        continue;
      const x = this.x(cue.sec);
      out.push(svg("line", { x1: x, x2: x, y1: 0, y2: HEIGHT, class: "wf-cue" }), svg("rect", { x, y: 0, width: 16, height: 16, class: "wf-flag" }), svg("text", { x: x + 8, y: 12, class: "wf-letter", "text-anchor": "middle" }, cue.slot));
    }
    return out;
  }
  draw() {
    this.canvas.replaceChildren(svg("line", { x1: 0, x2: WIDTH, y1: MID, y2: MID, class: "wf-mid" }), svg("polygon", { points: this.outline(), class: "wf-wave" }), ...this.grid(), ...this.marks());
    this.playhead = svg("line", { x1: 0, x2: 0, y1: 0, y2: HEIGHT, class: "wf-head" });
    this.canvas.append(this.playhead);
    this.moveHead();
  }
}

// panel/src/prepare.ts
var ZOOMS = [
  { span: 0, label: "Whole track" },
  { span: 60, label: "60 seconds" },
  { span: 30, label: "30 seconds" },
  { span: 15, label: "15 seconds" },
  { span: 8, label: "8 seconds" }
];
var deck = null;
var frame = 0;
var drawnFor = "";
var heading6 = h("h2", null);
var banner5 = h("div", { class: "notice warn", role: "alert", "data-state": "no-ffmpeg" });
var stale = h("p", { class: "why", role: "status", "data-part": "stale" });
var facts2 = h("div", { class: "facts", "data-part": "facts" });
var why5 = h("p", { class: "why", role: "status" });
var slot5 = h("div", { class: "slot", "data-part": "run-status" });
var tempoNote = h("p", { class: "why tempo-note", role: "status", "data-part": "tempo-note" });
var editNote = h("p", { class: "why", role: "status", "data-part": "edit-note" });
var controls = h("div", { class: "prep-controls" });
var time2 = h("span", { class: "time" }, "0:00.00");
var playNote = h("span", { class: "player-note", role: "status" });
var wave = new Waveform((sec) => seek2(sec));
var analyseButton = h("button", { type: "button", class: "btn primary big", id: "analyse", onclick: () => void analyse() }, icon("wave"), "Analyse");
var cancelButton4 = h("button", { type: "button", class: "btn", id: "analyse-cancel", onclick: () => void cancelLocal() }, "Cancel");
var playButton2 = h("button", { type: "button", class: "btn", id: "prep-play", onclick: () => void toggle2() }, icon("play", 14), "Play");
var zoom = h("select", { id: "wave-zoom", "aria-label": "Zoom" }, ...ZOOMS.map((each) => h("option", { value: String(each.span) }, each.label)));
var scroll = h("input", {
  type: "range",
  min: 0,
  max: 1000,
  value: 0,
  id: "wave-scroll",
  class: "seek",
  "aria-label": "Position in the track"
});
function seek2(sec) {
  ps.playhead = Math.max(0, sec);
  if (deck !== null && deck.audio.readyState > 0)
    deck.seek(ps.playhead);
  headMoved();
}
hooks.seek = seek2;
function headMoved() {
  wave.setPlayhead(ps.playhead);
  time2.textContent = `${clockText(ps.playhead)} / ${clockText(prep()?.analysis.durationSec ?? 0)}`;
  const { from, to } = wave.window;
  if (zoomSpan() > 0 && (ps.playhead < from || ps.playhead > to)) {
    wave.setWindow(zoomSpan(), Math.max(0, ps.playhead - zoomSpan() * 0.1));
    syncScroll();
  }
}
var zoomSpan = () => Number(zoom.value);
function syncScroll() {
  const duration = prep()?.analysis.durationSec ?? 0;
  const span = zoomSpan();
  scroll.disabled = span === 0 || duration <= span;
  scroll.value = span === 0 || duration <= span ? "0" : String(Math.round(wave.window.from / (duration - span) * 1000));
}
zoom.addEventListener("change", () => {
  wave.setWindow(zoomSpan(), Math.max(0, ps.playhead - zoomSpan() / 2));
  syncScroll();
});
scroll.addEventListener("input", () => {
  const duration = prep()?.analysis.durationSec ?? 0;
  const span = zoomSpan();
  wave.setWindow(span, Number(scroll.value) / 1000 * Math.max(0, duration - span));
});
function follow2() {
  const playing = deck;
  if (playing?.playing === true) {
    ps.playhead = playing.audio.currentTime;
    headMoved();
    frame = requestAnimationFrame(follow2);
  }
}
async function toggle2() {
  const source = prep()?.source;
  const project = app.project;
  if (source === undefined || project === null)
    return;
  if (deck === null || deck.id !== source.id || deck.kind !== source.kind) {
    deck?.dispose();
    deck = new Deck(project.id, source.kind, source.id);
    deck.audio.addEventListener("pause", () => buttons5());
    deck.audio.addEventListener("ended", () => buttons5());
  }
  try {
    if (deck.playing)
      deck.pause();
    else {
      await deck.play();
      deck.seek(ps.playhead);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(follow2);
    }
    playNote.textContent = "";
  } catch (caught) {
    playNote.textContent = caught instanceof Error ? caught.message : String(caught);
  }
  buttons5();
}
async function analyse() {
  const project = app.project;
  if (project === null)
    return;
  await startLocal("analyse", "prepare-analyse", { project: project.id }, async () => {
    deck?.dispose();
    deck = null;
    await load6();
    const found = prep();
    drawnFor = "";
    if (found === null)
      return "Analysed.";
    return found.analysis.bpm === null ? "Analysed. No clear tempo was found; type a BPM to make a grid." : `Analysed: ${found.grid?.bpm ?? found.analysis.bpm} BPM${found.analysis.key === null ? "" : `, ${found.analysis.key.camelot}`}.`;
  });
}
function blocker6() {
  const view = ps.view;
  if (view === null)
    return ps.error ?? "Loading…";
  if (!view.ffmpeg.ok)
    return view.ffmpeg.message;
  if (view.source === null)
    return "There is nothing to analyse yet. Choose a sketch on the Idea stage first.";
  return null;
}
function buttons5() {
  const reason = blocker6();
  const busy = localBusy();
  analyseButton.disabled = reason !== null || busy;
  cancelButton4.disabled = !(local.job?.status === "running" && local.job.work === "analyse") || local.cancelling;
  cancelButton4.textContent = local.cancelling ? "Cancelling…" : "Cancel";
  playButton2.disabled = prep() === null;
  playButton2.replaceChildren(icon(deck?.playing === true ? "pause" : "play", 14), deck?.playing === true ? "Pause" : "Play");
  zoom.disabled = prep() === null;
  const view = ps.view;
  why5.textContent = reason ?? (busy ? "" : prep() === null ? "Analysing takes a few seconds and runs on this computer." : "");
  banner5.hidden = view === null || view.ffmpeg.ok;
  fill(banner5, icon("alert"), h("div", { class: "notice-body" }, h("strong", null, "Preparing needs ffmpeg. "), view?.ffmpeg.message ?? ""));
  stale.textContent = view?.stale === true ? `There is a newer ${view.source?.label ?? "file"} than the one analysed. Analyse again to use it.` : "";
}
function tile(label, value, sub = "") {
  return h("div", { class: "fact" }, h("span", { class: "field-label" }, label), h("span", { class: "big-number" }, value), h("span", { class: "meta" }, sub));
}
function bpmSource() {
  const found = prep();
  if (found === null)
    return "";
  if (found.manualBpm)
    return "typed in";
  return found.analysis.bpm === null ? "none found" : "found";
}
var orDash = (value, make) => value === null || value === undefined ? "—" : make(value);
function drawFacts2() {
  const found = prep();
  const analysis = found?.analysis;
  const grid = found?.grid ?? null;
  fill(facts2, tile("BPM", orDash(grid?.bpm, String), bpmSource()), tile("Key", analysis?.key?.camelot ?? "—", analysis?.key?.name ?? ""), tile("First beat", orDash(grid?.firstBeatSec, (sec) => `${sec.toFixed(3)} s`)), tile("Energy", orDash(analysis?.energy, (energy) => `${energy} / 10`)), tile("Loudness", orDash(analysis?.lufs, (lufs) => `${lufs.toFixed(1)} LUFS`), orDash(analysis?.truePeak, (peak) => `peak ${peak.toFixed(1)} dBTP`).replace("—", "")));
  tempoNote.textContent = found !== null && grid === null ? "No clear tempo was found in this track, so there is no grid. Type a BPM below to make one." : "";
  editNote.textContent = ps.message ?? "";
  if (grid !== null && document.activeElement !== bpmInput)
    bpmInput.value = String(grid.bpm);
}
function waveData() {
  const found = prep();
  const peaks = ps.view?.peaks;
  if (found === null || peaks == null)
    return null;
  return {
    peaks: peaks.peaks,
    perSec: peaks.perSec,
    durationSec: found.analysis.durationSec,
    grid: found.grid,
    cues: found.cues,
    loop: found.loop
  };
}
function update7() {
  heading6.textContent = app.project === null ? "Prepare" : `Prepare — ${app.project.title}`;
  drawFacts2();
  buttons5();
  fill(controls, gridControls(), cuesBox(), loopControls(), compatibleRow(), crateControls());
  wave.setData(waveData());
  syncScroll();
  headMoved();
  const key = `${app.project?.id}:${prep()?.analysis.analysedAt}`;
  if (key !== drawnFor) {
    drawnFor = key;
    ps.playhead = 0;
    headMoved();
  }
  fill(slot5, localProgress("analyse"), localNotice("analyse"));
}
function mountPrepare() {
  const root = h("div", { class: "stage prepare", "data-stage": "prepare" }, h("section", { class: "main wide" }, heading6, banner5, h("div", { class: "actions" }, analyseButton, cancelButton4, why5), stale, slot5, facts2, tempoNote, wave.root, h("div", { class: "player wave-bar" }, playButton2, time2, h("span", { class: "grow" }), h("label", { class: "field-inline" }, h("span", { class: "field-label" }, "Zoom"), zoom), scroll), playNote, editNote, controls));
  return {
    root,
    update: update7,
    sync: () => {
      if (ps.loadedFor !== app.project?.id) {
        ps.view = null;
        deck?.dispose();
        deck = null;
        ps.playhead = 0;
      }
      ps.message = null;
      load6();
      update7();
    }
  };
}

// panel/src/produce.ts
var view6 = null;
var loadError6 = null;
var loadedFor6 = null;
var dirty5 = false;
async function load7() {
  const project = app.project;
  if (project === null)
    return;
  loadedFor6 = project.id;
  try {
    view6 = await call(`produce?project=${encodeURIComponent(project.id)}`);
    loadError6 = null;
  } catch (caught) {
    view6 = null;
    loadError6 = errorText(caught);
  }
  dirty5 = true;
  redraw("stage");
}
function blocker7() {
  if (view6 === null)
    return loadError6 ?? "Loading…";
  if (view6.source === null)
    return "Choose a sketch on the Idea stage first.";
  if (app.status !== null && !app.status.elevenlabs.keySet)
    return "No ElevenLabs key. Add it in Settings → Extensions → Music Studio.";
  return busy() ? "A run is in progress." : null;
}
var heading7 = h("h2", null);
var sourceLine = h("p", { class: "meta" });
var stemsBox = h("div", { class: "lanes", "data-part": "stems" });
var layersBox = h("div", { class: "lanes", "data-part": "layers" });
var workSlot2 = h("div", { class: "work-slot" });
var split = h("button", { type: "button", class: "btn primary", id: "split-stems", onclick: () => void splitStems() }, icon("wave"), "Split stems");
var why6 = h("p", { class: "why", role: "status" });
var prompt = h("input", {
  type: "text",
  name: "prompt",
  placeholder: "cymbal swell, vinyl crackle, door slam…",
  oninput: () => buttons6()
});
var bar = h("input", { type: "number", name: "start-bar", min: 1, step: 1, value: "1" });
var length = h("input", {
  type: "number",
  name: "length",
  min: 0.5,
  max: 30,
  step: 0.5,
  value: "3",
  oninput: () => buttons6()
});
var loop = h("input", { type: "checkbox", name: "loop" });
var add = h("button", { type: "button", class: "btn primary", id: "add-sfx", onclick: () => void addLayer() }, icon("spark"), "Add sound effect");
var addWhy = h("p", { class: "why", role: "status" });
function addBlocker() {
  const base = blocker7();
  if (base !== null)
    return base;
  if (prompt.value.trim() === "")
    return "Describe the sound first.";
  const sec = Number(length.value);
  if (!(sec >= 0.5 && sec <= 30))
    return "A sound effect lasts 0.5 to 30 seconds.";
  return null;
}
function buttons6() {
  const reason = blocker7();
  split.disabled = reason !== null;
  why6.textContent = reason ?? (view6?.stems.length ? "Splitting again replaces the stems below." : "");
  const addReason = addBlocker();
  add.disabled = addReason !== null;
  addWhy.textContent = addReason === "Describe the sound first." ? "" : addReason ?? "";
  for (const control of layersBox.querySelectorAll("button.layer-action"))
    control.disabled = busy();
}
async function splitStems() {
  const project = app.project;
  if (project === null)
    return;
  await startWork("stems-split", { project: project.id }, load7);
}
async function addLayer() {
  const project = app.project;
  if (project === null)
    return;
  await startWork("sfx-add", {
    project: project.id,
    prompt: prompt.value,
    startBar: Number(bar.value),
    lengthSec: Number(length.value),
    loop: loop.checked
  }, async () => {
    prompt.value = "";
    await load7();
  });
}
async function regenerate(layer) {
  const project = app.project;
  if (project === null)
    return;
  await startWork("sfx-regenerate", { project: project.id, layer: layer.id }, load7);
}
async function remove2(layer) {
  const project = app.project;
  if (project === null)
    return;
  try {
    await call("sfx-remove", { project: project.id, layer: layer.id });
  } catch (caught) {
    loadError6 = errorText(caught);
  }
  await load7();
}
function layerRow(project, layer) {
  return h("div", { class: "lane layer", "data-layer": layer.id }, h("div", { class: "lane-head" }, h("span", { class: "lane-name" }, layer.prompt), h("span", { class: "meta" }, `bar ${layer.startBar} · ${layer.lengthSec} s${layer.loop ? " · loop" : ""}`), h("span", { class: "grow" }), h("button", {
    type: "button",
    class: "btn small layer-action",
    onclick: () => void regenerate(layer)
  }, "Regenerate"), h("button", { type: "button", class: "btn small layer-action", onclick: () => void remove2(layer) }, "Remove")), player(project, layer.id, "layer", `sound effect ${layer.prompt}`));
}
function draw4() {
  const project = app.project;
  if (project === null || view6 === null) {
    fill(stemsBox, h("p", { class: "empty" }, loadError6 ?? "Open a project from the Library first."));
    fill(layersBox);
    return;
  }
  sourceLine.textContent = view6.source === null ? "" : `Working from ${view6.source.label}.${view6.stemSource === null ? "" : ` Stems are from ${view6.stemSource}.`}`;
  fill(stemsBox, view6.stems.length === 0 ? h("p", { class: "empty" }, "No stems yet. Split stems to separate the song into vocals, drums, bass and the rest.") : null, ...view6.stems.map((each) => h("div", { class: "lane stem", "data-stem": each.name }, h("div", { class: "lane-head" }, h("span", { class: "lane-name" }, each.name)), player(project.id, each.name, "stem", `${each.name} stem`))));
  fill(layersBox, view6.layers.length === 0 ? h("p", { class: "empty" }, "No sound effects yet.") : null, ...view6.layers.map((each) => layerRow(project.id, each)));
}
function update8() {
  heading7.textContent = app.project === null ? "Produce" : `Produce — ${app.project.title}`;
  fill(workSlot2, renderWork());
  if (dirty5) {
    dirty5 = false;
    draw4();
  }
  buttons6();
}
function mountProduce() {
  const root = h("div", { class: "stage produce", "data-stage": "produce" }, h("section", { class: "main wide" }, heading7, sourceLine, h("h3", null, "Stems"), h("div", { class: "actions" }, split, h("p", { class: "cost" }, "Billed by ElevenLabs to your plan. You confirm first.")), why6, stemsBox, h("h3", null, "Sound effects"), h("div", { class: "sfx-form" }, h("label", { class: "field grow" }, h("span", { class: "field-label" }, "Prompt"), prompt), h("label", { class: "field narrow" }, h("span", { class: "field-label" }, "Start bar"), bar), h("label", { class: "field narrow" }, h("span", { class: "field-label" }, "Length (s)"), length), h("label", { class: "check" }, loop, "Loop"), add), addWhy, layersBox, workSlot2));
  return {
    root,
    update: update8,
    sync: () => {
      if (loadedFor6 !== app.project?.id)
        view6 = null;
      load7();
      dirty5 = true;
      update8();
    }
  };
}

// panel/src/shoot.ts
var view7 = null;
var loadError7 = null;
var loadedFor7 = null;
var dirty6 = false;
var message2 = null;
var takes = 1;
var heading8 = h("h2", null);
var why7 = h("p", { class: "why", role: "status", "data-part": "why" });
var moneySlot = h("div", { class: "money-slot" });
var listBox = h("div", { class: "shots", "data-part": "shots" });
var workSlot3 = h("div", { class: "work-slot" });
var takesSelect = h("select", {
  name: "takes",
  "aria-label": "Takes per shot",
  onchange: () => {
    takes = Number(takesSelect.value);
    buttons7();
  }
}, ...Array.from({ length: MAX_TAKES_PER_SHOT }, (_each, at) => h("option", { value: String(at + 1) }, `${at + 1} take${at === 0 ? "" : "s"} per shot`)));
var shootButton = h("button", { type: "button", class: "btn primary big", id: "shoot", onclick: () => void shoot(null) }, icon("spark"), "Shoot approved shots");
var recoverButton = h("button", { type: "button", class: "btn", id: "shoot-recover", onclick: () => void recover() }, "Fetch interrupted clips");
var actionWhy2 = h("p", { class: "why", role: "status", "data-part": "action-why" });
async function load8() {
  const project = app.project;
  if (project === null)
    return;
  loadedFor7 = project.id;
  try {
    view7 = await call(`shoot?project=${encodeURIComponent(project.id)}`);
    loadError7 = null;
  } catch (caught) {
    view7 = null;
    loadError7 = errorText(caught);
  }
  dirty6 = true;
  redraw("stage");
}
function outcome(job) {
  if (job === null || job.status !== "done" || job.work !== "shoot")
    return;
  try {
    const out = JSON.parse(job.result ?? "");
    const stopped = out.stoppedBy === "budget" ? ` Shooting stopped at the budget (${usd(out.spentUsd)} of ${usd(out.budgetUsd)}): ${out.left} take${out.left === 1 ? " was" : "s were"} not shot. Raise the budget on the Treatment stage to go on.` : "";
    work.notice = {
      tone: out.stoppedBy === "budget" || out.failed > 0 ? "warn" : "info",
      text: `Made ${out.made} take${out.made === 1 ? "" : "s"}${out.failed > 0 ? `, ${out.failed} failed (the reason is on the take)` : ""}.${stopped}`
    };
  } catch {}
}
async function after() {
  outcome(work.job);
  await load8();
}
async function shoot(ids) {
  const project = app.project;
  if (project === null)
    return;
  message2 = null;
  await startWork("shoot-run", { project: project.id, shots: ids, takes: ids === null ? takes : 1 }, after);
}
async function recover() {
  const project = app.project;
  if (project === null)
    return;
  message2 = null;
  await startWork("shoot-recover", { project: project.id }, after);
}
async function choose2(take) {
  const project = app.project;
  if (project === null)
    return;
  try {
    view7 = await call("shoot-choose", { project: project.id, take: take.id });
    dirty6 = true;
  } catch (caught) {
    message2 = errorText(caught);
  }
  redraw("stage");
}
function takeRow(project, shot, take) {
  const done = take.status === "done";
  const select = h("button", {
    type: "button",
    class: `btn small${take.chosen ? " on" : ""}`,
    "aria-pressed": String(take.chosen),
    disabled: !done || take.chosen || busy(),
    onclick: () => void choose2(take)
  }, take.chosen ? "Chosen" : "Choose");
  const retry = h("button", {
    type: "button",
    class: "btn small",
    disabled: take.status !== "failed" || busy() || !canShoot(shot),
    onclick: () => void shoot([shot.id])
  }, "Retry");
  const status = take.status === "done" ? `${take.seconds} s clip` : take.status === "pending" ? "Waiting for Google" : `Failed: ${take.reason ?? "no reason given"}`;
  return h("div", { class: `take ${take.status}`, "data-take": take.id }, h("span", { class: "card-title" }, `Take ${take.n}`), h("span", {
    class: `meta${take.status === "failed" ? " error-text" : ""}`,
    role: take.status === "failed" ? "alert" : "status"
  }, status), done ? clip(project, "take", take.id, `Take ${take.n} of shot ${shot.number}`) : null, h("div", { class: "take-actions" }, select, retry));
}
var canShoot = (shot) => shot.approved && shot.frame !== null;
function shotCard(project, shot) {
  const more = h("button", {
    type: "button",
    class: "btn small",
    disabled: busy() || !canShoot(shot) || !(view7?.geminiKey ?? false),
    title: canShoot(shot) ? "" : "Approve this shot's frame on the Storyboard stage first.",
    onclick: () => void shoot([shot.id])
  }, shot.takes.length === 0 ? "Shoot this shot" : "Another take");
  return h("article", { class: `shot${shot.approved ? " approved" : ""}`, "data-shot": shot.id }, shot.frame === null ? h("div", { class: "pic-wrap empty-frame" }, h("span", { class: "meta" }, "No frame")) : picture(project, "frame", shot.id, shot.frame, `Frame of shot ${shot.number}`), h("div", { class: "shot-body" }, h("div", { class: "shot-head" }, h("span", { class: "card-title" }, `${shot.number}. ${shot.section}`), h("span", { class: "meta" }, `${clockText(shot.startSec)} to ${clockText(shot.endSec)}, ${shot.clipSeconds} s clip`)), h("p", { class: "shot-text" }, shot.text === "" ? "(no description)" : shot.text), shot.approved ? null : h("p", { class: "meta" }, "Not approved: approve its frame on the Storyboard stage to shoot it."), ...shot.takes.map((take) => takeRow(project, shot, take)), h("div", { class: "shot-actions" }, more)));
}
function drawList() {
  const project = app.project;
  if (project === null || view7 === null || view7.shots.length === 0) {
    fill(listBox, h("p", { class: "empty", "data-state": "no-shots" }, "No shot list yet. Draft one on the Storyboard stage."));
    return;
  }
  const shots = view7.shots;
  fill(listBox, ...shots.map((shot) => shotCard(project.id, shot)));
}
function blocker8() {
  if (view7 === null)
    return loadError7 ?? "Loading…";
  if (!view7.geminiKey)
    return keyHint;
  if (view7.shots.length === 0)
    return "There are no shots yet. Draft the shot list on the Storyboard stage.";
  if (view7.waiting.count === 0)
    return "Nothing is waiting: approve frames on the Storyboard stage, or use Another take on a shot.";
  if (view7.money.remainingUsd <= 0)
    return "The budget is used up. Raise it on the Treatment stage to shoot more.";
  return busy() ? "A run is in progress." : null;
}
function shootButtons(reason) {
  const count = (view7?.waiting.count ?? 0) * takes;
  const price = (view7?.waiting.usd ?? 0) * takes;
  setLabel(shootButton, count === 0 ? "Shoot approved shots" : `Shoot ${plural(count, "take")}, about ${usd(price)}`);
  shootButton.disabled = reason !== null;
  takesSelect.value = String(takes);
  takesSelect.disabled = view7 === null || busy();
}
function recoverButtons() {
  const orphans = view7?.orphans ?? 0;
  recoverButton.disabled = orphans === 0 || busy() || !(view7?.geminiKey ?? false);
  setLabel(recoverButton, orphans === 0 ? "Fetch interrupted clips" : `Fetch ${plural(orphans, "interrupted clip")}`);
}
function buttons7() {
  const reason = blocker8();
  shootButtons(reason);
  recoverButtons();
  why7.textContent = view7 !== null && !view7.geminiKey ? keyHint : "";
  actionWhy2.textContent = message2 ?? reason ?? `Clips are ${view7?.prices.resolution ?? "720p"}, billed to your Gemini key at about ${usd(view7?.prices.videoPerSecondUsd ?? 0)} a second (an estimate). You confirm the batch first; shooting stops at the budget.`;
}
function update9() {
  heading8.textContent = app.project === null ? "Shoot" : `Shoot — ${app.project.title}`;
  fill(moneySlot, moneyLine(view7?.money ?? null));
  fill(workSlot3, renderWork());
  if (dirty6) {
    dirty6 = false;
    drawList();
  }
  buttons7();
}
function mountShoot() {
  const root = h("div", { class: "stage shoot", "data-stage": "shoot" }, h("section", { class: "main wide" }, heading8, why7, moneySlot, h("div", { class: "actions" }, takesSelect, shootButton, recoverButton), actionWhy2, workSlot3, listBox));
  return {
    root,
    update: update9,
    sync: () => {
      if (loadedFor7 !== app.project?.id)
        view7 = null;
      load8();
      reattach(["shoot"], after, async () => "");
      dirty6 = true;
      update9();
    }
  };
}

// panel/src/storyboard.ts
var view8 = null;
var loadError8 = null;
var loadedFor8 = null;
var dirty7 = false;
var armed = false;
var message3 = null;
var heading9 = h("h2", null);
var why8 = h("p", { class: "why", role: "status", "data-part": "why" });
var moneySlot2 = h("div", { class: "money-slot" });
var listBox2 = h("div", { class: "shots", "data-part": "shots" });
var problemBox = h("p", { class: "why", role: "alert", "data-part": "problems" });
var workSlot4 = h("div", { class: "work-slot" });
var localSlot = h("div", { class: "slot", "data-part": "run-status" });
var prepareButton2 = h("button", { type: "button", class: "btn", id: "open-prepare", onclick: () => go("prepare") }, "Open Prepare");
var draftButton = h("button", { type: "button", class: "btn primary", id: "draft-shots", onclick: () => void draft2(false) }, icon("spark"), "Draft shot list");
var keepButton = h("button", {
  type: "button",
  class: "btn",
  id: "draft-keep",
  onclick: () => {
    armed = false;
    buttons8();
  }
}, "Keep my list");
var drawButton = h("button", { type: "button", class: "btn primary", id: "draw-frames", onclick: () => void drawFrames(null) }, icon("spark"), "Draw missing frames");
var approveAllButton = h("button", {
  type: "button",
  class: "btn",
  id: "approve-all",
  onclick: () => void change2({ approveAll: true })
}, "Approve all drawn");
var cancelButton5 = h("button", { type: "button", class: "btn", id: "draft-cancel", onclick: () => void cancelLocal() }, "Cancel");
var actionWhy3 = h("p", { class: "why", role: "status", "data-part": "action-why" });
async function load9() {
  const project = app.project;
  if (project === null)
    return;
  loadedFor8 = project.id;
  try {
    view8 = await call(`storyboard?project=${encodeURIComponent(project.id)}`);
    loadError8 = null;
  } catch (caught) {
    view8 = null;
    loadError8 = errorText(caught);
  }
  dirty7 = true;
  redraw("stage");
}
async function change2(body) {
  const project = app.project;
  if (project === null)
    return;
  message3 = null;
  try {
    const answer = await call("shot-edit", { project: project.id, ...body });
    if (answer.ok) {
      view8 = answer.view;
      dirty7 = true;
    } else
      message3 = answer.message;
  } catch (caught) {
    message3 = errorText(caught);
  }
  redraw("stage");
}
async function draft2(replace) {
  const project = app.project;
  if (project === null || view8 === null)
    return;
  if (view8.hasWork && !replace && !armed) {
    armed = true;
    buttons8();
    return;
  }
  armed = false;
  message3 = null;
  await startLocal("draft", "storyboard-draft", { project: project.id, replace: view8.hasWork }, async (job) => {
    await load9();
    return summary(job);
  });
}
function summary(job) {
  try {
    const out = JSON.parse(job.result ?? "");
    const base = `Cut the song into ${out.shots} shots.`;
    return out.note === null ? `${base} Descriptions written; edit any of them.` : `${base} ${out.note}`;
  } catch {
    return "Done.";
  }
}
async function drawFrames(ids) {
  const project = app.project;
  if (project === null)
    return;
  await startWork("storyboard-frames", { project: project.id, shots: ids }, async () => {
    await load9();
  });
}
function splitPoints(shot) {
  const list = view8?.list;
  if (list === null || list === undefined)
    return [];
  const grid = { bpm: list.bpm, firstBeatSec: list.firstBeatSec };
  const beat = 60 / list.bpm;
  return beatsBetween(grid, shot.startSec + beat - 0.001, shot.endSec - beat + 0.001).map((each) => ({
    sec: each.sec,
    label: `bar ${each.bar}, beat ${each.beat} (${clockText(each.sec)})`
  }));
}
function textBox(shot) {
  const box = h("textarea", {
    rows: 3,
    "aria-label": `Shot ${shot.number} description`,
    placeholder: "What the camera sees in this shot.",
    disabled: busy()
  });
  box.value = shot.text;
  box.addEventListener("change", () => void change2({ shot: shot.id, text: box.value }));
  return box;
}
function frameBox(project, shot) {
  if (shot.frame === null)
    return h("div", { class: "pic-wrap empty-frame", "data-state": "no-frame" }, h("span", { class: "meta" }, "No frame yet"));
  return picture(project, "frame", shot.id, shot.frame, `Frame of shot ${shot.number}`);
}
function splitControl(shot) {
  const points = splitPoints(shot);
  const select = h("select", {
    "aria-label": `Split shot ${shot.number} at`,
    disabled: busy() || points.length === 0
  });
  for (const point of points)
    select.append(h("option", { value: String(point.sec) }, point.label));
  select.value = String(points[Math.floor(points.length / 2)]?.sec ?? "");
  const button = h("button", {
    type: "button",
    class: "btn small",
    disabled: busy() || points.length === 0,
    onclick: () => void change2({ shot: shot.id, splitAt: Number(select.value) })
  }, "Split here");
  return h("div", { class: "split" }, select, button);
}
function card(project, shot, last) {
  const blocked = busy() || localBusy();
  const redraw1 = h("button", {
    type: "button",
    class: "btn small",
    disabled: blocked || !(view8?.geminiKey ?? false) || shot.text.trim() === "",
    onclick: () => void drawFrames([shot.id])
  }, shot.frame === null ? "Draw" : "Redraw");
  const approve = h("button", {
    type: "button",
    class: `btn small${shot.approved ? " on" : ""}`,
    "aria-pressed": String(shot.approved),
    disabled: blocked || shot.frame === null,
    onclick: () => void change2({ shot: shot.id, approved: !shot.approved })
  }, icon("check", 13), shot.approved ? "Approved" : "Approve");
  const merge = h("button", {
    type: "button",
    class: "btn small",
    disabled: blocked || last,
    onclick: () => void change2({ shot: shot.id, merge: true })
  }, "Join with next");
  return h("article", { class: `shot${shot.approved ? " approved" : ""}`, "data-shot": shot.id }, frameBox(project, shot), h("div", { class: "shot-body" }, h("div", { class: "shot-head" }, h("span", { class: "card-title" }, `${shot.number}. ${shot.section}`), h("span", { class: "meta" }, `${clockText(shot.startSec)} to ${clockText(shot.endSec)}, ${shot.bars} bars, ${shot.clipSeconds} s clip`)), textBox(shot), shot.frameError === null ? null : h("p", { class: "meta error-text", role: "alert" }, `Frame failed: ${shot.frameError}`), h("div", { class: "shot-actions" }, approve, redraw1, merge), splitControl(shot)));
}
function drawList2() {
  const project = app.project;
  const list = view8?.list;
  if (project === null || list === null || list === undefined) {
    fill(listBox2, h("p", { class: "empty", "data-state": "no-shots" }, "No shot list yet. Draft one: the song is cut into shots on the beat, from its sections."));
    return;
  }
  fill(listBox2, ...list.shots.map((shot, at) => card(project.id, shot, at === list.shots.length - 1)));
}
function draftBlocker() {
  if (view8 === null)
    return loadError8 ?? "Loading…";
  if (view8.tempo === null)
    return "There is no tempo yet. Analyse the track on the Prepare stage (or type its BPM in) so the shots can sit on bars.";
  return busy() || localBusy() ? "A run is in progress." : null;
}
function drawBlocker() {
  if (view8 === null)
    return loadError8 ?? "Loading…";
  if (!view8.geminiKey)
    return keyHint;
  if (view8.list === null)
    return "Draft the shot list first.";
  if (view8.missing.count === 0)
    return "Every shot has a frame.";
  const blank = view8.list.shots.find((each) => each.frame === null && each.text.trim() === "");
  if (blank !== undefined)
    return `Shot ${blank.number} has no description. Write what it shows first.`;
  if (view8.missing.usd > view8.money.remainingUsd)
    return "Over budget: raise the budget on the Treatment stage.";
  return busy() || localBusy() ? "A run is in progress." : null;
}
function draftButtons(reason) {
  draftButton.disabled = reason !== null;
  setLabel(draftButton, armed ? "Replace the shot list" : "Draft shot list");
  keepButton.disabled = !armed;
  prepareButton2.disabled = view8 === null || view8.tempo !== null;
  cancelButton5.disabled = !(local.job?.status === "running" && local.job.work === "draft") || local.cancelling;
  cancelButton5.textContent = local.cancelling ? "Cancelling…" : "Cancel";
}
function frameButtons(reason) {
  const count = view8?.missing.count ?? 0;
  setLabel(drawButton, count === 0 ? "Draw missing frames" : `Draw ${plural(count, "frame")}, about ${usd(view8?.missing.usd ?? 0)}`);
  drawButton.disabled = reason !== null;
  const drawn = view8?.list?.shots.some((each) => each.frame !== null && !each.approved) ?? false;
  approveAllButton.disabled = !drawn || busy() || localBusy();
}
function buttons8() {
  const draftReason = draftBlocker();
  const drawReason = drawBlocker();
  draftButtons(draftReason);
  frameButtons(drawReason);
  why8.textContent = view8 !== null && !view8.geminiKey ? keyHint : "";
  problemBox.textContent = (view8?.problems ?? []).join(" ");
  actionWhy3.textContent = message3 ?? (armed ? "This replaces the list with its descriptions, frames and approvals. Press the button again to go ahead." : draftReason ?? drawReason ?? "Frames are billed to your Gemini key (an estimate); you confirm the batch first.");
}
function update10() {
  heading9.textContent = app.project === null ? "Storyboard" : `Storyboard — ${app.project.title}`;
  fill(moneySlot2, moneyLine(view8?.money ?? null));
  fill(workSlot4, renderWork());
  fill(localSlot, localProgress("draft"), localNotice("draft"));
  if (dirty7) {
    dirty7 = false;
    drawList2();
  }
  buttons8();
}
function mountStoryboard() {
  const root = h("div", { class: "stage storyboard", "data-stage": "storyboard" }, h("section", { class: "main wide" }, heading9, why8, moneySlot2, h("div", { class: "actions" }, draftButton, keepButton, cancelButton5, prepareButton2, drawButton, approveAllButton), actionWhy3, problemBox, localSlot, workSlot4, listBox2));
  return {
    root,
    update: update10,
    sync: () => {
      if (loadedFor8 !== app.project?.id) {
        view8 = null;
        armed = false;
      }
      load9();
      reattach(["frames", "draft"], load9, async (job) => {
        await load9();
        return summary(job);
      });
      dirty7 = true;
      update10();
    }
  };
}

// panel/src/treatment.ts
var view9 = null;
var loadError9 = null;
var loadedFor9 = null;
var dirty8 = false;
var redrawCast = false;
var message4 = null;
var heading10 = h("h2", null);
var why9 = h("p", { class: "why", role: "status", "data-part": "why" });
var moneySlot3 = h("div", { class: "money-slot" });
var concept = h("textarea", {
  name: "concept",
  rows: 4,
  placeholder: "What the video is about: who, where, what happens.",
  "aria-label": "Concept"
});
var look = h("textarea", {
  name: "look",
  rows: 2,
  placeholder: "The look: film stock, colours, lighting, camera.",
  "aria-label": "Look"
});
var vertical = h("input", { type: "checkbox", name: "vertical" });
var budget = h("input", {
  type: "number",
  name: "budget",
  min: 0,
  step: 1,
  "aria-label": "Budget in dollars"
});
var barRadios = SHOT_BARS.map((bars) => h("input", {
  type: "radio",
  name: "shot-bars",
  value: String(bars),
  "aria-label": `${bars} bars`
}));
var save3 = h("button", { type: "button", class: "btn primary", id: "treatment-save", onclick: () => void saveForm() }, icon("check"), "Save treatment");
var saveWhy = h("p", { class: "why", role: "status" });
var castBox = h("div", { class: "cast", "data-part": "cast" });
var fileInput = h("input", {
  type: "file",
  accept: "image/png,image/jpeg,image/webp",
  hidden: true
});
var addButton = h("button", { type: "button", class: "btn", id: "cast-add", onclick: () => fileInput.click() }, "Add a picture from a file");
var drop = h("div", { class: "drop", "data-part": "drop", tabindex: 0 }, "Drop a picture here");
var castName = h("input", {
  type: "text",
  name: "cast-name",
  placeholder: "Name (Mia, the car…)",
  "aria-label": "Cast name"
});
var castPrompt = h("input", {
  type: "text",
  name: "cast-prompt",
  placeholder: "Describe the person, creature or object to draw",
  "aria-label": "Cast prompt"
});
var drawButton2 = h("button", { type: "button", class: "btn primary", id: "cast-draw", onclick: () => void draw5() }, icon("spark"), "Draw a cast picture");
var drawWhy = h("p", { class: "why", role: "status" });
var workSlot5 = h("div", { class: "work-slot" });
async function load10() {
  const project = app.project;
  if (project === null)
    return;
  loadedFor9 = project.id;
  try {
    view9 = await call(`treatment?project=${encodeURIComponent(project.id)}`);
    loadError9 = null;
  } catch (caught) {
    view9 = null;
    loadError9 = errorText(caught);
  }
  dirty8 = false;
  redrawCast = true;
  redraw("stage");
}
function setForm() {
  const t = view9?.treatment;
  if (t === undefined || dirty8)
    return;
  concept.value = t.concept;
  look.value = t.look;
  vertical.checked = t.vertical;
  for (const radio of barRadios)
    radio.checked = Number(radio.value) === t.shotBars;
  budget.value = String(view9?.money.budgetUsd ?? "");
}
function touched() {
  dirty8 = true;
  buttons9();
}
async function saveForm() {
  const project = app.project;
  if (project === null)
    return;
  message4 = null;
  const bars = barRadios.find((each) => each.checked)?.value;
  const asked = Number(budget.value);
  try {
    view9 = await call("treatment-save", {
      project: project.id,
      concept: concept.value,
      look: look.value,
      vertical: vertical.checked,
      shotBars: Number(bars),
      budgetUsd: budget.value.trim() === "" || !Number.isFinite(asked) ? null : asked
    });
    loadError9 = null;
    dirty8 = false;
    message4 = "Saved.";
  } catch (caught) {
    message4 = errorText(caught);
  }
  redraw("stage");
}
async function addFile(file) {
  const project = app.project;
  if (project === null)
    return;
  message4 = null;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (const byte of bytes)
      binary += String.fromCharCode(byte);
    const answer = await call("cast-add", {
      project: project.id,
      name: file.name.replace(/\.[^.]+$/, ""),
      base64: btoa(binary)
    });
    if (answer.ok) {
      view9 = answer.view;
      redrawCast = true;
    } else
      message4 = answer.message;
  } catch (caught) {
    message4 = errorText(caught);
  }
  redraw("stage");
}
async function remove3(id) {
  const project = app.project;
  if (project === null)
    return;
  try {
    view9 = await call("cast-remove", { project: project.id, id });
    redrawCast = true;
  } catch (caught) {
    message4 = errorText(caught);
  }
  redraw("stage");
}
async function draw5() {
  const project = app.project;
  if (project === null)
    return;
  const name = castName.value;
  await startWork("cast-draw", { project: project.id, name, prompt: castPrompt.value }, async () => {
    castPrompt.value = "";
    castName.value = "";
    await load10();
  });
}
function tile2(project, each) {
  return h("div", { class: "cast-tile", "data-cast": each.id }, picture(project, "cast", each.id, each.id, each.name === "" ? "Cast picture" : each.name), h("span", { class: "card-title" }, each.name === "" ? "Unnamed" : each.name), h("span", { class: "meta" }, each.source === "generated" ? "Drawn from a prompt" : "From a file"), h("button", {
    type: "button",
    class: "btn small",
    "aria-label": `Remove ${each.name === "" ? "this picture" : each.name}`,
    disabled: busy(),
    onclick: () => void remove3(each.id)
  }, "Remove"));
}
function drawCast() {
  const project = app.project;
  const cast = view9?.treatment.cast ?? [];
  fill(castBox, cast.length === 0 || project === null ? h("p", { class: "empty", "data-state": "no-cast" }, "No cast yet. Pictures keep a character looking the same in every shot; the video works without any.") : h("div", { class: "cast-grid" }, ...cast.map((each) => tile2(project.id, each))));
}
function drawBlocker2() {
  if (view9 === null)
    return loadError9 ?? "Loading…";
  if (!view9.geminiKey)
    return keyHint;
  if (view9.treatment.cast.length >= MAX_CAST)
    return `The cast holds at most ${MAX_CAST} pictures.`;
  if (castPrompt.value.trim() === "")
    return "Describe the picture first.";
  if (view9.money.remainingUsd < view9.prices.imageUsd)
    return "Over budget: raise the budget above.";
  return busy() ? "A run is in progress." : null;
}
function buttons9() {
  const blocked = view9 === null || busy();
  save3.disabled = blocked || !dirty8;
  saveWhy.textContent = message4 ?? (dirty8 ? "Unsaved changes." : "");
  const full = (view9?.treatment.cast.length ?? 0) >= MAX_CAST;
  addButton.disabled = blocked || full;
  drop.classList.toggle("off", blocked || full);
  const reason = drawBlocker2();
  drawButton2.disabled = reason !== null;
  drawWhy.textContent = reason ?? `Billed to your Gemini key: about ${usd(view9?.prices.imageUsd ?? 0)} for one picture (an estimate). You confirm first.`;
  for (const control of [concept, look, vertical, budget, ...barRadios, castName, castPrompt])
    control.disabled = blocked;
  const topReason = view9 === null ? loadError9 ?? "Loading…" : !view9.geminiKey ? keyHint : "";
  why9.textContent = topReason;
}
function update11() {
  heading10.textContent = app.project === null ? "Treatment" : `Treatment — ${app.project.title}`;
  fill(moneySlot3, moneyLine(view9?.money ?? null));
  fill(workSlot5, renderWork());
  setForm();
  if (redrawCast) {
    redrawCast = false;
    drawCast();
  }
  buttons9();
}
function wire() {
  for (const control of [concept, look, vertical, budget, ...barRadios])
    control.addEventListener("input", touched);
  castPrompt.addEventListener("input", buttons9);
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (file !== undefined)
      addFile(file);
  });
  drop.addEventListener("dragover", (event) => event.preventDefault());
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files[0];
    if (file !== undefined && !addButton.disabled)
      addFile(file);
  });
}
function mountTreatment() {
  wire();
  const root = h("div", { class: "stage treatment", "data-stage": "treatment" }, h("section", { class: "main wide" }, heading10, why9, moneySlot3, h("label", { class: "field" }, h("span", { class: "field-label" }, "Concept"), concept), h("label", { class: "field" }, h("span", { class: "field-label" }, "Look"), look), h("div", { class: "format-row", "data-part": "format" }, h("span", { class: "field-label" }, "Format"), h("span", { class: "chip on static" }, "16:9"), h("label", { class: "seg" }, vertical, "Also a 9:16 vertical cut"), h("span", { class: "field-label" }, "Shot length"), ...barRadios.map((radio, at) => h("label", { class: "seg" }, radio, `${SHOT_BARS[at]} bars`)), h("span", { class: "field-label" }, "Budget"), h("label", { class: "seg" }, "$", budget)), h("div", { class: "actions" }, save3, saveWhy), h("h3", null, "Cast"), castBox, h("div", { class: "cast-add" }, addButton, fileInput, drop), h("div", { class: "sfx-form" }, h("label", { class: "field narrow" }, h("span", { class: "field-label" }, "Name"), castName), h("label", { class: "field grow" }, h("span", { class: "field-label" }, "Prompt"), castPrompt), drawButton2), drawWhy, workSlot5));
  return {
    root,
    update: update11,
    sync: () => {
      if (loadedFor9 !== app.project?.id)
        view9 = null;
      load10();
      reattach(["cast"], load10, async () => "");
      update11();
    }
  };
}

// panel/src/main.ts
var LOOK = {
  "--background": "--bg",
  "--foreground": "--fg",
  "--card": "--card",
  "--muted": "--muted",
  "--muted-foreground": "--muted-fg",
  "--border": "--border",
  "--accent": "--accent",
  "--font-sans": "--font",
  "--font-mono": "--mono"
};
addEventListener("message", (event) => {
  const data = event.data;
  if (typeof data !== "object" || data === null || data.type !== "prifly-look")
    return;
  const look = data;
  document.documentElement.classList.toggle("dark", look.dark === true);
  for (const [theirs, ours] of Object.entries(LOOK)) {
    const value = look.tokens?.[theirs];
    if (typeof value === "string" && value !== "")
      document.documentElement.style.setProperty(ours, value);
  }
});
startFollowing();
var docked = app.follow.session !== null;
var followSlot = h("div", { class: "follow-slot" });
var followNote = h("div", { class: "follow-note-slot" });
var head = h("header", { class: "top" }, h("h1", null, "Music Studio"), followSlot, h("span", { class: "grow" }));
var statusSlot = h("div", { class: "status-slot" });
var bar2 = h("div", { class: "bar-slot" });
var body = h("main", { class: "body" });
var root = h("div", { class: "studio", "data-part": "studio" }, head, docked ? followNote : null, bar2, body);
head.append(statusSlot);
document.body.replaceChildren(root);
var idea = mountIdea();
var library = mountLibrary();
var stages = {
  arrange: mountArrange(),
  produce: mountProduce(),
  mix: mountMix(),
  master: mountMaster(),
  prepare: mountPrepare(),
  treatment: mountTreatment(),
  storyboard: mountStoryboard(),
  shoot: mountShoot(),
  edit: mountEdit(),
  deliver: mountDeliver()
};
function stage() {
  return STAGES.includes(app.view) ? stages[app.view] : null;
}
function drawHead() {
  fill(followSlot, renderFollow());
  fill(followNote, renderFollowNote());
  statusSlot.replaceChildren(renderHeader());
  bar2.replaceChildren(renderStageBar());
}
function drawBody() {
  const current = stage();
  body.replaceChildren(current?.root ?? (app.view === "idea" ? idea.root : library.root));
  if (current !== null) {
    clearWork();
    current.sync();
  } else if (app.view === "idea")
    idea.sync();
  else
    loadLibrary();
}
onRedraw((region) => {
  if (region === "head" || region === "all")
    drawHead();
  if (region === "idea")
    idea.update();
  if (region === "library")
    library.update();
  if (region === "stage")
    stage()?.update();
  if (region === "all")
    drawBody();
});
drawHead();
drawBody();
loadStatus();
