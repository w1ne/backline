/**
 * Tempo from a solo voice.
 *
 * A singer's onsets are syllables, so an inter-onset histogram (tempoLock.ts) lands on the
 * syllable rate: 1.5-2x the beat on most real songs. What a voice does carry is a weak
 * periodicity at the beat and its bar-level multiples, visible as peaks in the autocorrelation
 * of the spectral-flux envelope over 8 s of singing. This estimator takes that tempogram over
 * a sliding window, weights it with a log-Gaussian prior on singing tempos (100 bpm, half an
 * octave wide), adds each lag's double-period support (a beat's bar is periodic too, a
 * syllable's is not), picks the strongest peak, then chooses among its octave neighbours the
 * one whose beat best divides the sung note durations into whole beats. The result is folded
 * into 70..130, where a singer's beat lives.
 *
 * Measured on 52 stitched MIR-1K songs against the backing track (bench/tempo/RESULTS.md):
 * 54% within 8% of the truth and 62% within 8% of it or its exact half/double, at 8 s, against
 * 31% / 38% for the histogram. Confidence is how stable the estimate has been over the last
 * two seconds of windows; it does not separate right answers from wrong ones well (a
 * syllable-rate peak is as steady as a beat peak), so the app treats the tempo as a strong
 * hint, not as a downbeat it can count in from.
 */

export const MIN_BPM = 60, MAX_BPM = 180;
/** a singer's beat lives here; estimates outside are folded in by octave */
export const VOICE_LO = 70, VOICE_HI = 130;

export interface NoteSeg { start: number; end: number; midi: number }
export interface TempoEstimate { bpm: number; confidence: number }

export interface VoiceTempoOptions {
  /** envelope hop, seconds */
  hopSec?: number;
  /** sliding window, seconds; nothing is reported before `minWindowSec` of audio */
  windowSec?: number;
  minWindowSec?: number;
  /** log-Gaussian prior centre and width in octaves (0 disables) */
  priorBpm?: number;
  priorOctaves?: number;
  /** weight of the double-period support added to every lag */
  harmonic?: number;
  /** choose the octave by note-duration support */
  noteOctave?: boolean;
  /** fold the answer into VOICE_LO..VOICE_HI */
  fold?: boolean;
  /** stability confidence: how many earlier windows (`step` apart) the estimate is compared with */
  lookback?: number;
  step?: number;
}

export const DEFAULT_VOICE_TEMPO: Required<VoiceTempoOptions> = {
  hopSec: 0.02, windowSec: 8, minWindowSec: 8, priorBpm: 100, priorOctaves: 0.5, harmonic: 0.5, noteOctave: true, fold: true, lookback: 4, step: 0.5,
};

export function foldBpm(bpm: number, lo = MIN_BPM, hi = MAX_BPM): number {
  while (bpm > hi) bpm /= 2;
  while (bpm < lo) bpm *= 2;
  return bpm;
}

/**
 * Normalised autocorrelation of a (mean-removed, half-wave-rectified) envelope at every lag in
 * [minBpm, maxBpm], as {bpm, r} from the shortest lag up.
 */
export function autocorrTempogram(env: ArrayLike<number>, hopSec: number, minBpm: number, maxBpm: number): { bpm: number; r: number }[] {
  const n = env.length;
  const x = new Float64Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= Math.max(1, n);
  let r0 = 0;
  for (let i = 0; i < n; i++) { x[i] = Math.max(0, env[i] - mean); r0 += x[i] * x[i]; }
  const out: { bpm: number; r: number }[] = [];
  if (r0 <= 0) return out;
  const minLag = Math.max(1, Math.floor(60 / maxBpm / hopSec));
  const maxLag = Math.min(n - 1, Math.ceil(60 / minBpm / hopSec));
  for (let lag = minLag; lag <= maxLag; lag++) {
    let r = 0;
    for (let i = lag; i < n; i++) r += x[i] * x[i - lag];
    out.push({ bpm: 60 / (lag * hopSec), r: (r / r0) * (n / (n - lag)) });
  }
  return out;
}

export function logGaussPrior(bpm: number, centre: number, sigmaOct: number): number {
  if (sigmaOct <= 0) return 1;
  const z = Math.log2(bpm / centre) / sigmaOct;
  return Math.exp(-0.5 * z * z);
}

/** Local maxima of a tempogram after weighting, strongest first. */
export function pickPeaks(tg: { bpm: number; r: number }[], weight: (bpm: number) => number = () => 1): { bpm: number; r: number }[] {
  const w = tg.map(p => ({ bpm: p.bpm, r: p.r * weight(p.bpm) }));
  const peaks: { bpm: number; r: number }[] = [];
  for (let i = 1; i < w.length - 1; i++) if (w[i].r >= w[i - 1].r && w[i].r > w[i + 1].r && w[i].r > 0) peaks.push(w[i]);
  return peaks.sort((a, b) => b.r - a.r);
}

/** r'(lag) = r(lag) + h·r(2·lag): a lag is supported when its double is periodic too. */
export function harmonicSum(tg: { bpm: number; r: number }[], h: number): { bpm: number; r: number }[] {
  const byBpm = (bpm: number) => {
    let best = tg[0], d = Infinity;
    for (const p of tg) { const dd = Math.abs(Math.log2(p.bpm / bpm)); if (dd < d) { d = dd; best = p; } }
    return d < 0.02 ? best.r : 0;
  };
  return tg.map(p => ({ bpm: p.bpm, r: p.r + h * byBpm(p.bpm / 2) }));
}

/** Parabolic interpolation, in lag space, of the tempogram peak nearest `bpm`. */
export function refinePeak(tg: { bpm: number; r: number }[], bpm: number): number {
  if (!tg.length) return bpm;
  let i = 0;
  for (let k = 1; k < tg.length; k++) if (Math.abs(Math.log2(tg[k].bpm / bpm)) < Math.abs(Math.log2(tg[i].bpm / bpm))) i = k;
  if (i === 0 || i === tg.length - 1) return tg[i].bpm;
  const a = tg[i - 1].r, b = tg[i].r, c = tg[i + 1].r;
  const denom = a - 2 * b + c;
  const delta = denom ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
  const lagI = 60 / tg[i].bpm, lagNext = 60 / tg[i + 1].bpm;
  return 60 / (lagI + delta * (lagNext - lagI));
}

/**
 * How well a beat explains the sung note durations: duration-weighted mean distance (in beats)
 * from each note's length to the nearest whole number of beats. 0 = every note is a whole
 * number of beats; 0.25 = chance. Notes shorter than three quarters of a beat (eighths and
 * shorter) cannot support the beat and are skipped.
 */
export function noteDurationResidual(notes: NoteSeg[], bpm: number): { residual: number; explained: number } {
  const beat = 60 / bpm;
  let wsum = 0, rsum = 0, explained = 0;
  for (const n of notes) {
    const d = n.end - n.start;
    const b = d / beat;
    if (b < 0.75) continue;
    const k = Math.max(1, Math.round(b));
    const res = Math.abs(b - k);
    wsum += d;
    rsum += d * res;
    if (res < 0.15) explained += d;
  }
  return { residual: wsum ? rsum / wsum : 0.25, explained };
}

/**
 * One tempogram estimate from an envelope window (`hopSec` per sample, ending at `now`) and
 * the notes closed before `now`. Pure; the bench calls it on cached streams.
 */
export function tempogramEstimate(env: ArrayLike<number>, notes: NoteSeg[], o: Required<VoiceTempoOptions>): TempoEstimate | null {
  if (env.length < o.minWindowSec / o.hopSec - 1) return null;
  let tg = autocorrTempogram(env, o.hopSec, MIN_BPM / 2, MAX_BPM * 2);
  if (o.harmonic) tg = harmonicSum(tg, o.harmonic);
  const peaks = pickPeaks(tg, b => logGaussPrior(b, o.priorBpm, o.priorOctaves)).filter(p => p.bpm >= MIN_BPM && p.bpm <= MAX_BPM);
  if (!peaks.length) return null;
  let bpm = peaks[0].bpm;
  if (o.noteOctave) {
    const cands = [bpm / 2, bpm, bpm * 2].filter(b => b >= MIN_BPM && b <= MAX_BPM);
    let bestRes = Infinity;
    for (const c of cands) {
      const { residual } = noteDurationResidual(notes, c);
      if (residual < bestRes - 1e-9) { bestRes = residual; bpm = c; }
    }
  }
  bpm = refinePeak(tg, bpm);
  const second = peaks.find(p => Math.abs(Math.log2(p.bpm / peaks[0].bpm)) > 0.1);
  const confidence = second ? Math.max(0, Math.min(1, 1 - second.r / Math.max(1e-9, peaks[0].r))) : 1;
  if (o.fold) bpm = foldBpm(bpm, VOICE_LO, VOICE_HI);
  return { bpm: Math.round(bpm * 10) / 10, confidence };
}

/**
 * Streaming estimator: feed the spectral flux per hop and the pitch tracker's note starts and
 * ends, ask for the tempo whenever you like. Confidence blends the peak's margin with how
 * stable the estimate has been over the last `lookback` windows.
 */
export class VoiceTempo {
  private readonly o: Required<VoiceTempoOptions>;
  /** flux summed into hopSec bins from the first hop's time */
  private env: number[] = [];
  /** clock reading of the first hop; every bin and estimate is relative to it */
  private t0: number | null = null;
  private notes: NoteSeg[] = [];
  private open: { start: number; midi: number } | null = null;

  constructor(opts: VoiceTempoOptions = {}) {
    this.o = { ...DEFAULT_VOICE_TEMPO, ...opts };
  }

  pushFlux(flux: number, t: number): void {
    if (!Number.isFinite(t) || !(flux >= 0)) return;
    if (this.t0 === null) this.t0 = t;
    const bin = Math.floor((t - this.t0) / this.o.hopSec);
    if (bin < 0) return;
    while (this.env.length <= bin) this.env.push(0);
    this.env[bin] += flux;
  }

  /** A stable pitch began (or changed) at `t`; the previous note, if any, ends here. */
  noteOn(midi: number, t: number): void {
    this.noteOff(t);
    this.open = { start: t, midi };
  }

  noteOff(t: number): void {
    if (!this.open) return;
    if (t > this.open.start) this.notes.push({ start: this.open.start, end: t, midi: this.open.midi });
    this.open = null;
  }

  /** seconds of envelope available */
  get seconds(): number { return this.env.length * this.o.hopSec; }

  estimate(now: number = (this.t0 ?? 0) + this.seconds): TempoEstimate | null {
    if (this.t0 === null) return null;
    now -= this.t0;
    const e = this.estimateAt(now);
    if (!e) return null;
    let agree = 0, asked = 0;
    for (let k = 1; k <= this.o.lookback; k++) {
      const p = this.estimateAt(now - k * this.o.step);
      if (!p) continue;
      asked++;
      if (Math.abs(foldBpm(p.bpm, VOICE_LO, VOICE_HI) / foldBpm(e.bpm, VOICE_LO, VOICE_HI) - 1) < 0.08) agree++;
    }
    const stability = asked ? agree / asked : 0;
    return { bpm: e.bpm, confidence: stability * (0.5 + 0.5 * e.confidence) };
  }

  private estimateAt(now: number): TempoEstimate | null {
    if (now < this.o.minWindowSec) return null;
    const end = Math.min(this.env.length, Math.floor(now / this.o.hopSec));
    const start = Math.max(0, end - Math.floor(this.o.windowSec / this.o.hopSec));
    const win = this.env.slice(start, end);
    let max = 0;
    for (const v of win) max = Math.max(max, v);
    if (max > 0) for (let i = 0; i < win.length; i++) win[i] /= max;
    const t0 = this.t0 ?? 0;
    return tempogramEstimate(win, this.notes.filter(n => n.end - t0 <= now), this.o);
  }

  reset(): void {
    this.env = [];
    this.t0 = null;
    this.notes = [];
    this.open = null;
  }
}
