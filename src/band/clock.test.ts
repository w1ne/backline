import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  let callback: ((time: number) => void) | undefined;
  const bpm = { value: 0, setValueAtTime: vi.fn() };
  const transport = {
    bpm,
    scheduleRepeat: vi.fn((cb: (time: number) => void) => { callback = cb; return 7; }),
    start: vi.fn(),
    clear: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
  };
  return { transport, fire: (time: number) => callback?.(time) };
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
