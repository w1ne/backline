import * as Tone from 'tone';
export type { ClockLike } from './clockTypes';
import type { ClockLike } from './clockTypes';

export class ToneClock implements ClockLike {
  private cb?: (bar: number, t: number) => void;
  private id?: number;
  private bar = 0;
  bpm = 0;
  onBar(cb: (bar: number, t: number) => void) {
    this.cb = cb;
  }
  start(bpm: number, firstBarAt: number) {
    const T = Tone.getTransport();
    this.bpm = bpm;
    T.bpm.value = bpm;
    this.bar = 0;
    this.id = T.scheduleRepeat(
      (time) => {
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
    T.stop();
    T.cancel();
  }
  setBpm(bpm: number) {
    Tone.getTransport().bpm.rampTo(bpm, 60 / this.bpm);
    this.bpm = bpm;
  }
}
