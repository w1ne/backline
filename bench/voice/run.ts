/**
 * Offline bench for the mic pitch/onset pipeline: synthesizes vocal-like
 * clips, replays them through the real Listener + PitchTracker + OnsetDetector
 * code, and prints/records accuracy numbers. See bench/voice/RESULTS.md for
 * the last recorded run.
 *
 * Run with: npm run bench:voice
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { INSTRUMENT_PROFILE, VOICE_PROFILE, type PitchTrackerOptions } from '../../src/listener/pitchTracker';
import { buildClipAudio, buildClips, buildSpokenClip, type ClipSpec } from './synth';
import { runClip } from './driver';
import { median, noteSegmentation, rawPitchAccuracy } from './metrics';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROFILES: { name: string; opts: PitchTrackerOptions }[] = [
  { name: 'VOICE', opts: VOICE_PROFILE },
  { name: 'INSTRUMENT', opts: INSTRUMENT_PROFILE },
];

function fmt(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toFixed(digits);
}

interface Row {
  clip: string;
  profile: string;
  pitchAcc: number;
  octaveErr: number;
  precision: number;
  recall: number;
  f1: number;
  latencyMs: number | null;
  keyLockS: number | null;
  keyCorrect: string;
  tempoLockS: number | null;
  bpmErr: number | null;
}

export interface VoiceBenchResult {
  rows: Row[];
  spokenRows: { profile: string; falseNotes: number }[];
  md: string;
}

export function run(): VoiceBenchResult {
  const specs: ClipSpec[] = buildClips();
  const rows: Row[] = [];

  for (const spec of specs) {
    const audio = synthAudio(spec);
    for (const profile of PROFILES) {
      const result = runClip(audio, profile.opts);
      const acc = rawPitchAccuracy(result.rawFrames, spec.truth.notes);
      const seg = noteSegmentation(result.detectedNotes, spec.truth.notes);
      const lat = median(seg.latencies.filter(l => l >= 0));
      let keyCorrect = '—';
      if (spec.truth.key) {
        keyCorrect = result.key && result.key.root === spec.truth.key.root && result.key.mode === spec.truth.key.mode ? 'yes' : 'no';
      }
      const bpmErr = spec.truth.bpm && result.bpm !== null ? result.bpm - spec.truth.bpm : null;
      rows.push({
        clip: spec.truth.name,
        profile: profile.name,
        pitchAcc: acc.accuracyPct,
        octaveErr: acc.octaveErrorPct,
        precision: seg.precision,
        recall: seg.recall,
        f1: seg.f1,
        latencyMs: lat !== null ? lat * 1000 : null,
        keyLockS: result.keyLockT,
        keyCorrect,
        tempoLockS: result.tempoLockT,
        bpmErr,
      });
    }
  }

  // spoken / false-positive clip
  const spoken = buildSpokenClip();
  const spokenRows = PROFILES.map(profile => {
    const result = runClip(spoken.audio, profile.opts);
    return { profile: profile.name, falseNotes: result.detectedNotes.length };
  });

  // Candidate VOICE_PROFILE tweak, evaluated but NOT applied to src/: holdFrames 3 -> 2.
  // Reported here only; see "what this means" below for why it isn't pulled in.
  const candidateProfile: PitchTrackerOptions = { holdFrames: 2, minClarity: 0.7, minAgree: 2 };
  const melodySpecs = specs.filter(s => s.truth.name.startsWith('melody'));
  const candidateF1s = melodySpecs.map(spec => {
    const audio = synthAudio(spec);
    const result = runClip(audio, candidateProfile);
    return noteSegmentation(result.detectedNotes, spec.truth.notes).f1;
  });
  const voiceF1sOnMelody = melodySpecs.map(spec => {
    const audio = synthAudio(spec);
    const result = runClip(audio, VOICE_PROFILE);
    return noteSegmentation(result.detectedNotes, spec.truth.notes).f1;
  });
  const candidateFalseNotes = runClip(spoken.audio, candidateProfile).detectedNotes.length;
  const voiceFalseNotes = runClip(spoken.audio, VOICE_PROFILE).detectedNotes.length;
  const meanOf = (xs: number[]) => xs.filter(x => !Number.isNaN(x)).reduce((a, b) => a + b, 0) / xs.filter(x => !Number.isNaN(x)).length;

  const lines: string[] = [];
  lines.push('# Voice listener bench results');
  lines.push('');
  lines.push(`Generated ${new Date().toISOString().slice(0, 10)} by bench/voice/run.ts.`);
  lines.push('');
  lines.push('## Pitch, note detection, key/tempo lock');
  lines.push('');
  lines.push('| clip | profile | pitch acc % | octave err % | note P | note R | note F1 | latency ms | key lock s | key ok | tempo lock s | bpm err |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    lines.push(
      `| ${r.clip} | ${r.profile} | ${fmt(r.pitchAcc)} | ${fmt(r.octaveErr)} | ${fmt(r.precision, 2)} | ${fmt(r.recall, 2)} | ${fmt(r.f1, 2)} | ${fmt(r.latencyMs, 0)} | ${fmt(r.keyLockS, 2)} | ${r.keyCorrect} | ${fmt(r.tempoLockS, 2)} | ${fmt(r.bpmErr, 1)} |`,
    );
  }
  lines.push('');
  lines.push('## False notes on the spoken (no stable pitch) clip');
  lines.push('');
  lines.push('| profile | false notes emitted (truth = 0) |');
  lines.push('|---|---|');
  for (const r of spokenRows) lines.push(`| ${r.profile} | ${r.falseNotes} |`);
  lines.push('');
  lines.push('## Candidate VOICE_PROFILE tweak (not applied to src/)');
  lines.push('');
  lines.push('`{ holdFrames: 2, minClarity: 0.7, minAgree: 2 }` instead of the current `{ holdFrames: 3, minClarity: 0.7, minAgree: 2 }`:');
  lines.push('');
  lines.push('| profile | mean note F1 on the three melody clips | false notes on spoken clip |');
  lines.push('|---|---|---|');
  lines.push(`| current VOICE_PROFILE | ${fmt(meanOf(voiceF1sOnMelody), 2)} | ${voiceFalseNotes} |`);
  lines.push(`| candidate (holdFrames 2) | ${fmt(meanOf(candidateF1s), 2)} | ${candidateFalseNotes} |`);
  lines.push('');
  lines.push(
    'Two frames of agreement (100 ms) instead of three: fewer false notes on the spoken clip, but a much lower note F1 on the melodies now that the tracker holds a note through short dropouts. Not applied. Checked against synthetic voices only; real recordings may move both numbers.',
  );
  lines.push('');
  lines.push('## What this means');
  lines.push('');
  lines.push(
    "**Pitch accuracy %** is the share of 50ms analysis windows, while a ground-truth note is sounding, where the raw McLeod pitch estimate (before the tracker's smoothing) lands within 50 cents of the true note. Low numbers on a clip mean the detector is landing on the wrong pitch (or nothing) most of the time it's supposed to be tracking a note, not just occasionally.",
  );
  lines.push('');
  lines.push(
    '**Octave err %** is how often the miss above is specifically an octave (half or double the true frequency), which is a McLeod-family failure mode. If this number is high while accuracy is low, the fix is octave correction, not a better pitch estimator.',
  );
  lines.push('');
  lines.push(
    '**Note P/R/F1** treat a detected note as correct only if it has the true note\'s midi number and lands within 400 ms of when that note actually started, which covers the pipeline\'s own latency (85 ms window, 50 ms poll, three frames of agreement) so that latency is measured rather than scored as a miss. Precision drops when the tracker emits notes that are not there (chatter); recall drops when it misses real notes (too slow to lock in, or locks on the wrong pitch).',
  );
  lines.push('');
  lines.push(
    '**Latency ms** is the median delay, across correctly matched notes, between a note actually starting and the tracker reporting it. This is holdFrames worth of 50ms polls plus whatever time McLeod itself needs, so it has a floor set by the profile (VOICE: 3 frames, INSTRUMENT: 5).',
  );
  lines.push('');
  lines.push(
    '**Key lock s / key ok** is how many seconds of audio it took KeyDetector to report a non-null key, and whether that key is the right one. **Tempo lock s / bpm err** is the same for TempoLock (needs 12 onsets before it commits) and how far its bpm estimate is from the truth once locked.',
  );
  lines.push('');
  lines.push(
    '**False notes on the spoken clip** is a leak check: random pitch drift with no stable notes should produce zero detected notes. Any nonzero count here is the tracker hallucinating pitch out of speech-like noise, which would show up live as random unwanted notes while someone talks near the mic.',
  );
  lines.push('');

  const md = lines.join('\n');
  return { rows, spokenRows, md };
}

function synthAudio(spec: ClipSpec) {
  return buildClipAudio(spec).audio;
}

function main() {
  const { md } = run();
  console.log(md);
  writeFileSync(join(__dirname, 'RESULTS.md'), md);
}

if (!process.env.BENCH_GATE) main();
