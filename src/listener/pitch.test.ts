import { describe, it, expect } from 'vitest';
import { detectPitch, detectPitchHz, hzToMidi } from './pitch';
const sine = (hz: number, sr = 44100, n = 2048) => Float32Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * hz * i / sr));
describe('pitch', () => {
  it('A4', () => { expect(detectPitchHz(sine(440), 44100)!).toBeCloseTo(440, -1); });
  it('E2', () => { expect(detectPitchHz(sine(82.41), 44100)!).toBeCloseTo(82.4, -1); });
  it('noise → null', () => {
    let s = 1; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647 - 0.5;
    expect(detectPitchHz(Float32Array.from({ length: 2048 }, rnd), 44100)).toBeNull();
  });
  it('hzToMidi', () => { expect(hzToMidi(440)).toBe(69); expect(hzToMidi(261.63)).toBe(60); });
  it('inharmonic tone with strong harmonics still resolves to fundamental', () => {
    const sr = 44100, n = 2048;
    const frame = Float32Array.from({ length: n }, (_, i) => {
      const t = i / sr;
      return Math.sin(2 * Math.PI * 220 * t) + 0.6 * Math.sin(2 * Math.PI * 660 * t) + 0.4 * Math.sin(2 * Math.PI * 441 * t);
    });
    expect(detectPitchHz(frame, sr)!).toBeCloseTo(220, -1);
  });
});

describe('detectPitch clarity gate', () => {
  it('returns a breathy but periodic frame with its clarity, leaving the gate to the tracker', () => {
    const sr = 48000, n = 4096;
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
    const frame = Float32Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * 220 * i / sr) + 1.2 * rnd());
    const est = detectPitch(frame, sr);
    expect(est).not.toBeNull();
    expect(Math.abs(1200 * Math.log2(est!.hz / 220))).toBeLessThan(60); // within a semitone: noisy, but the right note
    expect(est!.clarity).toBeLessThan(0.9);
    expect(est!.clarity).toBeGreaterThan(0.6);
  });
});
