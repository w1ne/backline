/**
 * Tempo-from-voice candidates, as pure functions over the streams the Listener already has:
 * spectral-flux onsets (time + strength), the flux envelope itself, stable-pitch note segments
 * from the pitch tracker, and the level envelope. Every method is online: it only looks at
 * what happened before `now`, and returns a bpm with a 0..1 confidence or null when it has
 * nothing to say yet. bench/tempo/run.ts scores them against the backing track's tempo.
 */
import { bpmFromOnsets } from '../../src/listener/tempoLock';

export interface Onset { t: number; strength: number }
export interface NoteSeg { start: number; end: number; midi: number }

export interface VoiceStreams {
  onsets: Onset[];
  notes: NoteSeg[];
  /** onset-strength (spectral flux) envelope, one value per `hopSec` */
  flux: Float32Array;
  /** rms level envelope on the same hop */
  level: Float32Array;
  hopSec: number;
}

export interface TempoEstimate { bpm: number; confidence: number }
export type TempoMethod = (s: VoiceStreams, now: number) => TempoEstimate | null;

export const MIN_BPM = 60, MAX_BPM = 180;
/** a singer's beat lives here; estimates outside are folded in by octave */
export const VOICE_LO = 70, VOICE_HI = 130;

export function foldBpm(bpm: number, lo = MIN_BPM, hi = MAX_BPM): number {
  while (bpm > hi) bpm /= 2;
  while (bpm < lo) bpm *= 2;
  return bpm;
}

// ---------------------------------------------------------------- a. IOI histogram (baseline)

/** The app's current TempoLock over flux onsets, voice mode; confidence = share of IOIs in the winning bin. */
export const ioiFluxOnsets: TempoMethod = (s, now) => ioiOf(s.onsets.filter(o => o.t <= now).map(o => o.t));

// ---------------------------------------------------------------- b. IOI histogram over note onsets

export const ioiNoteOnsets: TempoMethod = (s, now) => ioiOf(s.notes.filter(n => n.start <= now).map(n => n.start));

function ioiOf(times: number[]): TempoEstimate | null {
  const r = bpmFromOnsets(times, 12, { voice: true });
  if (!r) return null;
  // confidence: how many folded IOIs land within 5% of the answer
  let near = 0, total = 0;
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (d <= 0.05) continue;
    total++;
    if (Math.abs(foldBpm(60 / d) / r.bpm - 1) < 0.05) near++;
  }
  return { bpm: r.bpm, confidence: total ? near / total : 0 };
}

// ---------------------------------------------------------------- c. autocorrelation tempogram

export interface TempogramOptions {
  /** sliding window, seconds; nothing is reported before `minWindowSec` of audio */
  windowSec?: number;
  minWindowSec?: number;
  /** log-Gaussian prior centre and width (octaves); sigma 0 disables it */
  priorBpm?: number;
  priorOctaves?: number;
  /** when true the octave is chosen by note-duration support rather than by the prior alone */
  noteOctave?: boolean;
  /**
   * metrical-level support: a lag's score is r(lag) + harmonic * r(2·lag), so the beat level
   * whose bar-ish double is also periodic beats the syllable level whose double is not
   */
  harmonic?: number;
  /** which envelope to correlate: the flux, the flux with a unit impulse at every note start, or note impulses alone */
  envelope?: 'flux' | 'flux+notes' | 'notes';
  /** fold the answer into the singing band before reporting */
  fold?: boolean;
}

/**
 * Normalised autocorrelation of a (mean-removed, half-wave-rectified) envelope at every lag in
 * [minBpm, maxBpm], as a list of {bpm, r}. Shared by the tempogram method and the truth measure.
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

/** Picks the local maxima of a tempogram, strongest first. */
export function pickPeaks(tg: { bpm: number; r: number }[], weight: (bpm: number) => number = () => 1): { bpm: number; r: number }[] {
  const w = tg.map(p => ({ bpm: p.bpm, r: p.r * weight(p.bpm) }));
  const peaks: { bpm: number; r: number }[] = [];
  for (let i = 1; i < w.length - 1; i++) if (w[i].r >= w[i - 1].r && w[i].r > w[i + 1].r && w[i].r > 0) peaks.push(w[i]);
  return peaks.sort((a, b) => b.r - a.r);
}

/**
 * How well a beat period explains the sung note durations: duration-weighted mean of the
 * distance (in beats) from each note's length to the nearest positive integer number of beats.
 * 0 = every note is a whole number of beats; 0.25 = no better than chance. Notes shorter than
 * half a beat are skipped (they cannot support this beat).
 */
export function noteDurationResidual(notes: NoteSeg[], bpm: number): { residual: number; explained: number } {
  const beat = 60 / bpm;
  let wsum = 0, rsum = 0, explained = 0;
  for (const n of notes) {
    const d = n.end - n.start;
    const b = d / beat;
    if (b < 0.5) continue;
    const k = Math.max(1, Math.round(b));
    const res = Math.abs(b - k);
    wsum += d;
    rsum += d * res;
    if (res < 0.15) explained += d;
  }
  return { residual: wsum ? rsum / wsum : 0.25, explained };
}

export function tempogramMethod(o: TempogramOptions = {}): TempoMethod {
  const windowSec = o.windowSec ?? 10, minWindowSec = o.minWindowSec ?? 8;
  const priorBpm = o.priorBpm ?? 100, priorOct = o.priorOctaves ?? 0.5;
  return (s, now) => {
    if (now < minWindowSec) return null;
    const end = Math.min(s.flux.length, Math.floor(now / s.hopSec));
    const start = Math.max(0, end - Math.floor(windowSec / s.hopSec));
    if (end - start < minWindowSec / s.hopSec - 1) return null;
    const env = envelopeOf(s, start, end, o.envelope ?? 'flux');
    let tg = autocorrTempogram(env, s.hopSec, MIN_BPM / 2, MAX_BPM * 2);
    if (o.harmonic) tg = harmonicSum(tg, o.harmonic);
    const peaks = pickPeaks(tg, b => logGaussPrior(b, priorBpm, priorOct)).filter(p => p.bpm >= MIN_BPM && p.bpm <= MAX_BPM);
    if (!peaks.length) return null;
    let best = peaks[0];
    if (o.noteOctave) {
      const notes = closedNotes(s.notes, now);
      const cands = [best.bpm / 2, best.bpm, best.bpm * 2].filter(b => b >= MIN_BPM && b <= MAX_BPM);
      let bestRes = Infinity, pick = best.bpm;
      for (const c of cands) {
        const { residual } = noteDurationResidual(notes, c);
        if (residual < bestRes - 1e-9) { bestRes = residual; pick = c; }
      }
      best = { bpm: pick, r: best.r };
    }
    const second = peaks.find(p => Math.abs(Math.log2(p.bpm / best.bpm)) > 0.1);
    const confidence = second ? Math.max(0, Math.min(1, 1 - second.r / Math.max(1e-9, peaks[0].r))) : 1;
    const bpm = o.fold ? foldBpm(best.bpm, VOICE_LO, VOICE_HI) : best.bpm;
    return { bpm: Math.round(bpm * 10) / 10, confidence };
  };
}

/**
 * Wraps a method with a stability confidence: the estimate is re-run at `now - k·step` for
 * k = 1..lookback and confidence becomes the share of those that agree (within 8%, octaves
 * folded) with the current one, times the method's own confidence blended in at half weight.
 * A peak that only exists in this window is not a tempo.
 */
export function withStability(method: TempoMethod, lookback = 4, step = 0.5): TempoMethod {
  return (s, now) => {
    const e = method(s, now);
    if (!e) return null;
    let agree = 0, asked = 0;
    for (let k = 1; k <= lookback; k++) {
      const p = method(s, now - k * step);
      if (!p) continue;
      asked++;
      if (Math.abs(foldBpm(p.bpm, VOICE_LO, VOICE_HI) / foldBpm(e.bpm, VOICE_LO, VOICE_HI) - 1) < 0.08) agree++;
    }
    const stability = asked ? agree / asked : 0;
    return { bpm: e.bpm, confidence: stability * (0.5 + 0.5 * e.confidence) };
  };
}

function envelopeOf(s: VoiceStreams, start: number, end: number, kind: 'flux' | 'flux+notes' | 'notes'): Float32Array {
  const env = new Float32Array(end - start);
  if (kind !== 'notes') {
    let max = 0;
    for (let i = start; i < end; i++) max = Math.max(max, s.flux[i]);
    if (max > 0) for (let i = start; i < end; i++) env[i - start] = s.flux[i] / max;
  }
  if (kind !== 'flux') {
    for (const n of s.notes) {
      const h = Math.round(n.start / s.hopSec) - start;
      if (h >= 0 && h < env.length) env[h] += 1;
    }
  }
  return env;
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

export function closedNotes(notes: NoteSeg[], now: number): NoteSeg[] {
  return notes.filter(n => n.end <= now && n.end > n.start);
}

// ---------------------------------------------------------------- d. note-duration clustering

export interface DurationClusterOptions {
  minNotes?: number;
  /** residual width in beats for a duration to count as "explained" */
  sigma?: number;
  priorBpm?: number;
  priorOctaves?: number;
}

/**
 * GCD-like search: the beat in 60..180 whose integer multiples explain the most sung duration
 * with the smallest residual. Faster beats explain everything trivially (any duration is near
 * some multiple of a short beat), so the score is the explained duration times (1 - residual/0.25),
 * under a log-Gaussian prior toward singing tempos.
 */
export function durationCluster(o: DurationClusterOptions = {}): TempoMethod {
  const minNotes = o.minNotes ?? 8, sigma = o.sigma ?? 0.12, priorBpm = o.priorBpm ?? 100, priorOct = o.priorOctaves ?? 0.5;
  return (s, now) => {
    const notes = closedNotes(s.notes, now).filter(n => n.end - n.start >= 0.1);
    if (notes.length < minNotes) return null;
    const total = notes.reduce((a, n) => a + (n.end - n.start), 0);
    let best = { bpm: 0, score: -1 }, second = 0;
    const scores: { bpm: number; score: number }[] = [];
    for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += 1) {
      const beat = 60 / bpm;
      let score = 0;
      for (const n of notes) {
        const b = (n.end - n.start) / beat;
        if (b < 0.5) continue;
        const res = Math.abs(b - Math.max(1, Math.round(b)));
        score += (n.end - n.start) * Math.exp(-0.5 * (res / sigma) ** 2);
      }
      score = (score / total) * logGaussPrior(bpm, priorBpm, priorOct);
      scores.push({ bpm, score });
      if (score > best.score) best = { bpm, score };
    }
    for (const p of scores) if (Math.abs(Math.log2(p.bpm / best.bpm)) > 0.1) second = Math.max(second, p.score);
    const confidence = best.score > 0 ? Math.max(0, 1 - second / best.score) : 0;
    return { bpm: best.bpm, confidence };
  };
}

// ---------------------------------------------------------------- e. combination

/**
 * Folds every method's estimate into the singing band and votes in log-tempo space: each vote
 * carries its method's weight times confidence; the winner is the densest cluster (within 8%).
 * Confidence = the winning cluster's share of the total vote.
 */
export function combine(parts: { method: TempoMethod; weight: number }[]): TempoMethod {
  return (s, now) => {
    const votes: { bpm: number; w: number }[] = [];
    for (const [i, p] of parts.entries()) {
      const e = p.method(s, now);
      // the first part is the primary: until it has an estimate the faster parts do not get to decide alone
      if (!e && i === 0) return null;
      if (e) votes.push({ bpm: foldBpm(e.bpm, VOICE_LO, VOICE_HI), w: p.weight * (0.2 + 0.8 * e.confidence) });
    }
    if (!votes.length) return null;
    const total = votes.reduce((a, v) => a + v.w, 0);
    let best = { bpm: 0, w: -1 };
    for (const v of votes) {
      let w = 0, num = 0;
      for (const u of votes) if (Math.abs(Math.log2(u.bpm / v.bpm)) < 0.11) { w += u.w; num += u.w * Math.log2(u.bpm); }
      if (w > best.w) best = { bpm: 2 ** (num / w), w };
    }
    return { bpm: Math.round(best.bpm * 10) / 10, confidence: best.w / total };
  };
}
