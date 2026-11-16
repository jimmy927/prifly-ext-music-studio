/** The pieces of the source material block (panel/src/sources.ts): tiles, findings, notices and buttons. */

import { MAX_UPLOAD_BYTES } from "../../sources/constants";
import {
  call,
  errorText,
  type Job,
  type SourceItem,
  type SourcesView,
  type StartAnswer,
} from "./api";
import { type Child, h, icon } from "./dom";
import { keyHint, picture, plural } from "./video";

export type Message = { tone: "info" | "warn" | "error"; text: string };

/** A picture, or a video's frame strip; loaded when built. */
function thumbs(project: string, item: SourceItem): HTMLElement {
  if (item.kind === "image") {
    return item.hasPicture
      ? picture(project, "source", item.id, item.id, item.name)
      : h("div", { class: "pic-wrap empty-pic" }, "Not read yet");
  }
  if (item.frames === 0) return h("div", { class: "pic-wrap empty-pic" }, "Video: no frames yet");
  const strip = h("div", { class: "frame-strip", "data-part": "frames" });
  for (let at = 0; at < item.frames; at += 1) {
    const id = `${item.id}.${at}`;
    strip.append(picture(project, "sourceframe", id, id, `${item.name}, frame ${at + 1}`));
  }
  return strip;
}

export const line = (label: string, value: string | null | undefined): Child =>
  value === null || value === undefined || value === ""
    ? null
    : h("p", { class: "found" }, h("strong", null, `${label}: `), value);

const joined = (...parts: string[]): string => parts.filter((each) => each !== "").join(", ");

function found(item: SourceItem): HTMLElement {
  const { seen, audio } = item;
  return h(
    "div",
    { class: "found-box" },
    seen === null
      ? h("p", { class: "meta" }, "Not read yet.")
      : h(
          "div",
          null,
          line("People", seen.people),
          line("Place", seen.place),
          line("Happens", seen.actions),
          line("Mood", seen.mood),
          line("Colours", seen.colours),
          line("Text", seen.text === "" ? null : `“${seen.text}”`),
        ),
    audio === null
      ? null
      : h(
          "div",
          { class: "audio-found" },
          line("Tempo", audio.bpm === null ? null : `${Math.round(audio.bpm)} BPM`),
          line("Key", audio.key),
          line("Sound", joined(audio.mood, audio.genre)),
          line("Language", audio.language),
          audio.note === null ? null : h("p", { class: "meta" }, audio.note),
        ),
  );
}

export function tile(project: string, item: SourceItem): HTMLElement {
  const length = item.durationSec === null ? "" : `, ${Math.round(item.durationSec)} s`;
  return h(
    "div",
    { class: `source-tile ${item.kind}`, "data-source": item.id },
    thumbs(project, item),
    h("span", { class: "card-title" }, item.name),
    h("span", { class: "meta" }, item.kind === "video" ? `Video${length}` : "Picture"),
    found(item),
  );
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/** The files added before the idea has a project, with Remove on each. */
export function stagedList(paths: string[], remove: (path: string) => void): HTMLElement {
  return h(
    "div",
    { class: "staged", "data-state": "staged" },
    h(
      "p",
      null,
      `${plural(paths.length, "source")} will be read when you press Sketch 3 ideas (the same confirm card covers it; a few cents at most):`,
    ),
    h(
      "ul",
      null,
      ...paths.map((path) =>
        h(
          "li",
          null,
          path.split(/[\\/]/).pop() ?? path,
          " ",
          h(
            "button",
            {
              type: "button",
              class: "btn small",
              "aria-label": `Remove ${path}`,
              onclick: () => remove(path),
            },
            "Remove",
          ),
        ),
      ),
    ),
  );
}

export function noticeRow(message: Message | null): Child {
  if (message === null) return null;
  return h(
    "div",
    { class: `notice ${message.tone}`, role: message.tone === "error" ? "alert" : "status" },
    icon(message.tone === "info" ? "info" : "alert"),
    h("div", { class: "notice-body" }, message.text),
  );
}

/** Waiting for the confirm card, or the running job with Cancel. */
export function progressRow(confirming: boolean, job: Job | null): Child {
  if (confirming)
    return h(
      "div",
      { class: "progress", role: "status", "data-state": "confirming" },
      h("span", null, "Waiting for you to confirm the cost in prifly…"),
    );
  if (job === null || job.status !== "running") return null;
  const id = job.id;
  return h(
    "div",
    { class: "progress", role: "status", "data-state": "analysing" },
    h("span", null, `${job.label}. This can take a minute.`),
    h("div", { class: "track" }, h("div", { class: "fill indeterminate" })),
    h(
      "button",
      {
        type: "button",
        class: "btn small",
        onclick: () => void call("cancel", { job: id }).catch(() => undefined),
      },
      "Cancel",
    ),
  );
}

/** What the material suggests for the song, and for the video on the Treatment stage. */
export function synthesisBox(v: SourcesView, where: "idea" | "treatment"): Child {
  const s = v.synthesis;
  if (s === null || v.state !== "read") return null;
  const lyrics = s.song.lyrics.split("\n").slice(0, 3).join(" / ");
  return h(
    "div",
    { class: "synthesis", "data-part": "synthesis" },
    h("h4", null, "What the material suggests"),
    line("Song", s.song.brief),
    line("Mood and genre", joined(s.song.mood, s.song.genre)),
    line("Tempo and key", joined(s.song.tempo === null ? "" : `${s.song.tempo} BPM`, s.song.key)),
    line("Story", s.song.story),
    line(
      `Draft lyrics${s.song.language === "" ? "" : ` (${s.song.language})`}`,
      lyrics === "" ? null : `${lyrics} …`,
    ),
    where === "treatment"
      ? h(
          "div",
          null,
          line("Concept", s.video.concept),
          line("Look", s.video.look),
          line("Cast", s.video.cast.map((each) => `${each.name} (${each.source})`).join(", ")),
        )
      : null,
  );
}

/** The words for a state of the block: nothing added, added but not read, ffmpeg missing, a failed read. */
export function stateNotes(v: SourcesView, running: boolean): Child[] {
  return [
    v.state === "none"
      ? h(
          "p",
          { class: "empty", "data-state": "no-sources" },
          "No source material in this project. Add pictures or videos and Gemini reads them.",
        )
      : null,
    v.state === "unread" && !running
      ? h(
          "p",
          { class: "meta", "data-state": "unread" },
          "Added, not read yet. Reading costs a few cents; you confirm first.",
        )
      : null,
    v.ffmpeg !== null && !v.ffmpeg.ok
      ? h(
          "div",
          { class: "notice warn", role: "alert", "data-state": "no-ffmpeg" },
          icon("alert"),
          h("div", { class: "notice-body" }, v.ffmpeg.message),
        )
      : null,
    v.state === "failed" && v.error !== null
      ? h(
          "div",
          { class: "notice error", role: "alert", "data-state": "failed" },
          icon("alert"),
          h("div", { class: "notice-body" }, `Reading the source material failed: ${v.error}`),
        )
      : null,
  ];
}

const READ_LABEL = {
  none: "",
  failed: "Try again",
  unread: "Read the source material",
  read: "Read again",
};

/** Read / Try again, and on the Treatment stage the button that fills the treatment. */
export function actionRow(
  v: SourcesView,
  where: "idea" | "treatment",
  blocked: boolean,
  on: { read: () => void; fill: () => void },
): Child {
  if (v.state === "none") return null;
  const noKey = !v.geminiKey;
  const readLabel = READ_LABEL[v.state];
  const showRead = v.state !== "read" || where === "treatment";
  return h(
    "div",
    { class: "actions" },
    showRead
      ? h(
          "button",
          {
            type: "button",
            class: `btn${v.state === "read" ? "" : " primary"}`,
            id: `${where}-source-read`,
            disabled: blocked || noKey,
            onclick: on.read,
          },
          readLabel,
        )
      : null,
    where === "treatment" && v.state === "read"
      ? h(
          "button",
          {
            type: "button",
            class: "btn primary",
            id: "treatment-from-sources",
            disabled: blocked,
            onclick: on.fill,
          },
          "Fill the treatment from this",
        )
      : null,
    noKey ? h("p", { class: "why", role: "status" }, keyHint) : null,
  );
}

/** What a job that ended says, as a message; null when it went well. */
export function endMessage(ended: Job): Message | null {
  if (ended.status === "failed")
    return { tone: "error", text: ended.error ?? "Reading the source material failed." };
  if (ended.status === "cancelled")
    return { tone: "info", text: "Cancelled. What was read is kept." };
  return null;
}

/** What an answer that did not start the run says. */
export function refused(answer: Extract<StartAnswer, { ok: false }>): Message {
  return answer.reason === "cancelled"
    ? { tone: "info", text: "Cancelled. Nothing was read and nothing was spent." }
    : { tone: "warn", text: answer.message };
}

/** Hands a picked file to the extension (the page has no file paths): where it was kept, or why not. */
export async function stageFile(file: File): Promise<{ path: string } | { message: Message }> {
  if (file.size > MAX_UPLOAD_BYTES)
    return {
      message: {
        tone: "warn",
        text: `${file.name} is over ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB. Type its full path in the box instead.`,
      },
    };
  try {
    const answer = await call<{ ok: true; path: string } | { ok: false; message: string }>(
      "sources-stage",
      { name: file.name, base64: toBase64(new Uint8Array(await file.arrayBuffer())) },
    );
    return answer.ok ? { path: answer.path } : { message: { tone: "warn", text: answer.message } };
  } catch (caught) {
    return { message: { tone: "error", text: errorText(caught) } };
  }
}
