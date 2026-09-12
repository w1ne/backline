const MIN = 60, MAX = 180, MIN_ONSETS = 12;
/** a singer's beat lives here; a faster mode with a peak at its half is syllable rate */
const VOICE_MIN = 70, VOICE_MAX = 130;
/** the half-tempo peak must hold this share of the winner's count to be taken as the beat */
const VOICE_HALF_SHARE = 0.4;

export interface TempoOptions {
  /** onsets come from a voice: prefer the beat over the syllable rate (see bpmFromOnsets) */
  voice?: boolean;
}

export function estimateTempo(onsets: number[], opts: TempoOptions = {}): { bpm: number; downbeat: number } | null {
  return bpmFromOnsets(onsets, MIN_ONSETS, opts);
}

export function bpmFromOnsets(onsets: number[], minOnsets: number, opts: TempoOptions = {}): { bpm: number; downbeat: number } | null {
  if (onsets.length < minOnsets) return null;
  const iois: number[] = [];
  for (let i = 1; i < onsets.length; i++) {
    const d = onsets[i] - onsets[i - 1];
    if (d > 0.05) iois.push(d);
  }
  if (iois.length < 4) return null;
  // fold every IOI into the 60–180 bpm window, tracking each one's folded
  // period alongside its rounded bpm (used for the stage-2 refinement below)
  const folded: { period: number; bpm: number }[] = [];
  const hist = new Map<number, number>();
  for (const d of iois) {
    let period = d;
    let bpm = 60 / period;
    while (bpm > MAX) { bpm /= 2; period *= 2; }
    while (bpm < MIN) { bpm *= 2; period /= 2; }
    const b = Math.round(bpm);
    folded.push({ period, bpm: b });
    hist.set(b, (hist.get(b) ?? 0) + 1);
  }
  // Stage 1: find the mode with a window proportional to the candidate bpm
  // (±5%), so nearby-but-distinct tempos (e.g. 100 vs 110) stay separate
  // while jitter that spreads across a few bpm still gets grouped.
  const countNear = (b: number) => {
    const w = b * 0.05;
    let n = 0;
    for (const [k, c] of hist) { if (Math.abs(k - b) <= w) n += c; }
    return n;
  };
  let bestCount = 0, modeBpm = 0;
  for (const [b] of hist) {
    const n = countNear(b);
    if (n > bestCount) { bestCount = n; modeBpm = b; }
  }
  // A solo voice's onsets are syllables, and most syllables fall on half beats, so the mode
  // lands at 1.5-2x the beat the singer hears (MIR-1K: 174 vs 117, 139 vs 84, 165 vs 87).
  // When the half tempo is a plausible singing beat and the histogram has a second peak
  // there (the syllables that did land on beats), take the half. On the MIR-1K songs the
  // 12-onset histogram at lock has no such peak (the mode itself holds 3 of 11 IOIs), so
  // this does not fire there; see bench/realvoice/RESULTS.md.
  if (opts.voice && modeBpm / 2 >= VOICE_MIN && modeBpm / 2 <= VOICE_MAX) {
    const halfCount = countNear(modeBpm / 2);
    if (halfCount >= VOICE_HALF_SHARE * bestCount) modeBpm = modeBpm / 2;
  }
  // Stage 2: refine in IOI space, where jitter is symmetric — average the
  // actual periods (not their rounded bpm) of every folded IOI within ±12%
  // of the mode's period, then convert back to bpm. The anchor here is the
  // rounded mode bpm, i.e. one edge of the jittered split rather than its
  // true center, so the window has to cover the full split width (up to
  // ~4*jitter/period) as seen from that edge, not just half of it.
  const modePeriod = 60 / modeBpm;
  const near = folded.filter(f => Math.abs(f.period - modePeriod) <= modePeriod * 0.12);
  const meanPeriod = near.reduce((s, f) => s + f.period, 0) / near.length;
  const bpm = 60 / meanPeriod;
  return { bpm: Math.round(bpm * 10) / 10, downbeat: onsets[0] };
}

export class TempoLock {
  private onsets: number[] = [];
  private result: { bpm: number; downbeat: number } | null = null;
  /** true while `result` came from adoptProvisional() rather than a full 12-onset estimate;
   * a provisional result is still replaceable by the real thing. */
  private provisional = false;
  private voiceOnsets = 0;

  /** `voice`: the onset came from a mic singer rather than an instrument or MIDI. */
  push(t: number, voice = false) {
    if (this.result && !this.provisional) return;
    this.onsets.push(t);
    if (voice) this.voiceOnsets++;
    const real = estimateTempo(this.onsets, { voice: this.voiceOnsets * 2 > this.onsets.length });
    if (real) {
      this.result = real;
      this.provisional = false;
    }
  }

  /** Adopts a faster, lower-confidence estimate (e.g. the listener's running pendingBpm)
   * while the full 12-onset lock is still pending — a real lock, once it lands, replaces
   * this. No-op once a real lock already exists. */
  adoptProvisional(bpm: number, downbeat: number) {
    if (this.result && !this.provisional) return;
    this.result = { bpm, downbeat };
    this.provisional = true;
  }

  get locked() { return this.result; }
  get isProvisional() { return this.provisional; }
  reset() {
    this.onsets = [];
    this.result = null;
    this.provisional = false;
    this.voiceOnsets = 0;
  }
}
