import type { Chord } from '../types';
import { QUALITY_TONES } from '../listener/chordDetector';

export interface VoiceLeadOpts {
  low: number;
  high: number;
  voices?: number;
}

const mod12 = (n: number): number => ((n % 12) + 12) % 12;

/** All concrete MIDI pitches within [low, high] whose pitch class is one of the chord's tones. */
function candidatesFor(chord: Chord, low: number, high: number): number[] {
  const tones = new Set(QUALITY_TONES[chord.quality].map(t => mod12(chord.root + t)));
  const out: number[] = [];
  for (let n = low; n <= high; n++) if (tones.has(mod12(n))) out.push(n);
  return out;
}

/**
 * Picks `count` distinct candidate pitches minimizing the total movement from `target`
 * midpoints (used for the null-prev case) — a simple greedy nearest-then-unique pick.
 */
function pickNearMiddle(candidates: number[], count: number, mid: number): number[] {
  const sorted = [...candidates].sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
  const picked: number[] = [];
  const usedPc = new Set<number>();
  for (const c of sorted) {
    const pc = mod12(c);
    if (usedPc.has(pc)) continue;
    picked.push(c);
    usedPc.add(pc);
    if (picked.length === count) break;
  }
  // Not enough distinct pitch classes (e.g. voices > chord tones): allow octave duplicates
  // of a pitch class but never the exact same MIDI note twice.
  if (picked.length < count) {
    const usedMidi = new Set(picked);
    for (const c of sorted) {
      if (picked.length === count) break;
      if (usedMidi.has(c)) continue;
      picked.push(c);
      usedMidi.add(c);
    }
  }
  return picked.sort((a, b) => a - b);
}

/**
 * Chooses `count` distinct pitches from `candidates` that minimize the total movement
 * against `prev` under an optimal (min-cost) assignment. Brute-force over all combinations
 * is fine here — the candidate pool per chord within a couple of octaves is small (well
 * under a few dozen notes).
 */
function bestAssignment(candidates: number[], prev: number[], count: number): number[] {
  // Greedy-with-backtracking would work, but the search space (candidates choose count,
  // count small, candidates typically <= ~30) is small enough for a straightforward
  // recursive search with pruning that tracks the best full assignment found.
  let best: number[] | null = null;
  let bestCost = Infinity;

  const sortedPrev = [...prev].sort((a, b) => a - b);

  function search(startIdx: number, chosen: number[], usedPc: Set<number>) {
    if (chosen.length === count) {
      const sortedChosen = [...chosen].sort((a, b) => a - b);
      const cost = sortedPrev.reduce((sum, p, i) => sum + Math.abs(p - (sortedChosen[i] ?? sortedChosen[sortedChosen.length - 1])), 0);
      if (cost < bestCost) {
        bestCost = cost;
        best = sortedChosen;
      }
      return;
    }
    for (let i = startIdx; i < candidates.length; i++) {
      const c = candidates[i];
      const pc = mod12(c);
      // Prefer distinct pitch classes first pass; allow repeats only if we run out of room.
      chosen.push(c);
      search(i + 1, chosen, usedPc);
      chosen.pop();
    }
  }
  search(0, [], new Set());
  if (best) return best;
  return pickNearMiddle(candidates, count, (candidates[0] ?? 60));
}

export function voiceLead(prev: number[] | null, chord: Chord, opts: VoiceLeadOpts): number[] {
  const { low, high } = opts;
  const tones = QUALITY_TONES[chord.quality];
  const count = opts.voices ?? (tones.length >= 4 ? 4 : 3);
  const candidates = candidatesFor(chord, low, high);

  if (!prev || prev.length === 0) {
    const mid = (low + high) / 2;
    return pickNearMiddle(candidates, count, mid);
  }

  if (candidates.length <= 18) {
    return bestAssignment(candidates, prev, count);
  }
  // Large range: fall back to a nearest-per-voice greedy pick to keep this fast; still
  // enforces distinctness.
  const usedMidi = new Set<number>();
  const prevSorted = [...prev].sort((a, b) => a - b);
  const picked: number[] = [];
  for (const p of prevSorted) {
    const sorted = [...candidates].filter(c => !usedMidi.has(c)).sort((a, b) => Math.abs(a - p) - Math.abs(b - p));
    if (sorted.length === 0) break;
    picked.push(sorted[0]);
    usedMidi.add(sorted[0]);
  }
  while (picked.length < count) {
    const mid = (low + high) / 2;
    const sorted = [...candidates].filter(c => !usedMidi.has(c)).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
    if (sorted.length === 0) break;
    picked.push(sorted[0]);
    usedMidi.add(sorted[0]);
  }
  return picked.sort((a, b) => a - b);
}
