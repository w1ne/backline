/**
 * Our hand-written McLeod (src/listener/pitch.ts) against the pitchy library (same McLeod
 * pitch method, FFT-based NSDF), on the MIR-1K clips present locally, both fed through the
 * shipping PitchTracker so note metrics compare on equal footing.
 * Run: npx vite-node bench/pitchmodels/pitchy.ts
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PitchDetector } from 'pitchy';
import { VOICE_PROFILE } from '../../src/listener/pitchTracker';
import { detectPitch, type PitchEstimate } from '../../src/listener/pitch';
import { detectPitch as detectPitchOld } from './mcleod_old';
import { median, noteSegmentation } from '../voice/metrics';
import { SR } from '../voice/synth';
import { CLIPS, DATA_DIR, datasetPresent, labelNotes, loadClip, type RealClip } from '../realvoice/dataset';
import { labelPitchAccuracy } from '../realvoice/metrics';
import { pollWindows, replay, PITCH_RMS_FLOOR, PITCH_WINDOW } from './driver';

type Est = (PitchEstimate | null)[];
interface R { acc: number; oct: number; silent: number; f1: number; p: number; r: number; lat: number | null; ms: number }

function score(clip: RealClip, est: Est, ms: number): R {
  const rep = replay(clip.audio, VOICE_PROFILE, est);
  const acc = labelPitchAccuracy(rep.rawFrames, clip.labels);
  const seg = noteSegmentation(rep.detectedNotes, labelNotes(clip.labels));
  const lat = median(seg.latencies);
  return { acc: acc.accuratePct, oct: acc.octaveErrorPct, silent: acc.silentPct, f1: seg.f1, p: seg.precision, r: seg.recall, lat: lat === null ? null : lat * 1000, ms };
}

function main() {
  if (!datasetPresent()) throw new Error('dataset missing');
  const only = process.env.CLIPS?.split(',');
  const names = (only ?? CLIPS).filter(n => existsSync(join(DATA_DIR, 'Wavfile', `${n}.wav`)));
  const methods: Record<string, (x: Float32Array) => PitchEstimate | null> = {};
  methods.mcleod_old = x => detectPitchOld(x, SR);
  methods.pitchy_src = x => detectPitch(x, SR);
  for (const k of [0.8, 0.9]) {
    const det = PitchDetector.forFloat32Array(PITCH_WINDOW);
    det.clarityThreshold = k;
    methods[`pitchy_k${k}`] = x => {
      const [hz, clarity] = det.findPitch(x, SR);
      if (!(hz > 0) || hz < 60 || hz > 1200) return null;
      return { hz, clarity, peak: clarity };
    };
  }
  const rows: Record<string, R[]> = {};
  for (const name of names) {
    const clip = loadClip(name);
    const windows = pollWindows(clip.audio);
    const line: string[] = [];
    for (const [mn, fn] of Object.entries(methods)) {
      let ms = 0;
      const est: Est = windows.map(w => {
        if (w.rms <= PITCH_RMS_FLOOR) return null;
        const t0 = performance.now();
        const e = fn(w.x);
        ms += performance.now() - t0;
        return e;
      });
      const r = score(clip, est, ms / windows.length);
      (rows[mn] ??= []).push(r);
      line.push(`${mn} acc ${r.acc.toFixed(1)} oct ${r.oct.toFixed(1)} F1 ${r.f1.toFixed(2)} ${r.ms.toFixed(2)}ms`);
    }
    console.log(name.padEnd(20), line.join(' | '));
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  console.log(`\n${names.length} clips`);
  console.log('| method | pitch acc % | octave err % | no pitch % | note F1 | P | R | latency ms | ms/frame |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const [mn, rs] of Object.entries(rows)) {
    const lat = median(rs.map(r => r.lat).filter((x): x is number => x !== null));
    console.log(`| ${mn} | ${mean(rs.map(r => r.acc)).toFixed(1)} | ${mean(rs.map(r => r.oct)).toFixed(1)} | ${mean(rs.map(r => r.silent)).toFixed(1)} | ${mean(rs.map(r => r.f1)).toFixed(2)} | ${mean(rs.map(r => r.p)).toFixed(2)} | ${mean(rs.map(r => r.r)).toFixed(2)} | ${lat?.toFixed(0)} | ${mean(rs.map(r => r.ms)).toFixed(2)} |`);
  }
}
main();
