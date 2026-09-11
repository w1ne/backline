import { describe, it, expect } from 'vitest';
import { pcm16ToFloat32 } from './pcmPlayer';

describe('pcm16ToFloat32', () => {
  it('converts little-endian PCM16 samples to float32 range', () => {
    const bytes = new Uint8Array([0xff, 0x7f, 0x00, 0x80]);
    const out = pcm16ToFloat32(bytes);
    expect(out.length).toBe(2);
    expect(out[0]).toBeCloseTo(0.99997, 4);
    expect(out[1]).toBeCloseTo(-1, 4);
  });
});
