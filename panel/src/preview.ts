/**
 * The Mix stage's live preview: each track is a buffer source through a gain
 * node (the level in dB, silent when muted or when another track is soloed)
 * and a stereo panner, all into one destination. Changing a level while it
 * plays changes the nodes at once; nothing is rendered.
 */

import { barStartMs } from "../../audio/bars";
import { audible, gainOf, type TrackMix } from "../../audio/mixgraph";
import type { MixTrack } from "./api";
import { fetchMedia } from "./player";

type Voice = {
  key: string;
  buffer: AudioBuffer;
  startSec: number;
  gain: GainNode;
  pan: StereoPannerNode;
};

async function decode(
  context: AudioContext,
  project: string,
  track: MixTrack,
): Promise<AudioBuffer> {
  const media = await fetchMedia(
    project,
    track.kind === "stem" ? "stem" : "layer",
    track.key.slice(track.key.indexOf(":") + 1),
  );
  const bytes = Uint8Array.from(atob(media.base64), (char) => char.charCodeAt(0));
  return await context.decodeAudioData(bytes.buffer);
}

export class Preview {
  private context: AudioContext | null = null;
  private voices: Voice[] = [];
  private sources: AudioBufferSourceNode[] = [];
  private loadedFor = "";
  playing = false;

  /** Forgets the loaded audio: stems or layers may have new files under the same names. */
  reset(): void {
    this.stop();
    this.voices = [];
    this.loadedFor = "";
  }

  /** Reads the tracks' audio (once per set of tracks). */
  async load(project: string, tracks: MixTrack[], tempo: number): Promise<void> {
    const id = `${project}|${tracks.map((each) => each.key).join(",")}|${tempo}`;
    if (id === this.loadedFor && this.voices.length > 0) return;
    this.stop();
    this.context ??= new AudioContext();
    const context = this.context;
    const voices: Voice[] = [];
    for (const track of tracks) {
      const gain = context.createGain();
      const pan = context.createStereoPanner();
      gain.connect(pan).connect(context.destination);
      voices.push({
        key: track.key,
        buffer: await decode(context, project, track),
        startSec: track.startBar === null ? 0 : barStartMs(track.startBar, tempo) / 1000,
        gain,
        pan,
      });
    }
    this.voices = voices;
    this.loadedFor = id;
  }

  /** Sets every voice's level, pan and silence from the mix. */
  apply(mix: Record<string, TrackMix>): void {
    const items = this.voices.map((voice) => ({
      key: voice.key,
      db: mix[voice.key]?.db ?? 0,
      pan: mix[voice.key]?.pan ?? 0,
      mute: mix[voice.key]?.mute === true,
      solo: mix[voice.key]?.solo === true,
    }));
    const heard = new Set(audible(items).map((each) => each.key));
    for (const [at, voice] of this.voices.entries()) {
      const item = items[at];
      voice.gain.gain.value = heard.has(voice.key) && item ? gainOf(item.db) : 0;
      voice.pan.pan.value = item?.pan ?? 0;
    }
  }

  async play(mix: Record<string, TrackMix>, onEnd: () => void): Promise<void> {
    const context = this.context;
    if (context === null || this.voices.length === 0) return;
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

  stop(): void {
    const stopping = this.sources;
    this.sources = [];
    for (const source of stopping) {
      try {
        source.stop();
      } catch {
        // A source that never started has nothing to stop.
      }
    }
    this.playing = false;
  }
}
