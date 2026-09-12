/**
 * Calibrates the listener constants in src/listener/tuning.ts against real singers.
 *
 * The 24 MIR-1K clips of bench/realvoice are split by singer into 16 calibration and 8
 * held-out clips. Stage 1 searches the pitch-tracker and pitch-gate constants for the best
 * mean note F1 on the calibration clips, under a latency cap and without losing the synthetic
 * melodies of bench/voice. Stage 2 then searches the key-detector constants for the most key
 * locks without fewer correct or plausible keys. Both stages score the default and the best
 * tuning on the calibration and the held-out clips, print the table and write it to
 * bench/calibrate/CALIBRATION.md. The decision rule for adopting the result is in `verdict`.
 *
 * The signal-processing half of every clip (FFT flux, McLeod) is computed once; a candidate
 * only re-runs the trackers and the Listener, so an evaluation is well under a second.
 *
 * Run with: npm run bench:calibrate
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DEFAULT_TUNING, type KeyTuning, type ListenerTuning } from '../../src/listener/tuning';
import { KeyDetector } from '../../src/listener/keyDetector';
import { keyName } from '../../src/music/scales';
import type { Key } from '../../src/types';
import { analyse, runClip, type Analysis, type RunResult } from '../voice/driver';
import { median, noteSegmentation } from '../voice/metrics';
import { buildClipAudio, buildClips, buildSpokenClip, type ClipSpec } from '../voice/synth';
import type { Note } from '../voice/synth';
import { CLIPS, datasetPresent, labelNotes, labelPitchClassWeights, loadClip, singerOf } from '../realvoice/dataset';
import { KEY_PLAUSIBLE_COVERAGE, bestCoveringKey, scaleCoverage } from '../realvoice/metrics';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Held-out singers: two female, two male range, fixed so reruns compare. The other eight calibrate. */
export const HELD_OUT_SINGERS = ['heycat', 'yifen', 'jmzen', 'Kenshin'];
export const CALIBRATION_CLIPS = CLIPS.filter(c => !HELD_OUT_SINGERS.includes(singerOf(c)));
export const HELD_OUT_CLIPS = CLIPS.filter(c => HELD_OUT_SINGERS.includes(singerOf(c)));

/** note latency the tracker may not exceed (median over calibration clips) */
const MAX_LATENCY_MS = 140;
/** the synthetic melodies of bench/voice may lose at most this much mean note F1 */
const SYNTH_F1_SLACK = 0.02;
/** Listener caps the sustain credited to one pitch frame at this (listener.ts MAX_PITCH_FRAME_SEC) */
const MAX_PITCH_FRAME_SEC = 0.1;

const GRID_TRACKER = {
  holdFrames: [2, 3, 4],
  trackerClarity: [0.55, 0.6, 0.65, 0.7, 0.75, 0.8],
  minAgree: [2, 3],
  maxDropout: [1, 2, 3],
  glideCents: [25, 30, 35, 40, 45, 50],
  pitchClarity: [0.5, 0.55, 0.6, 0.65, 0.7],
};
const GRID_KEY = {
  earlyConfidence: [0.6, 0.65, 0.7, 0.75, 0.8],
  coverMin: [0.8, 0.825, 0.85, 0.875, 0.9],
  coverMargin: [0.04, 0.06, 0.08, 0.1, 0.12],
  coverMinSustainSec: [1, 1.5, 2, 2.5, 3],
};

interface TrackerParams { holdFrames: number; trackerClarity: number; minAgree: number; maxDropout: number; glideCents: number; pitchClarity: number }
type KeyParams = Pick<KeyTuning, 'earlyConfidence' | 'coverMin' | 'coverMargin' | 'coverMinSustainSec'>;

const trackerParamsOf = (t: ListenerTuning): TrackerParams => ({
  holdFrames: t.voiceProfile.holdFrames, trackerClarity: t.voiceProfile.minClarity, minAgree: t.voiceProfile.minAgree,
  maxDropout: t.tracker.maxDropout, glideCents: t.tracker.glideCents, pitchClarity: t.pitch.minClarity,
});
const keyParamsOf = (t: ListenerTuning): KeyParams => ({
  earlyConfidence: t.key.earlyConfidence, coverMin: t.key.coverMin, coverMargin: t.key.coverMargin, coverMinSustainSec: t.key.coverMinSustainSec,
});
function withTracker(base: ListenerTuning, p: TrackerParams): ListenerTuning {
  return {
    ...base,
    pitch: { ...base.pitch, minClarity: p.pitchClarity },
    tracker: { ...base.tracker, maxDropout: p.maxDropout, glideCents: p.glideCents },
    voiceProfile: { holdFrames: p.holdFrames, minClarity: p.trackerClarity, minAgree: p.minAgree },
  };
}
function withKey(base: ListenerTuning, p: KeyParams): ListenerTuning {
  return { ...base, key: { ...base.key, ...p } };
}

interface RealClipData { name: string; audio: Float32Array; pre: Analysis; truth: Note[]; weights: number[]; labelKey: Key }
interface SynthClipData { spec: ClipSpec; pre: Analysis; audio: Float32Array }

interface NoteScore { f1: number; p: number; r: number; latencyMs: number | null; run: RunResult }
interface KeyScore { lockT: number | null; key: Key | null; plausible: boolean; correct: boolean }

function scoreNotes(clip: RealClipData, tuning: ListenerTuning): NoteScore {
  const run = runClip(clip.audio, tuning.voiceProfile, undefined, tuning, clip.pre);
  const seg = noteSegmentation(run.detectedNotes, clip.truth);
  const lat = median(seg.latencies.filter(l => l >= 0));
  return { f1: seg.f1, p: seg.precision, r: seg.recall, latencyMs: lat === null ? null : lat * 1000, run };
}

/**
 * Replays the tracker's stable-pitch stream into a fresh KeyDetector exactly the way
 * Listener.onPitch feeds it (mic onsets carry no pitch, so nothing else reaches it), and polls
 * the key every frame the way the driver does. Lets the key grid run without the audio.
 */
function replayKey(frames: RunResult['pitchFrames'], key: KeyTuning): { lockT: number | null; key: Key | null } {
  const det = new KeyDetector(key);
  let lastPitchAt: number | null = null;
  let lastSung: number | null = null;
  let lockT: number | null = null;
  let last: Key | null = null;
  for (const f of frames) {
    if (f.midi !== null) {
      if (lastPitchAt !== null) det.addSustain(f.midi, Math.min(Math.max(0, f.t - lastPitchAt), MAX_PITCH_FRAME_SEC));
      lastPitchAt = f.t;
      if (f.midi !== lastSung) { lastSung = f.midi; det.addNote(f.midi, 0); }
    } else {
      lastSung = null;
      lastPitchAt = null;
    }
    last = det.key;
    if (lockT === null && last !== null) lockT = f.t;
  }
  return { lockT, key: last };
}

function scoreKey(clip: RealClipData, frames: RunResult['pitchFrames'], key: KeyTuning): KeyScore {
  const r = replayKey(frames, key);
  const cov = r.key ? scaleCoverage(clip.weights, r.key) : NaN;
  return { lockT: r.lockT, key: r.key, plausible: r.key !== null && cov >= KEY_PLAUSIBLE_COVERAGE, correct: r.key !== null && r.key.root === clip.labelKey.root && r.key.mode === clip.labelKey.mode };
}

interface SetSummary {
  n: number; f1: number; p: number; r: number; latencyMs: number | null;
  locked: number; plausible: number; correct: number; lockMedianS: number | null;
}

const mean = (xs: number[]) => { const v = xs.filter(x => !Number.isNaN(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; };

/** Note and key numbers of one tuning over one clip set. */
function summarize(clips: RealClipData[], tuning: ListenerTuning): SetSummary & { notes: NoteScore[]; keys: KeyScore[] } {
  const notes = clips.map(c => scoreNotes(c, tuning));
  const keys = clips.map((c, i) => scoreKey(c, notes[i].run.pitchFrames, tuning.key));
  const lats = notes.map(n => n.latencyMs).filter((x): x is number => x !== null);
  const locks = keys.map(k => k.lockT).filter((x): x is number => x !== null);
  return {
    n: clips.length, f1: mean(notes.map(n => n.f1)), p: mean(notes.map(n => n.p)), r: mean(notes.map(n => n.r)), latencyMs: median(lats),
    locked: locks.length, plausible: keys.filter(k => k.plausible).length, correct: keys.filter(k => k.correct).length, lockMedianS: median(locks),
    notes, keys,
  };
}

interface SynthSummary { melodyF1: number; falseNotes: number; keysCorrect: number }

function summarizeSynth(melody: SynthClipData[], keyed: SynthClipData[], spoken: SynthClipData, tuning: ListenerTuning): SynthSummary {
  const f1s = melody.map(c => noteSegmentation(runClip(c.audio, tuning.voiceProfile, undefined, tuning, c.pre).detectedNotes, c.spec.truth.notes).f1);
  const falseNotes = runClip(spoken.audio, tuning.voiceProfile, undefined, tuning, spoken.pre).detectedNotes.length;
  let keysCorrect = 0;
  for (const c of keyed) {
    const run = runClip(c.audio, tuning.voiceProfile, undefined, tuning, c.pre);
    const k = replayKey(run.pitchFrames, tuning.key).key;
    const truth = c.spec.truth.key!;
    if (k && k.root === truth.root && k.mode === truth.mode) keysCorrect++;
  }
  return { melodyF1: mean(f1s), falseNotes, keysCorrect };
}

const fmt = (n: number | null | undefined, d = 2) => (n === null || n === undefined || Number.isNaN(n)) ? '—' : n.toFixed(d);
const elapsed = (t0: number) => `${((performance.now() - t0) / 1000).toFixed(0)}s`;

function main() {
  if (!datasetPresent()) {
    console.error('MIR-1K not found under bench/realvoice/data/MIR-1K/ — see bench/realvoice/dataset.ts');
    process.exit(1);
  }
  const T0 = performance.now();
  const log = (s: string) => console.error(`[${elapsed(T0)}] ${s}`);

  log(`analysing ${CLIPS.length} clips (${CALIBRATION_CLIPS.length} calibration / ${HELD_OUT_CLIPS.length} held-out) and the synthetic clips once`);
  const load = (name: string): RealClipData => {
    const c = loadClip(name);
    const weights = labelPitchClassWeights(c.labels);
    return { name, audio: c.audio, pre: analyse(c.audio), truth: labelNotes(c.labels), weights, labelKey: bestCoveringKey(weights).key };
  };
  const cal = CALIBRATION_CLIPS.map(load);
  const held = HELD_OUT_CLIPS.map(load);
  const synthAll: SynthClipData[] = buildClips().map(spec => { const a = buildClipAudio(spec).audio; return { spec, audio: a, pre: analyse(a) }; });
  const synthMelody = synthAll.filter(c => c.spec.truth.name.startsWith('melody'));
  const synthKeyed = synthAll.filter(c => c.spec.truth.key);
  const spokenClip = buildSpokenClip();
  const spoken: SynthClipData = { spec: { truth: spokenClip.truth } as ClipSpec, audio: spokenClip.audio, pre: analyse(spokenClip.audio) };
  log('analysis done');

  // sanity: the key replay must reproduce what the Listener did inside the run
  {
    const s = summarize(cal, DEFAULT_TUNING);
    for (let i = 0; i < cal.length; i++) {
      const live = s.notes[i].run;
      const rep = s.keys[i];
      const same = live.keyLockT === rep.lockT && (live.key === null) === (rep.key === null) && (!live.key || (live.key.root === rep.key!.root && live.key.mode === rep.key!.mode));
      if (!same) throw new Error(`key replay diverged from the Listener on ${cal[i].name}: live ${live.keyLockT} ${live.key && keyName(live.key)} vs replay ${rep.lockT} ${rep.key && keyName(rep.key)}`);
    }
  }

  // ---------------- stage 1: tracker + pitch gate ----------------
  const baseSynth = summarizeSynth(synthMelody, synthKeyed, spoken, DEFAULT_TUNING);
  const synthFloor = baseSynth.melodyF1 - SYNTH_F1_SLACK;
  log(`stage 1: synthetic melody F1 floor ${fmt(synthFloor)} (current ${fmt(baseSynth.melodyF1)}), latency cap ${MAX_LATENCY_MS} ms`);

  interface Eval1 { params: TrackerParams; f1: number; latencyMs: number | null; synthF1: number; falseNotes: number; ok: boolean }
  const cache1 = new Map<string, Eval1>();
  let evals1 = 0;
  const eval1 = (params: TrackerParams): Eval1 => {
    const k = JSON.stringify(params);
    const hit = cache1.get(k);
    if (hit) return hit;
    const tuning = withTracker(DEFAULT_TUNING, params);
    const s = summarize(cal, tuning);
    const sy = summarizeSynth(synthMelody, synthKeyed, spoken, tuning);
    const ok = params.minAgree <= params.holdFrames && s.latencyMs !== null && s.latencyMs <= MAX_LATENCY_MS && sy.melodyF1 >= synthFloor - 1e-9;
    const e: Eval1 = { params, f1: s.f1, latencyMs: s.latencyMs, synthF1: sy.melodyF1, falseNotes: sy.falseNotes, ok };
    cache1.set(k, e);
    evals1++;
    return e;
  };
  // higher F1 wins; a feasible point always beats an infeasible one; ties go to the lower latency
  const better1 = (a: Eval1, b: Eval1): boolean => {
    if (a.ok !== b.ok) return a.ok;
    if (Math.abs(a.f1 - b.f1) > 1e-9) return a.f1 > b.f1;
    return (a.latencyMs ?? Infinity) < (b.latencyMs ?? Infinity);
  };

  let best1 = eval1(trackerParamsOf(DEFAULT_TUNING));
  const default1 = best1;
  log(`stage 1 default: F1 ${fmt(best1.f1)} latency ${fmt(best1.latencyMs, 0)} ms synth ${fmt(best1.synthF1)} false ${best1.falseNotes}`);
  const order1 = Object.keys(GRID_TRACKER) as (keyof TrackerParams)[];
  for (let pass = 1; pass <= 4; pass++) {
    const before = best1;
    for (const name of order1) {
      for (const v of GRID_TRACKER[name]) {
        const e = eval1({ ...best1.params, [name]: v });
        if (better1(e, best1)) best1 = e;
      }
      log(`stage 1 pass ${pass} ${name}: best F1 ${fmt(best1.f1)} latency ${fmt(best1.latencyMs, 0)} ms synth ${fmt(best1.synthF1)} ${JSON.stringify(best1.params)} (${evals1} evals)`);
    }
    if (best1 === before) break;
  }
  // one joint sweep of the two profile gates around the optimum, the pair that interacts most
  for (const trackerClarity of GRID_TRACKER.trackerClarity) for (const pitchClarity of GRID_TRACKER.pitchClarity) {
    const e = eval1({ ...best1.params, trackerClarity, pitchClarity });
    if (better1(e, best1)) best1 = e;
  }
  log(`stage 1 done after ${evals1} evaluations: ${JSON.stringify(best1.params)}`);
  const tuning1 = withTracker(DEFAULT_TUNING, best1.params);

  // ---------------- stage 2: key detector ----------------
  interface Eval2 { params: KeyParams; locked: number; plausible: number; correct: number; lockMedianS: number | null; synthKeys: number; ok: boolean }
  interface Stage2 { best: Eval2; def: Eval2; evals: number; fullRuns: number; noteFloor: number }
  /**
   * Full grid over the key constants on top of `tracker`. The replay gives the lock numbers
   * without the audio. The key also reaches the notes, though: once a key "fits", Listener
   * snaps sung pitches onto it, so a looser key rule can move note F1 on both benches. A
   * candidate the replay likes is therefore confirmed with a full run before it becomes the
   * incumbent: calibration note F1 may not drop more than 0.005 below the tracker's own.
   */
  const searchKey = (tracker: ListenerTuning, label: string): Stage2 => {
    const base = summarize(cal, tracker);
    const calFrames = base.notes.map(n => n.run.pitchFrames);
    const synthKeyedFrames = synthKeyed.map(c => runClip(c.audio, tracker.voiceProfile, undefined, tracker, c.pre).pitchFrames);
    const noteFloor = base.f1 - 0.005;
    let fullRuns = 0;
    const confirm = (e: Eval2): boolean => {
      fullRuns++;
      const t = withKey(tracker, e.params);
      const s = summarize(cal, t);
      const sy = summarizeSynth(synthMelody, synthKeyed, spoken, t);
      return s.f1 >= noteFloor && sy.melodyF1 >= synthFloor - 1e-9 && sy.keysCorrect >= baseSynth.keysCorrect;
    };
    const eval2 = (params: KeyParams, floor?: Eval2): Eval2 => {
      const key = withKey(tracker, params).key;
      const ks = cal.map((c, i) => scoreKey(c, calFrames[i], key));
      const locks = ks.map(k => k.lockT).filter((x): x is number => x !== null);
      let synthKeys = 0;
      synthKeyed.forEach((c, i) => {
        const k = replayKey(synthKeyedFrames[i], key).key;
        const truth = c.spec.truth.key!;
        if (k && k.root === truth.root && k.mode === truth.mode) synthKeys++;
      });
      const e: Eval2 = { params, locked: locks.length, plausible: ks.filter(k => k.plausible).length, correct: ks.filter(k => k.correct).length, lockMedianS: median(locks), synthKeys, ok: true };
      if (floor) e.ok = e.plausible >= floor.plausible && e.correct >= floor.correct && e.synthKeys >= floor.synthKeys;
      return e;
    };
    const def = eval2(keyParamsOf(DEFAULT_TUNING));
    log(`stage 2 (${label}) default keys: locked ${def.locked}/${cal.length} plausible ${def.plausible} correct ${def.correct} median ${fmt(def.lockMedianS, 1)} s synth keys ${def.synthKeys}/${synthKeyed.length}; note F1 floor ${fmt(noteFloor, 3)}`);
    // more locks win; never fewer plausible, correct or synthetic keys than today; ties to more plausible, then earlier
    const better2 = (a: Eval2, b: Eval2): boolean => {
      if (a.ok !== b.ok) return a.ok;
      if (a.locked !== b.locked) return a.locked > b.locked;
      if (a.plausible + a.correct !== b.plausible + b.correct) return a.plausible + a.correct > b.plausible + b.correct;
      return (a.lockMedianS ?? Infinity) < (b.lockMedianS ?? Infinity);
    };
    let best = def;
    let evals = 0;
    for (const earlyConfidence of GRID_KEY.earlyConfidence) {
      for (const coverMin of GRID_KEY.coverMin) for (const coverMargin of GRID_KEY.coverMargin) for (const coverMinSustainSec of GRID_KEY.coverMinSustainSec) {
        const e = eval2({ earlyConfidence, coverMin, coverMargin, coverMinSustainSec }, def);
        evals++;
        if (better2(e, best) && confirm(e)) best = e;
      }
      log(`stage 2 (${label}) earlyConfidence ${earlyConfidence}: best locked ${best.locked} plausible ${best.plausible} correct ${best.correct} ${JSON.stringify(best.params)} (${evals} evals, ${fullRuns} confirmed with a full run)`);
    }
    return { best, def, evals, fullRuns, noteFloor };
  };
  const stage2 = searchKey(tuning1, 'stage-1 tracker');
  const best = withKey(tuning1, stage2.best.params);
  // the key constants alone, on today's tracker, in case the tracker change is what fails the held-out test
  const stage2Default = best1 === default1 ? stage2 : searchKey(DEFAULT_TUNING, 'default tracker');
  const keyOnly = withKey(DEFAULT_TUNING, stage2Default.best.params);

  // ---------------- report: default vs best on calibration and held-out ----------------
  log('scoring default and best on both clip sets');
  const rows = [
    { name: 'default', tuning: DEFAULT_TUNING },
    { name: 'best (tracker + keys)', tuning: best },
    { name: 'tracker only', tuning: tuning1 },
    { name: 'keys only', tuning: keyOnly },
  ].map(r => ({ ...r, cal: summarize(cal, r.tuning), held: summarize(held, r.tuning), synth: summarizeSynth(synthMelody, synthKeyed, spoken, r.tuning) }));
  const d = rows[0];
  const verdicts = rows.slice(1).map(r => ({ row: r, v: verdict(d.held, r.held, d.synth, r.synth) }));
  const adopted = verdicts.find(x => x.v.adopt);
  const b = adopted?.row ?? rows[1];

  const L: string[] = [];
  L.push('# Listener calibration (MIR-1K)');
  L.push('');
  L.push(`Generated ${new Date().toISOString().slice(0, 10)} by bench/calibrate/run.ts in ${elapsed(T0)}. Calibration: ${cal.length} clips (${CALIBRATION_CLIPS.map(singerOf).filter((s, i, a) => a.indexOf(s) === i).join(', ')}). Held out: ${held.length} clips (${HELD_OUT_SINGERS.join(', ')}). Stage 1: ${evals1} tracker evaluations by coordinate descent over holdFrames ${GRID_TRACKER.holdFrames.join('/')}, tracker minClarity ${GRID_TRACKER.trackerClarity.join('/')}, minAgree ${GRID_TRACKER.minAgree.join('/')}, maxDropout ${GRID_TRACKER.maxDropout.join('/')}, glide cents ${GRID_TRACKER.glideCents.join('/')}, pitch minClarity ${GRID_TRACKER.pitchClarity.join('/')}, maximizing calibration note F1 with median latency <= ${MAX_LATENCY_MS} ms and synthetic melody F1 >= ${fmt(synthFloor)}. Stage 2: full grid of ${stage2.evals} key tunings (replayed; ${stage2.fullRuns} confirmed with full runs, which must keep calibration note F1 within 0.005 of the tracker's) over earlyConfidence ${GRID_KEY.earlyConfidence.join('/')}, coverMin ${GRID_KEY.coverMin.join('/')}, coverMargin ${GRID_KEY.coverMargin.join('/')}, coverMinSustainSec ${GRID_KEY.coverMinSustainSec.join('/')}, maximizing calibration key locks with correct, plausible and synthetic-key counts not below the default; run on the stage-1 tracker and, separately, on today's tracker ("keys only").`);
  L.push('');
  L.push('| tuning | set | note F1 | P | R | latency ms | key locked | plausible | correct | lock median s | synth melody F1 | synth false notes | synth keys ok |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) for (const [set, s] of [['calibration', r.cal], ['held-out', r.held]] as const) {
    L.push(`| ${r.name} | ${set} (${s.n}) | ${fmt(s.f1)} | ${fmt(s.p)} | ${fmt(s.r)} | ${fmt(s.latencyMs, 0)} | ${s.locked}/${s.n} | ${s.plausible} | ${s.correct} | ${fmt(s.lockMedianS, 1)} | ${fmt(r.synth.melodyF1)} | ${r.synth.falseNotes} | ${r.synth.keysCorrect}/${synthKeyed.length} |`);
  }
  L.push('');
  L.push('| constant | default | best (tracker + keys) | keys only |');
  L.push('|---|---|---|---|');
  const pd = trackerParamsOf(DEFAULT_TUNING), pb = best1.params, kd = keyParamsOf(DEFAULT_TUNING), kb = stage2.best.params, ko = stage2Default.best.params;
  const mark = (a: number, b: number) => `${b}${a !== b ? ' *' : ''}`;
  for (const k of Object.keys(pd) as (keyof TrackerParams)[]) L.push(`| ${k} | ${pd[k]} | ${mark(pd[k], pb[k])} | ${pd[k]} |`);
  for (const k of Object.keys(kd) as (keyof KeyParams)[]) L.push(`| key.${k} | ${kd[k]} | ${mark(kd[k], kb[k])} | ${mark(kd[k], ko[k])} |`);
  L.push('');
  L.push(`Per held-out clip, default -> ${b.name} (note F1, key):`);
  L.push('');
  for (let i = 0; i < held.length; i++) {
    const dn = d.held.notes[i], bn = b.held.notes[i], dk = d.held.keys[i], bk = b.held.keys[i];
    const kf = (k: KeyScore) => k.key ? `${keyName(k.key)} @${fmt(k.lockT, 1)}s${k.plausible ? ' plausible' : ''}${k.correct ? ' correct' : ''}` : 'none';
    L.push(`- ${held[i].name}: F1 ${fmt(dn.f1)} -> ${fmt(bn.f1)}, key ${kf(dk)} -> ${kf(bk)} (label ${keyName(held[i].labelKey)})`);
  }
  L.push('');
  L.push('Candidates against the held-out set:');
  L.push('');
  for (const { row, v } of verdicts) L.push(`- ${row.name}: ${v.adopt ? 'ADOPT' : 'reject'}. ${v.reason}`);
  L.push('');
  L.push(`Verdict: ${adopted ? `adopt "${adopted.row.name}"` : 'keep the defaults'}.`);
  L.push('');
  L.push('Correct = the detected key is the major/minor scale that covers the most of the labelled pitch classes; plausible = that scale covers at least 85% of them. The defaults adopt only when the held-out set gains at least 0.02 note F1 or two key locks and nothing regresses there (F1, P, R, locks, plausible, correct, synthetic melody F1 and key count not lower; latency and false notes not higher).');
  const md = L.join('\n');
  console.log(md);
  writeFileSync(join(__dirname, 'CALIBRATION.md'), md + '\n');
  if (adopted) console.error(`\nadopt ${adopted.row.name}:\n${JSON.stringify({ pitch: b.tuning.pitch, tracker: b.tuning.tracker, voiceProfile: b.tuning.voiceProfile, key: b.tuning.key }, null, 2)}`);
}

/** Adopt when the held-out set clearly gains and nothing on it regresses. */
function verdict(d: SetSummary, b: SetSummary, ds: SynthSummary, bs: SynthSummary): { adopt: boolean; reason: string } {
  const gains: string[] = [];
  if (b.f1 - d.f1 >= 0.02 - 1e-9) gains.push(`note F1 +${fmt(b.f1 - d.f1)}`);
  if (b.locked - d.locked >= 2) gains.push(`key locks +${b.locked - d.locked}`);
  const regress: string[] = [];
  // half a point of the two-decimal table is noise, not a regression
  const lower = (name: string, x: number, y: number) => { if (y < x - 0.005) regress.push(`${name} ${fmt(x)} -> ${fmt(y)}`); };
  lower('note F1', d.f1, b.f1); lower('P', d.p, b.p); lower('R', d.r, b.r);
  lower('key locks', d.locked, b.locked); lower('plausible', d.plausible, b.plausible); lower('correct', d.correct, b.correct);
  lower('synthetic melody F1', ds.melodyF1, bs.melodyF1); lower('synthetic keys', ds.keysCorrect, bs.keysCorrect);
  if ((b.latencyMs ?? 0) > (d.latencyMs ?? 0) + 1e-9) regress.push(`latency ${fmt(d.latencyMs, 0)} -> ${fmt(b.latencyMs, 0)} ms`);
  if (bs.falseNotes > ds.falseNotes) regress.push(`false notes ${ds.falseNotes} -> ${bs.falseNotes}`);
  if (!gains.length) return { adopt: false, reason: 'No held-out gain of 0.02 note F1 or two key locks.' };
  if (regress.length) return { adopt: false, reason: `Held-out gains (${gains.join(', ')}) but regressions: ${regress.join('; ')}.` };
  return { adopt: true, reason: `Held-out gains: ${gains.join(', ')}; nothing regressed.` };
}

main();
