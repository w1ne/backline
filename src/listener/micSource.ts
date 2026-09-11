import * as Tone from 'tone';
import type { Source } from './listener';
import { OnsetDetector } from './onset';
import { detectPitchHz, hzToMidi } from './pitch';

export class MicSource implements Source {
  private stream?: MediaStream;
  private raf = 0;

  async start(onNote: (m: number, v: number, t: number) => void, onLevel: (l: number) => void) {
    const ctx = Tone.getContext().rawContext as AudioContext;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const src = ctx.createMediaStreamSource(this.stream);
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    const onset = new OnsetDetector();
    const loop = () => {
      an.getFloatTimeDomainData(buf);
      const t = ctx.currentTime;
      let s = 0;
      for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
      const rms = Math.sqrt(s / buf.length);
      onLevel(Math.min(1, rms * 8));
      if (onset.process(buf, t)) {
        const hz = detectPitchHz(buf, ctx.sampleRate);
        onNote(hz ? hzToMidi(hz) : -1, Math.min(1, rms * 8), t);
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach(t => t.stop());
  }
}
