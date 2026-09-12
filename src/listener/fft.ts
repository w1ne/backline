/**
 * Minimal radix-2 FFT and the windowed magnitude spectrum the onset detector
 * runs on.
 *
 * The same analysis (Hann window, 1024-point FFT, 512-sample hop, the 2/N
 * magnitude scale) is duplicated in plain JS in public/worklet/onset-processor.js,
 * because an AudioWorklet module cannot import from the bundle. onset.test.ts
 * asserts the shared constants still match; if you change the maths here, change
 * it there too.
 */

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

/** In-place iterative Cooley–Tukey FFT. `re`/`im` must have a power-of-two length. */
export function fftInPlace(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + len / 2], bi = im[i + k + len / 2];
        const tr = br * cr - bi * ci, ti = br * ci + bi * cr;
        re[i + k] = ar + tr; im[i + k] = ai + ti;
        re[i + k + len / 2] = ar - tr; im[i + k + len / 2] = ai - ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Hann-windowed magnitude spectrum of a real frame (length = power of two). */
export function magnitudeSpectrum(frame: Float32Array, out?: Float32Array): Float32Array {
  const n = frame.length;
  const w = hannWindow(n);
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let i = 0; i < n; i++) re[i] = frame[i] * w[i];
  fftInPlace(re, im);
  const mag = out ?? new Float32Array(n / 2);
  const scale = 2 / n;
  for (let k = 0; k < n / 2; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * scale;
  return mag;
}
