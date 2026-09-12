import * as Tone from 'tone';
import type { Source } from './listener';
import { OnsetDetector } from './onset';
import { FFT_SIZE, HOP_SIZE, magnitudeSpectrum } from './fft';
import { detectPitchHz, hzToMidi } from './pitch';

const WORKLET_URL = `${import.meta.env.BASE_URL}worklet/onset-processor.js`;
/** one level update every N hops — the meter does not need 93 repaints a second */
const LEVEL_EVERY = 3;

export class MicSource implements Source {
  private stream?: MediaStream;
  private timer = 0;
  private node?: AudioWorkletNode;

  async start(onNote: (m: number, v: number, t: number) => void, onLevel: (l: number) => void) {
    const ctx = Tone.getContext().rawContext as AudioContext;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const src = ctx.createMediaStreamSource(this.stream);
    // kept for pitch only: read the freshest time-domain samples when an onset lands
    const an = ctx.createAnalyser();
    an.fftSize = 2048; // pitch wants a longer window than the onset hop does
    an.smoothingTimeConstant = 0;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    const onset = new OnsetDetector({ sampleRate: ctx.sampleRate });

    const fire = (t: number, rms: number) => {
      an.getFloatTimeDomainData(buf);
      const hz = detectPitchHz(buf, ctx.sampleRate);
      onNote(hz ? hzToMidi(hz) : -1, Math.min(1, rms * 8), t);
    };

    try {
      await ctx.audioWorklet.addModule(WORKLET_URL);
      const node = new AudioWorkletNode(ctx, 'onset-processor', { numberOfOutputs: 0 });
      this.node = node;
      src.connect(node);
      let n = 0;
      node.port.onmessage = e => {
        const { flux, rms, t } = e.data as { flux: number; rms: number; t: number };
        if (n++ % LEVEL_EVERY === 0) onLevel(Math.min(1, rms * 20));
        const at = onset.pushFlux(flux, t, rms);
        if (at !== null) fire(at, rms);
      };
      return;
    } catch {
      // No AudioWorklet (or the module failed to load): poll the analyser instead.
      // Frames then overlap unevenly, which costs some timing precision, but the
      // flux detector itself works the same.
      this.pollAnalyser(ctx, an, buf, onset, onLevel, fire);
    }
  }

  /** Fallback path: 10 ms polling of the analyser, skipping frames that have not moved on. */
  private pollAnalyser(
    ctx: AudioContext,
    an: AnalyserNode,
    buf: Float32Array<ArrayBuffer>,
    onset: OnsetDetector,
    onLevel: (l: number) => void,
    fire: (t: number, rms: number) => void,
  ) {
    let lastHash = NaN;
    let n = 0;
    this.timer = window.setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let hash = 0;
      for (let i = 0; i < 16; i++) hash += buf[buf.length - 1 - i] * (i + 1);
      if (hash === lastHash) return; // analyser has not been refilled yet
      lastHash = hash;
      let s = 0;
      for (let i = buf.length - HOP_SIZE; i < buf.length; i++) s += buf[i] * buf[i];
      const rms = Math.sqrt(s / HOP_SIZE);
      if (n++ % LEVEL_EVERY === 0) onLevel(Math.min(1, rms * 20));
      const t = ctx.currentTime - FFT_SIZE / 2 / ctx.sampleRate;
      const frame = buf.slice(buf.length - FFT_SIZE);
      const at = onset.pushFlux(onset.flux(magnitudeSpectrum(frame)), t, rms);
      if (at !== null) fire(at, rms);
    }, 10);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = 0;
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
      this.node = undefined;
    }
    this.stream?.getTracks().forEach(t => t.stop());
  }
}
