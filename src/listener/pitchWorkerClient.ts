import type { StablePitch } from './pitchTracker';
export interface PitchJob { samples: Float32Array; sampleRate: number; timeSec: number }
export interface PitchResult { pitch: StablePitch | null; timeSec: number }
/** One running frame plus one replaceable latest frame: work cannot accumulate. */
export class PitchWorkerClient {
  private busy = false;
  private latest?: PitchJob;
  private stopped = false;
  constructor(private worker: Worker, private onPitch: (p: StablePitch | null, timeSec: number) => void) {
    worker.onmessage = (event: MessageEvent<PitchResult>) => {
      if (this.stopped) return;
      this.busy = false;
      this.onPitch(event.data.pitch, event.data.timeSec);
      const next = this.latest;
      this.latest = undefined;
      if (next) this.submit(next);
    };
    worker.onerror = () => { this.onPitch(null, performance.now() / 1000); this.stop(); };
  }
  submit(job: PitchJob): void {
    if (this.stopped) return;
    if (this.busy) { this.latest = job; return; }
    this.busy = true;
    this.worker.postMessage(job, [job.samples.buffer as ArrayBuffer]);
  }
  stop(): void {
    this.stopped = true;
    this.latest = undefined;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
  }
}
export function createPitchWorker(): Worker {
  return new Worker(new URL('./pitchWorker.ts', import.meta.url), { type: 'module' });
}
