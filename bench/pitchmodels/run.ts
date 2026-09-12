/**
 * Research spike: McLeod (ours) vs pYIN (pure TS, this dir) vs Spotify Basic Pitch (ONNX) on
 * the 24 MIR-1K clips of bench/realvoice, with the same frame metrics and note matching.
 *
 * Run from the repo root: npx vite-node bench/pitchmodels/run.ts
 * Needs bench/realvoice/data (see bench/realvoice/dataset.ts) and `npm install` inside
 * bench/pitchmodels (onnxruntime-node, dev only) plus models/nmp.onnx (see REPORT.md).
 */
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { VOICE_PROFILE } from '../../src/listener/pitchTracker';
import { detectPitch, type PitchEstimate } from '../../src/listener/pitch';
import { median, noteSegmentation } from '../voice/metrics';
import type { DetectedNote } from '../voice/driver';
import { SR } from '../voice/synth';
import { CLIPS, datasetPresent, labelNotes, loadClip, type RealClip } from '../realvoice/dataset';
import { labelPitchAccuracy, type LabelPitchAccuracy } from '../realvoice/metrics';
import { resample } from '../realvoice/wav';
import { pollWindows, replay, PITCH_RMS_FLOOR } from './driver';
import { pyinFrame, pyinViterbi } from './pyin';
import { BP_SR, MODEL_PATH, basicPitchNotes, contourPitchAt, runBasicPitch } from './basicpitch';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTOUR_THRESH = 0.2;

interface MethodResult {
  acc: LabelPitchAccuracy;
  f1: number; p: number; r: number;
  nDet: number;
  latencyMs: number | null;
  /** compute per 50 ms poll frame, ms */
  frameMs: number;
}
interface ClipRow { name: string; sex: 'f' | 'm'; nTruth: number; methods: Record<string, MethodResult> }

const fmt = (n: number | null | undefined, d = 1) => (n === null || n === undefined || Number.isNaN(n)) ? '—' : n.toFixed(d);

function score(clip: RealClip, rawFrames: { t: number; hz: number | null }[], det: DetectedNote[], frameMs: number): MethodResult {
  const acc = labelPitchAccuracy(rawFrames, clip.labels);
  const seg = noteSegmentation(det, labelNotes(clip.labels));
  const lat = median(seg.latencies);
  return { acc, f1: seg.f1, p: seg.precision, r: seg.recall, nDet: det.length, latencyMs: lat === null ? null : lat * 1000, frameMs };
}

async function runOne(clip: RealClip): Promise<ClipRow> {
  const windows = pollWindows(clip.audio);
  const methods: Record<string, MethodResult> = {};
  const truth = labelNotes(clip.labels);

  // --- McLeod (ours), timed the same way for a fair per-frame number ---
  {
    let ms = 0;
    const est: (PitchEstimate | null)[] = windows.map(w => {
      if (w.rms <= PITCH_RMS_FLOOR) return null;
      const t0 = performance.now();
      const e = detectPitch(w.x, SR);
      ms += performance.now() - t0;
      return e;
    });
    const r = replay(clip.audio, VOICE_PROFILE, est);
    methods.mcleod = score(clip, r.rawFrames, r.detectedNotes, ms / windows.length);
  }

  // --- pYIN: frame analysis (timed per frame) + clip-wide Viterbi (timed, spread per frame) ---
  {
    let ms = 0;
    const t0 = performance.now();
    const frames = windows.map(w => pyinFrame(w.x, SR));
    ms += performance.now() - t0;
    const t1 = performance.now();
    const track = pyinViterbi(frames);
    const viterbiMs = performance.now() - t1;
    const est: (PitchEstimate | null)[] = windows.map((w, i) => {
      if (w.rms <= PITCH_RMS_FLOOR || track[i].hz === null) return null;
      // Viterbi's voicing decision is the gate; the tracker's clarity test is then a no-op.
      return { hz: track[i].hz!, clarity: 1 };
    });
    const r = replay(clip.audio, VOICE_PROFILE, est);
    methods.pyin = score(clip, r.rawFrames, r.detectedNotes, (ms + viterbiMs) / windows.length);
    // no-Viterbi variant: the single best candidate per frame (what an online pYIN would do
    // with zero lookahead), through the same tracker
    const estYin: (PitchEstimate | null)[] = windows.map((w, i) => {
      const f = frames[i];
      if (w.rms <= PITCH_RMS_FLOOR || f.bestHz === null || f.voicedProb < 0.5) return null;
      return { hz: f.bestHz, clarity: Math.min(1, 0.7 + f.bestProb) };
    });
    const ry = replay(clip.audio, VOICE_PROFILE, estYin);
    methods.pyin_online = score(clip, ry.rawFrames, ry.detectedNotes, ms / windows.length);
  }

  // --- Basic Pitch: offline over the whole clip; frame pitch from the contour, notes from its own segmentation ---
  if (existsSync(MODEL_PATH)) {
    const a22 = resample(clip.audio, SR, BP_SR);
    const out = await runBasicPitch(a22);
    const rawFrames = windows.map(w => {
      // the bench reads the label at the pitch window's centre; the contour is read there too
      const centre = w.t + (512 - 4096 / 2) / SR;
      const c = w.rms <= PITCH_RMS_FLOOR ? null : contourPitchAt(out, centre, CONTOUR_THRESH);
      return { t: w.t, hz: c?.hz ?? null };
    });
    const notes = basicPitchNotes(out);
    const det: DetectedNote[] = notes.map(n => ({ midi: n.midi, velocity: 0.8, t: n.start }));
    // per-frame budget if a browser re-ran the 2 s window every 50 ms poll (sliding), i.e. one inference per frame
    const perWindowMs = out.inferMs / out.windows;
    const m = score(clip, rawFrames, det, perWindowMs);
    methods.basicpitch = m;
    // Also: Basic Pitch contour pushed through OUR tracker (segmentation comparison on equal footing)
    const est: (PitchEstimate | null)[] = rawFrames.map(f => (f.hz === null ? null : { hz: f.hz, clarity: 1 }));
    const r = replay(clip.audio, VOICE_PROFILE, est);
    methods.basicpitch_tracker = score(clip, r.rawFrames, r.detectedNotes, perWindowMs);
    // The contour reads ~+35 cents sharp against the MIR-1K labels on every clip (see diag.ts);
    // one contour bin (33 cents) down is a fixed calibration, reported separately.
    const cal = rawFrames.map(f => ({ t: f.t, hz: f.hz === null ? null : f.hz * 2 ** (-1 / 36) }));
    const rc = replay(clip.audio, VOICE_PROFILE, cal.map(f => (f.hz === null ? null : { hz: f.hz, clarity: 1 })));
    methods.basicpitch_cal_tracker = score(clip, rc.rawFrames, rc.detectedNotes, perWindowMs);
  }

  return { name: clip.name, sex: clip.sex, nTruth: truth.length, methods };
}

function mean(xs: number[]) { const v = xs.filter(x => !Number.isNaN(x)); return v.reduce((a, b) => a + b, 0) / v.length; }

async function main() {
  if (!datasetPresent()) { console.error('dataset missing: bench/realvoice/data/MIR-1K'); process.exit(1); }
  const rows: ClipRow[] = [];
  for (const name of CLIPS) {
    const clip = loadClip(name);
    const row = await runOne(clip);
    rows.push(row);
    const line = Object.entries(row.methods).map(([k, m]) => `${k}: acc ${fmt(m.acc.accuratePct)} oct ${fmt(m.acc.octaveErrorPct)} F1 ${fmt(m.f1, 2)} ${fmt(m.frameMs, 2)}ms`).join(' | ');
    console.log(`${name.padEnd(20)} ${line}`);
  }
  const methodNames = Object.keys(rows[0].methods);
  const lines: string[] = [];
  lines.push('# Pitch-model spike: per-clip numbers', '', `Generated ${new Date().toISOString().slice(0, 10)} by bench/pitchmodels/run.ts on ${CLIPS.length} MIR-1K clips. Model file: ${existsSync(MODEL_PATH) ? (statSync(MODEL_PATH).size / 1024).toFixed(0) + ' KB' : 'absent'}.`, '');
  for (const mn of methodNames) {
    lines.push(`## ${mn}`, '', '| clip | range | pitch acc % | octave err % | no pitch % | other err % | note F1 | P | R | notes (label/det) | latency ms | ms/frame |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of rows) {
      const m = r.methods[mn];
      lines.push(`| ${r.name} | ${r.sex} | ${fmt(m.acc.accuratePct)} | ${fmt(m.acc.octaveErrorPct)} | ${fmt(m.acc.silentPct)} | ${fmt(m.acc.otherErrorPct)} | ${fmt(m.f1, 2)} | ${fmt(m.p, 2)} | ${fmt(m.r, 2)} | ${r.nTruth}/${m.nDet} | ${fmt(m.latencyMs, 0)} | ${fmt(m.frameMs, 2)} |`);
    }
    const ms = rows.map(r => r.methods[mn]);
    const f = rows.filter(r => r.sex === 'f').map(r => r.methods[mn]), ml = rows.filter(r => r.sex === 'm').map(r => r.methods[mn]);
    const lat = median(ms.map(m => m.latencyMs).filter((x): x is number => x !== null));
    lines.push('', `Means: pitch acc ${fmt(mean(ms.map(m => m.acc.accuratePct)))}%, octave err ${fmt(mean(ms.map(m => m.acc.octaveErrorPct)))}%, no pitch ${fmt(mean(ms.map(m => m.acc.silentPct)))}%, other ${fmt(mean(ms.map(m => m.acc.otherErrorPct)))}%, note F1 ${fmt(mean(ms.map(m => m.f1)), 2)} (P ${fmt(mean(ms.map(m => m.p)), 2)}, R ${fmt(mean(ms.map(m => m.r)), 2)}), median latency ${fmt(lat, 0)} ms, mean compute ${fmt(mean(ms.map(m => m.frameMs)), 2)} ms per 50 ms frame. Female: acc ${fmt(mean(f.map(m => m.acc.accuratePct)))}% F1 ${fmt(mean(f.map(m => m.f1)), 2)}; male: acc ${fmt(mean(ml.map(m => m.acc.accuratePct)))}% F1 ${fmt(mean(ml.map(m => m.f1)), 2)}.`, '');
  }
  const outPath = join(__dirname, 'RESULTS.md');
  writeFileSync(outPath, lines.join('\n'));
  console.log('\nwrote', outPath);
  const summary: Record<string, unknown> = {};
  for (const mn of methodNames) {
    const ms = rows.map(r => r.methods[mn]);
    summary[mn] = {
      acc: mean(ms.map(m => m.acc.accuratePct)), oct: mean(ms.map(m => m.acc.octaveErrorPct)), silent: mean(ms.map(m => m.acc.silentPct)),
      f1: mean(ms.map(m => m.f1)), p: mean(ms.map(m => m.p)), r: mean(ms.map(m => m.r)),
      lat: median(ms.map(m => m.latencyMs).filter((x): x is number => x !== null)), frameMs: mean(ms.map(m => m.frameMs)),
    };
  }
  console.log(JSON.stringify(summary, null, 1));
}

main().catch(e => { console.error(e); process.exit(1); });
