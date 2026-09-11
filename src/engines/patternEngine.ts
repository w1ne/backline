import type { BandState, Genre, Instrument, Pattern } from '../types';
import { Bandleader, type PlayersLike } from '../band/bandleader';
import { ToneClock } from '../band/clock';
import type { BandEngine } from './engine';

/** Wraps the existing Bandleader + ToneClock + Players behind the BandEngine interface. */
export class PatternEngine implements BandEngine {
  readonly changeLatencyMs = 0;
  private band: Bandleader;
  onBar?: (bar: number) => void;

  constructor(players: PlayersLike, patterns: Record<Genre, Record<Instrument, Pattern>>) {
    this.band = new Bandleader(new ToneClock(), players, patterns);
    this.band.onBarCb = bar => this.onBar?.(bar);
  }

  async start(bpm: number, firstBarAt: number): Promise<void> {
    this.band.start(bpm, firstBarAt);
  }

  stop(): void {
    this.band.stop();
  }

  set(p: Partial<Pick<BandState, 'genre' | 'key' | 'creativity'>>): void {
    this.band.set(p);
  }

  setEnabled(i: Instrument, on: boolean): void {
    this.band.setEnabled(i, on);
  }

  setBpm(bpm: number): void {
    this.band.clock.setBpm(bpm);
  }
}
