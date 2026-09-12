import type { EngineChoice } from '../ui/state';

export interface FallbackResult {
  engine: EngineChoice;
  note: string;
}

/** Decides whether a failing engine should fall back to Patterns, and what LCD note to show.
 *  `reason` is unused for now (both failure paths land on the same target) but is kept in the
 *  signature so a future engine-specific fallback can branch on it without changing call sites. */
export function chooseFallback(current: EngineChoice, _reason: string, allowPatterns = true): FallbackResult | null {
  if (!allowPatterns) return null;
  if (current === 'acestep') return { engine: 'patterns', note: 'ACE OFFLINE · PATTERNS' };
  if (current === 'lyria') return { engine: 'patterns', note: 'LYRIA OFFLINE · PATTERNS' };
  if (current === 'amt') return { engine: 'patterns', note: 'AMT OFFLINE · PATTERNS' };
  return null;
}
