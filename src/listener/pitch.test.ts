import { describe, it, expect } from 'vitest';
import { detectPitchHz, hzToMidi } from './pitch';
const sine = (hz: number, sr = 44100, n = 2048) => Float32Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * hz * i / sr));
describe('pitch', () => {
  it('A4', () => { expect(detectPitchHz(sine(440), 44100)!).toBeCloseTo(440, -1); });
  it('E2', () => { expect(detectPitchHz(sine(82.41), 44100)!).toBeCloseTo(82.4, -1); });
  it('noise → null', () => {
    let s = 1; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647 - 0.5;
    expect(detectPitchHz(Float32Array.from({ length: 2048 }, rnd), 44100)).toBeNull();
  });
  it('hzToMidi', () => { expect(hzToMidi(440)).toBe(69); expect(hzToMidi(261.63)).toBe(60); });
});
