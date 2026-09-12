import { magnitudeSpectrum } from './fft';

/**
 * Spectral-flux onset detection.
 *
 * The old detector compared frame RMS against an EMA "noise floor". That only
 * worked for isolated percussive hits: while somebody actually plays, the floor
 * climbs to the playing level and the 3x floor gate swallows every following
 * note, and a level-only test cannot see a legato note change at all. This one
 * looks at the *spectrum*: how much energy appeared in bins that were quieter a
 * hop ago. A new note lights up new partials even when the level never dips, so
 * legato and sustained playing register, while a steady tone or steady noise
 * produces almost no flux no matter how loud it is.
 *
 * Per hop (512 samples @ 48 kHz ≈ 10.7 ms):
 *   flux[n] = Σ_k max(0, log1p(K·mag[n][k]) − log1p(K·mag[n−1][k]))
 * A frame is an onset when its flux beats a median-of-the-last-second threshold,
 * is the largest in a ±3-hop neighbourhood, and is far enough from the previous
 * onset. The ±3 lookahead means an onset is reported ~3 hops (≈32 ms) after it
 * happened, timestamped with when it actually happened.
 */

/** Log-compression constant. Mirrored in public/worklet/onset-processor.js. */
export const FLUX_K = 20;
/**
 * Flux is summed over this band only. Below it there is nothing but rumble and
 * DC; above it, mic hiss and the fizz of a decaying cymbal keep fluctuating
 * under a held note, which is exactly the "steady tone still produces flux"
 * false positive this detector exists to avoid.
 */
export const FLUX_LO_HZ = 40;
export const FLUX_HI_HZ = 5000;

export interface OnsetOptions {
  /** Minimum time between onsets, seconds. */
  minGapSec?: number;
  /** Length of the median window used for the adaptive threshold, seconds. */
  medianWindowSec?: number;
  /**
   * Threshold = median × mult + delta. The multiplier has to clear the ratio a
   * *steady* input reaches on its own: measured against steady pink noise and a
   * vibrato'd held note, flux wanders up to ~1.7× its running median, so the
   * textbook 1.5 fires on hiss alone. Real onsets sit one to two orders of
   * magnitude above the median, so 2.5 costs no sensitivity. `delta` covers the
   * other end — a median still half-full of silence right after the first note.
   */
  mult?: number;
  delta?: number;
  /**
   * Which quantile of the window the threshold is built on. A plain median goes
   * wrong in the second right after the first note, when half the window is
   * still the silence from before it: the baseline collapses and the held note's
   * own wobble clears the threshold. The upper quartile tracks the level the
   * input is actually sitting at, and onsets are far too rare to move it.
   */
  quantile?: number;
  /** Half-width of the peak-picking neighbourhood, in hops. */
  lookaheadHops?: number;
  /** Sample rate of the spectra fed to process(), used to map the flux band to bins. */
  sampleRate?: number;
}

interface Frame {
  flux: number;
  t: number;
  thr: number;
}

export class OnsetDetector {
  private prevC: Float32Array | null = null;
  /** flux history for the adaptive threshold, trimmed to medianWindowSec */
  private hist: Frame[] = [];
  /** peak-picking neighbourhood: 2·lookahead+1 frames, oldest first */
  private win: Frame[] = [];
  private lastOnset = -Infinity;
  private level = 0;
  private readonly gap: number;
  private readonly windowSec: number;
  private readonly mult: number;
  private readonly delta: number;
  private readonly look: number;
  private readonly quantile: number;
  private readonly sampleRate: number;

  constructor(o: OnsetOptions = {}) {
    this.gap = o.minGapSec ?? 0.08;
    this.windowSec = o.medianWindowSec ?? 1;
    this.mult = o.mult ?? 2.5;
    this.delta = o.delta ?? 0.12;
    this.look = o.lookaheadHops ?? 3;
    this.quantile = o.quantile ?? 0.75;
    this.sampleRate = o.sampleRate ?? 48000;
  }

  /**
   * Feed one hop's linear magnitude spectrum.
   * Returns true when a (slightly earlier) frame is confirmed as an onset;
   * its timestamp is `lastOnsetTime`.
   */
  process(mag: Float32Array, t: number, rms?: number): boolean {
    return this.pushFlux(this.flux(mag), t, rms) !== null;
  }

  /** Same, straight from a time-domain frame (length must be a power of two). */
  processFrame(frame: Float32Array, t: number): boolean {
    let s = 0;
    for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i];
    return this.process(magnitudeSpectrum(frame), t, Math.sqrt(s / frame.length));
  }

  /**
   * Feed a flux value computed elsewhere (the AudioWorklet does the FFT off the
   * main thread). Returns the onset time in seconds, or null.
   */
  pushFlux(flux: number, t: number, rms?: number): number | null {
    if (rms !== undefined) this.level = Math.min(1, rms * 20);

    const thr = this.threshold(flux, t);
    const frame = { flux, t, thr };
    this.win.push(frame);
    const span = 2 * this.look + 1;
    if (this.win.length < span) return null;
    if (this.win.length > span) this.win.shift();

    const c = this.win[this.look];
    if (c.flux <= c.thr) return null;
    for (let i = 0; i < span; i++) {
      if (i === this.look) continue;
      // strict on the left so a flat run reports its first frame, not its last
      if (i < this.look ? this.win[i].flux >= c.flux : this.win[i].flux > c.flux) return null;
    }
    if (c.t - this.lastOnset < this.gap) return null;
    this.lastOnset = c.t;
    return c.t;
  }

  /** Spectral flux of `mag` (linear magnitudes) against the previous spectrum. */
  flux(mag: Float32Array): number {
    const binHz = this.sampleRate / (2 * mag.length);
    const lo = Math.max(1, Math.round(FLUX_LO_HZ / binHz));
    const hi = Math.min(mag.length, Math.round(FLUX_HI_HZ / binHz));
    const c = new Float32Array(mag.length);
    for (let i = lo; i < hi; i++) c[i] = Math.log1p(FLUX_K * mag[i]);
    const prev = this.prevC;
    this.prevC = c;
    if (!prev || prev.length !== c.length) return 0;
    let f = 0;
    for (let i = lo; i < hi; i++) {
      const d = c[i] - prev[i];
      if (d > 0) f += d;
    }
    return f;
  }

  /** Adaptive threshold from the last `windowSec` of flux. */
  private threshold(flux: number, t: number): number {
    this.hist.push({ flux, t, thr: 0 });
    while (this.hist.length && t - this.hist[0].t > this.windowSec) this.hist.shift();
    const sorted = this.hist.map(h => h.flux).sort((a, b) => a - b);
    const base = sorted[Math.floor(this.quantile * (sorted.length - 1))];
    return base * this.mult + this.delta;
  }

  get inputLevel(): number {
    return this.level;
  }

  get lastOnsetTime(): number {
    return this.lastOnset;
  }

  reset(): void {
    this.prevC = null;
    this.hist = [];
    this.win = [];
    this.lastOnset = -Infinity;
    this.level = 0;
  }
}
