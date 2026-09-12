/**
 * Spectral-flux front end for the mic listener.
 *
 * Runs on the audio thread at a fixed 512-sample hop (~10.7 ms @ 48 kHz) so the
 * detector sees evenly spaced, non-overlapping-in-time frames instead of
 * whatever requestAnimationFrame happened to sample. Posts { flux, rms, t } per
 * hop; the peak picking lives in src/listener/onset.ts, on the main thread,
 * where it can be unit tested.
 *
 * The analysis below mirrors src/listener/fft.ts + the flux() in onset.ts —
 * an AudioWorklet module cannot import from the bundle, so the maths is
 * duplicated. onset.test.ts asserts these constants still match.
 */

const FFT_SIZE = 1024;
const HOP_SIZE = 512;
const FLUX_K = 20;
const FLUX_LO_HZ = 40;
const FLUX_HI_HZ = 5000;
const BINS = FFT_SIZE / 2;

const hann = new Float32Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE);

function fftInPlace(re, im) {
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

class OnsetProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(FFT_SIZE); // sliding analysis window, newest at the end
    this.hop = new Float32Array(HOP_SIZE); // samples collected since the last hop
    this.hopFill = 0;
    this.re = new Float32Array(FFT_SIZE);
    this.im = new Float32Array(FFT_SIZE);
    this.prevC = new Float32Array(BINS);
    this.hasPrev = false;
  }

  analyse(t) {
    const { re, im, buf, prevC } = this;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = buf[i] * hann[i];
      im[i] = 0;
    }
    fftInPlace(re, im);
    const scale = 2 / FFT_SIZE;
    const binHz = sampleRate / FFT_SIZE;
    const lo = Math.max(1, Math.round(FLUX_LO_HZ / binHz));
    const hi = Math.min(BINS, Math.round(FLUX_HI_HZ / binHz));
    let flux = 0;
    for (let k = lo; k < hi; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * scale;
      const c = Math.log1p(FLUX_K * mag);
      const d = c - prevC[k];
      if (d > 0) flux += d;
      prevC[k] = c;
    }
    if (!this.hasPrev) {
      this.hasPrev = true;
      flux = 0;
    }
    let s = 0;
    for (let i = FFT_SIZE - HOP_SIZE; i < FFT_SIZE; i++) s += buf[i] * buf[i];
    this.port.postMessage({ flux, rms: Math.sqrt(s / HOP_SIZE), t });
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let i = 0;
    while (i < ch.length) {
      const n = Math.min(HOP_SIZE - this.hopFill, ch.length - i);
      this.hop.set(ch.subarray(i, i + n), this.hopFill);
      this.hopFill += n;
      i += n;
      if (this.hopFill === HOP_SIZE) {
        this.buf.copyWithin(0, HOP_SIZE); // drop the oldest hop, slide the window
        this.buf.set(this.hop, FFT_SIZE - HOP_SIZE);
        this.hopFill = 0;
        // timestamp the centre of the window that just closed, matching the
        // convention the detector's tests use
        this.analyse(currentTime + (i - FFT_SIZE / 2) / sampleRate);
      }
    }
    return true;
  }
}

registerProcessor('onset-processor', OnsetProcessor);
