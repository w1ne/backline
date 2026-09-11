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

  // McLeod pitch method peak selection: after the first negative-going zero
  // crossing, collect all local maxima (parabolically interpolated), then
  // pick the FIRST one that is at least 0.8x the tallest peak found. This
  // avoids both octave errors: picking the global max (which can land on a
  // harmonic for pure tones) and requiring an absolute 0.9 on the first peak
  // (which skips a slightly-attenuated true fundamental in inharmonic/real
  // input and locks onto a later harmonic instead).
  let lag = minLag;
  while (lag <= maxLag && nsdf[lag] > 0) lag++;
  const peaks: { lag: number; value: number }[] = [];
  for (; lag < maxLag; lag++) {
    if (nsdf[lag] > nsdf[lag - 1] && nsdf[lag] >= nsdf[lag + 1]) {
      const a = nsdf[lag - 1], b = nsdf[lag], c = nsdf[lag + 1];
      const denom = a - 2 * b + c;
      const shift = denom !== 0 ? (a - c) / (2 * denom) : 0;
      const interpValue = b - (denom !== 0 ? 0.25 * (a - c) * shift : 0);
      peaks.push({ lag: lag + shift, value: interpValue });
    }
  }
  if (peaks.length === 0) return null;
  const max = Math.max(...peaks.map(p => p.value));
  if (max < 0.9) return null;
  const chosen = peaks.find(p => p.value >= 0.8 * max)!;
  return sr / chosen.lag;
}

export const hzToMidi = (hz: number) => Math.round(69 + 12 * Math.log2(hz / 440));
