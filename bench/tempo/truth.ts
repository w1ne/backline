/**
 * The bench's ground truth: the tempo of the karaoke backing track (left channel) the singer
 * was following. Measured with an autocorrelation tempogram of the spectral-flux envelope over
 * the whole stitched song; the four songs with a hand-established bpm cross-check the measure.
 */
import { OnsetDetector } from '../../src/listener/onset';
import { FFT_SIZE, HOP_SIZE, magnitudeSpectrum } from '../../src/listener/fft';
import { SR } from '../voice/synth';
import { autocorrTempogram, pickPeaks, logGaussPrior } from './methods';

/** Spectral-flux envelope (the listener's own flux) of `audio`, one value per 512-sample hop. */
export function fluxEnvelope(audio: Float32Array): { flux: Float32Array; level: Float32Array; hopSec: number } {
  const det = new OnsetDetector({ sampleRate: SR });
  const nHops = Math.floor(audio.length / HOP_SIZE);
  const flux = new Float32Array(nHops), level = new Float32Array(nHops);
  const frame = new Float32Array(FFT_SIZE);
  for (let h = 0; h < nHops; h++) {
    const hopStart = h * HOP_SIZE;
    const fStart = hopStart + HOP_SIZE - FFT_SIZE;
    frame.fill(0);
    for (let i = Math.max(0, -fStart); i < FFT_SIZE; i++) if (fStart + i < audio.length) frame[i] = audio[fStart + i];
    flux[h] = det.flux(magnitudeSpectrum(frame));
    let s = 0;
    for (let i = hopStart; i < hopStart + HOP_SIZE && i < audio.length; i++) s += audio[i] * audio[i];
    level[h] = Math.sqrt(s / HOP_SIZE);
  }
  return { flux, level, hopSec: HOP_SIZE / SR };
}

/** Sums `env` into bins of `outHop` seconds (20 ms for the tempogram methods). */
export function rebin(env: Float32Array, hopSec: number, outHop: number): Float32Array {
  const n = Math.floor((env.length * hopSec) / outHop);
  const out = new Float32Array(n);
  for (let i = 0; i < env.length; i++) {
    const j = Math.floor((i * hopSec) / outHop);
    if (j < n) out[j] += env[i];
  }
  return out;
}

export interface TruthEstimate { bpm: number; /** runner-up peak's share of the winner */ ambiguity: number; peaks: number[] }

/**
 * Backing tempo from a full-length accompaniment. The autocorrelation is taken over 40..240 bpm
 * so both octave neighbours are visible; the reported tempo is the strongest peak in 60..180
 * under a gentle prior toward 110 bpm (sigma one octave), which is where the four known songs
 * sit without the prior having to decide any of them.
 */
export function backingTempo(accomp: Float32Array): TruthEstimate | null {
  const { flux, hopSec } = fluxEnvelope(accomp);
  const env = rebin(flux, hopSec, 0.01);
  const tg = autocorrTempogram(env, 0.01, 40, 240);
  const peaks = pickPeaks(tg, b => logGaussPrior(b, 110, 1)).filter(p => p.bpm >= 60 && p.bpm <= 180);
  if (!peaks.length) return null;
  const best = refinePeak(tg, peaks[0].bpm);
  const second = peaks.find(p => Math.abs(Math.log2(p.bpm / best)) > 0.1);
  return { bpm: Math.round(best * 10) / 10, ambiguity: second ? second.r / peaks[0].r : 0, peaks: peaks.slice(0, 4).map(p => Math.round(p.bpm)) };
}

/** Parabolic interpolation of the tempogram peak nearest `bpm`, in lag space. */
function refinePeak(tg: { bpm: number; r: number }[], bpm: number): number {
  let i = 0;
  for (let k = 1; k < tg.length; k++) if (Math.abs(tg[k].bpm - bpm) < Math.abs(tg[i].bpm - bpm)) i = k;
  if (i === 0 || i === tg.length - 1) return tg[i].bpm;
  const a = tg[i - 1].r, b = tg[i].r, c = tg[i + 1].r;
  const denom = a - 2 * b + c;
  const delta = denom ? (0.5 * (a - c)) / denom : 0;
  const lagI = 60 / tg[i].bpm, lagNext = 60 / tg[i + 1].bpm;
  return 60 / (lagI + delta * (lagNext - lagI));
}
