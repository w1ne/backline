import { audioRecorder } from '../export/audioRecorder';
import * as Tone from 'tone';
import type { Source } from './listener';
import { OnsetDetector } from './onset';
import { FFT_SIZE, HOP_SIZE, magnitudeSpectrum } from './fft';
import { detectPitch } from './pitch';
import { PitchTracker, VOICE_PROFILE, type StablePitch } from './pitchTracker';
import { micConstraints } from './micConstraints';

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
  private srcNode?: MediaStreamAudioSourceNode;
  private lastRms = 0;
  /** chosen audioinput device, or null for the system default */
  private deviceId: string | null = null;
  /** while true, no onsets/levels/pitch reach the Listener — MIDI is unaffected */
  private muted = false;
  /** kept so a device change can restart the same pipeline without the Listener noticing */
  private cbs?: {
    onNote: (m: number, v: number, t: number) => void;
    onLevel: (l: number) => void;
    onPitch?: (p: StablePitch | null) => void;
  };

  constructor(deviceId: string | null = null) {
    this.deviceId = deviceId;
  }

  /**
   * Switches input device. While running this tears the stream down and builds it again
   * on the new device; the Listener keeps its tempo lock, key and chord state, because
   * only this source's audio nodes are replaced — nothing calls back into it.
   */
  async setDevice(deviceId: string | null): Promise<void> {
    if (deviceId === this.deviceId) return;
    this.deviceId = deviceId;
    const cbs = this.cbs;
    if (!cbs) return;
    this.stop();
    await this.start(cbs.onNote, cbs.onLevel, cbs.onPitch);
  }

  /**
   * Second attempt at getUserMedia, for the first user tap: a prompt raised on page
   * load has no user activation behind it and Chrome may quiet or refuse it.
   * Returns false when there is nothing to retry (never started, or already live).
   */
  async retry(): Promise<boolean> {
    if (!this.cbs || this.stream) return false;
    await this.start(this.cbs.onNote, this.cbs.onLevel, this.cbs.onPitch);
    return true;
  }

  get device(): string | null {
    return this.deviceId;
  }

  /** The mic's MediaStreamAudioSourceNode, for a monitor tap (e.g. the vocal chain) to
   *  connect from — this does not touch or gate the analysis path above. Undefined until
   *  start() has built it. */
  get sourceNode(): MediaStreamAudioSourceNode | undefined {
    return this.srcNode;
  }

  /**
   * Gates the mic's contribution to the listener without touching the MediaStream track,
   * so unmuting is instant (no getUserMedia round trip). MIDI input is a separate Source
   * and keeps working regardless.
   */
  setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    if (muted) {
      this.cbs?.onLevel(0);
      this.cbs?.onPitch?.(null);
    }
  }

  async start(
    onNote: (m: number, v: number, t: number) => void,
    onLevel: (l: number) => void,
    onPitch?: (p: StablePitch | null) => void,
  ) {
    this.cbs = { onNote, onLevel, onPitch };
    const ctx = Tone.getContext().rawContext as AudioContext;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(this.deviceId) });
    const src = ctx.createMediaStreamSource(this.stream);
    this.srcNode = src;
    audioRecorder.addSource(src);
    // kept for pitch only: continuously polled independently of onset timing
    const an = ctx.createAnalyser();
    an.fftSize = 4096; // longer window than the onset hop for better low-note resolution
    an.smoothingTimeConstant = 0;
    src.connect(an);
    const pitchBuf = new Float32Array(an.fftSize);
    const onset = new OnsetDetector({ sampleRate: ctx.sampleRate });
    // the mic is mostly a voice at a duet.ai session; instruments still pass, just a little sooner
    const tracker = new PitchTracker(VOICE_PROFILE);

    // onsets now only drive tempo; note pitch comes from the continuous tracker below
    const fire = (t: number) => {
      if (this.muted) return;
      onNote(-1, Math.min(1, this.lastRms * 8), t + performance.now() / 1000 - ctx.currentTime);
    };

    this.pitchTimer = window.setInterval(() => {
      if (this.muted) return;
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
        if (!this.muted && n++ % LEVEL_EVERY === 0) onLevel(Math.min(1, rms * 20));
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
      if (!this.muted && n++ % LEVEL_EVERY === 0) onLevel(Math.min(1, rms * 20));
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
    if (this.srcNode) audioRecorder.removeSource(this.srcNode);
    this.srcNode?.disconnect();
    this.srcNode = undefined;
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = undefined;
  }
}
