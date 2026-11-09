/**
 * The waveform of a prepared track as one SVG: the peaks, the beatgrid (bar
 * lines stronger than beat lines), the cue flags, the loop, and the playhead.
 * It shows the whole track or a window of it; a click asks the page to seek.
 */

import { beatsBetween, type Cue, type Grid } from "../../prep/grid";

const NS = "http://www.w3.org/2000/svg";
const WIDTH = 1000;
const HEIGHT = 150;
const MID = HEIGHT / 2;

export type WaveData = {
  peaks: number[];
  perSec: number;
  durationSec: number;
  grid: Grid | null;
  cues: Cue[];
  loop: { startSec: number; endSec: number } | null;
};

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
  text?: string,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

export class Waveform {
  readonly root: HTMLElement;
  private readonly canvas: SVGSVGElement;
  private playhead: SVGLineElement | null = null;
  private data: WaveData | null = null;
  private span = 0;
  private start = 0;
  private head = 0;
  private readonly seekTo: (sec: number) => void;

  constructor(seekTo: (sec: number) => void) {
    this.seekTo = seekTo;
    this.canvas = svg("svg", {
      viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
      preserveAspectRatio: "none",
      class: "wf",
      role: "img",
      "aria-label": "Waveform with beatgrid and cues",
    });
    this.canvas.addEventListener("click", (event) => this.click(event));
    this.root = document.createElement("div");
    this.root.className = "wave";
    this.root.append(this.canvas);
  }

  /** The seconds in view; 0 is the whole track. */
  get window(): { from: number; to: number } {
    const duration = this.data?.durationSec ?? 0;
    const length = this.span === 0 ? duration : Math.min(this.span, duration);
    const from = this.span === 0 ? 0 : Math.min(this.start, Math.max(0, duration - length));
    return { from, to: from + length };
  }

  setData(data: WaveData | null): void {
    this.data = data;
    this.draw();
  }

  setWindow(span: number, start: number): void {
    this.span = span;
    this.start = start;
    this.draw();
  }

  setPlayhead(sec: number): void {
    this.head = sec;
    this.moveHead();
  }

  private x(sec: number): number {
    const { from, to } = this.window;
    return to > from ? ((sec - from) / (to - from)) * WIDTH : 0;
  }

  private moveHead(): void {
    if (this.playhead === null) return;
    const x = this.x(this.head);
    this.playhead.setAttribute("x1", String(x));
    this.playhead.setAttribute("x2", String(x));
    this.playhead.setAttribute("visibility", x >= 0 && x <= WIDTH ? "visible" : "hidden");
  }

  private click(event: MouseEvent): void {
    const box = this.canvas.getBoundingClientRect();
    if (box.width === 0) return;
    const { from, to } = this.window;
    this.seekTo(from + ((event.clientX - box.left) / box.width) * (to - from));
  }

  private outline(): string {
    const data = this.data;
    if (data === null || data.peaks.length === 0) return "";
    const { from, to } = this.window;
    const top: string[] = [];
    const bottom: string[] = [];
    for (let column = 0; column < WIDTH; column += 1) {
      const a = Math.floor((from + ((to - from) * column) / WIDTH) * data.perSec);
      const b = Math.max(
        a + 1,
        Math.floor((from + ((to - from) * (column + 1)) / WIDTH) * data.perSec),
      );
      let peak = 0;
      for (let at = a; at < b; at += 1) peak = Math.max(peak, data.peaks[at] ?? 0);
      const half = (peak / 255) * (MID - 14);
      top.push(`${column},${(MID - half).toFixed(1)}`);
      bottom.unshift(`${column},${(MID + half).toFixed(1)}`);
    }
    return [...top, ...bottom].join(" ");
  }

  private grid(): SVGElement[] {
    const data = this.data;
    if (data === null || data.grid === null) return [];
    const { from, to } = this.window;
    const beats = beatsBetween(data.grid, from, to);
    const every = beats.length > 360 ? 4 : 1;
    return beats
      .filter((each) => every === 1 || each.beat === 1)
      .map((each) =>
        svg("line", {
          x1: this.x(each.sec),
          x2: this.x(each.sec),
          y1: each.beat === 1 ? 0 : 18,
          y2: HEIGHT,
          class: each.beat === 1 ? "wf-bar" : "wf-beat",
        }),
      );
  }

  private marks(): SVGElement[] {
    const data = this.data;
    if (data === null) return [];
    const { from, to } = this.window;
    const out: SVGElement[] = [];
    if (data.loop !== null) {
      const left = this.x(Math.max(from, data.loop.startSec));
      const right = this.x(Math.min(to, data.loop.endSec));
      if (right > left)
        out.push(
          svg("rect", { x: left, y: 0, width: right - left, height: HEIGHT, class: "wf-loop" }),
        );
    }
    for (const cue of data.cues) {
      if (cue.sec < from || cue.sec > to) continue;
      const x = this.x(cue.sec);
      out.push(
        svg("line", { x1: x, x2: x, y1: 0, y2: HEIGHT, class: "wf-cue" }),
        svg("rect", { x, y: 0, width: 16, height: 16, class: "wf-flag" }),
        svg("text", { x: x + 8, y: 12, class: "wf-letter", "text-anchor": "middle" }, cue.slot),
      );
    }
    return out;
  }

  draw(): void {
    this.canvas.replaceChildren(
      svg("line", { x1: 0, x2: WIDTH, y1: MID, y2: MID, class: "wf-mid" }),
      svg("polygon", { points: this.outline(), class: "wf-wave" }),
      ...this.grid(),
      ...this.marks(),
    );
    this.playhead = svg("line", { x1: 0, x2: 0, y1: 0, y2: HEIGHT, class: "wf-head" });
    this.canvas.append(this.playhead);
    this.moveHead();
  }
}
