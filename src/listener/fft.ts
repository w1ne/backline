/**
 * The windowed magnitude spectrum the onset detector runs on, over fft.js.
 *
 * The same analysis (Hann window, 1024-point FFT, 512-sample hop, the 2/N
 * magnitude scale) is duplicated in plain JS in public/worklet/onset-processor.js,
 * because an AudioWorklet module cannot import from the bundle. onset.test.ts
 * asserts the shared constants still match; if you change the maths here, change
 * it there too.
 */
import FFT from 'fft.js';

export const FFT_SIZE = 1024;
export const HOP_SIZE = 512;

const windows = new Map<number, Float32Array>();

export function hannWindow(n: number): Float32Array {
  let w = windows.get(n);
  if (!w) {
    w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    windows.set(n, w);
  }
  return w;
}

/** fft.js plans per size and reuses its twiddle tables; keep one plan and scratch per size. */
const plans = new Map<number, { fft: FFT; input: Float64Array; out: number[] }>();

function planFor(n: number) {
  let p = plans.get(n);
  if (!p) {
    const fft = new FFT(n);
    p = { fft, input: new Float64Array(n), out: fft.createComplexArray() };
    plans.set(n, p);
  }
  return p;
}

/** Hann-windowed magnitude spectrum of a real frame (length = power of two). */
export function magnitudeSpectrum(frame: Float32Array, out?: Float32Array): Float32Array {
  const n = frame.length;
  const w = hannWindow(n);
  const p = planFor(n);
  for (let i = 0; i < n; i++) p.input[i] = frame[i] * w[i];
  p.fft.realTransform(p.out, p.input);
  const mag = out ?? new Float32Array(n / 2);
  const scale = 2 / n;
  for (let k = 0; k < n / 2; k++) {
    const re = p.out[2 * k], im = p.out[2 * k + 1];
    mag[k] = Math.sqrt(re * re + im * im) * scale;
  }
  return mag;
}
