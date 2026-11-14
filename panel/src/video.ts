/**
 * What the four Video stages' pages share: the budget line, pictures and clips
 * fetched from `api/media` (streamed where prifly serves the folder, else base64 in Blob URLs), the one-line
 * reasons a stage is blocked, and picking up a run that was started before
 * the page was reopened.
 */

import { money } from "../../video/constants";
import { call, errorText, type Job, type JobsView, type MoneyView } from "./api";
import { h } from "./dom";
import { followLocal, localBusy } from "./local";
import { fetchMedia, type Kind, mediaSrc } from "./player";
import { app } from "./state";
import { busy, follow } from "./work";

export const usd = money;

const LOCAL_WORK = ["draft", "preview", "render", "master", "analyse", "deliver"];

/** Spent against the budget, as words and a bar of fixed height. */
export function moneyLine(m: MoneyView | null): HTMLElement {
  const share = m === null || m.budgetUsd <= 0 ? 0 : Math.min(1, m.spentUsd / m.budgetUsd);
  const over = m !== null && m.remainingUsd <= 0;
  return h(
    "div",
    { class: `money${over ? " over" : ""}`, "data-part": "money", role: "status" },
    h(
      "span",
      { class: "money-text" },
      m === null
        ? "Budget: loading…"
        : `${usd(m.spentUsd)} spent of the ${usd(m.budgetUsd)} budget${m.own ? "" : " (the extension's setting)"}, ${usd(m.remainingUsd)} left. Estimates from Google's prices; the bill is Google's.`,
    ),
    h(
      "div",
      { class: "track", "aria-hidden": "true" },
      h("div", { class: "fill", style: `width:${Math.round(share * 100)}%` }),
    ),
  );
}

const urls = new Map<string, string>();
const loading = new Map<string, Promise<string>>();

/** The Blob URL of a picture or clip, fetched once per `key` (a name that changes when the file does). */
export async function mediaUrl(
  project: string,
  kind: Kind,
  id: string,
  key: string,
): Promise<string> {
  const cacheKey = `${project}:${kind}:${id}:${key}`;
  const known = urls.get(cacheKey);
  if (known !== undefined) return known;
  let pending = loading.get(cacheKey);
  if (pending === undefined) {
    pending = fetchMedia(project, kind, id).then((media) => {
      const url = mediaSrc(media);
      urls.set(cacheKey, url);
      return url;
    });
    loading.set(cacheKey, pending);
    pending.finally(() => loading.delete(cacheKey)).catch(() => undefined);
  }
  return await pending;
}

/** A picture that loads when it is built; `alt` stands in until then and if it fails. */
export function picture(
  project: string,
  kind: "cast" | "frame",
  id: string,
  key: string,
  alt: string,
): HTMLElement {
  const img = h("img", { alt, class: "pic", loading: "lazy" });
  const wrap = h("div", { class: "pic-wrap", "data-kind": kind }, img);
  mediaUrl(project, kind, id, key).then(
    (url) => {
      img.src = url;
    },
    (caught: unknown) => {
      wrap.classList.add("failed");
      wrap.title = errorText(caught);
    },
  );
  return wrap;
}

/** A clip that loads when "Play" is pressed (so a page of shots does not fetch every video). */
export function clip(
  project: string,
  kind: "take" | "preview",
  id: string,
  label: string,
): HTMLElement {
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
  return h(
    "div",
    { class: "clip-box", "data-kind": kind },
    video,
    h("div", { class: "clip-bar" }, button, note),
  );
}

/** Picks up a run for this project that was started before the page was opened (paid, or local). */
export async function reattach(
  kinds: Job["work"][],
  after: () => Promise<void>,
  done: (job: Job) => Promise<string>,
): Promise<void> {
  const project = app.project;
  if (project === null || busy() || localBusy()) return;
  try {
    const answer = await call<JobsView>(`jobs?project=${encodeURIComponent(project.id)}`);
    const job = answer.jobs.find((each) => kinds.includes(each.work));
    if (job === undefined) return;
    if (job.work === "draft" || job.work === "preview" || job.work === "render")
      void followLocal(job.work, job, done);
    else if (!LOCAL_WORK.includes(job.work)) void follow(job, after);
  } catch {
    // The stage's own load reports a broken connection.
  }
}

/** Changes the words of a button, keeping its icon. */
export function setLabel(button: HTMLElement, text: string): void {
  button.lastChild?.replaceWith(document.createTextNode(text));
}

export const plural = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

export const keyHint = "No Gemini key. Add it in Settings → Extensions → Music Studio.";
