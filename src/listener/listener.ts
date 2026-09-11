import type { BandInput, Key } from '../types';
import { TempoLock } from './tempoLock';
import { TempoFollower } from './tempoFollower';
import { KeyDetector } from './keyDetector';

export interface Source {
  start(onNote: (midi: number, velocity: number, timeSec: number) => void, onLevel: (level: number) => void): Promise<void>;
  stop(): void;
}

export class Listener {
  private tempo = new TempoLock();
  private keyDet = new KeyDetector();
  private recent: { n: number; t: number }[] = [];
  private level = 0;
  private onsetCount = 0;
  private override: { bpm?: number; key?: Key } = {};
  private cbs: ((i: BandInput) => void)[] = [];
  private mode: 'locked' | 'follow' = 'locked';
  private follower?: TempoFollower;
  private followBpm: number | null = null;

  constructor(private source: Source) {}

  setTempoMode(m: 'locked' | 'follow') {
    this.mode = m;
    if (m === 'locked') {
      this.follower = undefined;
      this.followBpm = null;
    }
    this.emit();
  }

  async start() {
    await this.source.start((n, v, t) => {
      this.tempo.push(t);
      if (this.tempo.locked && this.mode === 'follow') {
        this.follower ??= new TempoFollower(this.tempo.locked.bpm);
        this.followBpm = this.follower.push(t);
      }
      this.onsetCount++;
      if (n >= 0) {
        this.keyDet.addNote(n, v);
        this.recent.push({ n, t });
        this.recent = this.recent.filter(r => t - r.t < 0.5);
      }
      this.emit();
    }, lvl => { this.level = lvl; this.emit(); });
  }

  stop() { this.source.stop(); }

  setOverride(p: { bpm?: number; key?: Key }) { Object.assign(this.override, p); this.emit(); }

  onChange(cb: (i: BandInput) => void) { this.cbs.push(cb); }

  get input(): BandInput {
    return {
      bpm: this.override.bpm ?? (this.mode === 'follow' ? this.followBpm : null) ?? this.tempo.locked?.bpm ?? null,
      key: this.override.key ?? this.keyDet.key,
      notesNow: [...new Set(this.recent.map(r => r.n))],
      inputLevel: this.level,
      onsets: this.onsetCount,
    };
  }

  get downbeat() { return this.tempo.locked?.downbeat ?? null; }

  private emit() { const i = this.input; this.cbs.forEach(c => c(i)); }
}
