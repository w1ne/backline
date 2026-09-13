import { describe, it, expect } from 'vitest';
import { chooseFallback } from './fallback';

describe('chooseFallback', () => {
  it('falls back ACE to patterns with an ACE-specific note', () => {
    expect(chooseFallback('acestep')).toEqual({
      engine: 'patterns',
      note: 'ACE OFFLINE · PATTERNS',
    });
  });

  it('falls back Lyria to patterns with a Lyria-specific note', () => {
    expect(chooseFallback('lyria')).toEqual({
      engine: 'patterns',
      note: 'LYRIA OFFLINE · PATTERNS',
    });
  });

  it('falls back AMT to patterns with an AMT-specific note', () => {
    expect(chooseFallback('amt')).toEqual({ engine: 'patterns', note: 'AMT OFFLINE · PATTERNS' });
  });

  it('has no fallback for patterns itself', () => {
    expect(chooseFallback('patterns')).toBeNull();
  });
});

it('keeps the selected model when automatic pattern fallback is disabled', () => {
  expect(chooseFallback('amt', false)).toBeNull();
});
