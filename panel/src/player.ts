/**
 * A sketch's player. The host serves no audio files, so the audio comes from
 * `api/media` as base64 in JSON, becomes a Blob and plays from its URL.
 */

import { call, errorText } from "./api";
import { h, icon } from "./dom";

let playing: HTMLAudioElement | null = null;

const clock = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

function blobUrl(base64: string, mime: string): string {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

/** A play button, a seek bar and the time, for one sketch. */
export function player(project: string, sketch: string): HTMLElement {
  const audio = new Audio();
  const button = h(
    "button",
    { type: "button", class: "play", "aria-label": `Play sketch ${sketch.toUpperCase()}` },
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
        const media = await call<{ mime: string; base64: string }>(
          `media?project=${encodeURIComponent(project)}&sketch=${encodeURIComponent(sketch)}`,
        );
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
