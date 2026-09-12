import type { BandInput, Chord, Dynamics, Key } from '../types';
import { ActivityTracker } from './activity';
import { TempoLock, bpmFromOnsets } from './tempoLock';
import { TempoFollower } from './tempoFollower';
import { KeyDetector } from './keyDetector';
import { ChordDetector } from './chordDetector';
import type { StablePitch } from './pitchTracker';
import { DEFAULT_TUNING, type ListenerTuning } from './tuning';

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
/** seconds of onsets, with no lock yet, before a provisional tempo is adopted from pendingBpm */
const PROVISIONAL_WAIT_SEC = 8;
/** longest gap between two stable pitch frames still counted as the note being held */
const MAX_PITCH_FRAME_SEC = 0.1;

export class Listener {
  private tempo = new TempoLock();
  private activity = new ActivityTracker();
  private keyDet: KeyDetector;
  private chordDet: ChordDetector;
  private chord: Chord | null = null;
  /** absolute beat of the last `tickChord`; diagnostic only */
  lastChordBeat = -1;
  private recent: { n: number; t: number }[] = [];
  /** distinct stable notes from the continuous mic pitch tracker */
  private pitchNotes: { n: number; t: number }[] = [];
  private pitch: StablePitch | null = null;
  private lastStableMidi: number | null = null;
  /** the last stable pitch as sung (before snapping), so the key detector counts real note changes */
  private lastSungMidi: number | null = null;
  /** when a MIDI note last arrived; while none is recent the chord detector runs in melody mode */
  private lastMidiNoteAt = -Infinity;
  private level = 0;
  private onsetCount = 0;
  /** onset times kept only for the live "~98 BPM" readout while listening */
  private onsetTimes: number[] = [];
  /** how many of `onsetTimes` came from the mic; a voice majority folds syllable rate to the beat */
  private voiceOnsets = 0;
  /** clock reading at the previous stable pitch frame, for the key detector's duration weights */
  private lastPitchAt: number | null = null;
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

  constructor(sources: Source[], kinds?: SourceKind[], now: () => number = () => performance.now() / 1000, tuning: ListenerTuning = DEFAULT_TUNING) {
    this.sources = sources;
    this.kinds = kinds ?? sources.map((_, i) => (i === 0 ? 'midi' : 'mic'));
    this.now = now;
    this.keyDet = new KeyDetector(tuning.key);
    this.chordDet = new ChordDetector(tuning.chord);
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
    const onNote = (n: number, v: number, t: number, kind: SourceKind) => {
      const voice = kind === 'mic';
      this.tempo.push(t, voice);
      if (this.tempo.locked && this.mode === 'follow') {
        this.follower ??= new TempoFollower(this.frozenBpm ?? this.tempo.locked.bpm);
        this.followBpm = this.follower.push(t);
      }
      this.onsetCount++;
      this.activity.onset(t);
      this.onsetTimes.push(t);
      if (voice) this.voiceOnsets++;
      if (this.onsetTimes.length > 24) { this.onsetTimes.shift(); if (this.voiceOnsets > this.onsetTimes.length) this.voiceOnsets = this.onsetTimes.length; }
      // A singer with a fast tempo shouldn't wait the full 12 onsets for the band to start:
      // once there's been 6+ onsets' worth of signal for 8s with still no real lock, adopt
      // the running estimate as a provisional one — bpmFromOnsets(..., 12) below still runs
      // every push and will replace it with the real lock as soon as it's ready.
      if (!this.tempo.locked && this.onsetTimes.length >= PENDING_MIN_ONSETS) {
        const first = this.onsetTimes[0];
        if (t - first >= PROVISIONAL_WAIT_SEC) {
          const pending = bpmFromOnsets(this.onsetTimes, PENDING_MIN_ONSETS, this.tempoOpts);
          if (pending) this.tempo.adoptProvisional(pending.bpm, pending.downbeat);
        }
      }
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
        // The key detector hears the pitch as sung, never the snapped one below: snapping to a
        // provisional key would only ever confirm it. It weighs a pitch by how long it is held
        // (frames are ~50 ms apart; a gap after silence is capped so it does not count), and
        // counts each new pitch once toward its minimum-evidence gate.
        if (this.lastPitchAt !== null) this.keyDet.addSustain(p.midi, Math.min(Math.max(0, now - this.lastPitchAt), MAX_PITCH_FRAME_SEC));
        this.lastPitchAt = now;
        if (p.midi !== this.lastSungMidi) {
          this.lastSungMidi = p.midi;
          this.keyDet.addNote(p.midi, 0);
        }
        // A voice glides through the cracks between scale tones; once the key is known and
        // the singer is actually staying inside it, land each sung pitch on the nearest scale
        // tone so a slide does not drag the harmony.
        const snapKey = this.override.key ?? (this.keyDet.fits ? this.keyDet.key : null);
        const midi = snapToKey(p.midi, snapKey);
        if (midi !== this.lastStableMidi) {
          this.lastStableMidi = midi;
          this.chordDet.addNote(midi, now, 0.8);
          this.pitchNotes.push({ n: midi, t: now });
          this.noteCbs.forEach(cb => cb({ midi, velocity: 0.8, timeSec: now }));
        }
      } else {
        this.lastStableMidi = null;
        this.lastSungMidi = null;
        this.lastPitchAt = null;
      }
      this.pitchNotes = this.pitchNotes.filter(r => now - r.t < PITCH_NOTES_WINDOW_SEC);
      this.emit();
    };

    await Promise.all(
      this.sources.map(async (source, i) => {
        const kind = this.kinds[i];
        try {
          await source.start((n, v, t) => onNote(n, v, t, kind), onLevel, onPitch);
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
      pendingBpm: bpmFromOnsets(this.onsetTimes, PENDING_MIN_ONSETS, this.tempoOpts)?.bpm ?? null,
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

  private get tempoOpts() { return { voice: this.voiceOnsets * 2 > this.onsetTimes.length }; }

  private emit() { const i = this.input; this.cbs.forEach(c => c(i)); }

  private emitStatus() { const s = this.status; this.statusCbs.forEach(c => c(s)); }
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];

/** Nearest scale tone of `key` to `midi` (ties resolve downward); `midi` itself when no key is known. */
export function snapToKey(midi: number, key: { root: number; mode: 'major' | 'minor' } | null): number {
  if (!key) return midi;
  const scale = key.mode === 'major' ? MAJOR : MINOR;
  const inKey = (m: number) => scale.includes((((m - key.root) % 12) + 12) % 12);
  if (inKey(midi)) return midi;
  return inKey(midi - 1) ? midi - 1 : midi + 1;
}
