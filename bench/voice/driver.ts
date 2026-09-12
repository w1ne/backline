/**
 * Replays a synthesized clip through the exact same analysis chain MicSource
 * wires up — OnsetDetector on 512-sample hops, detectPitch on a 4096-sample
 * window every 50ms, PitchTracker(profile), and a real Listener — entirely
 * offline, driven by simulated sample time instead of the audio clock.
 *
 * One nuance: Listener's own onPitch handler timestamps notes with
 * `performance.now()`, since in the live app that IS the audio clock. Here
 * everything happens in one synchronous sweep, so that wall-clock stamp is
 * useless for latency — we instead capture the simulated time the callback
 * fired at, from a closure variable updated right before each call into the
 * source's callbacks. Because Source callbacks run synchronously inside
 * Listener, this is exact.
 */
import { Listener, type Source } from '../../src/listener/listener';
import { OnsetDetector } from '../../src/listener/onset';
import { FFT_SIZE, HOP_SIZE, magnitudeSpectrum } from '../../src/listener/fft';
import { detectPitch } from '../../src/listener/pitch';
import { PitchTracker, type PitchTrackerOptions, type StablePitch } from '../../src/listener/pitchTracker';
import type { Key } from '../../src/types';
import { SR } from './synth';

const PITCH_WINDOW = 4096;
const PITCH_POLL_SEC = 0.05;
const PITCH_RMS_FLOOR = 0.01;

class SimSource implements Source {
  note!: (m: number, v: number, t: number) => void;
  pitch?: (p: StablePitch | null) => void;
  async start(onNote: SimSource['note'], _onLevel: (l: number) => void, onPitch?: SimSource['pitch']) {
    this.note = onNote;
    this.pitch = onPitch;
  }
  stop() {}
}

export interface DetectedNote {
  midi: number;
  velocity: number;
  /** simulated time (seconds from clip start) the note was emitted */
  t: number;
}

export interface RawFrame {
  /** simulated time at the center of the analysis window */
  t: number;
  /** raw McLeod pitch estimate for this window, or null if none/below floor */
  hz: number | null;
}

export interface RunResult {
  detectedNotes: DetectedNote[];
  rawFrames: RawFrame[];
  /** simulated time the key first locked (non-null), or null if never */
  keyLockT: number | null;
  key: Key | null;
  /** simulated time the tempo first locked (non-null bpm), or null if never */
  tempoLockT: number | null;
  bpm: number | null;
}

/**
 * Runs one clip through the pipeline with the given pitch-tracker profile.
 */
export function runClip(audio: Float32Array, profile: PitchTrackerOptions): RunResult {
  const sr = SR;
  const source = new SimSource();
  const listener = new Listener([source], ['mic']);
  const detectedNotes: DetectedNote[] = [];
  let currentSimT = 0;
  let keyLockT: number | null = null;
  let tempoLockT: number | null = null;

  listener.onNote(n => {
    detectedNotes.push({ midi: n.midi, velocity: n.velocity, t: currentSimT });
  });

  // start() is async but resolves synchronously here (SimSource.start has no awaits
  // that yield), so the source callbacks are wired before we drive it.
  void listener.start();

  const onset = new OnsetDetector({ sampleRate: sr });
  const tracker = new PitchTracker(profile);
  const rawFrames: RawFrame[] = [];

  const hopSec = HOP_SIZE / sr;
  const nHops = Math.floor(audio.length / HOP_SIZE);
  let nextPollT = 0;
  const frame = new Float32Array(FFT_SIZE);
  const pitchWin = new Float32Array(PITCH_WINDOW);

  for (let h = 0; h < nHops; h++) {
    const hopStart = h * HOP_SIZE;
    const t = hopStart / sr;
    currentSimT = t;

    // --- onset path: same 1024-sample analysis frame ending at this hop ---
    const fStart = hopStart + HOP_SIZE - FFT_SIZE;
    frame.fill(0);
    for (let i = Math.max(0, -fStart); i < FFT_SIZE; i++) {
      const src = fStart + i;
      if (src < audio.length) frame[i] = audio[src];
    }
    let sumSq = 0;
    for (let i = hopStart; i < hopStart + HOP_SIZE && i < audio.length; i++) sumSq += audio[i] * audio[i];
    const rms = Math.sqrt(sumSq / HOP_SIZE);
    const mag = magnitudeSpectrum(frame);
    const at = onset.pushFlux(onset.flux(mag), t, rms);
    if (at !== null) {
      currentSimT = at;
      source.note(-1, Math.min(1, rms * 8), at);
      currentSimT = t;
    }

    // --- pitch path: poll every 50ms of simulated time ---
    if (t >= nextPollT) {
      nextPollT += PITCH_POLL_SEC;
      const winStart = hopStart + HOP_SIZE - PITCH_WINDOW;
      pitchWin.fill(0);
      for (let i = Math.max(0, -winStart); i < PITCH_WINDOW; i++) {
        const src = winStart + i;
        if (src < audio.length) pitchWin[i] = audio[src];
      }
      let pSumSq = 0;
      for (let i = 0; i < PITCH_WINDOW; i++) pSumSq += pitchWin[i] * pitchWin[i];
      const pRms = Math.sqrt(pSumSq / PITCH_WINDOW);
      let est: ReturnType<typeof detectPitch> = null;
      if (pRms > PITCH_RMS_FLOOR) {
        est = detectPitch(pitchWin, sr);
      }
      rawFrames.push({ t, hz: est?.hz ?? null });
      currentSimT = t;
      source.pitch?.(pRms > PITCH_RMS_FLOOR ? tracker.push(est ? { hz: est.hz, clarity: est.clarity, t } : null) : tracker.push(null));

      if (keyLockT === null && listener.input.key !== null) keyLockT = t;
      if (tempoLockT === null && listener.input.bpm !== null) tempoLockT = t;
    }
  }

  return {
    detectedNotes,
    rawFrames,
    keyLockT,
    key: listener.input.key,
    tempoLockT,
    bpm: listener.input.bpm,
  };
}
