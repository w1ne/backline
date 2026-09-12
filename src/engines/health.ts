import type { EngineChoice } from '../ui/state';

/**
 * Engines the relay's /health body reports as offline. The relay probes its GPU upstreams,
 * so `{ amt: false }` means the pod is down even though the relay answered. A legacy plain
 * "ok" body carries no per-engine information and yields null.
 */
export function parseHealth(body: string): EngineChoice[] | null {
  try {
    const h = JSON.parse(body) as Partial<Record<EngineChoice, unknown>>;
    return (['amt', 'acestep', 'lyria'] as const).filter(e => h[e] !== true);
  } catch {
    return null;
  }
}
