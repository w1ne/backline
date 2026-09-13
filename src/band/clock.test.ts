import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  // Repeats keyed by their transport start offset: 0 is the bar callback, '2n' the half bar.
  const callbacks = new Map<string | number, (time: number) => void>();
  const bpm = { value: 0, setValueAtTime: vi.fn() };
  const transport = {
    bpm,
    scheduleRepeat: vi.fn((cb: (time: number) => void, _interval: string, startTime: string | number) => { callbacks.set(startTime, cb); return callbacks.size; }),
    start: vi.fn(),
    clear: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
  };
  return { transport, fire: (time: number) => callbacks.get(0)?.(time), fireHalf: (time: number) => callbacks.get('2n')?.(time) };
});

vi.mock('tone', () => ({ getTransport: () => fake.transport, now: () => 0 }));

import { ToneClock } from './clock';

describe('ToneClock tempo changes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('applies a requested tempo on the next bar boundary', () => {
    const clock = new ToneClock();
    const seen: number[] = [];
    clock.onBar(() => seen.push(clock.bpm));
    clock.start(120, 1);
    clock.setBpm(90);

    expect(clock.bpm).toBe(120);
    expect(fake.transport.bpm.setValueAtTime).not.toHaveBeenCalled();
    fake.fire(3);
    expect(fake.transport.bpm.setValueAtTime).toHaveBeenCalledWith(90, 3);
    expect(seen).toEqual([90]);
  });
});

describe('ToneClock half-bar cue', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fires the half-bar callback from the transport, half a measure after each bar', () => {
    const clock = new ToneClock();
    const bars: [number, number][] = [];
    const halves: [number, number][] = [];
    clock.onBar((bar, t) => bars.push([bar, t]));
    clock.onHalfBar((bar, t) => halves.push([bar, t]));
    clock.start(120, 1);
    expect(fake.transport.scheduleRepeat).toHaveBeenCalledWith(expect.any(Function), '1m', '2n');
    fake.fire(1);
    fake.fireHalf(2);
    fake.fire(3);
    fake.fireHalf(4);
    expect(bars).toEqual([[0, 1], [1, 3]]);
    expect(halves).toEqual([[0, 2], [1, 4]]);
    clock.stop();
    expect(fake.transport.clear).toHaveBeenCalledTimes(2);
  });
});
