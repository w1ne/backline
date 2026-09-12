/**
 * bench/voice/driver.ts with the pitch estimator swapped out. Same 512-sample onset hops, same
 * 4096-sample pitch window polled every 50 ms, same RMS floor, same PitchTracker and Listener;
 * only the per-window estimate comes from `estimates[pollIndex]` instead of detectPitch, so a
 * pYIN (or any) pitch can be pushed through our own note tracker for a comparable note F1.
 */
import { Listener, type Source } from '../../src/listener/listener';
import { OnsetDetector } from '../../src/listener/onset';
import { FFT_SIZE, HOP_SIZE, magnitudeSpectrum } from '../../src/listener/fft';
import type { PitchEstimate } from '../../src/listener/pitch';
import { PitchTracker, type PitchTrackerOptions, type StablePitch } from '../../src/listener/pitchTracker';
import type { DetectedNote, RawFrame } from '../voice/driver';
import { SR } from '../voice/synth';

export const PITCH_WINDOW = 4096;
export const PITCH_POLL_SEC = 0.05;
export const PITCH_RMS_FLOOR = 0.01;

class SimSource implements Source {
  note!: (m: number, v: number, t: number) => void;
  pitch?: (p: StablePitch | null) => void;
  async start(onNote: SimSource['note'], _onLevel: (l: number) => void, onPitch?: SimSource['pitch']) {
    this.note = onNote;
    this.pitch = onPitch;
  }
  stop() {}
}

export interface PollWindow {
  t: number;
  rms: number;
  /** copy of the 4096-sample window ending one hop after t */
  x: Float32Array;
}

/** The exact windows the driver would hand to detectPitch, in poll order. */
export function pollWindows(audio: Float32Array): PollWindow[] {
  const out: PollWindow[] = [];
  const nHops = Math.floor(audio.length / HOP_SIZE);
  let nextPollT = 0;
  for (let h = 0; h < nHops; h++) {
    const hopStart = h * HOP_SIZE;
    const t = hopStart / SR;
    if (t < nextPollT) continue;
    nextPollT += PITCH_POLL_SEC;
    const x = new Float32Array(PITCH_WINDOW);
    const winStart = hopStart + HOP_SIZE - PITCH_WINDOW;
    for (let i = Math.max(0, -winStart); i < PITCH_WINDOW; i++) {
      const src = winStart + i;
      if (src < audio.length) x[i] = audio[src];
    }
    let s = 0;
    for (let i = 0; i < PITCH_WINDOW; i++) s += x[i] * x[i];
    out.push({ t, rms: Math.sqrt(s / PITCH_WINDOW), x });
  }
  return out;
}

export interface ReplayResult {
  detectedNotes: DetectedNote[];
  rawFrames: RawFrame[];
}

/** Replays the clip with precomputed per-poll estimates (null = no pitch). */
export function replay(audio: Float32Array, profile: PitchTrackerOptions, estimates: (PitchEstimate | null)[]): ReplayResult {
  const sr = SR;
  const source = new SimSource();
  let currentSimT = 0;
  const listener = new Listener([source], ['mic'], () => currentSimT);
  const detectedNotes: DetectedNote[] = [];
  listener.onNote(n => detectedNotes.push({ midi: n.midi, velocity: n.velocity, t: currentSimT }));
  void listener.start();

  const onset = new OnsetDetector({ sampleRate: sr });
  const tracker = new PitchTracker(profile);
  const rawFrames: RawFrame[] = [];
  const nHops = Math.floor(audio.length / HOP_SIZE);
  let nextPollT = 0, poll = 0;
  const frame = new Float32Array(FFT_SIZE);

  for (let h = 0; h < nHops; h++) {
    const hopStart = h * HOP_SIZE;
    const t = hopStart / sr;
    currentSimT = t;
    const fStart = hopStart + HOP_SIZE - FFT_SIZE;
    frame.fill(0);
    for (let i = Math.max(0, -fStart); i < FFT_SIZE; i++) {
      const src = fStart + i;
      if (src < audio.length) frame[i] = audio[src];
    }
    let sumSq = 0;
    for (let i = hopStart; i < hopStart + HOP_SIZE && i < audio.length; i++) sumSq += audio[i] * audio[i];
    const rms = Math.sqrt(sumSq / HOP_SIZE);
    const at = onset.pushFlux(onset.flux(magnitudeSpectrum(frame)), t, rms);
    if (at !== null) {
      currentSimT = at;
      source.note(-1, Math.min(1, rms * 8), at);
      currentSimT = t;
    }
    if (t >= nextPollT) {
      nextPollT += PITCH_POLL_SEC;
      const est = estimates[poll++] ?? null;
      rawFrames.push({ t, hz: est?.hz ?? null });
      currentSimT = t;
      source.pitch?.(tracker.push(est ? { hz: est.hz, clarity: est.clarity, t } : null));
    }
  }
  return { detectedNotes, rawFrames };
}
