import { describe, it, expect } from 'vitest';
import { OnsetDetector } from './onset';
const frame = (amp: number, n = 1024) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin(i * 0.3));
// flat frame with an exact rms value (constant amplitude), for precise threshold tests
const flat = (rms: number, n = 1024) => new Float32Array(n).fill(rms);
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

  it('fires on a quiet mic with low noise floor (adaptive threshold)', () => {
    const d = new OnsetDetector();
    let t = 0;
    for (let i = 0; i < 30; i++) { d.process(flat(0.003), t); t += 1 / 60; }
    expect(d.process(flat(0.012), t)).toBe(true);
  });

  it('does not re-fire on subsequent equal frames of a loud sustained note', () => {
    const d = new OnsetDetector();
    let t = 0;
    d.process(flat(0), t); t += 1 / 60;
    expect(d.process(flat(0.5), t)).toBe(true);
    t += 1 / 60;
    expect(d.process(flat(0.5), t)).toBe(false);
    t += 1 / 60;
    expect(d.process(flat(0.5), t)).toBe(false);
  });

  it('adapts the noise floor so louder ambient levels raise the threshold', () => {
    const d = new OnsetDetector();
    let t = 0;
    for (let i = 0; i < 200; i++) { d.process(flat(0.03), t); t += 1 / 60; }
    expect(d.process(flat(0.035), t)).toBe(false);
    t += 1 / 60;
    expect(d.process(flat(0.1), t)).toBe(true);
  });
});
