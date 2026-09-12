import { describe, it, expect } from 'vitest';
import { chooseFallback } from './fallback';

describe('chooseFallback', () => {
  it('falls back ACE to patterns with an ACE-specific note', () => {
    expect(chooseFallback('acestep', 'timeout')).toEqual({
      engine: 'patterns',
      note: 'ACE OFFLINE · PATTERNS',
    });
  });

  it('falls back Lyria to patterns with a Lyria-specific note', () => {
    expect(chooseFallback('lyria', 'connection error')).toEqual({
      engine: 'patterns',
      note: 'LYRIA OFFLINE · PATTERNS',
    });
  });

  it('has no fallback for patterns itself', () => {
    expect(chooseFallback('patterns', 'anything')).toBeNull();
  });
});
