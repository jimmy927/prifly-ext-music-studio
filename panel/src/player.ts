/**
 * A player for one audio file of a project. The audio comes from `api/media`:
 * a `media/…` url prifly streams where it serves the library folder, else
 * base64 in JSON that becomes a Blob and plays from its URL.
 */

import { call, errorText } from "./api";
import { h, icon } from "./dom";

let playing: HTMLAudioElement | null = null;

const clock = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export function blobUrl(base64: string, mime: string): string {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

export type Kind =
  | "sketch"
  | "version"
  | "stem"
  | "layer"
  | "mix"
  | "master"
  | "cast"
  | "frame"
  | "take"
  | "preview";

/** What `api/media` answers: a `url` to stream where prifly serves the library folder, else the bytes as `base64`. */
export type MediaAnswer = { mime: string; url?: string; base64?: string };

/** The file's type and where to get it from the extension. */
export async function fetchMedia(project: string, kind: Kind, id: string): Promise<MediaAnswer> {
  return await call<MediaAnswer>(
    `media?project=${encodeURIComponent(project)}&kind=${kind}&id=${encodeURIComponent(id)}&stream=1`,
  );
}

/** What an `<audio>`, `<video>` or `<img>` takes as `src`: the streaming url, else a Blob URL. */
export function mediaSrc(media: MediaAnswer): string {
  if (media.url !== undefined) return media.url;
  return blobUrl(media.base64 ?? "", media.mime);
}

/** The file's bytes, for decoding. */
export async function mediaBytes(media: MediaAnswer): Promise<ArrayBuffer> {
  if (media.url !== undefined) {
    const response = await fetch(media.url);
    if (!response.ok) throw new Error(`The file could not be loaded (${response.status}).`);
    return await response.arrayBuffer();
  }
  return Uint8Array.from(atob(media.base64 ?? ""), (char) => char.charCodeAt(0)).buffer;
}

/** A play button, a seek bar and the time, for one file. `label` names it for assistive tech. */
export function player(
  project: string,
  id: string,
  kind: Kind = "sketch",
  label = "",
): HTMLElement {
  const audio = new Audio();
  const button = h(
    "button",
    {
      type: "button",
      class: "play",
      "aria-label": `Play ${label === "" ? `sketch ${id.toUpperCase()}` : label}`,
    },
    icon("play", 18),
  );
  const seek = h("input", {
    type: "range",
    min: 0,
    max: 1000,
    value: 0,
    class: "seek",
    "aria-label": "Position",
  });
  const time = h("span", { class: "time" }, "0:00");
  const note = h("span", { class: "player-note", role: "status" });
  let loaded = false;

  const show = (name: "play" | "pause") => button.replaceChildren(icon(name, 18));
  audio.addEventListener("timeupdate", () => {
    if (audio.duration > 0)
      seek.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
    time.textContent = `${clock(audio.currentTime)} / ${clock(audio.duration || 0)}`;
  });
  audio.addEventListener("ended", () => show("play"));
  seek.addEventListener("input", () => {
    if (audio.duration > 0) audio.currentTime = (Number(seek.value) / 1000) * audio.duration;
  });

  button.addEventListener("click", async () => {
    if (!loaded) {
      button.disabled = true;
      note.textContent = "Loading…";
      try {
        const media = await fetchMedia(project, kind, id);
        audio.src = mediaSrc(media);
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
      if (playing !== null && playing !== audio) playing.pause();
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

/** Makes `audio` the one that plays: whatever else played is paused. */
export function claimPlayback(audio: HTMLAudioElement): void {
  if (playing !== null && playing !== audio) playing.pause();
  playing = audio;
}

/** Stops whatever plays, so the mix preview and a player never sound together. */
export function stopPlayers(): void {
  playing?.pause();
}
