import type { Instrument } from '../types';
import { DRUM } from '../types';
import type { AppState, EngineChoice, Store } from './state';

/** Anything that can put a note on the strip: the player, or one of the band's instruments. */
export type VizSource = 'you' | Instrument;

export const PITCH_MIN = 36;
export const PITCH_MAX = 96;
/** bars of timeline on screen at once */
export const BARS_VISIBLE = 4;
/** where the playhead sits, as a fraction of the plot width — the rest is lookahead */
export const NOW_FRAC = 0.3;
export const RING_CAPACITY = 512;
export const SPECTRUM_BARS = 48;
const SPECTRUM_MIN_HZ = 60;
const SPECTRUM_MAX_HZ = 8000;

const BEATS_PER_BAR = 4;
/** width of the pitch ruler gutter, in CSS px */
const GUTTER = 26;
const PAD_TOP = 9;
const PAD_BOTTOM = 6;
/** seconds a note keeps its attack glow */
const GLOW_SEC = 0.15;

const SOURCE_COLOR: Record<VizSource, string> = {
  you: '#17b26a',
  drums: '#ff5a1f',
  bass: '#1e5cff',
  keys: '#3fa36b',
  lead: '#ff3fa4',
};
const YOU_OUTLINE = '#8cffc4';

const ENGINE_COLOR: Record<EngineChoice, string> = {
  patterns: '#ffd400',
  lyria: '#ff3fa4',
  acestep: '#ff5a1f',
  amt: '#1e5cff',
};
/** engines whose output is audio rather than notes, so the strip also shows a spectrum */
const AUDIO_ENGINES: EngineChoice[] = ['lyria', 'acestep'];

const GRID_BEAT = '#17402c';
const GRID_BAR = '#256b49';
const BEAT_FLASH = '#2aff95';
const LANE_GUIDE = '#0f2a1d';
const LABEL = '#3f7a5c';
const BG = '#04100a';
const NOW_LINE = '#2aff95';

/** Drum voices from the top lane down; anything unrecognised lands on the middle lane. */
const DRUM_LANES: number[] = [DRUM.crash, DRUM.openHat, DRUM.hat, DRUM.snare, DRUM.kick];

const MONO_FONT = '9px "DM Mono", ui-monospace, monospace';
const RULER_PITCHES = [48, 60, 72];
const RULER_LABELS = ['C3', 'C4', 'C5'];

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

/** Horizontal position of an absolute time, with `now` pinned at NOW_FRAC across the plot. */
export function timeToX(t: number, now: number, pxPerSec: number, left: number, width: number, nowFrac = NOW_FRAC): number {
  return left + width * nowFrac + (t - now) * pxPerSec;
}

/** Pixels per second so that `bars` bars of 4/4 at `bpm` exactly fill `width`. */
export function pxPerSecond(width: number, bpm: number, bars = BARS_VISIBLE): number {
  const barSec = (60 / bpm) * BEATS_PER_BAR;
  return width / (bars * barSec);
}

/** MIDI pitch to a y inside [top, bottom]; PITCH_MAX sits at `top`. Out-of-range notes clamp. */
export function pitchToY(midi: number, top: number, bottom: number): number {
  const clamped = Math.min(PITCH_MAX, Math.max(PITCH_MIN, midi));
  const f = (clamped - PITCH_MIN) / (PITCH_MAX - PITCH_MIN);
  return bottom - f * (bottom - top);
}

/** Lane index (0 = top) for a drum voice. */
export function drumLane(note: number): number {
  const i = DRUM_LANES.indexOf(note);
  return i < 0 ? 2 : i;
}

/**
 * `count` FFT bin edges spaced evenly in log frequency between fMin and fMax.
 * Monotonic and clamped to the analyser's bin range, so adjacent edges can repeat
 * at the low end where bins are wider than the log step.
 */
export function logSpacedBins(count: number, fMin: number, fMax: number, sampleRate: number, fftSize: number): Int32Array {
  const out = new Int32Array(count);
  const bins = fftSize / 2;
  const hzPerBin = sampleRate / fftSize;
  const ratio = fMax / fMin;
  let last = 0;
  for (let i = 0; i < count; i++) {
    const f = fMin * Math.pow(ratio, count === 1 ? 0 : i / (count - 1));
    const bin = Math.min(bins - 1, Math.max(0, Math.round(f / hzPerBin)));
    last = Math.max(last, bin);
    out[i] = last;
  }
  return out;
}

export interface VizNoteSlot {
  source: VizSource;
  midi: number;
  /** absolute AudioContext time the note starts */
  start: number;
  /** absolute AudioContext time the note ends */
  end: number;
  velocity: number;
}

/**
 * Fixed-size ring of note slots, preallocated once and mutated in place so drawing
 * a frame allocates nothing. Adding past capacity overwrites the oldest entry.
 */
export class NoteRing {
  private slots: VizNoteSlot[] = [];
  private tail = 0;
  private count = 0;

  constructor(readonly capacity = RING_CAPACITY) {
    for (let i = 0; i < capacity; i++) {
      this.slots.push({ source: 'you', midi: 0, start: 0, end: 0, velocity: 0 });
    }
  }

  get length(): number {
    return this.count;
  }

  add(source: VizSource, midi: number, start: number, duration: number, velocity: number): void {
    const head = (this.tail + this.count) % this.capacity;
    const slot = this.slots[head];
    slot.source = source;
    slot.midi = midi;
    slot.start = start;
    slot.end = start + Math.max(0, duration);
    slot.velocity = velocity;
    if (this.count === this.capacity) this.tail = (this.tail + 1) % this.capacity;
    else this.count++;
  }

  /** Oldest-first access; `i` must be < length. */
  at(i: number): VizNoteSlot {
    return this.slots[(this.tail + i) % this.capacity];
  }

  /** Drops leading notes that finished before `cutoff`. */
  prune(cutoff: number): void {
    while (this.count > 0 && this.slots[this.tail].end < cutoff) {
      this.tail = (this.tail + 1) % this.capacity;
      this.count--;
    }
  }

  clear(): void {
    this.tail = 0;
    this.count = 0;
  }
}

// ---------------------------------------------------------------------------
// canvas strip
// ---------------------------------------------------------------------------

export class Viz {
  private ctx: CanvasRenderingContext2D | null;
  private notes = new NoteRing();
  private analyser?: AnalyserNode;
  private freqData?: Uint8Array;
  private binEdges?: Int32Array;
  private firstBarAt = 0;
  private bpm = 120;
  private clockSet = false;
  private raf = 0;
  private lastDrawMs = 0;
  private minFrameMs = 0;
  private reduced = false;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private running = false;
  private engine: EngineChoice = 'patterns';
  private powered = false;
  private unsubscribe?: () => void;
  private observer?: ResizeObserver;

  constructor(
    private canvas: HTMLCanvasElement,
    store: Store,
    /** "now" in the same time base as the note times handed to addNote (AudioContext seconds) */
    private now: () => number,
  ) {
    this.ctx = canvas.getContext('2d');
    this.reduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // reduced motion: 10 fps and no glow, rather than a frozen strip that would
    // hide where the band is in the bar
    this.minFrameMs = this.reduced ? 100 : 0;

    this.measure();
    if (typeof ResizeObserver === 'function') {
      this.observer = new ResizeObserver(() => this.measure());
      this.observer.observe(canvas);
    } else {
      window.addEventListener('resize', this.onResize);
    }
    document.addEventListener('visibilitychange', this.onVisibility);
    this.apply(store.state);
    this.unsubscribe = store.subscribe(s => this.apply(s));
  }

  /** Ties the timeline to the band's bar grid. Called on start and on every bpm change. */
  setClock(firstBarAt: number, bpm: number): void {
    if (!(bpm > 0)) return;
    this.firstBarAt = firstBarAt;
    this.bpm = bpm;
    this.clockSet = true;
  }

  /**
   * Re-anchors the grid to a new tempo. The bar the playhead is in keeps its number and
   * its downbeat, so following a tempo change doesn't make the grid jump sideways.
   */
  setBpm(bpm: number): void {
    if (!(bpm > 0)) return;
    if (!this.clockSet) {
      this.bpm = bpm;
      return;
    }
    const barSec = (60 / this.bpm) * BEATS_PER_BAR;
    const bars = Math.floor((this.now() - this.firstBarAt) / barSec);
    const barStart = this.firstBarAt + bars * barSec;
    this.setClock(barStart - bars * (60 / bpm) * BEATS_PER_BAR, bpm);
  }

  /** `start` and `duration` are absolute AudioContext seconds. */
  addNote(source: VizSource, midi: number, start: number, duration: number, velocity = 0.8): void {
    if (!Number.isFinite(midi) || !Number.isFinite(start)) return;
    this.notes.add(source, midi, start, duration, velocity);
  }

  /** Spectrum tap for the audio engines; pass undefined to drop it. */
  setAnalyser(node?: AnalyserNode | null): void {
    this.analyser = node ?? undefined;
    this.freqData = undefined;
    this.binEdges = undefined;
    if (!node) return;
    node.fftSize = 2048;
    node.smoothingTimeConstant = 0.7;
    this.freqData = new Uint8Array(node.frequencyBinCount);
    this.binEdges = logSpacedBins(
      SPECTRUM_BARS + 1,
      SPECTRUM_MIN_HZ,
      SPECTRUM_MAX_HZ,
      node.context.sampleRate,
      node.fftSize,
    );
  }

  clear(): void {
    this.notes.clear();
    this.clockSet = false;
  }

  destroy(): void {
    this.stop();
    this.unsubscribe?.();
    this.observer?.disconnect();
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  private apply(s: AppState): void {
    this.engine = s.engine;
    const powered = s.power === 'on';
    if (powered !== this.powered) {
      this.powered = powered;
      if (!powered) this.clear();
    }
    this.sync();
  }

  /** Runs only while there is something to animate: powered on and tab visible. */
  private sync(): void {
    const want = this.powered && !document.hidden;
    if (want === this.running) return;
    if (want) this.start();
    else this.stop();
  }

  private start(): void {
    if (this.running) return;
    this.running = true;
    this.lastDrawMs = 0;
    this.raf = requestAnimationFrame(this.tick);
  }

  private stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.draw(); // leave an idle grid behind rather than a stale frame
  }

  private onResize = (): void => {
    this.measure();
  };

  private onVisibility = (): void => {
    this.sync();
  };

  private tick = (): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.tick);
    const t = performance.now();
    if (this.minFrameMs && t - this.lastDrawMs < this.minFrameMs) return;
    this.lastDrawMs = t;
    this.draw();
  };

  private measure(): void {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (w === this.width && h === this.height && dpr === this.dpr) return;
    this.width = w;
    this.height = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx || this.width < 2) return;
    const W = this.width;
    const H = this.height;
    const now = this.now();
    const bpm = this.bpm;
    const beatSec = 60 / bpm;
    const barSec = beatSec * BEATS_PER_BAR;
    const plotW = W - GUTTER;
    const pps = pxPerSecond(plotW, bpm);
    const nowX = GUTTER + plotW * NOW_FRAC;
    // drums get their own lanes along the bottom so the pitched voices keep the
    // full vertical range above them
    const drumH = Math.min(26, H * 0.24);
    const top = PAD_TOP;
    const bottom = H - PAD_BOTTOM - drumH;
    const laneStep = drumH / DRUM_LANES.length;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    this.notes.prune(now - BARS_VISIBLE * barSec);

    if (this.analyser && AUDIO_ENGINES.includes(this.engine)) this.drawSpectrum(ctx, GUTTER, plotW, H);
    this.drawGrid(ctx, now, pps, nowX, plotW, H, beatSec);

    // drum lane guides, so an empty lane still reads as a lane
    ctx.fillStyle = LANE_GUIDE;
    for (let i = 0; i < DRUM_LANES.length; i++) {
      ctx.fillRect(GUTTER, Math.round(H - PAD_BOTTOM - drumH + (i + 0.5) * laneStep), plotW, 1);
    }

    this.drawNotes(ctx, now, pps, nowX, plotW, top, bottom, drumH, laneStep, H);
    this.drawRuler(ctx, top, bottom, W);

    // playhead
    ctx.fillStyle = NOW_LINE;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(Math.round(nowX), 0, 1, H);
    ctx.globalAlpha = 1;
  }

  private drawSpectrum(ctx: CanvasRenderingContext2D, left: number, plotW: number, H: number): void {
    const data = this.freqData;
    const edges = this.binEdges;
    if (!data || !edges) return;
    this.analyser!.getByteFrequencyData(data as Uint8Array<ArrayBuffer>);
    const cy = H / 2;
    const barW = plotW / SPECTRUM_BARS;
    ctx.fillStyle = ENGINE_COLOR[this.engine];
    ctx.globalAlpha = 0.22;
    for (let i = 0; i < SPECTRUM_BARS; i++) {
      const from = edges[i];
      const to = Math.max(from + 1, edges[i + 1]);
      let peak = 0;
      for (let b = from; b < to && b < data.length; b++) if (data[b] > peak) peak = data[b];
      const half = (peak / 255) * (H / 2 - 2);
      if (half < 0.5) continue;
      ctx.fillRect(left + i * barW + 0.5, cy - half, barW - 1, half * 2);
    }
    ctx.globalAlpha = 1;
  }

  private drawGrid(
    ctx: CanvasRenderingContext2D,
    now: number,
    pps: number,
    nowX: number,
    plotW: number,
    H: number,
    beatSec: number,
  ): void {
    const leftTime = now - (nowX - GUTTER) / pps;
    const rightTime = leftTime + plotW / pps;
    const firstBeat = Math.floor((leftTime - this.firstBarAt) / beatSec);
    const lastBeat = Math.ceil((rightTime - this.firstBarAt) / beatSec);
    const nowBeat = Math.floor((now - this.firstBarAt) / beatSec);
    ctx.font = MONO_FONT;
    ctx.textBaseline = 'top';

    // brightest right on the beat, gone by the next one
    const phase = (now - this.firstBarAt) / beatSec - nowBeat;
    const fade = 1 - Math.min(1, Math.max(0, phase));

    for (let b = firstBeat; b <= lastBeat; b++) {
      const t = this.firstBarAt + b * beatSec;
      const x = Math.round(timeToX(t, now, pps, GUTTER, plotW));
      if (x < GUTTER - 1 || x > GUTTER + plotW) continue;
      const isBar = ((b % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR === 0;
      const isNow = this.clockSet && b === nowBeat;
      if (isNow) {
        ctx.globalAlpha = 0.25 + 0.75 * fade * fade;
        ctx.fillStyle = BEAT_FLASH;
      } else {
        ctx.fillStyle = isBar ? GRID_BAR : GRID_BEAT;
      }
      ctx.fillRect(x, isBar || isNow ? 0 : 6, 1, isBar || isNow ? H : H - 10);
      ctx.globalAlpha = 1;
      if (isBar && this.clockSet) {
        ctx.fillStyle = LABEL;
        ctx.fillText(barLabel(b / BEATS_PER_BAR), x + 4, 2);
      }
    }

    // the beat the playhead is inside also lights up as a band, so the pulse reads
    // from across the room and not just on the line
    if (this.clockSet) {
      const x = Math.max(GUTTER, timeToX(this.firstBarAt + nowBeat * beatSec, now, pps, GUTTER, plotW));
      const w = Math.min(beatSec * pps, GUTTER + plotW - x);
      ctx.fillStyle = BEAT_FLASH;
      ctx.globalAlpha = 0.07 * fade * fade;
      ctx.fillRect(x, 0, w, H);
      ctx.globalAlpha = 1;
    }
  }

  private drawNotes(
    ctx: CanvasRenderingContext2D,
    now: number,
    pps: number,
    nowX: number,
    plotW: number,
    top: number,
    bottom: number,
    drumH: number,
    laneStep: number,
    H: number,
  ): void {
    const right = GUTTER + plotW;
    const pitchH = Math.max(5, Math.min(8, (bottom - top) / 12));
    const drumPillH = Math.max(3, laneStep - 2);
    const glow = !this.reduced;

    for (let i = 0; i < this.notes.length; i++) {
      const n = this.notes.at(i);
      const x = timeToX(n.start, now, pps, GUTTER, plotW);
      const w = Math.max(5, (n.end - n.start) * pps);
      if (x > right || x + w < GUTTER) continue;

      let y: number;
      let h: number;
      if (n.source === 'drums') {
        h = drumPillH;
        y = H - PAD_BOTTOM - drumH + drumLane(n.midi) * laneStep + (laneStep - h) / 2;
      } else {
        h = pitchH;
        y = pitchToY(n.midi, top, bottom) - h / 2;
      }

      const color = SOURCE_COLOR[n.source];
      const clipX = Math.max(GUTTER, x);
      const clipW = Math.min(right, x + w) - clipX;
      if (clipW <= 0) continue;

      const fresh = glow && now >= n.start && now - n.start < GLOW_SEC;
      if (fresh) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 12 * (1 - (now - n.start) / GLOW_SEC);
      }

      if (n.end <= now) {
        ctx.globalAlpha = 1;
        pill(ctx, clipX, y, clipW, h, color);
      } else if (n.start > now) {
        ctx.globalAlpha = 0.5;
        pill(ctx, clipX, y, clipW, h, color);
      } else {
        // straddling the playhead: the played part is solid, the rest still ghosted
        ctx.globalAlpha = 0.5;
        pill(ctx, clipX, y, clipW, h, color);
        const playedW = Math.min(nowX, right) - clipX;
        if (playedW > 0) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(clipX, 0, playedW, H);
          ctx.clip();
          ctx.globalAlpha = 1;
          pill(ctx, clipX, y, clipW, h, color);
          ctx.restore();
        }
      }

      if (n.source === 'you') {
        ctx.globalAlpha = n.start > now ? 0.5 : 1;
        ctx.strokeStyle = YOU_OUTLINE;
        ctx.lineWidth = 1;
        roundRectPath(ctx, clipX + 0.5, y + 0.5, Math.max(1, clipW - 1), Math.max(1, h - 1));
        ctx.stroke();
      }

      if (fresh) ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  private drawRuler(ctx: CanvasRenderingContext2D, top: number, bottom: number, W: number): void {
    ctx.font = MONO_FONT;
    ctx.textBaseline = 'middle';
    for (let i = 0; i < RULER_PITCHES.length; i++) {
      const y = Math.round(pitchToY(RULER_PITCHES[i], top, bottom));
      ctx.fillStyle = GRID_BEAT;
      ctx.fillRect(GUTTER, y, W - GUTTER, 1);
      ctx.fillStyle = LABEL;
      ctx.fillText(RULER_LABELS[i], 3, y);
    }
    ctx.fillStyle = GRID_BEAT;
    ctx.fillRect(GUTTER - 1, 0, 1, bottom + 8);
  }
}

/** Bar numbers, memoised so a frame doesn't allocate a string per bar line. */
const barLabels = new Map<number, string>();
function barLabel(bar: number): string {
  let s = barLabels.get(bar);
  if (s === undefined) {
    s = String(bar);
    barLabels.set(bar, s);
  }
  return s;
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const r = Math.min(h / 2, w / 2);
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function pill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  roundRectPath(ctx, x, y, w, h);
  ctx.fill();
}

export function createViz(canvas: HTMLCanvasElement, store: Store, now: () => number): Viz {
  return new Viz(canvas, store, now);
}
