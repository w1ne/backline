export function detectPitchHz(x: Float32Array, sr: number): number | null {
  const n = x.length;
  const minLag = Math.floor(sr / 1200);
  const maxLag = Math.min(Math.floor(sr / 60), n - 1);
  let e = 0;
  for (let i = 0; i < n; i++) e += x[i] * x[i];
  if (e / n < 1e-6) return null;

  const nsdf = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let ac = 0, m = 0;
    for (let i = 0; i + lag < n; i++) {
      ac += x[i] * x[i + lag];
      m += x[i] * x[i] + x[i + lag] * x[i + lag];
    }
    nsdf[lag] = m ? (2 * ac) / m : 0;
  }

  // first peak after the first negative-going zero crossing that clears the
  // clarity threshold (McLeod-style: take the first strong peak, not the
  // global max, to avoid picking a sub-harmonic on pure tones)
  let lag = minLag;
  while (lag <= maxLag && nsdf[lag] > 0) lag++;
  let bestLag = -1;
  const CLARITY = 0.9;
  for (; lag < maxLag; lag++) {
    if (nsdf[lag] > nsdf[lag - 1] && nsdf[lag] >= nsdf[lag + 1] && nsdf[lag] >= CLARITY) {
      bestLag = lag;
      break;
    }
  }
  if (bestLag < 0) return null;

  // parabolic interpolation around the peak
  const a = nsdf[bestLag - 1], b = nsdf[bestLag], c = nsdf[bestLag + 1];
  const denom = a - 2 * b + c;
  const shift = denom !== 0 ? (a - c) / (2 * denom) : 0;
  return sr / (bestLag + shift);
}

export const hzToMidi = (hz: number) => Math.round(69 + 12 * Math.log2(hz / 440));
