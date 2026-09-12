import type { BandState, Chord, Genre, Instrument, NoteEvent, Pattern } from '../types';
import { INSTRUMENTS, IDLE_DYNAMICS } from '../types';
import { tonicTriad } from '../listener/chordDetector';
import { mulberry32 } from '../rng';
import type { ClockLike } from './clockTypes';

const BEATS_PER_BAR = 4;
/** chord-timeline entries kept; two bars of half-bar ticks is plenty to voice a bar from */
const CHORD_LOG_MAX = 8;

export interface PlayersLike {
  schedule(instrument: Instrument, events: NoteEvent[], barStartTime: number, bpm: number): void;
}

export class Bandleader {
  state: BandState = {
    genre: 'lofi',
    key: { root: 0, mode: 'major' },
    chord: null,
    creativity: 0.3,
    enabled: { drums: false, bass: false, keys: false, lead: false },
    dynamics: { ...IDLE_DYNAMICS },
  };
  onBarCb?: (bar: number) => void;
  private rng: () => number;
  /** chord changes stamped with the absolute beat they took effect on, ascending */
  private chordLog: { beat: number; chord: Chord }[] = [];
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
  set(p: Partial<Pick<BandState, 'genre' | 'key' | 'chord' | 'creativity' | 'dynamics'>> & { chordBeat?: number }) {
    const { chordBeat, ...rest } = p;
    Object.assign(this.state, rest);
    if (p.chord) this.pushChord(p.chord, chordBeat);
  }

  private pushChord(chord: Chord, beat = 0) {
    const last = this.chordLog[this.chordLog.length - 1];
    if (last && last.beat >= beat) {
      // Same tick re-reported (or an out-of-order one): replace rather than append, so
      // chordAt() never has to reason about a non-monotonic log.
      last.chord = chord;
      return;
    }
    if (last && last.chord.root === chord.root && last.chord.quality === chord.quality) return;
    this.chordLog.push({ beat, chord });
    if (this.chordLog.length > CHORD_LOG_MAX) this.chordLog.shift();
  }

  /** Chord in force at an absolute beat, falling back to the key's tonic triad. */
  chordAtBeat(beat: number): Chord {
    for (let i = this.chordLog.length - 1; i >= 0; i--)
      if (this.chordLog[i].beat <= beat) return this.chordLog[i].chord;
    return this.state.chord ?? tonicTriad(this.state.key);
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
    const { genre, key, creativity, enabled, dynamics } = this.state;
    const barBeat = bar * BEATS_PER_BAR;
    const ctx = {
      bar,
      key,
      creativity,
      dynamics,
      rng: this.rng,
      chord: this.chordAtBeat(barBeat),
      chordAt: (beat: number) => this.chordAtBeat(barBeat + beat),
    };
    for (const i of INSTRUMENTS)
      if (enabled[i])
        this.players.schedule(i, this.patterns[genre][i].nextBar(ctx), t, this.clock.bpm);
  }
}
