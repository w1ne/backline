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
  ) {
    this.rng = mulberry32(seed);
    clock.onBar((bar, t) => this.onBar(bar, t));
  }
  set(p: Partial<BandState>) {
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
