import type { BandState, Chord, Genre, Instrument, NoteEvent, Pattern } from '../types';
import { INSTRUMENTS, IDLE_DYNAMICS, DRUM } from '../types';
import { sameChord, tonicTriad } from '../listener/chordDetector';
import { colorChord } from '../music/chordColor';
import { mulberry32 } from '../rng';
import type { ClockLike } from './clockTypes';
import { SongForm } from './form';

const BEATS_PER_BAR = 4;
/** chord-timeline entries kept; two bars of half-bar ticks is plenty to voice a bar from */
const CHORD_LOG_MAX = 8;

/** Timing jitter, in milliseconds either side of the written time. Kick and snare — the
 *  notes that most give away a rigid grid — get a tighter window than everything else. */
const JITTER_MS = 8;
const JITTER_MS_TIGHT = 4;
/** Velocity curve: written velocity randomized by up to this fraction, up or down. */
const VELOCITY_VARIATION = 0.1;

/** Applies deterministic (rng-seeded) timing jitter and velocity variation to a bar's worth
 *  of events, so the band doesn't sit dead-on-grid at one fixed loudness. Pitch/duration/
 *  note choice are untouched; ghost notes are out of scope. `spb` (seconds per beat)
 *  converts the millisecond jitter into NoteEvent's beat-relative `time` unit. */
export function humanize(inst: Instrument, events: NoteEvent[], spb: number, rng: () => number): NoteEvent[] {
  return events.map(e => {
    const tight = inst === 'drums' && (e.note === DRUM.kick || e.note === DRUM.snare);
    const jitterMs = tight ? JITTER_MS_TIGHT : JITTER_MS;
    const jitterBeats = ((rng() * 2 - 1) * jitterMs) / 1000 / spb;
    const velocityMul = 1 + (rng() * 2 - 1) * VELOCITY_VARIATION;
    return {
      ...e,
      time: Math.max(0, e.time + jitterBeats),
      velocity: Math.min(1, Math.max(0, e.velocity * velocityMul)),
    };
  });
}

/** Original event objects actually accepted for audible scheduling. Fired only after
 * sample readiness and stale/mute checks; omitted when nothing can play. */
export type ScheduleConfirmation = (events: readonly NoteEvent[]) => void;

export interface PlayersLike {
  setEnabled?(instrument: Instrument, on: boolean): void;
  setBandAmount?(amount: number): void;
  cancelScheduled?(): void;
  schedule(instrument: Instrument, events: NoteEvent[], barStartTime: number, bpm: number, onScheduled?: ScheduleConfirmation): void;
  /** AMT only: play through a real GM instrument sampler (see gmInstruments.ts) instead of
   *  the synthesized Keys voice. */
  scheduleAccompaniment?(gmProgram: number, events: NoteEvent[], barStartTime: number, bpm: number, onScheduled?: ScheduleConfirmation): void;
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
  /** the song's own arrangement — intro/groove/lift/breakdown/ending — reset on every start() */
  private songForm = new SongForm();
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
  set(p: Partial<Pick<BandState, 'genre' | 'key' | 'chord' | 'creativity' | 'dynamics' | 'source' | 'sungPitchClass'>> & { chordBeat?: number }) {
    const { chordBeat, ...rest } = p;
    Object.assign(this.state, rest);
    if (p.chord) {
      // Genre-color the detected triad right where the chord is stored, so both the
      // patterns (via chordAtBeat) and anything downstream (e.g. the AMT engine's
      // chordName upstream) see the same colored chord. Uses genre/key/source as of this
      // call, which Object.assign above has already applied if this same `set` also changed
      // them.
      const colored = colorChord(p.chord, this.state.genre, this.state.key, this.state.source);
      this.state.chord = colored;
      this.pushChord(colored, chordBeat);
    }
  }

  private pushChord(chord: Chord, beat = 0) {
    const last = this.chordLog[this.chordLog.length - 1];
    if (last && last.beat >= beat) {
      // Same tick re-reported (or an out-of-order one): replace rather than append, so
      // chordAt() never has to reason about a non-monotonic log.
      last.chord = chord;
      return;
    }
    if (last && sameChord(last.chord, chord)) return;
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
    this.songForm.reset();
    this.clock.start(bpm, firstBarAt);
  }
  stop() {
    this.clock.stop();
    // Stopping the clock only cancels bars that haven't been scheduled yet — the bar already
    // in flight was handed to the synths as absolute-time triggerAttackRelease calls, which
    // keep ringing on their own regardless of transport state. Cancel those too, so pause is
    // immediate instead of waiting out whatever was already committed.
    this.players.cancelScheduled?.();
  }
  private onBar(bar: number, t: number) {
    this.onBarCb?.(bar);
    // A toggle can land after this bar's callback was scheduled ahead of time; if the bar's
    // start has already slipped into the past, don't schedule stale notes for it — the
    // instrument simply joins on the next bar.
    if (t < this.now()) return;
    const { genre, key, creativity, enabled, dynamics, source, sungPitchClass } = this.state;
    const barBeat = bar * BEATS_PER_BAR;
    const form = this.songForm.tick({ bar, dynamics, silenceBeats: dynamics.silenceBeats, playerStopped: false });
    const ctx = {
      bar,
      key,
      creativity,
      dynamics,
      rng: this.rng,
      chord: this.chordAtBeat(barBeat),
      chordAt: (beat: number) => this.chordAtBeat(barBeat + beat),
      arrangement: form.arrangement,
      // Below a singer's range, not a global — only meaningful for the keys comp.
      keysHigh: source === 'mic' ? 60 : undefined,
      sungPitchClass: source === 'mic' ? sungPitchClass : undefined,
    };
    const spb = this.clock.bpm > 0 ? 60 / this.clock.bpm : 0.5;
    for (const i of INSTRUMENTS)
      if (enabled[i])
        this.players.schedule(i, humanize(i, this.patterns[genre][i].nextBar(ctx), spb, this.rng), t, this.clock.bpm);
    // The ending bar above has just been scheduled with arrangement.ending — now stop the
    // clock so the band doesn't loop forever. The app restarts it through the existing
    // first-lock path once the singer comes back in (see main.ts).
    if (form.shouldStop) this.stop();
  }
}
