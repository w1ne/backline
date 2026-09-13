/**
 * Onset-only half of bench/calibrate: scores OnsetDetector's mult/delta/quantile constants
 * against the note starts bench/voice's synthetic melodies already know (ClipSpec.truth.notes),
 * and reports whether a candidate keeps or worsens TempoLock's time-to-lock on those same
 * melodies. Independent of the pitch tracker and the key/chord detectors, so it can run off
 * the flux/rms half of bench/voice/driver's cached `Analysis` alone.
 */
import { Listener, type Source } from '../../src/listener/listener';
import { HOP_SIZE } from '../../src/listener/fft';
import { OnsetDetector, type OnsetOptions } from '../../src/listener/onset';
import { DEFAULT_TUNING } from '../../src/listener/tuning';
import type { Analysis } from '../voice/driver';
import type { Note } from '../voice/synth';
import { SR } from '../voice/synth';

class SimSource implements Source {
  note!: (m: number, v: number, t: number) => void;
  async start(onNote: SimSource['note']) {
    this.note = onNote;
  }
  stop() {}
}

export interface OnsetPR {
  p: number;
  r: number;
  f1: number;
}

/** Greedy nearest-time match, one truth note to at most one detected onset, within `tol`. */
export function onsetPR(onsets: number[], truth: Note[], tol = 0.1): OnsetPR {
  const used = new Set<number>();
  let tp = 0;
  for (const n of truth) {
    let best = -1, bestDt = Infinity;
    for (let i = 0; i < onsets.length; i++) {
      if (used.has(i)) continue;
      const dt = Math.abs(onsets[i] - n.start);
      if (dt <= tol && dt < bestDt) { best = i; bestDt = dt; }
    }
    if (best >= 0) { used.add(best); tp++; }
  }
  const fp = onsets.length - used.size;
  const fn = truth.length - tp;
  const p = onsets.length > 0 ? tp / onsets.length : NaN;
  const r = truth.length > 0 ? tp / truth.length : NaN;
  const f1 = !Number.isNaN(p) && !Number.isNaN(r) && p + r > 0 ? (2 * p * r) / (p + r) : NaN;
  return { p, r, f1 };
}

export interface OnsetRun {
  /** onset times, seconds from clip start */
  onsets: number[];
  /** simulated time TempoLock first reported a bpm, or null */
  tempoLockT: number | null;
}

/**
 * Feeds one clip's cached flux/rms through a fresh OnsetDetector(opts) into a fresh Listener,
 * exactly the way bench/voice/driver's runClip does for its onset path, so TempoLock sees the
 * same event stream a candidate would produce live. Independent of pitch/key/chord, so it
 * skips the rest of the pipeline entirely.
 */
export function runOnset(pre: Analysis, opts: OnsetOptions): OnsetRun {
  const source = new SimSource();
  let currentSimT = 0;
  const listener = new Listener([source], ['mic'], () => currentSimT, DEFAULT_TUNING);
  void listener.start();
  const onset = new OnsetDetector({ sampleRate: SR, ...opts });
  const onsets: number[] = [];
  let tempoLockT: number | null = null;
  for (let h = 0; h < pre.hops.length; h++) {
    const t = (h * HOP_SIZE) / SR;
    currentSimT = t;
    const { flux, rms } = pre.hops[h];
    const at = onset.pushFlux(flux, t, rms);
    if (at !== null) {
      currentSimT = at;
      source.note(-1, Math.min(1, rms * 8), at);
      onsets.push(at);
      currentSimT = t;
    }
    if (tempoLockT === null && listener.input.bpm !== null) tempoLockT = t;
  }
  return { onsets, tempoLockT };
}
