/**
 * Spotify Basic Pitch (ICASSP 2022 "nmp" model) through onnxruntime-node. 230 KB ONNX, input
 * 22050 Hz mono in fixed 43844-sample (~2 s) windows hopped by 36164 samples (30 frames of
 * overlap, 15 trimmed from each side), outputs per 256-sample frame (86.13 fps): note
 * posteriorgram (88 semitones from A0), onset posteriorgram (88), pitch contour (264 bins,
 * 3 per semitone). Constants and the note-creation rules follow basic_pitch/constants.py and
 * basic_pitch/note_creation.py (output_to_notes_polyphonic with its defaults).
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Note } from '../voice/synth';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ort = require('onnxruntime-node') as typeof import('onnxruntime-node');

const __dirname = dirname(fileURLToPath(import.meta.url));
export const MODEL_PATH = join(__dirname, 'models', 'nmp.onnx');

export const BP_SR = 22050;
const FFT_HOP = 256;
const ANNOT_FPS = BP_SR / FFT_HOP;
const ANNOT_N_FRAMES = 172;
const AUDIO_N_SAMPLES = BP_SR * 2 - FFT_HOP; // 43844
const N_OVERLAP_FRAMES = 30;
const OVERLAP_LEN = N_OVERLAP_FRAMES * FFT_HOP; // 7680
const HOP_SIZE = AUDIO_N_SAMPLES - OVERLAP_LEN; // 36164
const N_NOTES = 88;
const CONTOUR_BINS = 264;
const BASE_HZ = 27.5;
const MIDI_OFFSET = 21;

export interface BasicPitchOutput {
  /** [frame][88] */
  note: Float32Array[];
  onset: Float32Array[];
  /** [frame][264] */
  contour: Float32Array[];
  /** seconds for frame i */
  times: Float64Array;
  /** wall time spent inside session.run, total and per window */
  inferMs: number;
  windows: number;
}

let session: import('onnxruntime-node').InferenceSession | null = null;
export async function loadBasicPitch() {
  session ??= await ort.InferenceSession.create(MODEL_PATH, { intraOpNumThreads: 1, interOpNumThreads: 1 });
  return session;
}

/** Runs the model over the clip (22050 Hz mono) and unwraps the overlapping windows. */
export async function runBasicPitch(audio22k: Float32Array): Promise<BasicPitchOutput> {
  const s = await loadBasicPitch();
  const padded = new Float32Array(OVERLAP_LEN / 2 + audio22k.length);
  padded.set(audio22k, OVERLAP_LEN / 2);
  const nWindows = Math.max(1, Math.ceil((padded.length - AUDIO_N_SAMPLES) / HOP_SIZE) + 1);
  const note: Float32Array[] = [], onset: Float32Array[] = [], contour: Float32Array[] = [];
  let inferMs = 0;
  const trim = N_OVERLAP_FRAMES / 2;
  for (let w = 0; w < nWindows; w++) {
    const buf = new Float32Array(AUDIO_N_SAMPLES);
    const start = w * HOP_SIZE;
    buf.set(padded.subarray(start, Math.min(padded.length, start + AUDIO_N_SAMPLES)));
    const input = new ort.Tensor('float32', buf, [1, AUDIO_N_SAMPLES, 1]);
    const t0 = performance.now();
    const out = await s.run({ [s.inputNames[0]]: input });
    inferMs += performance.now() - t0;
    // Output order in the ONNX export: :0 contour (264), :1 note (88), :2 onset (88)
    // (basic_pitch/inference.py zips ["note","onset","contour"] with [":1", ":2", ":0"]).
    const con = out['StatefulPartitionedCall:0'].data as Float32Array;
    const nt = out['StatefulPartitionedCall:1'].data as Float32Array;
    const on = out['StatefulPartitionedCall:2'].data as Float32Array;
    for (let f = trim; f < ANNOT_N_FRAMES - trim; f++) {
      note.push(nt.slice(f * N_NOTES, (f + 1) * N_NOTES));
      onset.push(on.slice(f * N_NOTES, (f + 1) * N_NOTES));
      contour.push(con.slice(f * CONTOUR_BINS, (f + 1) * CONTOUR_BINS));
    }
  }
  const nOut = Math.min(note.length, Math.floor(audio22k.length * ANNOT_FPS / BP_SR));
  note.length = onset.length = contour.length = nOut;
  // model_frames_to_time: drift correction per window as in basic_pitch
  const windowOffset = (FFT_HOP / BP_SR) * (ANNOT_N_FRAMES - AUDIO_N_SAMPLES / FFT_HOP) + 0.0018;
  const times = new Float64Array(nOut);
  for (let i = 0; i < nOut; i++) times[i] = i / ANNOT_FPS - windowOffset * Math.floor(i / ANNOT_N_FRAMES);
  return { note, onset, contour, times, inferMs, windows: nWindows };
}

export const contourBinHz = (bin: number) => BASE_HZ * 2 ** (bin / 36);

/** Frame pitch from the contour at time t: argmax bin, null under `thresh`. */
export function contourPitchAt(out: BasicPitchOutput, t: number, thresh: number): { hz: number; p: number } | null {
  // frames are uniform to within the tiny per-window drift; nearest by time
  let i = Math.round(t * ANNOT_FPS);
  if (i < 0 || i >= out.contour.length) return null;
  while (i > 0 && out.times[i] > t + 0.5 / ANNOT_FPS) i--;
  while (i < out.contour.length - 1 && out.times[i + 1] <= t + 0.5 / ANNOT_FPS) i++;
  const c = out.contour[i];
  let b = 0;
  for (let k = 1; k < c.length; k++) if (c[k] > c[b]) b = k;
  if (c[b] < thresh) return null;
  // parabolic refinement between neighbouring bins (1/3 semitone apart)
  let shift = 0;
  if (b > 0 && b < c.length - 1) {
    const a = c[b - 1], m = c[b], r = c[b + 1];
    const den = a - 2 * m + r;
    if (den !== 0) shift = Math.max(-0.5, Math.min(0.5, (a - r) / (2 * den)));
  }
  return { hz: contourBinHz(b + shift), p: c[b] };
}

/**
 * basic_pitch.note_creation.output_to_notes_polyphonic with the library defaults
 * (onset 0.5, frame 0.3, min 11 frames ≈ 128 ms, infer_onsets, melodia_trick, energy_tol 11).
 */
export function basicPitchNotes(out: BasicPitchOutput, onsetThresh = 0.5, frameThresh = 0.3, minLenFrames = 11, energyTol = 11): Note[] {
  const T = out.note.length;
  if (!T) return [];
  const notes = out.note.map(r => Float32Array.from(r));
  const onsets = out.onset.map(r => Float32Array.from(r));
  // infer onsets: add positive frame-to-frame increases of the note posteriorgram
  for (let t = 1; t < T; t++) for (let p = 0; p < N_NOTES; p++) {
    const d = notes[t][p] - notes[t - 1][p];
    if (d > 0) onsets[t][p] = Math.min(1, Math.max(onsets[t][p], d));
  }
  const remaining = notes;
  const result: Note[] = [];
  const walk = (tStart: number, p: number): number => {
    let i = tStart + 1, k = 0;
    while (i < T - 1 && k < energyTol) {
      if (remaining[i][p] < frameThresh) k++; else k = 0;
      i++;
    }
    return i - k;
  };
  // peak-picked onsets, strongest first
  const peaks: { t: number; p: number; v: number }[] = [];
  for (let p = 0; p < N_NOTES; p++) for (let t = 0; t < T; t++) {
    const v = onsets[t][p];
    if (v < onsetThresh) continue;
    if ((t > 0 && onsets[t - 1][p] > v) || (t < T - 1 && onsets[t + 1][p] > v)) continue;
    peaks.push({ t, p, v });
  }
  peaks.sort((a, b) => b.v - a.v);
  for (const { t, p } of peaks) {
    if (remaining[t][p] < frameThresh) continue;
    const end = walk(t, p);
    if (end - t >= minLenFrames) {
      result.push({ midi: p + MIDI_OFFSET, start: out.times[t], end: out.times[Math.min(T - 1, end)] });
      for (let i = t; i < end; i++) remaining[i][p] = 0;
    }
  }
  // melodia trick: sweep up leftover energy peaks into notes, extending both ways
  for (;;) {
    let bt = -1, bp = -1, bv = frameThresh;
    for (let t = 0; t < T; t++) for (let p = 0; p < N_NOTES; p++) if (remaining[t][p] > bv) { bv = remaining[t][p]; bt = t; bp = p; }
    if (bt < 0) break;
    remaining[bt][bp] = 0;
    let i = bt + 1, k = 0;
    while (i < T - 1 && k < energyTol) { if (remaining[i][bp] < frameThresh) k++; else k = 0; remaining[i][bp] = 0; i++; }
    const end = i - k;
    i = bt - 1; k = 0;
    while (i > 0 && k < energyTol) { if (remaining[i][bp] < frameThresh) k++; else k = 0; remaining[i][bp] = 0; i--; }
    const start = i + k;
    if (end - start >= minLenFrames) result.push({ midi: bp + MIDI_OFFSET, start: out.times[start], end: out.times[Math.min(T - 1, end)] });
  }
  result.sort((a, b) => a.start - b.start);
  return result;
}
