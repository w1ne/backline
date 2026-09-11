import type { BandState, Genre, Instrument, NoteEvent, Pattern } from '../types';
import { INSTRUMENTS } from '../types';
import { mulberry32 } from '../rng';
import type { ClockLike } from './clockTypes';

export interface PlayersLike {
  schedule(instrument: Instrument, events: NoteEvent[], barStartTime: number, bpm: number): void;
}

export class Bandleader {
  state: BandState = {
    genre: 'lofi',
    key: { root: 0, mode: 'major' },
    creativity: 0.3,
    enabled: { drums: false, bass: false, keys: false, lead: false },
  };
  onBarCb?: (bar: number) => void;
  private rng: () => number;
  constructor(
    readonly clock: ClockLike,
    private players: PlayersLike,
    private patterns: Record<Genre, Record<Instrument, Pattern>>,
    seed = Date.now(),
    /** Returns "now" in the same time base as the bar-start times the clock hands to onBar.
     * Defaults to never-past so tests driving a fake clock with synthetic times aren't
     * affected; production wires this to Tone.now(). */
    private now: () => number = () => -Infinity,
  ) {
    this.rng = mulberry32(seed);
    clock.onBar((bar, t) => this.onBar(bar, t));
  }
  set(p: Partial<Pick<BandState, 'genre' | 'key' | 'creativity'>>) {
    Object.assign(this.state, p);
  }
  setEnabled(i: Instrument, on: boolean) {
    this.state.enabled[i] = on;
  }
  start(bpm: number, firstBarAt: number) {
    this.clock.start(bpm, firstBarAt);
  }
  stop() {
    this.clock.stop();
  }
  private onBar(bar: number, t: number) {
    this.onBarCb?.(bar);
    // A toggle can land after this bar's callback was scheduled ahead of time; if the bar's
    // start has already slipped into the past, don't schedule stale notes for it — the
    // instrument simply joins on the next bar.
    if (t < this.now()) return;
    const { genre, key, creativity, enabled } = this.state;
    for (const i of INSTRUMENTS)
      if (enabled[i])
        this.players.schedule(
          i,
          this.patterns[genre][i].nextBar({ bar, key, creativity, rng: this.rng }),
          t,
          this.clock.bpm,
        );
  }
}
