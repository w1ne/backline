import { describe, it, expect } from 'vitest';
import { REVERB_SEND, MASTER_CHAIN } from './players';

// Players.init() builds the real reverb/compressor/limiter chain, which needs a live
// AudioContext (unavailable under vitest's node environment — see players.test.ts, which
// exercises Players.schedule() against an injected fake SoundSet instead). These constants
// are exported so the mix values the brief calls for can be checked without an audio graph.

describe('mix bus settings', () => {
  it('sends more of keys/lead into the reverb than the percussive/low voices', () => {
    expect(REVERB_SEND.keys).toBeGreaterThan(REVERB_SEND.lead);
    expect(REVERB_SEND.lead).toBeGreaterThan(REVERB_SEND.drums);
    expect(REVERB_SEND.lead).toBeGreaterThan(REVERB_SEND.bass);
    expect(REVERB_SEND.drums).toBeCloseTo(REVERB_SEND.bass, 1);
  });

  it('keeps the reverb light and the sends all within [0, 1]', () => {
    expect(MASTER_CHAIN.reverbDecay).toBeCloseTo(1.4, 5);
    Object.values(REVERB_SEND).forEach(send => {
      expect(send).toBeGreaterThan(0);
      expect(send).toBeLessThan(0.3);
    });
  });

  it('matches the specified master compressor and limiter settings', () => {
    expect(MASTER_CHAIN.compressor).toEqual({ threshold: -18, ratio: 3, attack: 0.01, release: 0.2 });
    expect(MASTER_CHAIN.limiterCeilingDb).toBe(-1);
  });
});
