import { describe, it, expect, vi } from 'vitest';
import { amtSampleStorage } from './amtSamples';

describe('AMT sample transport', () => {
  it('fails a hanging asset load within a bounded timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url, {signal}) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    })));
    try {
      const result = amtSampleStorage.fetch('/samples/amt/violin-ogg.js');
      const rejected = expect(result).rejects.toThrow('aborted');
      await vi.advanceTimersByTimeAsync(15_000);
      await rejected;
    } finally { vi.unstubAllGlobals(); vi.useRealTimers(); }
  });
  it('rejects an HTTP error instead of passing an HTML error page to the decoder', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('missing', {status:404})));
    try { await expect(amtSampleStorage.fetch('/missing')).rejects.toThrow('404'); }
    finally { vi.unstubAllGlobals(); }
  });
});
