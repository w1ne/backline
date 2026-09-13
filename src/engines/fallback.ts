import type { EngineChoice } from '../ui/state';

export interface FallbackResult {
  engine: EngineChoice;
  note: string;
}

const OFFLINE_NAME: Partial<Record<EngineChoice, string>> = { acestep: 'ACE', lyria: 'LYRIA', amt: 'AMT' };

/** Decides whether a failing engine should fall back to Patterns, and what LCD note to show. */
export function chooseFallback(current: EngineChoice, allowPatterns = true): FallbackResult | null {
  const name = OFFLINE_NAME[current];
  return allowPatterns && name ? { engine: 'patterns', note: `${name} OFFLINE · PATTERNS` } : null;
}
