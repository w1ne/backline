import type { BandInput, Chord, Dynamics, Key } from '../types';
import { ActivityTracker } from './activity';
import { TempoLock, bpmFromOnsets } from './tempoLock';
import { TempoFollower } from './tempoFollower';
import { KeyDetector } from './keyDetector';
import { ChordDetector } from './chordDetector';
import type { StablePitch } from './pitchTracker';

export interface Source {
  start(
    onNote: (midi: number, velocity: number, timeSec: number) => void,
    onLevel: (level: number) => void,
    onPitch?: (p: StablePitch | null) => void,
  ): Promise<void>;
  stop(): void;
}

/** stable pitch-tracker notes are kept this long for the YOU strip's chip list */
const PITCH_NOTES_WINDOW_SEC = 1.5;

export type SourceKind = 'mic' | 'midi';
export type SourceState = 'off' | 'on' | 'denied' | 'none';
export type SourceStatus = { mic: SourceState; midi: SourceState };

/** onsets needed before the LCD dares show a running tempo estimate */
const PENDING_MIN_ONSETS = 6;

export class Listener {
  private tempo = new TempoLock();
  private activity = new ActivityTracker();
  private keyDet = new KeyDetector();
  private chordDet = new ChordDetector();
  private chord: Chord | null = null;
  /** absolute beat of the last `tickChord`; diagnostic only */
  lastChordBeat = -1;
  private recent: { n: number; t: number }[] = [];
  /** distinct stable notes from the continuous mic pitch tracker */
  private pitchNotes: { n: number; t: number }[] = [];
  private pitch: StablePitch | null = null;
  private lastStableMidi: number | null = null;
  /** when a MIDI note last arrived; while none is recent the chord detector runs in melody mode */
  private lastMidiNoteAt = -Infinity;
  private level = 0;
  private onsetCount = 0;
  /** onset times kept only for the live "~98 BPM" readout while listening */
  private onsetTimes: number[] = [];
  private override: { bpm?: number; key?: Key } = {};
  private cbs: ((i: BandInput) => void)[] = [];
  private statusCbs: ((s: SourceStatus) => void)[] = [];
  private noteCbs: ((n: { midi: number; velocity: number; timeSec: number }) => void)[] = [];
  private mode: 'locked' | 'follow' = 'locked';
  private follower?: TempoFollower;
  private followBpm: number | null = null;
  /** bpm to report while locked after having followed — freezes where the follower left off
   * instead of snapping back to the original lock estimate */
  private frozenBpm: number | null = null;
  private sources: Source[];
  private kinds: SourceKind[];
  private status: SourceStatus = { mic: 'off', midi: 'off' };

  /** seconds on the clock every note, level and chord tick is stamped with; injectable for offline replay */
  private now: () => number;

  constructor(sources: Source[], kinds?: SourceKind[], now: () => number = () => performance.now() / 1000) {
    this.sources = sources;
    this.kinds = kinds ?? sources.map((_, i) => (i === 0 ? 'midi' : 'mic'));
    this.now = now;
  }

  setTempoMode(m: 'locked' | 'follow') {
    if (m === this.mode) return;
    if (m === 'locked') {
      this.frozenBpm = this.followBpm ?? this.frozenBpm;
      this.follower = undefined;
      this.followBpm = null;
    } else {
      this.follower = undefined;
      this.followBpm = null;
    }
    this.mode = m;
    this.emit();
  }

  async start() {
    const onNote = (n: number, v: number, t: number) => {
      this.tempo.push(t);
      if (this.tempo.locked && this.mode === 'follow') {
        this.follower ??= new TempoFollower(this.frozenBpm ?? this.tempo.locked.bpm);
        this.followBpm = this.follower.push(t);
      }
      this.onsetCount++;
      this.activity.onset(t);
      this.onsetTimes.push(t);
      if (this.onsetTimes.length > 24) this.onsetTimes.shift();
      if (n >= 0) {
        this.lastMidiNoteAt = t;
        this.keyDet.addNote(n, v);
        this.chordDet.addNote(n, t, Math.max(0.3, v));
        this.recent.push({ n, t });
        this.recent = this.recent.filter(r => t - r.t < 0.5);
        this.noteCbs.forEach(cb => cb({ midi: n, velocity: v, timeSec: t }));
      }
      this.emit();
    };
    const onLevel = (lvl: number) => {
      this.level = lvl;
      this.activity.level(lvl, this.now());
      this.emit();
    };
    const onPitch = (p: StablePitch | null) => {
      this.pitch = p;
      const now = this.now();
      if (p && p.stable) {
        // Preserve the performance; harmony constraints belong to accompaniment output.
        const midi = p.midi;
        if (midi !== this.lastStableMidi) {
          this.lastStableMidi = midi;
          this.keyDet.addNote(midi, 0.8);
          this.chordDet.addNote(midi, now, 0.8);
          this.pitchNotes.push({ n: midi, t: now });
          this.noteCbs.forEach(cb => cb({ midi, velocity: 0.8, timeSec: now }));
        }
      } else {
        this.lastStableMidi = null;
      }
      this.pitchNotes = this.pitchNotes.filter(r => now - r.t < PITCH_NOTES_WINDOW_SEC);
      this.emit();
    };

    await Promise.all(
      this.sources.map(async (source, i) => {
        const kind = this.kinds[i];
        try {
          await source.start(onNote, onLevel, onPitch);
          const getStatus = (source as { getStatus?(): SourceState }).getStatus;
          this.status = { ...this.status, [kind]: getStatus ? getStatus.call(source) : 'on' };
        } catch {
          this.status = { ...this.status, [kind]: 'denied' };
        } finally {
          this.emitStatus();
        }
      }),
    );
    this.emitStatus();
  }

  stop() { this.sources.forEach(s => s.stop()); }

  /** Records a source that came up (or failed) after start(), e.g. a mic retried on the first tap. */
  setSourceState(kind: SourceKind, state: SourceState) {
    this.status = { ...this.status, [kind]: state };
    this.emitStatus();
  }

  /** Gates the mic source(s) only; MIDI sources are untouched. */
  setMicMuted(muted: boolean): void {
    this.sources.forEach((s, i) => {
      if (this.kinds[i] !== 'mic') return;
      (s as { setMuted?(m: boolean): void }).setMuted?.(muted);
    });
  }

  setOverride(p: { bpm?: number; key?: Key }) { Object.assign(this.override, p); this.emit(); }

  onChange(cb: (i: BandInput) => void) { this.cbs.push(cb); }

  /** Fires for every pitched note (rests, i.e. midi < 0, are excluded). */
  onNote(cb: (n: { midi: number; velocity: number; timeSec: number }) => void) {
    this.noteCbs.push(cb);
    return () => { this.noteCbs = this.noteCbs.filter(fn => fn !== cb); };
  }

  onSourceStatus(cb: (s: SourceStatus) => void) { this.statusCbs.push(cb); }

  get sourceStatus(): SourceStatus { return this.status; }

  get hasBpmOverride(): boolean { return this.override.bpm !== undefined; }

  get input(): BandInput {
    return {
      bpm:
        this.override.bpm ??
        (this.mode === 'follow' ? this.followBpm ?? this.frozenBpm : this.frozenBpm) ??
        this.tempo.locked?.bpm ??
        null,
      key: this.override.key ?? this.keyDet.key,
      chord: this.chord,
      notesNow: [...new Set([...this.recent.map(r => r.n), ...this.pitchNotes.map(r => r.n)])],
      pitch: this.pitch,
      inputLevel: this.level,
      onsets: this.onsetCount,
      pendingBpm: bpmFromOnsets(this.onsetTimes, PENDING_MIN_ONSETS)?.bpm ?? null,
      dynamics: this.activity.dynamics,
    };
  }

  /**
   * Folds the last beat of playing into a fresh `Dynamics` frame. Called by the app's beat
   * clock (`beatIndex` is absolute beats since the band started), not per note — the band
   * re-reads the player once a beat, the same rate it makes decisions at.
   */
  tickBeat(beatIndex: number, t = this.now()): Dynamics {
    const d = this.activity.tick(beatIndex, t);
    this.emit();
    return d;
  }

  /**
   * Re-decides the chord from the notes in the last two beats. Called by the app clock on
   * every bar and half bar (`beatIndex` is absolute beats since the band started), not per
   * note — the band wants one chord per half bar, not a new guess on every key press.
   */
  tickChord(beatIndex: number): Chord | null {
    const bpm = this.input.bpm;
    if (bpm) this.chordDet.windowSec = (2 * 60) / bpm;
    const now = this.now();
    const mode = now - this.lastMidiNoteAt > this.chordDet.windowSec * 2 ? 'melody' : 'auto';
    this.chord = this.chordDet.tick(now, this.input.key, mode);
    this.lastChordBeat = beatIndex;
    this.emit();
    return this.chord;
  }

  get downbeat() { return this.tempo.locked?.downbeat ?? null; }

  private emit() { const i = this.input; this.cbs.forEach(c => c(i)); }

  private emitStatus() { const s = this.status; this.statusCbs.forEach(c => c(s)); }
}
