import type { BandInput, Key } from '../types';
import { TempoLock, bpmFromOnsets } from './tempoLock';
import { TempoFollower } from './tempoFollower';
import { KeyDetector } from './keyDetector';

export interface Source {
  start(onNote: (midi: number, velocity: number, timeSec: number) => void, onLevel: (level: number) => void): Promise<void>;
  stop(): void;
}

export type SourceKind = 'mic' | 'midi';
export type SourceState = 'off' | 'on' | 'denied' | 'none';
export type SourceStatus = { mic: SourceState; midi: SourceState };

/** onsets needed before the LCD dares show a running tempo estimate */
const PENDING_MIN_ONSETS = 6;

export class Listener {
  private tempo = new TempoLock();
  private keyDet = new KeyDetector();
  private recent: { n: number; t: number }[] = [];
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

  constructor(sources: Source[], kinds?: SourceKind[]) {
    this.sources = sources;
    this.kinds = kinds ?? sources.map((_, i) => (i === 0 ? 'midi' : 'mic'));
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
      this.onsetTimes.push(t);
      if (this.onsetTimes.length > 24) this.onsetTimes.shift();
      if (n >= 0) {
        this.keyDet.addNote(n, v);
        this.recent.push({ n, t });
        this.recent = this.recent.filter(r => t - r.t < 0.5);
        this.noteCbs.forEach(cb => cb({ midi: n, velocity: v, timeSec: t }));
      }
      this.emit();
    };
    const onLevel = (lvl: number) => { this.level = lvl; this.emit(); };

    await Promise.all(
      this.sources.map(async (source, i) => {
        const kind = this.kinds[i];
        try {
          await source.start(onNote, onLevel);
          const getStatus = (source as { getStatus?(): SourceState }).getStatus;
          this.status = { ...this.status, [kind]: getStatus ? getStatus.call(source) : 'on' };
        } catch {
          this.status = { ...this.status, [kind]: 'denied' };
        }
      }),
    );
    this.emitStatus();
  }

  stop() { this.sources.forEach(s => s.stop()); }

  setOverride(p: { bpm?: number; key?: Key }) { Object.assign(this.override, p); this.emit(); }

  onChange(cb: (i: BandInput) => void) { this.cbs.push(cb); }

  /** Fires for every pitched note (rests, i.e. midi < 0, are excluded). */
  onNote(cb: (n: { midi: number; velocity: number; timeSec: number }) => void) { this.noteCbs.push(cb); }

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
      notesNow: [...new Set(this.recent.map(r => r.n))],
      inputLevel: this.level,
      onsets: this.onsetCount,
      pendingBpm: bpmFromOnsets(this.onsetTimes, PENDING_MIN_ONSETS)?.bpm ?? null,
    };
  }

  get downbeat() { return this.tempo.locked?.downbeat ?? null; }

  private emit() { const i = this.input; this.cbs.forEach(c => c(i)); }

  private emitStatus() { const s = this.status; this.statusCbs.forEach(c => c(s)); }
}
