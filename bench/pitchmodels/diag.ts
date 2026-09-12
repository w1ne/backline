// Alignment / output-mapping sanity check for Basic Pitch (throwaway).
import { loadClip, labelAt } from '../realvoice/dataset';
import { resample } from '../realvoice/wav';
import { runBasicPitch, contourBinHz, BP_SR } from './basicpitch';
const midiToHz = (m: number) => 440 * 2 ** ((m - 69) / 12);
for (const name of ['leon_1_01', 'abjones_3_02', 'amy_4_01']) {
  const clip = loadClip(name);
  const out = await runBasicPitch(resample(clip.audio, 48000, BP_SR));
  const meanAct = (rows: Float32Array[]) => rows.reduce((a, r) => a + r.reduce((x, y) => x + y, 0), 0) / rows.length;
  console.log(name, 'mean note', meanAct(out.note).toFixed(3), 'mean onset', meanAct(out.onset).toFixed(3), 'frames', out.note.length, 'dur', clip.durationSec.toFixed(2), 'lastT', out.times[out.times.length - 1].toFixed(2));
  for (const shift of [-0.04, -0.02, -0.01, 0, 0.01, 0.02, 0.04]) {
    let v = 0, ok50 = 0, ok100 = 0, oct = 0;
    for (let i = 0; i < out.contour.length; i++) {
      const truth = labelAt(clip.labels, out.times[i] + shift); if (truth === null) continue; v++;
      const c = out.contour[i]; let b = 0; for (let k = 1; k < c.length; k++) if (c[k] > c[b]) b = k;
      const cents = 1200 * Math.log2(contourBinHz(b) / midiToHz(truth));
      if (Math.abs(cents) <= 50) ok50++; if (Math.abs(cents) <= 100) ok100++; if (Math.abs(Math.abs(cents) - 1200) <= 50) oct++;
    }
    console.log(' shift', shift, 'acc50', (100 * ok50 / v).toFixed(1), 'acc100', (100 * ok100 / v).toFixed(1), 'oct', (100 * oct / v).toFixed(1));
  }
  let v = 0, ok = 0;
  for (let i = 0; i < out.note.length; i++) { const truth = labelAt(clip.labels, out.times[i]); if (truth === null) continue; v++; const c = out.note[i]; let b = 0; for (let k = 1; k < c.length; k++) if (c[k] > c[b]) b = k; if (Math.abs(21 + b - truth) <= 0.5) ok++; }
  console.log(' note-argmax acc', (100 * ok / v).toFixed(1));
}
