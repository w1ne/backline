import type { Dynamics } from '../types';
import { IDLE_DYNAMICS } from '../types';

/**
 * Measures how hard the player is working, so the band can behave like a bandmate rather
 * than a backing track.
 *
 * Fed three streams — onsets (`onset`), input level (`level`) and a beat clock (`tick`) — it
 * folds the last beat into a `Dynamics` frame:
 *
 * - `intensity` is a smoothed mix of note density (0 onsets in a beat -> 0, `busyOnsets` or
 *   more -> 1) and level *relative to how loud this player actually gets* (a running 95th
 *   percentile of the level samples, not an absolute threshold, so a quiet mic and a hot DI
 *   both reach 1 when the player digs in). It attacks in about one beat and releases over
 *   about eight, so the band leans in immediately and backs off gradually.
 * - `space` is the gap the band is allowed to answer in: at least `spaceBeats` of silence,
 *   and only once the player has actually played something (before the first note there is
 *   no "space", only an empty room).
 * - `fillDue` marks the downbeat of the last bar of each four-bar group, but only while the
 *   player is quiet — a fill under a busy player is a collision, not a fill.
 */

export interface ActivityOptions {
  /** onsets in one beat that count as fully busy */
  busyOnsets?: number;
  /** time constant of the rise, in beats */
  attackBeats?: number;
  /** time constant of the fall, in beats */
  releaseBeats?: number;
  /** silence needed before the band treats the gap as an invitation */
  spaceBeats?: number;
  beatsPerBar?: number;
  /** bars per phrase group; the last bar of each group is where a fill belongs */
  barsPerGroup?: number;
  /** intensity below which a fill is welcome */
  fillBelow?: number;
  /** weight of density in the intensity mix; level takes the rest */
  densityWeight?: number;
}

/** Level samples kept for the running 95th percentile (~8 s of 20 ms hops). */
const LEVEL_HISTORY = 512;
/** Below this the "loud" reference is just noise, and level contributes nothing. */
const MIN_LEVEL_REF = 0.02;
/** Fallback beat length before two ticks have been seen. */
const DEFAULT_BEAT_SEC = 0.5;

export class ActivityTracker {
  private readonly busyOnsets: number;
  private readonly attackBeats: number;
  private readonly releaseBeats: number;
  private readonly spaceBeats: number;
  private readonly beatsPerBar: number;
  private readonly barsPerGroup: number;
  private readonly fillBelow: number;
  private readonly densityWeight: number;

  /** onset times since the last tick */
  private onsets: number[] = [];
  /** level samples since the last tick, averaged into the beat */
  private beatLevels: number[] = [];
  /** rolling level history for the 95th-percentile reference */
  private levelHistory: number[] = [];
  private lastOnsetAt: number | null = null;
  private lastTickAt: number | null = null;
  private beatSec = DEFAULT_BEAT_SEC;
  private intensity = 0;
  private current: Dynamics = { ...IDLE_DYNAMICS };

  constructor(o: ActivityOptions = {}) {
    this.busyOnsets = o.busyOnsets ?? 4;
    this.attackBeats = o.attackBeats ?? 1;
    this.releaseBeats = o.releaseBeats ?? 8;
    this.spaceBeats = o.spaceBeats ?? 1.5;
    this.beatsPerBar = o.beatsPerBar ?? 4;
    this.barsPerGroup = o.barsPerGroup ?? 4;
    this.fillBelow = o.fillBelow ?? 0.4;
    this.densityWeight = o.densityWeight ?? 0.6;
  }

  /** One detected note/hit at time `t` (seconds, same base as `tick`). */
  onset(t: number): void {
    this.onsets.push(t);
    if (this.lastOnsetAt === null || t > this.lastOnsetAt) this.lastOnsetAt = t;
  }

  /** One input-level sample. `t` is accepted for symmetry; samples are folded per beat. */
  level(rms: number, _t?: number): void {
    const v = Math.max(0, rms);
    this.beatLevels.push(v);
    this.levelHistory.push(v);
    if (this.levelHistory.length > LEVEL_HISTORY) this.levelHistory.shift();
  }

  /** Folds everything since the previous tick into a new `Dynamics` frame. */
  tick(beatIndex: number, t: number): Dynamics {
    const since = this.lastTickAt;
    if (since !== null && t > since) {
      // Track the real beat length so `silenceBeats` is measured in beats, not seconds.
      const dt = t - since;
      this.beatSec = this.beatSec ? this.beatSec * 0.7 + dt * 0.3 : dt;
    }
    this.lastTickAt = t;

    const inBeat = since === null ? this.onsets.length : this.onsets.filter(o => o > since && o <= t).length;
    this.onsets = this.onsets.filter(o => o > t);

    const meanLevel = this.beatLevels.length
      ? this.beatLevels.reduce((a, b) => a + b, 0) / this.beatLevels.length
      : 0;
    this.beatLevels = [];

    const density = Math.min(1, inBeat / this.busyOnsets);
    const ref = this.levelRef();
    const level = ref >= MIN_LEVEL_REF ? Math.min(1, meanLevel / ref) : 0;
    const target = this.densityWeight * density + (1 - this.densityWeight) * level;

    const tau = target > this.intensity ? this.attackBeats : this.releaseBeats;
    const alpha = 1 - Math.exp(-1 / Math.max(1e-6, tau));
    this.intensity += (target - this.intensity) * alpha;
    if (this.intensity < 1e-4) this.intensity = 0;

    const silenceBeats =
      this.lastOnsetAt === null ? 0 : Math.max(0, (t - this.lastOnsetAt) / (this.beatSec || DEFAULT_BEAT_SEC));
    const live = this.lastOnsetAt !== null;
    const bar = Math.floor(beatIndex / this.beatsPerBar);
    const onDownbeat = beatIndex % this.beatsPerBar === 0;
    const lastOfGroup = ((bar % this.barsPerGroup) + this.barsPerGroup) % this.barsPerGroup === this.barsPerGroup - 1;

    this.current = {
      intensity: Math.min(1, Math.max(0, this.intensity)),
      space: live && silenceBeats >= this.spaceBeats,
      fillDue: onDownbeat && lastOfGroup && this.intensity < this.fillBelow,
      silenceBeats,
    };
    return this.current;
  }

  get dynamics(): Dynamics {
    return this.current;
  }

  reset(): void {
    this.onsets = [];
    this.beatLevels = [];
    this.levelHistory = [];
    this.lastOnsetAt = null;
    this.lastTickAt = null;
    this.beatSec = DEFAULT_BEAT_SEC;
    this.intensity = 0;
    this.current = { ...IDLE_DYNAMICS };
  }

  /** 95th percentile of the level history — "how loud this player gets", not an absolute. */
  private levelRef(): number {
    if (!this.levelHistory.length) return 0;
    const sorted = [...this.levelHistory].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(0.95 * (sorted.length - 1)))];
  }
}
