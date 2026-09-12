/**
 * Compact pYIN (Mauch & Dixon 2014): per frame, YIN's cumulative mean normalised difference
 * function is thresholded at many thresholds drawn from a beta prior; each threshold's first
 * dip becomes a pitch candidate weighted by the prior mass, so a frame yields a sparse
 * distribution over pitch rather than one number. A Viterbi pass over (pitch bin, voiced |
 * unvoiced) states then picks the smoothest track. No dependencies, ~150 lines.
 *
 * Frame analysis is O(n * maxLag) like our McLeod, so per-frame cost is comparable; the
 * Viterbi runs over the whole clip here (offline upper bound) and is cheap (states^2 with a
 * banded transition).
 */

export const PYIN_MIN_HZ = 55;   // A1
export const PYIN_MAX_HZ = 1100; // ~C#6
const BINS_PER_SEMITONE = 5;
const N_SEMITONES = Math.ceil(12 * Math.log2(PYIN_MAX_HZ / PYIN_MIN_HZ));
export const N_BINS = N_SEMITONES * BINS_PER_SEMITONE;
const N_THRESHOLDS = 100;
/** beta(2, 18) prior over thresholds, as in the paper's "mean 0.1" setting */
const THRESHOLD_PRIOR = (() => {
  const w = new Float64Array(N_THRESHOLDS);
  let s = 0;
  for (let i = 0; i < N_THRESHOLDS; i++) {
    const x = (i + 1) / N_THRESHOLDS;
    w[i] = Math.pow(x, 1) * Math.pow(1 - x, 17);
    s += w[i];
  }
  for (let i = 0; i < N_THRESHOLDS; i++) w[i] /= s;
  return w;
})();

export const hzToBin = (hz: number) => Math.round(12 * BINS_PER_SEMITONE * Math.log2(hz / PYIN_MIN_HZ));
export const binToHz = (bin: number) => PYIN_MIN_HZ * 2 ** (bin / (12 * BINS_PER_SEMITONE));

export interface PyinFrame {
  /** sparse: probability mass per pitch bin (length N_BINS), sums to the voiced probability */
  probs: Float32Array;
  voicedProb: number;
  /** best single-frame candidate (for a no-Viterbi "YIN-ish" baseline) */
  bestHz: number | null;
  bestProb: number;
}

/** One frame: YIN CMNDF, multi-threshold dip picking, parabolic lag refinement. */
export function pyinFrame(x: Float32Array, sr: number): PyinFrame {
  const n = x.length;
  const minLag = Math.floor(sr / PYIN_MAX_HZ);
  const maxLag = Math.min(Math.floor(sr / PYIN_MIN_HZ), n >> 1);
  const W = n - maxLag; // fixed integration window so every lag sees the same samples
  const d = new Float64Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i < W; i++) { const v = x[i] - x[i + lag]; s += v * v; }
    d[lag] = s;
  }
  // cumulative mean normalised difference
  const cm = new Float64Array(maxLag + 1);
  cm[0] = 1;
  let run = 0;
  for (let lag = 1; lag <= maxLag; lag++) { run += d[lag]; cm[lag] = run ? d[lag] * lag / run : 1; }

  // local minima of the CMNDF (candidate periods), parabolically interpolated
  const dips: { lag: number; value: number }[] = [];
  for (let lag = Math.max(2, minLag); lag < maxLag; lag++) {
    if (cm[lag] < cm[lag - 1] && cm[lag] <= cm[lag + 1]) {
      const a = cm[lag - 1], b = cm[lag], c = cm[lag + 1];
      const denom = a - 2 * b + c;
      const shift = denom !== 0 ? (a - c) / (2 * denom) : 0;
      dips.push({ lag: lag + shift, value: Math.max(0, b - (denom !== 0 ? 0.25 * (a - c) * shift : 0)) });
    }
  }
  const probs = new Float32Array(N_BINS);
  let voiced = 0, bestHz: number | null = null, bestProb = 0;
  if (dips.length) {
    // for each threshold the first dip under it wins; if none, YIN's rule gives the global
    // minimum, with the probability discounted (unvoiced mass), as in the paper
    const globalMin = dips.reduce((m, p) => (p.value < m.value ? p : m), dips[0]);
    const perDip = new Float64Array(dips.length);
    for (let t = 0; t < N_THRESHOLDS; t++) {
      const thr = (t + 1) / N_THRESHOLDS;
      let k = dips.findIndex(p => p.value < thr);
      let w = THRESHOLD_PRIOR[t];
      if (k < 0) { k = dips.indexOf(globalMin); w *= 0.01; }
      perDip[k] += w;
    }
    for (let k = 0; k < dips.length; k++) {
      if (!perDip[k]) continue;
      const hz = sr / dips[k].lag;
      const bin = hzToBin(hz);
      if (bin < 0 || bin >= N_BINS) continue;
      probs[bin] += perDip[k];
      voiced += perDip[k];
      if (perDip[k] > bestProb) { bestProb = perDip[k]; bestHz = hz; }
    }
  }
  return { probs, voicedProb: voiced, bestHz, bestProb };
}

/** Viterbi output per frame: hz (null = unvoiced) plus the posterior-ish weight of the chosen bin. */
export interface PyinTrackFrame { hz: number | null; prob: number }

/**
 * HMM decode. States 0..N_BINS-1 voiced bins, N_BINS..2N-1 the same bins unvoiced. Pitch
 * moves by at most `maxJump` bins per frame with a triangular weight; voiced<->unvoiced
 * switching costs `switchProb`. Emission: voiced bin b -> probs[b]; unvoiced states share
 * (1 - voicedProb) evenly. Log domain, banded, so cost per frame is ~N_BINS * maxJump.
 */
export function pyinViterbi(frames: PyinFrame[], maxJump = 2 * BINS_PER_SEMITONE + 3, switchProb = 0.01): PyinTrackFrame[] {
  const N = N_BINS, S = 2 * N, T = frames.length;
  if (!T) return [];
  const EPS = 1e-9;
  const logSwitch = Math.log(switchProb), logStay = Math.log(1 - switchProb);
  // triangular jump weights, normalised
  const jump = new Float64Array(2 * maxJump + 1);
  let js = 0;
  for (let k = -maxJump; k <= maxJump; k++) { jump[k + maxJump] = maxJump + 1 - Math.abs(k); js += jump[k + maxJump]; }
  const logJump = jump.map(v => Math.log(v / js));

  let prev = new Float64Array(S).fill(Math.log(1 / S));
  const back = new Int32Array(S * T);
  const emit = new Float64Array(S);
  for (let t = 0; t < T; t++) {
    const f = frames[t];
    const unv = Math.log(Math.max(EPS, 1 - f.voicedProb) / N);
    for (let b = 0; b < N; b++) { emit[b] = Math.log(f.probs[b] + EPS); emit[N + b] = unv; }
    const cur = new Float64Array(S).fill(-Infinity);
    for (let b = 0; b < N; b++) {
      // best predecessor pitch bin within the band, separately from voiced and unvoiced rows
      let bestV = -Infinity, argV = 0, bestU = -Infinity, argU = 0;
      const lo = Math.max(0, b - maxJump), hi = Math.min(N - 1, b + maxJump);
      for (let p = lo; p <= hi; p++) {
        const lj = logJump[p - b + maxJump];
        const v = prev[p] + lj; if (v > bestV) { bestV = v; argV = p; }
        const u = prev[N + p] + lj; if (u > bestU) { bestU = u; argU = N + p; }
      }
      // into voiced b
      const vv = bestV + logStay, uv = bestU + logSwitch;
      if (vv >= uv) { cur[b] = vv + emit[b]; back[t * S + b] = argV; } else { cur[b] = uv + emit[b]; back[t * S + b] = argU; }
      // into unvoiced b
      const uu = bestU + logStay, vu = bestV + logSwitch;
      if (uu >= vu) { cur[N + b] = uu + emit[N + b]; back[t * S + N + b] = argU; } else { cur[N + b] = vu + emit[N + b]; back[t * S + N + b] = argV; }
    }
    prev = cur;
  }
  let s = 0;
  for (let i = 1; i < S; i++) if (prev[i] > prev[s]) s = i;
  const out: PyinTrackFrame[] = new Array(T);
  for (let t = T - 1; t >= 0; t--) {
    const f = frames[t];
    out[t] = s < N ? { hz: binToHz(s), prob: f.probs[s] } : { hz: null, prob: 1 - f.voicedProb };
    s = back[t * S + s];
  }
  return out;
}
