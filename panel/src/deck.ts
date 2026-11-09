/** One audio file of a project, loaded from `api/media` on first use, for the A/B switch and the Prepare transport. */

import { errorText } from "./api";
import { blobUrl, claimPlayback, fetchMedia, type Kind } from "./player";

export class Deck {
  readonly audio = new Audio();
  readonly project: string;
  readonly kind: Kind;
  readonly id: string;
  private loading: Promise<void> | null = null;
  error: string | null = null;

  constructor(project: string, kind: Kind, id: string) {
    this.project = project;
    this.kind = kind;
    this.id = id;
  }

  /** Loads the audio once; a failure is kept in `error` and thrown. */
  load(): Promise<void> {
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

  get playing(): boolean {
    return !this.audio.paused;
  }

  async play(): Promise<void> {
    await this.load();
    claimPlayback(this.audio);
    await this.audio.play();
  }

  pause(): void {
    this.audio.pause();
  }

  seek(sec: number): void {
    if (Number.isFinite(sec)) this.audio.currentTime = Math.max(0, sec);
  }

  /** Stops it and lets the memory go. */
  dispose(): void {
    this.audio.pause();
    if (this.audio.src.startsWith("blob:")) URL.revokeObjectURL(this.audio.src);
    this.audio.removeAttribute("src");
  }
}

export const clock = (seconds: number): string => {
  const whole = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  return `${Math.floor(whole / 60)}:${(whole % 60).toFixed(1).padStart(4, "0")}`;
};
