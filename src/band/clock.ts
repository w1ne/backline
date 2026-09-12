import * as Tone from 'tone';
export type { ClockLike } from './clockTypes';
import type { ClockLike } from './clockTypes';

export class ToneClock implements ClockLike {
  private cb?: (bar: number, t: number) => void;
  private id?: number;
  private bar = 0;
  private pendingBpm?: number;
  bpm = 0;
  onBar(cb: (bar: number, t: number) => void) {
    this.cb = cb;
  }
  start(bpm: number, firstBarAt: number) {
    const T = Tone.getTransport();
    this.bpm = bpm;
    this.pendingBpm = undefined;
    T.bpm.value = bpm;
    this.bar = 0;
    this.id = T.scheduleRepeat(
      (time) => {
        // A whole bar's notes have already been committed in audio seconds.
        // Change both the transport and the next bar's note spacing together.
        if (this.pendingBpm !== undefined) {
          this.bpm = this.pendingBpm;
          this.pendingBpm = undefined;
          T.bpm.setValueAtTime(this.bpm, time);
        }
        this.cb?.(this.bar++, time);
      },
      '1m',
      0,
    );
    T.start(Math.max(firstBarAt, Tone.now() + 0.05));
  }
  stop() {
    const T = Tone.getTransport();
    if (this.id !== undefined) T.clear(this.id);
    this.id = undefined;
    this.pendingBpm = undefined;
    T.stop();
    T.cancel();
  }
  setBpm(bpm: number) {
    if (Number.isFinite(bpm) && bpm > 0) this.pendingBpm = bpm;
  }
}
