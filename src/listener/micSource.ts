import * as Tone from 'tone';
import type { Source } from './listener';
import { OnsetDetector } from './onset';
import { FFT_SIZE, HOP_SIZE, magnitudeSpectrum } from './fft';
import { detectPitch } from './pitch';
import { PitchTracker, type StablePitch } from './pitchTracker';

const WORKLET_URL = `${import.meta.env.BASE_URL}worklet/onset-processor.js`;
/** one level update every N hops — the meter does not need 93 repaints a second */
const LEVEL_EVERY = 3;
/** continuous pitch poll period, independent of onsets */
const PITCH_POLL_MS = 50;
/** below this rms there is nothing to track a pitch on (same floor the onset path treats as silence) */
const PITCH_RMS_FLOOR = 0.01;

export class MicSource implements Source {
  private stream?: MediaStream;
  private timer = 0;
  private pitchTimer = 0;
  private node?: AudioWorkletNode;
  private lastRms = 0;

  async start(
    onNote: (m: number, v: number, t: number) => void,
    onLevel: (l: number) => void,
    onPitch?: (p: StablePitch | null) => void,
  ) {
    const ctx = Tone.getContext().rawContext as AudioContext;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const src = ctx.createMediaStreamSource(this.stream);
    // kept for pitch only: continuously polled independently of onset timing
    const an = ctx.createAnalyser();
    an.fftSize = 4096; // longer window than the onset hop for better low-note resolution
    an.smoothingTimeConstant = 0;
    src.connect(an);
    const pitchBuf = new Float32Array(an.fftSize);
    const onset = new OnsetDetector({ sampleRate: ctx.sampleRate });
    const tracker = new PitchTracker();

    // onsets now only drive tempo; note pitch comes from the continuous tracker below
    const fire = (t: number) => onNote(-1, Math.min(1, this.lastRms * 8), t);

    this.pitchTimer = window.setInterval(() => {
      if (this.lastRms <= PITCH_RMS_FLOOR) {
        onPitch?.(tracker.push(null));
        return;
      }
      an.getFloatTimeDomainData(pitchBuf);
      const est = detectPitch(pitchBuf, ctx.sampleRate);
      onPitch?.(tracker.push(est ? { hz: est.hz, clarity: est.clarity, t: ctx.currentTime } : null));
    }, PITCH_POLL_MS);

    try {
      await ctx.audioWorklet.addModule(WORKLET_URL);
      const node = new AudioWorkletNode(ctx, 'onset-processor', { numberOfOutputs: 0 });
      this.node = node;
      src.connect(node);
      let n = 0;
      node.port.onmessage = e => {
        const { flux, rms, t } = e.data as { flux: number; rms: number; t: number };
        this.lastRms = rms;
        if (n++ % LEVEL_EVERY === 0) onLevel(Math.min(1, rms * 20));
        const at = onset.pushFlux(flux, t, rms);
        if (at !== null) fire(at);
      };
      return;
    } catch {
      // No AudioWorklet (or the module failed to load): poll the analyser instead.
      // Frames then overlap unevenly, which costs some timing precision, but the
      // flux detector itself works the same.
      this.pollAnalyser(ctx, an, onset, onLevel, fire);
    }
  }

  /** Fallback path: 10 ms polling of the analyser, skipping frames that have not moved on. */
  private pollAnalyser(
    ctx: AudioContext,
    an: AnalyserNode,
    onset: OnsetDetector,
    onLevel: (l: number) => void,
    fire: (t: number) => void,
  ) {
    const tail = new Float32Array(an.fftSize);
    let lastHash = NaN;
    let n = 0;
    this.timer = window.setInterval(() => {
      an.getFloatTimeDomainData(tail);
      let hash = 0;
      for (let i = 0; i < 16; i++) hash += tail[tail.length - 1 - i] * (i + 1);
      if (hash === lastHash) return; // analyser has not been refilled yet
      lastHash = hash;
      let s = 0;
      for (let i = tail.length - HOP_SIZE; i < tail.length; i++) s += tail[i] * tail[i];
      const rms = Math.sqrt(s / HOP_SIZE);
      this.lastRms = rms;
      if (n++ % LEVEL_EVERY === 0) onLevel(Math.min(1, rms * 20));
      const t = ctx.currentTime - FFT_SIZE / 2 / ctx.sampleRate;
      const frame = tail.slice(tail.length - FFT_SIZE);
      const at = onset.pushFlux(onset.flux(magnitudeSpectrum(frame)), t, rms);
      if (at !== null) fire(at);
    }, 10);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = 0;
    if (this.pitchTimer) clearInterval(this.pitchTimer);
    this.pitchTimer = 0;
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
      this.node = undefined;
    }
    this.stream?.getTracks().forEach(t => t.stop());
  }
}
