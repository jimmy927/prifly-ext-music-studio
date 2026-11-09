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
async function call(path, body) {
  const response = await fetch(`api/${path}`, {
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
var STAGES = ["arrange", "produce", "mix"];
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
  library: { projects: null, query: "", error: null }
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
      { id: "master", label: "Master", slice: 4 }
    ]
  },
  { name: "DJ", tabs: [{ id: "prepare", label: "Prepare", slice: 4 }] },
  {
    name: "Video",
    tabs: [
      { id: "treatment", label: "Treatment", slice: 6 },
      { id: "storyboard", label: "Storyboard", slice: 6 },
      { id: "shoot", label: "Shoot", slice: 7 },
      { id: "edit", label: "Edit", slice: 7 }
    ]
  },
  { name: "", tabs: [{ id: "deliver", label: "Deliver", slice: 5 }] }
];
function tab(each) {
  if (each.slice !== undefined) {
    return h("button", {
      type: "button",
      class: "tab",
      disabled: true,
      "aria-disabled": "true",
      title: `${each.label} arrives in slice ${each.slice}.`
    }, each.label);
  }
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
function gate(view) {
  const project = app.project;
  if (project === null || project.chosen === null)
    return { enabled: false, reason: "Choose a sketch on the Idea stage first." };
  if (view === "arrange") {
    const engine = project.sketchList.find((each) => each.id === project.chosen)?.engine;
    if (engine !== "elevenlabs")
      return { enabled: false, reason: LYRIA_REASON };
  }
  return { enabled: true, reason: null };
}
function stageNote() {
  if (app.project === null)
    return "Open a project from the Library to use Arrange, Produce and Mix.";
  return gate("arrange").reason ?? "";
}
function go(view) {
  app.view = view;
  redraw("all");
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
function slot(id, index) {
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
  return h("div", { class: "progress", role: "status" }, h("span", null, `Making sketch ${step} of ${job.total} with ${ENGINE_LABELS[job.engine]}. A sketch takes about half a minute.`), h("div", { class: "track" }, h("div", {
    class: "fill",
    style: `width:${Math.round(job.done.length / job.total * 100)}%`
  })), h("button", { type: "button", class: "btn small", disabled: cancelling, onclick: cancel }, cancelling ? "Cancelling…" : "Cancel"));
}
function renderSketches(cancel, cancelling) {
  const project = app.project;
  const heading = project === null ? "Sketches" : `Sketches — ${project.title}`;
  const empty = project === null && app.job === null && !app.confirming;
  return h("section", { class: "side", "data-part": "sketches" }, h("h2", null, heading), progress2(cancel, cancelling), empty ? h("p", { class: "empty" }, "Nothing sketched yet. Write a brief, pick a preset if you like, and press Sketch 3 ideas.") : h("ul", { class: "cards" }, ...SKETCH_IDS.map((id, index) => slot(id, index))), project === null ? null : h("p", { class: "meta folder" }, `Saved in ${project.folder}`));
}

// panel/src/idea.ts
var POLL_MS2 = 1500;
var timer = null;
var cancelling = false;
function blocker2() {
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
function ended2(job) {
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
async function poll2() {
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
      timer = setTimeout(() => void poll2(), POLL_MS2);
    else {
      cancelling = false;
      ended2(job);
    }
  } catch (caught) {
    app.notice = { tone: "error", text: errorText(caught) };
    app.job = null;
  }
  redraw("idea");
}
function startPolling() {
  if (timer !== null)
    clearTimeout(timer);
  poll2();
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
    const reason = blocker2();
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

// panel/src/library.ts
async function loadLibrary() {
  try {
    const answer = await call(`library?q=${encodeURIComponent(app.library.query)}`);
    app.library.projects = answer.projects;
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
function table(projects) {
  return h("table", { class: "projects" }, h("thead", null, h("tr", null, ...["Title", "Engine", "Length", "Created", "Sketches", ""].map((each) => h("th", null, each)))), h("tbody", null, ...projects.map((each) => h("tr", { "data-project": each.id }, h("td", { class: "title" }, each.title), h("td", null, ENGINE_LABELS[each.engine]), h("td", null, formatLength(each.lengthSec)), h("td", null, day(each.created)), h("td", null, `${each.sketches}${each.chosen === null ? "" : `, ${each.chosen.toUpperCase()} chosen`}`), h("td", null, h("button", { type: "button", class: "btn small", onclick: () => void open(each.id) }, "Open"))))));
}
function mountLibrary() {
  const body = h("div", { class: "library-body" });
  let wait = null;
  const search = h("input", {
    type: "search",
    class: "search",
    placeholder: "Search title, engine or brief",
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
    else if (projects.length === 0 && query.trim() === "") {
      fill(body, h("div", { class: "empty-state", "data-state": "empty" }, icon("wave", 28), h("p", null, "The library is empty."), h("p", { class: "meta" }, "Sketch an idea and it is saved here."), h("button", { type: "button", class: "btn primary", onclick: () => go("idea") }, "Go to Idea")));
    } else if (projects.length === 0)
      fill(body, h("p", { class: "empty" }, `No project matches "${query}".`));
    else
      fill(body, table(projects));
  }
  const root = h("div", { class: "library", "data-stage": "library" }, h("section", { class: "main wide" }, h("div", { class: "lib-head" }, h("h2", null, "Library"), h("div", { class: "search-wrap" }, icon("search", 15), search)), body));
  update();
  return { root, update };
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
var view2 = null;
var loadError2 = null;
var loadedFor2 = null;
var dirty2 = false;
var mix = {};
var preview = new Preview;
async function load2() {
  const project = app.project;
  if (project === null)
    return;
  loadedFor2 = project.id;
  try {
    view2 = await call(`mix?project=${encodeURIComponent(project.id)}`);
    mix = Object.fromEntries(view2.tracks.map((each) => [each.key, { ...each.mix }]));
    loadError2 = null;
  } catch (caught) {
    view2 = null;
    loadError2 = errorText(caught);
  }
  dirty2 = true;
  redraw("stage");
}
var dbText = (db) => `${db > 0 ? "+" : ""}${db.toFixed(1)} dB`;
var panText = (pan) => Math.abs(pan) < 0.025 ? "C" : `${pan < 0 ? "L" : "R"}${Math.round(Math.abs(pan) * 100)}`;
var heading2 = h("h2", null);
var banner = h("div", { class: "notice warn", role: "alert", "data-state": "no-ffmpeg" });
var tracksBox = h("div", { class: "tracks", "data-part": "tracks" });
var rendersBox = h("div", { class: "renders", "data-part": "renders" });
var status = h("p", { class: "why", role: "status" });
var previewState = "idle";
var rendering = false;
var renderNote = null;
var saveTimer = null;
var play = h("button", { type: "button", class: "btn", id: "play-preview", onclick: () => void startPreview() }, icon("play", 14), "Play preview");
var stop = h("button", { type: "button", class: "btn", id: "stop-preview", onclick: () => stopPreview() }, icon("pause", 14), "Stop");
var render2 = h("button", { type: "button", class: "btn primary big", id: "render-mix", onclick: () => void renderNow() }, icon("wave"), "Render mix");
var note = h("div", { class: "notices", "data-part": "mix-note" });
var hasTracks = () => (view2?.tracks.length ?? 0) > 0;
function renderBlocker() {
  if (view2 === null)
    return loadError2 ?? "Loading the tracks…";
  if (!hasTracks())
    return "There are no stems yet. Split stems on the Produce stage first.";
  if (!view2.ffmpeg.ok)
    return view2.ffmpeg.message;
  if (rendering)
    return "Rendering…";
  if (audible(Object.values(mix)).length === 0)
    return "Every track is muted, or others are soloed.";
  return null;
}
function buttons() {
  const reason = renderBlocker();
  render2.disabled = reason !== null || busy();
  play.disabled = !hasTracks() || previewState !== "idle";
  stop.disabled = previewState !== "playing";
  status.textContent = previewState === "loading" ? "Loading the tracks for the preview…" : reason ?? "";
  banner.hidden = view2 === null || view2.ffmpeg.ok;
  const shown = view2?.ffmpeg.ok === false ? view2.ffmpeg.message : "";
  fill(banner, icon("alert"), h("div", { class: "notice-body" }, h("strong", null, "Mix cannot be rendered. "), shown, " Playing the preview still works."));
  fill(note, renderNote === null ? null : h("div", { class: `notice ${renderNote.tone}`, role: "status" }, icon(renderNote.tone === "info" ? "check" : "alert"), h("div", { class: "notice-body" }, renderNote.text)));
}
function changed() {
  preview.apply(mix);
  if (saveTimer !== null)
    clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), 400);
  dimRows();
  buttons();
}
async function save() {
  const project = app.project;
  if (project === null)
    return;
  try {
    await call("mix-save", { project: project.id, mix: { tracks: mix } });
  } catch (caught) {
    renderNote = { tone: "error", text: errorText(caught) };
    buttons();
  }
}
function dimRows() {
  const heard = new Set(audible(Object.entries(mix).map(([key, each]) => ({ key, ...each }))).map((each) => each.key));
  for (const row of tracksBox.querySelectorAll("[data-track]"))
    row.classList.toggle("silent", !heard.has(row.dataset["track"] ?? ""));
}
async function startPreview() {
  const project = app.project;
  if (project === null || view2 === null)
    return;
  previewState = "loading";
  buttons();
  try {
    await preview.load(project.id, view2.tracks, view2.tempo);
    stopPlayers();
    await preview.play(mix, () => {
      previewState = "idle";
      buttons();
    });
    previewState = "playing";
  } catch (caught) {
    previewState = "idle";
    renderNote = { tone: "error", text: `The preview could not play: ${errorText(caught)}` };
  }
  buttons();
}
function stopPreview() {
  preview.stop();
  previewState = "idle";
  buttons();
}
async function renderNow() {
  const project = app.project;
  if (project === null)
    return;
  rendering = true;
  renderNote = null;
  buttons();
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
  await load2();
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
function draw() {
  const project = app.project;
  if (project === null || view2 === null) {
    fill(tracksBox, h("p", { class: "empty" }, loadError2 ?? "Open a project from the Library first."));
    fill(rendersBox);
    return;
  }
  if (view2.tracks.length === 0) {
    fill(tracksBox, h("div", { class: "empty-state", "data-state": "no-stems" }, h("p", null, "No stems yet. Split the song into stems on the Produce stage, then mix them here."), h("button", { type: "button", class: "btn", onclick: () => go("produce") }, "Go to Produce")));
  } else {
    fill(tracksBox, ...view2.tracks.map(row));
    dimRows();
  }
  const list = [...view2.renders].reverse();
  fill(rendersBox, h("h3", null, "Rendered mixes"), list.length === 0 ? h("p", { class: "empty" }, "No mix rendered yet.") : h("ul", { class: "version-list" }, ...list.map((each) => h("li", { class: "version", "data-mix": String(each.n) }, h("div", { class: "card-title" }, `mix-${each.n}.wav`), player(project.id, String(each.n), "mix", `mix ${each.n}`)))));
}
function update2() {
  heading2.textContent = app.project === null ? "Mix" : `Mix — ${app.project.title}`;
  if (dirty2) {
    dirty2 = false;
    draw();
  }
  buttons();
}
function mountMix() {
  const root = h("div", { class: "stage mix", "data-stage": "mix" }, h("section", { class: "main wide" }, heading2, banner, tracksBox, h("div", { class: "actions" }, play, stop, render2, h("p", { class: "cost" }, "Rendered on this computer with ffmpeg. Free, no confirm.")), status, note, rendersBox));
  return {
    root,
    update: update2,
    sync: () => {
      if (loadedFor2 !== app.project?.id)
        view2 = null;
      preview.reset();
      previewState = "idle";
      load2();
      dirty2 = true;
      update2();
    }
  };
}

// panel/src/produce.ts
var view3 = null;
var loadError3 = null;
var loadedFor3 = null;
var dirty3 = false;
async function load3() {
  const project = app.project;
  if (project === null)
    return;
  loadedFor3 = project.id;
  try {
    view3 = await call(`produce?project=${encodeURIComponent(project.id)}`);
    loadError3 = null;
  } catch (caught) {
    view3 = null;
    loadError3 = errorText(caught);
  }
  dirty3 = true;
  redraw("stage");
}
function blocker3() {
  if (view3 === null)
    return loadError3 ?? "Loading…";
  if (view3.source === null)
    return "Choose a sketch on the Idea stage first.";
  if (app.status !== null && !app.status.elevenlabs.keySet)
    return "No ElevenLabs key. Add it in Settings → Extensions → Music Studio.";
  return busy() ? "A run is in progress." : null;
}
var heading3 = h("h2", null);
var sourceLine = h("p", { class: "meta" });
var stemsBox = h("div", { class: "lanes", "data-part": "stems" });
var layersBox = h("div", { class: "lanes", "data-part": "layers" });
var workSlot2 = h("div", { class: "work-slot" });
var split = h("button", { type: "button", class: "btn primary", id: "split-stems", onclick: () => void splitStems() }, icon("wave"), "Split stems");
var why2 = h("p", { class: "why", role: "status" });
var prompt = h("input", {
  type: "text",
  name: "prompt",
  placeholder: "cymbal swell, vinyl crackle, door slam…",
  oninput: () => buttons2()
});
var bar = h("input", { type: "number", name: "start-bar", min: 1, step: 1, value: "1" });
var length = h("input", {
  type: "number",
  name: "length",
  min: 0.5,
  max: 30,
  step: 0.5,
  value: "3",
  oninput: () => buttons2()
});
var loop = h("input", { type: "checkbox", name: "loop" });
var add = h("button", { type: "button", class: "btn primary", id: "add-sfx", onclick: () => void addLayer() }, icon("spark"), "Add sound effect");
var addWhy = h("p", { class: "why", role: "status" });
function addBlocker() {
  const base = blocker3();
  if (base !== null)
    return base;
  if (prompt.value.trim() === "")
    return "Describe the sound first.";
  const sec = Number(length.value);
  if (!(sec >= 0.5 && sec <= 30))
    return "A sound effect lasts 0.5 to 30 seconds.";
  return null;
}
function buttons2() {
  const reason = blocker3();
  split.disabled = reason !== null;
  why2.textContent = reason ?? (view3?.stems.length ? "Splitting again replaces the stems below." : "");
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
  await startWork("stems-split", { project: project.id }, load3);
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
    await load3();
  });
}
async function regenerate(layer) {
  const project = app.project;
  if (project === null)
    return;
  await startWork("sfx-regenerate", { project: project.id, layer: layer.id }, load3);
}
async function remove2(layer) {
  const project = app.project;
  if (project === null)
    return;
  try {
    await call("sfx-remove", { project: project.id, layer: layer.id });
  } catch (caught) {
    loadError3 = errorText(caught);
  }
  await load3();
}
function layerRow(project, layer) {
  return h("div", { class: "lane layer", "data-layer": layer.id }, h("div", { class: "lane-head" }, h("span", { class: "lane-name" }, layer.prompt), h("span", { class: "meta" }, `bar ${layer.startBar} · ${layer.lengthSec} s${layer.loop ? " · loop" : ""}`), h("span", { class: "grow" }), h("button", {
    type: "button",
    class: "btn small layer-action",
    onclick: () => void regenerate(layer)
  }, "Regenerate"), h("button", { type: "button", class: "btn small layer-action", onclick: () => void remove2(layer) }, "Remove")), player(project, layer.id, "layer", `sound effect ${layer.prompt}`));
}
function draw2() {
  const project = app.project;
  if (project === null || view3 === null) {
    fill(stemsBox, h("p", { class: "empty" }, loadError3 ?? "Open a project from the Library first."));
    fill(layersBox);
    return;
  }
  sourceLine.textContent = view3.source === null ? "" : `Working from ${view3.source.label}.${view3.stemSource === null ? "" : ` Stems are from ${view3.stemSource}.`}`;
  fill(stemsBox, view3.stems.length === 0 ? h("p", { class: "empty" }, "No stems yet. Split stems to separate the song into vocals, drums, bass and the rest.") : null, ...view3.stems.map((each) => h("div", { class: "lane stem", "data-stem": each.name }, h("div", { class: "lane-head" }, h("span", { class: "lane-name" }, each.name)), player(project.id, each.name, "stem", `${each.name} stem`))));
  fill(layersBox, view3.layers.length === 0 ? h("p", { class: "empty" }, "No sound effects yet.") : null, ...view3.layers.map((each) => layerRow(project.id, each)));
}
function update3() {
  heading3.textContent = app.project === null ? "Produce" : `Produce — ${app.project.title}`;
  fill(workSlot2, renderWork());
  if (dirty3) {
    dirty3 = false;
    draw2();
  }
  buttons2();
}
function mountProduce() {
  const root = h("div", { class: "stage produce", "data-stage": "produce" }, h("section", { class: "main wide" }, heading3, sourceLine, h("h3", null, "Stems"), h("div", { class: "actions" }, split, h("p", { class: "cost" }, "Billed by ElevenLabs to your plan. You confirm first.")), why2, stemsBox, h("h3", null, "Sound effects"), h("div", { class: "sfx-form" }, h("label", { class: "field grow" }, h("span", { class: "field-label" }, "Prompt"), prompt), h("label", { class: "field narrow" }, h("span", { class: "field-label" }, "Start bar"), bar), h("label", { class: "field narrow" }, h("span", { class: "field-label" }, "Length (s)"), length), h("label", { class: "check" }, loop, "Loop"), add), addWhy, layersBox, workSlot2));
  return {
    root,
    update: update3,
    sync: () => {
      if (loadedFor3 !== app.project?.id)
        view3 = null;
      load3();
      dirty3 = true;
      update3();
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
var head = h("header", { class: "top" }, h("h1", null, "Music Studio"), h("span", { class: "grow" }));
var statusSlot = h("div", { class: "status-slot" });
var bar2 = h("div", { class: "bar-slot" });
var body = h("main", { class: "body" });
var root = h("div", { class: "studio", "data-part": "studio" }, head, bar2, body);
head.append(statusSlot);
document.body.replaceChildren(root);
var idea = mountIdea();
var library = mountLibrary();
var stages = { arrange: mountArrange(), produce: mountProduce(), mix: mountMix() };
function stage() {
  return STAGES.includes(app.view) ? stages[app.view] : null;
}
function drawHead() {
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
