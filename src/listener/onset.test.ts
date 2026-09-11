import { describe, it, expect } from 'vitest';
import { OnsetDetector } from './onset';
const frame = (amp: number, n = 1024) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin(i * 0.3));
describe('OnsetDetector', () => {
  it('fires on a jump from silence and not on sustained level', () => {
    const d = new OnsetDetector();
    expect(d.process(frame(0), 0)).toBe(false);
    expect(d.process(frame(0.5), 0.02)).toBe(true);
    expect(d.process(frame(0.5), 0.04)).toBe(false);
    expect(d.process(frame(0.5), 0.06)).toBe(false);
  });
  it('respects min gap', () => {
    const d = new OnsetDetector({ minGapSec: 0.1 });
    d.process(frame(0), 0); expect(d.process(frame(0.5), 0.02)).toBe(true);
    d.process(frame(0), 0.05); expect(d.process(frame(0.5), 0.08)).toBe(false);
    d.process(frame(0), 0.2); expect(d.process(frame(0.5), 0.25)).toBe(true);
  });
});
