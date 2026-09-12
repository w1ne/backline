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
import { detectPitch, type PitchEstimate } from '../../src/listener/pitch';
import { PitchTracker, type PitchTrackerOptions, type StablePitch } from '../../src/listener/pitchTracker';
import { DEFAULT_TUNING, type ListenerTuning } from '../../src/listener/tuning';
import type { Chord, Dynamics, Key } from '../../src/types';
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
  /** the tracker's reading at every poll, as the Listener saw it (null = no stable pitch) */
  pitchFrames: { t: number; midi: number | null }[];
  /** simulated time the key first locked (non-null), or null if never */
  keyLockT: number | null;
  key: Key | null;
  /** simulated time the tempo first locked (non-null bpm), or null if never */
  tempoLockT: number | null;
  bpm: number | null;
  /** every change of the listener's chord reading, stamped with simulated time */
  chords: { t: number; chord: Chord | null }[];
  /** the listener's dynamics frame after every beat tick (only when a clock was given) */
  beats: { t: number; beat: number; dynamics: Dynamics }[];
  /** TempoLock's downbeat estimate (seconds) once locked, else null */
  downbeat: number | null;
}

/**
 * The signal-processing half of a run, which no listener constant influences: spectral flux
 * and rms per onset hop, and the raw McLeod estimate per pitch poll with its clarity gate
 * left open (`peak` carries the tallest NSDF peak so any minClarity can be applied later).
 * Computing this once per clip is what lets bench/calibrate try thousands of tunings.
 */
export interface Analysis {
  hops: { flux: number; rms: number }[];
  /** one per pitch poll: the hop index it fired on, window rms, and the ungated estimate */
  polls: { h: number; rms: number; est: PitchEstimate | null }[];
}

export function analyse(audio: Float32Array): Analysis {
  const sr = SR;
  const onset = new OnsetDetector({ sampleRate: sr });
  const nHops = Math.floor(audio.length / HOP_SIZE);
  const hops: Analysis['hops'] = [];
  const polls: Analysis['polls'] = [];
  const frame = new Float32Array(FFT_SIZE);
  const pitchWin = new Float32Array(PITCH_WINDOW);
  let nextPollT = 0;
  for (let h = 0; h < nHops; h++) {
    const hopStart = h * HOP_SIZE;
    const t = hopStart / sr;
    const fStart = hopStart + HOP_SIZE - FFT_SIZE;
    frame.fill(0);
    for (let i = Math.max(0, -fStart); i < FFT_SIZE; i++) {
      const src = fStart + i;
      if (src < audio.length) frame[i] = audio[src];
    }
    let sumSq = 0;
    for (let i = hopStart; i < hopStart + HOP_SIZE && i < audio.length; i++) sumSq += audio[i] * audio[i];
    hops.push({ flux: onset.flux(magnitudeSpectrum(frame)), rms: Math.sqrt(sumSq / HOP_SIZE) });
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
      polls.push({ h, rms: pRms, est: pRms > PITCH_RMS_FLOOR ? detectPitch(pitchWin, sr, 0) : null });
    }
  }
  return { hops, polls };
}

/**
 * Runs one clip through the pipeline with the given pitch-tracker profile. `tuning` replaces
 * the listener constants (defaults = the app's); `pre` is a cached `analyse(audio)`.
 */
export function runClip(
  audio: Float32Array,
  profile: PitchTrackerOptions,
  clock?: { bpm: number; t0: number },
  tuning: ListenerTuning = DEFAULT_TUNING,
  pre: Analysis = analyse(audio),
): RunResult {
  const sr = SR;
  const source = new SimSource();
  let currentSimT = 0;
  const listener = new Listener([source], ['mic'], () => currentSimT, tuning);
  const detectedNotes: DetectedNote[] = [];
  let keyLockT: number | null = null;
  let tempoLockT: number | null = null;
  const chords: { t: number; chord: Chord | null }[] = [];
  const beats: { t: number; beat: number; dynamics: Dynamics }[] = [];

  listener.onNote(n => {
    detectedNotes.push({ midi: n.midi, velocity: n.velocity, t: currentSimT });
  });

  // start() is async but resolves synchronously here (SimSource.start has no awaits
  // that yield), so the source callbacks are wired before we drive it.
  void listener.start();

  const onset = new OnsetDetector({ sampleRate: sr });
  const tracker = new PitchTracker(profile, tuning.tracker);
  const rawFrames: RawFrame[] = [];
  const pitchFrames: RunResult['pitchFrames'] = [];

  const nHops = pre.hops.length;
  let poll = 0;
  let lastBeat = -1;

  for (let h = 0; h < nHops; h++) {
    const hopStart = h * HOP_SIZE;
    const t = hopStart / sr;
    currentSimT = t;

    // --- onset path: same 1024-sample analysis frame ending at this hop ---
    const { flux, rms } = pre.hops[h];
    const at = onset.pushFlux(flux, t, rms);
    if (at !== null) {
      currentSimT = at;
      source.note(-1, Math.min(1, rms * 8), at);
      currentSimT = t;
    }

    // --- band clock: the app re-decides the chord every half bar and reads dynamics every beat ---
    if (clock) {
      const beatSec = 60 / clock.bpm;
      const beat = Math.floor((t - clock.t0) / beatSec);
      if (t >= clock.t0 && beat > lastBeat) {
        lastBeat = beat;
        beats.push({ t, beat, dynamics: listener.tickBeat(beat, t) });
        if (beat % 2 === 0) listener.tickChord(beat);
      }
    }

    // --- pitch path: poll every 50ms of simulated time ---
    if (poll < pre.polls.length && pre.polls[poll].h === h) {
      const p = pre.polls[poll++];
      // the same gate detectPitch applies when called with this minClarity
      const est = p.est && p.est.peak >= tuning.pitch.minClarity ? p.est : null;
      rawFrames.push({ t, hz: est?.hz ?? null });
      currentSimT = t;
      const reading = tracker.push(est ? { hz: est.hz, clarity: est.clarity, t } : null);
      pitchFrames.push({ t, midi: reading && reading.stable ? reading.midi : null });
      source.pitch?.(reading);

      const c = listener.input.chord;
      const last = chords[chords.length - 1];
      if (!last || (c?.root !== last.chord?.root || c?.quality !== last.chord?.quality)) chords.push({ t, chord: c });
      if (keyLockT === null && listener.input.key !== null) keyLockT = t;
      if (tempoLockT === null && listener.input.bpm !== null) tempoLockT = t;
    }
  }

  return {
    detectedNotes,
    rawFrames,
    pitchFrames,
    keyLockT,
    key: listener.input.key,
    tempoLockT,
    bpm: listener.input.bpm,
    chords,
    beats,
    downbeat: listener.downbeat,
  };
}
