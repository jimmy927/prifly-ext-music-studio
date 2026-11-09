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
      { id: "arrange", label: "Arrange", slice: 2 },
      { id: "produce", label: "Produce", slice: 3 },
      { id: "mix", label: "Mix", slice: 3 },
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
  const on = app.view === "idea";
  return h("button", {
    type: "button",
    class: `tab${on ? " on" : ""}`,
    "aria-current": on ? "page" : "false",
    onclick: () => go("idea")
  }, each.label);
}
function go(view) {
  app.view = view;
  redraw("all");
}
function renderStageBar() {
  const library = app.view === "library";
  return h("nav", { class: "stagebar", "aria-label": "Stages", "data-part": "stagebar" }, ...GROUPS.map((group) => h("div", { class: "group", "data-group": group.name === "" ? "deliver" : group.name.toLowerCase() }, group.name === "" ? null : h("span", { class: "group-name" }, group.name), h("div", { class: "tabs" }, ...group.tabs.map(tab)))), h("span", { class: "grow" }), h("button", {
    type: "button",
    class: `tab library${library ? " on" : ""}`,
    "aria-current": library ? "page" : "false",
    onclick: () => go("library")
  }, icon("library", 15), "Library"));
}

// panel/src/form.ts
var NOTES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
var KEYS = NOTES.flatMap((note) => [`${note} major`, `${note} minor`]);
var VOCAL_LABELS = {
  generated: "Generated lyrics",
  mine: "My lyrics",
  instrumental: "Instrumental"
};
function field(label, control, hint) {
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
  const lyricsField = field("Lyrics", lyrics);
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
  const root = h("div", { class: "form" }, field("Brief", text), h("div", { class: "field" }, h("span", { class: "field-label" }, "Presets"), h("div", { class: "chips" }, ...chips)), h("div", { class: "row" }, field("Tempo (BPM)", tempo), field("Key", key), field("Length", length, "Of the finished song")), h("div", { class: "field" }, h("span", { class: "field-label" }, "Vocals"), h("div", { class: "segs" }, ...vocals)), lyricsField, field("Engine", engine));
  sync();
  return { root, sync };
}

// panel/src/player.ts
var playing = null;
var clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
function blobUrl(base64, mime) {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}
function player(project, sketch) {
  const audio = new Audio;
  const button = h("button", { type: "button", class: "play", "aria-label": `Play sketch ${sketch.toUpperCase()}` }, icon("play", 18));
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
        const media = await call(`media?project=${encodeURIComponent(project)}&sketch=${encodeURIComponent(sketch)}`);
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

// panel/src/sketches.ts
async function choose(project, sketch) {
  try {
    app.project = await call("choose", { project, sketch });
  } catch (caught) {
    app.notice = { tone: "error", text: errorText(caught) };
  }
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
function progress(cancel, cancelling) {
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
  return h("section", { class: "side", "data-part": "sketches" }, h("h2", null, heading), progress(cancel, cancelling), empty ? h("p", { class: "empty" }, "Nothing sketched yet. Write a brief, pick a preset if you like, and press Sketch 3 ideas.") : h("ul", { class: "cards" }, ...SKETCH_IDS.map((id, index) => slot(id, index))), project === null ? null : h("p", { class: "meta folder" }, `Saved in ${project.folder}`));
}

// panel/src/idea.ts
var POLL_MS = 1500;
var timer = null;
var cancelling = false;
function blocker() {
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
function ended(job) {
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
async function poll() {
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
      timer = setTimeout(() => void poll(), POLL_MS);
    else {
      cancelling = false;
      ended(job);
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
  poll();
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
async function cancel() {
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
    const reason = blocker();
    button.disabled = reason !== null;
    why.textContent = reason ?? "";
    cost.textContent = app.draft.engine === "elevenlabs" ? "Billed by ElevenLabs to your plan. You confirm first." : "Billed to your Gemini key. You confirm first.";
    fill(messages, ...notices());
    fill(side, renderSketches(() => void cancel(), cancelling));
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
var bar = h("div", { class: "bar-slot" });
var body = h("main", { class: "body" });
var root = h("div", { class: "studio", "data-part": "studio" }, head, bar, body);
head.append(statusSlot);
document.body.replaceChildren(root);
var idea = mountIdea();
var library = mountLibrary();
function drawHead() {
  statusSlot.replaceChildren(renderHeader());
  bar.replaceChildren(renderStageBar());
}
function drawBody() {
  body.replaceChildren(app.view === "idea" ? idea.root : library.root);
  if (app.view === "idea")
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
  if (region === "all")
    drawBody();
});
drawHead();
drawBody();
loadStatus();
