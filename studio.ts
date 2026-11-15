/**
 * What the panel and the session tools share: the keys, the store, the
 * running jobs, and "Sketch 3 ideas" (check the keys and credits, ask the
 * reader on a confirm card, then make three sketches in the background).
 */

import type { ExtensionApi } from "@prifly/extension-api";
import { ffmpegBinary } from "./audio/ffmpeg";
import { askReader } from "./confirm";
import { type Credits, composeDetailed, credits as elevenCredits } from "./engines/elevenlabs";
import { lyria } from "./engines/gemini";
import { EngineError, type EngineErrorKind, type Fetch, type Sketched } from "./engines/types";
import {
  type Brief,
  buildPrompt,
  ENGINE_LABELS,
  type EngineId,
  parseBrief,
  SKETCH_IDS,
  SKETCH_MS,
  titleOf,
} from "./project/brief";
import { Crates } from "./project/crates";
import { type IndexEntry, libraryFolder, Store } from "./project/store";
import { noteProject } from "./session";

export type Deps = {
  api: () => ExtensionApi | null;
  fetch: Fetch;
  /** Milliseconds between two polls of a long-running Gemini call; 5000 when left out. */
  pollMs?: number;
  /** A smaller frame for every render (tests render at 160x90); the real sizes when left out. */
  renderSize?: { width: number; height: number };
};

/** The ids of the manifest panel and session view that play files from the library folder. */
const MEDIA_IDS = ["studio-view"];

export const SETTINGS_HINT = "Add it in Settings → Extensions → Music Studio.";

export type JobStatus = "running" | "done" | "failed" | "cancelled";

export type JobKind =
  | "sketch"
  | "arrange"
  | "stems"
  | "sfx"
  | "cast"
  | "frames"
  | "shoot"
  | "master"
  | "analyse"
  | "deliver"
  | "draft"
  | "preview"
  | "render";

const LOCAL_KINDS: readonly JobKind[] = [
  "master",
  "analyse",
  "deliver",
  "draft",
  "preview",
  "render",
];

/** The kinds that run on this computer: no key, no cost. */
export const isLocalKind = (kind: JobKind): boolean => LOCAL_KINDS.includes(kind);

/** A run (paid: sketches, an arrange render, stems, a sound effect; local: master, analyse, deliver), as the panel polls it. */
export type Job = {
  id: string;
  work: JobKind;
  /** What the run is doing, in words: "Rendering version 2". */
  label: string;
  /** The project the work goes to; null once an empty project was removed again. */
  project: string | null;
  /** The engine a paid run uses; null for local work. */
  engine: EngineId | null;
  status: JobStatus;
  /** Steps finished so far (sketch ids for sketches). */
  done: string[];
  total: number;
  /** What the run made, once done: "v2", "stems", a layer id. */
  result: string | null;
  error: string | null;
  kind: EngineErrorKind | null;
  /** The prompt ElevenLabs suggested when it refused the brief. */
  suggestion: string | null;
};

export class Studio {
  readonly deps: Deps;
  readonly jobs = new Map<string, Job>();
  private readonly aborts = new Map<string, AbortController>();

  constructor(deps: Deps) {
    this.deps = deps;
  }

  api(): ExtensionApi {
    const api = this.deps.api();
    if (api === null) throw new Error("The extension is not running.");
    return api;
  }

  store(): Store {
    const api = this.api();
    if (api.state === undefined) throw new Error("This prifly keeps no state. Update prifly.");
    return new Store(libraryFolder(api.settings?.["libraryFolder"]), api.state);
  }

  /** The crates, kept in the extension's state. */
  crates(): Crates {
    const api = this.api();
    if (api.state === undefined) throw new Error("This prifly keeps no state. Update prifly.");
    return new Crates(api.state);
  }

  /** The ffmpeg to start: the `ffmpegPath` setting, else the PATH's. */
  ffmpeg(): string {
    return ffmpegBinary(this.api().settings?.["ffmpegPath"]);
  }

  libraryPath(): string {
    return libraryFolder(this.api().settings?.["libraryFolder"]);
  }

  /** True once prifly serves the library folder at `media/…` for the panel and the view. */
  streaming = false;

  /**
   * Has prifly serve the library folder (`api.panelMedia`, feature "panel-media")
   * so the players stream real files; without it the files go as base64 JSON.
   */
  serveMedia(): void {
    const api = this.api();
    const call = (api as { panelMedia?: (panelId: string, folder: string) => void }).panelMedia;
    if (!(api.features ?? []).includes("panel-media") || typeof call !== "function") return;
    const folder = this.libraryPath();
    const served = MEDIA_IDS.map((id) => {
      try {
        call.call(api, id, folder);
        return true;
      } catch (caught) {
        // A prifly with panel media but no session views refuses the view's id; the panel still streams.
        api.log("panel-media-failed", { id, error: String(caught) });
        return false;
      }
    });
    this.streaming = served[0] === true;
  }

  /** How long to wait between two polls of a Gemini call that is still running. */
  pollMs(): number {
    return this.deps.pollMs ?? 5000;
  }

  /** The stored key for an engine, or null when there is none. */
  async key(engine: EngineId): Promise<string | null> {
    const name = engine === "elevenlabs" ? "elevenlabsKey" : "geminiKey";
    const key = await this.api().secrets?.get(name);
    return key === undefined || key === null || key.trim() === "" ? null : key.trim();
  }

  cancel(jobId: string): boolean {
    const abort = this.aborts.get(jobId);
    if (abort === undefined) return false;
    abort.abort();
    return true;
  }

  register(job: Job, abort: AbortController): void {
    this.jobs.set(job.id, job);
    this.aborts.set(job.id, abort);
  }

  release(jobId: string): void {
    this.aborts.delete(jobId);
  }
}

export type Status = {
  elevenlabs: { keySet: boolean; credits: Credits | null; error: string | null };
  gemini: { keySet: boolean };
  library: string;
};

/** The header line's facts: the keys that are set and the ElevenLabs credits left. */
export async function statusOf(studio: Studio): Promise<Status> {
  const eleven = await studio.key("elevenlabs");
  const gemini = await studio.key("lyria-clip");
  let credits: Credits | null = null;
  let error: string | null = null;
  if (eleven !== null) {
    try {
      credits = await elevenCredits(studio.deps.fetch, eleven);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }
  return {
    elevenlabs: { keySet: eleven !== null, credits, error },
    gemini: { keySet: gemini !== null },
    library: studio.libraryPath(),
  };
}

export type Started =
  | { ok: true; job: Job; finished: Promise<Job> }
  | {
      ok: false;
      reason: "invalid" | "no_key" | "cancelled" | "unsupported" | "failed";
      message: string;
    };

export const fail = (
  reason: Extract<Started, { ok: false }>["reason"],
  message: string,
): Started => ({
  ok: false,
  reason,
  message,
});

/** The confirm card's words for a sketch run. */
export function confirmSpec(brief: Brief): Parameters<NonNullable<ExtensionApi["confirm"]>>[0] {
  const engine = ENGINE_LABELS[brief.engine];
  const cost =
    brief.engine === "elevenlabs"
      ? "billed by ElevenLabs to your plan (its API gives no per-track price, so none is shown)"
      : "billed to your Gemini key (Google's price per clip is not shown here)";
  return {
    title: "Sketch 3 ideas",
    summary: `Make 3 sketches of 30 seconds with ${engine}: ${cost}`,
    content: buildPrompt(brief),
    details: `${brief.engine === "elevenlabs" ? "POST /v1/music/detailed, model music_v2_5" : "POST /v1beta/interactions, model lyria-3-clip-preview"}, ${SKETCH_MS} ms, ${brief.vocals === "instrumental" ? "instrumental" : "with vocals"}, three calls`,
  };
}

async function makeOne(
  studio: Studio,
  brief: Brief,
  key: string,
  signal: AbortSignal,
): Promise<Sketched> {
  const request = {
    prompt: buildPrompt(brief),
    lengthMs: SKETCH_MS,
    instrumental: brief.vocals === "instrumental",
  };
  return brief.engine === "elevenlabs"
    ? await composeDetailed(studio.deps.fetch, key, request, signal)
    : await lyria(studio.deps.fetch, key, "lyria-3-clip-preview", request, signal);
}

/** Ends a job that threw: cancelled when the reader aborted it, else failed with the engine's words. */
export function endFailed(job: Job, caught: unknown, signal: AbortSignal): void {
  if (signal.aborted) {
    job.status = "cancelled";
    return;
  }
  job.status = "failed";
  job.error = caught instanceof Error ? caught.message : String(caught);
  if (caught instanceof EngineError) {
    job.kind = caught.kind;
    job.suggestion = caught.suggestion;
  }
}

/** Makes the sketches one after another into the project; ends the job whatever happens. */
async function run(
  studio: Studio,
  job: Job,
  entry: IndexEntry,
  brief: Brief,
  key: string,
  signal: AbortSignal,
) {
  const store = studio.store();
  let failure: { caught: unknown } | null = null;
  try {
    for (const id of SKETCH_IDS) {
      if (signal.aborted) break;
      await store.saveSketch(entry, id, await makeOne(studio, brief, key, signal), brief.engine);
      job.done.push(id);
    }
  } catch (caught) {
    failure = { caught };
  }
  // A project with no sketch is only clutter in the library. The run ends only after it is gone.
  if (job.done.length === 0) {
    try {
      await store.remove(entry);
      job.project = null;
    } catch (caught) {
      failure ??= { caught };
    }
  }
  if (failure !== null) endFailed(job, failure.caught, signal);
  else job.status = signal.aborted ? "cancelled" : "done";
  studio.release(job.id);
  return job;
}

/**
 * "Sketch 3 ideas": checks, asks the reader, and starts the run. Nothing is
 * spent before the reader confirms. `linked` aborts the run when it fires
 * (the session that called the tool went away).
 */
export async function startSketch(
  studio: Studio,
  raw: unknown,
  linked?: AbortSignal,
): Promise<Started> {
  const brief = parseBrief(raw);
  if (typeof brief === "string") return fail("invalid", brief);
  const key = await studio.key(brief.engine);
  if (key === null) {
    const which = brief.engine === "elevenlabs" ? "ElevenLabs" : "Gemini";
    return fail("no_key", `There is no ${which} key. ${SETTINGS_HINT}`);
  }
  const answer = await askReader(studio.api(), confirmSpec(brief));
  if (answer === null)
    return fail("unsupported", "This prifly cannot ask you first. Update prifly.");
  if (!answer) return fail("cancelled", "Not done: you cancelled.");
  const entry = await studio.store().create(brief, titleOf(brief));
  await noteProject(studio, entry.id);
  const job: Job = {
    id: crypto.randomUUID().slice(0, 8),
    work: "sketch",
    label: "Sketching 3 ideas",
    project: entry.id,
    engine: brief.engine,
    status: "running",
    done: [],
    total: SKETCH_IDS.length,
    result: null,
    error: null,
    kind: null,
    suggestion: null,
  };
  const abort = new AbortController();
  linked?.addEventListener("abort", () => abort.abort());
  studio.register(job, abort);
  return { ok: true, job, finished: run(studio, job, entry, brief, key, abort.signal) };
}
