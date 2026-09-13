import * as Tone from 'tone';
export type { ClockLike } from './clockTypes';
import type { ClockLike } from './clockTypes';

export class ToneClock implements ClockLike {
  private cb?: (bar: number, t: number) => void;
  private halfCb?: (bar: number, t: number) => void;
  private id?: number;
  private halfId?: number;
  private bar = 0;
  private pendingBpm?: number;
  bpm = 0;
  onBar(cb: (bar: number, t: number) => void) {
    this.cb = cb;
  }
  onHalfBar(cb: (bar: number, t: number) => void) {
    this.halfCb = cb;
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
    // Half a measure after every downbeat, on the same transport as the bar callback, so a
    // mid-bar cue is not at the mercy of a setTimeout (clamped to a second in a hidden tab).
    // `this.bar` was already advanced by the bar callback, so the current bar is one less.
    this.halfId = T.scheduleRepeat((time) => this.halfCb?.(this.bar - 1, time), '1m', '2n');
    T.start(Math.max(firstBarAt, Tone.now() + 0.05));
  }
  stop() {
    const T = Tone.getTransport();
    if (this.id !== undefined) T.clear(this.id);
    this.id = undefined;
    if (this.halfId !== undefined) T.clear(this.halfId);
    this.halfId = undefined;
    this.pendingBpm = undefined;
    T.stop();
    T.cancel();
  }
  setBpm(bpm: number) {
    if (Number.isFinite(bpm) && bpm > 0) this.pendingBpm = bpm;
  }
}
