import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { connectMock, sessionMock } = vi.hoisted(() => {
  const sessionMock = {
    setWeightedPrompts: vi.fn().mockResolvedValue(undefined),
    setMusicGenerationConfig: vi.fn().mockResolvedValue(undefined),
    resetContext: vi.fn(),
    play: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    close: vi.fn(),
  };
  const connectMock = vi.fn().mockResolvedValue(sessionMock);
  return { connectMock, sessionMock };
});

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    live: { music: { connect: connectMock } },
  })),
}));

import { LyriaEngine } from './lyriaEngine';

function fakeCtx(): AudioContext {
  return { currentTime: 0 } as unknown as AudioContext;
}

describe('LyriaEngine control coalescing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionMock.setWeightedPrompts.mockClear();
    sessionMock.setMusicGenerationConfig.mockClear();
    sessionMock.resetContext.mockClear();
    connectMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not resetContext when set() key is unchanged', async () => {
    const engine = new LyriaEngine('key', fakeCtx());
    await engine.start(100, 0);
    sessionMock.resetContext.mockClear();

    engine.set({ key: { root: 0, mode: 'major' } }); // same as initial default
    await vi.advanceTimersByTimeAsync(300);

    expect(sessionMock.resetContext).not.toHaveBeenCalled();
  });

  it('coalesces 10 rapid changes into exactly one applyAll within 250ms of the first', async () => {
    const engine = new LyriaEngine('key', fakeCtx());
    await engine.start(100, 0);
    sessionMock.resetContext.mockClear();
    sessionMock.setWeightedPrompts.mockClear();

    for (let i = 0; i < 10; i++) {
      engine.set({ creativity: i / 10 });
      await vi.advanceTimersByTimeAsync(20); // rapid changes, each within the coalesce window
    }
    // total elapsed so far: 200ms since first change; not yet fired
    expect(sessionMock.resetContext).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60); // crosses the 250ms-from-first-change mark
    expect(sessionMock.resetContext).toHaveBeenCalledTimes(1);
    expect(sessionMock.setWeightedPrompts).toHaveBeenCalledTimes(1);
  });
});
