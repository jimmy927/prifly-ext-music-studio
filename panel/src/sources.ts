/**
 * The source material block shared by Idea and Treatment: the project's
 * pictures and videos (thumbnails, a frame strip per video), what reading
 * them found, and "Add source material". Before an idea has a project the
 * added files wait in `app.sources` and are read, behind the sketch's one
 * confirm card, when the reader presses Sketch. Each state has its own words:
 * none yet, not read, reading, failed (with Try again), no Gemini key, ffmpeg
 * missing, a file that is not a picture or a video. The pieces are in
 * source-parts.ts.
 */

import { call, errorText, type Job, type SourcesView, type StartAnswer } from "./api";
import { type Child, fill, h } from "./dom";
import {
  actionRow,
  endMessage,
  type Message,
  noticeRow,
  progressRow,
  refused,
  stagedList,
  stageFile,
  stateNotes,
  synthesisBox,
  tile,
} from "./source-parts";
import { app } from "./state";

const POLL_MS = 1500;

export type SourcesOptions = {
  /** "idea" keeps added files for the sketch; "treatment" offers to fill the treatment too. */
  where: "idea" | "treatment";
  /** Redraws the stage the block is in. */
  redraw: () => void;
  /** Called when reading finished or the treatment was filled, so the stage can reload. */
  changed?: () => void;
};

const NO_SOURCES =
  "No source material. Add pictures or phone videos (or a folder of them) and the sketches start from what is in them: the mood, the text on screen, a video's sound, tempo and key.";

class SourcesBlock {
  readonly root: HTMLElement;
  private readonly options: SourcesOptions;
  private readonly body = h("div", { class: "sources-body" });
  private readonly fileInput = h("input", {
    type: "file",
    multiple: true,
    accept: "image/png,image/jpeg,image/webp,video/*,.mov,.mkv",
    hidden: true,
  });
  private readonly pathInput = h("input", {
    type: "text",
    name: "source-path",
    placeholder: "Or the full path of a file or a folder",
    "aria-label": "Path of a source file or folder",
  });
  private readonly addButton: HTMLButtonElement;
  private readonly pathButton: HTMLButtonElement;
  private view: SourcesView | null = null;
  private loadedFor: string | null = null;
  private loadError: string | null = null;
  private message: Message | null = null;
  private confirming = false;
  private job: Job | null = null;
  private adding = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SourcesOptions) {
    this.options = options;
    this.addButton = h(
      "button",
      {
        type: "button",
        class: "btn",
        id: `${options.where}-source-add`,
        onclick: () => this.fileInput.click(),
      },
      "Add source material",
    );
    this.pathButton = h(
      "button",
      { type: "button", class: "btn small", onclick: () => void this.addPath() },
      "Add path",
    );
    this.root = h(
      "section",
      { class: "sources", "data-part": "sources" },
      h("h3", null, "Source material"),
      this.body,
      h(
        "div",
        { class: "cast-add" },
        this.addButton,
        this.fileInput,
        this.pathInput,
        this.pathButton,
      ),
    );
    this.fileInput.addEventListener("change", () => {
      const files = [...(this.fileInput.files ?? [])];
      this.fileInput.value = "";
      void this.addFiles(files);
    });
    this.pathInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void this.addPath();
    });
  }

  private running(): boolean {
    return this.confirming || this.job?.status === "running" || this.view?.running != null;
  }

  async load(): Promise<void> {
    const current = app.project;
    if (current === null) return;
    this.loadedFor = current.id;
    try {
      const view = await call<SourcesView>(`sources?project=${encodeURIComponent(current.id)}`);
      this.view = view;
      this.loadError = null;
      if (view.running !== null && this.job === null) {
        this.job = view.running;
        void this.poll(view.running.id);
      }
    } catch (caught) {
      this.view = null;
      this.loadError = errorText(caught);
    }
    this.options.redraw();
  }

  private async poll(id: string): Promise<void> {
    try {
      const job = await call<Job>(`job?id=${encodeURIComponent(id)}`);
      this.job = job;
      if (job.status === "running") {
        this.timer = setTimeout(() => void this.poll(id), POLL_MS);
      } else {
        this.message = endMessage(job);
        this.job = null;
        await this.load();
        this.options.changed?.();
        return;
      }
    } catch (caught) {
      this.message = { tone: "error", text: errorText(caught) };
      this.job = null;
    }
    this.options.redraw();
  }

  /** Reads the project's sources, `add` joining them. */
  private async analyse(add: string[]): Promise<void> {
    const current = app.project;
    if (current === null) return;
    this.message = null;
    this.confirming = true;
    this.options.redraw();
    try {
      const answer = await call<StartAnswer>("sources-analyse", { project: current.id, add });
      this.confirming = false;
      if (answer.ok) {
        this.job = answer.job;
        void this.poll(answer.job.id);
      } else this.message = refused(answer);
    } catch (caught) {
      this.confirming = false;
      this.message = { tone: "error", text: errorText(caught) };
    }
    this.options.redraw();
  }

  /** Takes paths the reader gave or staged: kept for the sketch (no project yet), or read now. */
  private async take(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    if (app.project === null) {
      for (const path of paths) if (!app.sources.includes(path)) app.sources.push(path);
      this.options.redraw();
      return;
    }
    await this.analyse(paths);
  }

  private async addPath(): Promise<void> {
    const path = this.pathInput.value.trim();
    if (path === "") return;
    this.pathInput.value = "";
    await this.take([path]);
  }

  private async addFiles(files: File[]): Promise<void> {
    this.message = null;
    this.adding = true;
    this.options.redraw();
    const paths: string[] = [];
    for (const file of files) {
      const staged = await stageFile(file);
      if ("path" in staged) paths.push(staged.path);
      else this.message = staged.message;
    }
    this.adding = false;
    await this.take(paths);
    this.options.redraw();
  }

  private async useForTreatment(): Promise<void> {
    const current = app.project;
    if (current === null) return;
    try {
      const answer = await call<{ ok: true } | { ok: false; message: string }>(
        "treatment-from-sources",
        { project: current.id },
      );
      this.message = answer.ok
        ? { tone: "info", text: "The concept, look, cast and references are filled in below." }
        : { tone: "warn", text: answer.message };
      this.options.changed?.();
    } catch (caught) {
      this.message = { tone: "error", text: errorText(caught) };
    }
    this.options.redraw();
  }

  /** The project's sources as read from the extension, with the buttons for its state. */
  private projectContent(current: string, v: SourcesView): Child[] {
    return [
      ...stateNotes(v, this.running()),
      h("div", { class: "source-grid" }, ...v.items.map((each) => tile(current, each))),
      ...v.notes.map((each) => h("p", { class: "meta", "data-part": "note" }, each)),
      synthesisBox(v, this.options.where),
      actionRow(v, this.options.where, this.running() || this.adding, {
        read: () => void this.analyse([]),
        fill: () => void this.useForTreatment(),
      }),
    ];
  }

  private content(): Child[] {
    const current = app.project;
    if (current === null) {
      if (app.sources.length === 0)
        return [h("p", { class: "empty", "data-state": "no-sources" }, NO_SOURCES)];
      return [
        stagedList(app.sources, (path) => {
          app.sources = app.sources.filter((each) => each !== path);
          this.options.redraw();
        }),
      ];
    }
    if (this.view === null)
      return [
        h("p", { class: "meta", role: "status" }, this.loadError ?? "Loading the source material…"),
      ];
    return this.projectContent(current.id, this.view);
  }

  update(): void {
    const current = app.project;
    if (current === null) {
      this.loadedFor = null;
      this.view = null;
    } else if (this.loadedFor !== current.id) {
      this.view = null;
      this.job = null;
      void this.load();
    }
    fill(
      this.body,
      progressRow(this.confirming, this.job),
      noticeRow(this.message),
      ...this.content(),
    );
    const blocked = this.running() || this.adding;
    this.addButton.disabled = blocked;
    this.pathButton.disabled = blocked;
    this.pathInput.disabled = blocked;
  }

  /** Starts the block over for a page that was just shown. */
  sync(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.loadedFor = null;
    this.message = null;
    this.update();
  }
}

export const mountSources = (options: SourcesOptions): SourcesBlock => new SourcesBlock(options);
