import { afterEach, describe, expect, it, vi } from 'vitest';
import { EndingGate } from './endingGate';

describe('EndingGate', () => {
  afterEach(() => vi.useRealTimers());

  it('finishes the ending bar and only re-arms for a newer onset', () => {
    vi.useFakeTimers();
    const gate = new EndingGate();
    const stop = vi.fn();
    let onsets = 4;
    gate.finishAfter(2000, () => onsets, stop);

    expect(gate.canStart(onsets)).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(stop).toHaveBeenCalledOnce();
    expect(gate.canStart(onsets)).toBe(false);
    onsets++;
    expect(gate.canStart(onsets)).toBe(true);
  });
});
