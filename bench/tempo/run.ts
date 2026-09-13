/**
 * Tempo-from-solo-voice bench. Stitches every MIR-1K singer/song with ~30 s of consecutive
 * clips (bench/tempo/songs.ts), takes the backing track's tempo as truth (bench/tempo/truth.ts,
 * cross-checked against the four hand-established songs and, when bench/tempo/out/libs.json is
 * present, against madmom/librosa on the same backing), and scores every method in
 * bench/tempo/methods.ts online: each is asked for a tempo every half second up to 12 s and
 * its decision is the first estimate whose confidence clears the method's threshold (or its
 * last estimate at 12 s).
 *
 * Per method: % of songs within 8% of truth, % within 8% of truth or its exact half/double,
 * median seconds to a decision, and the distribution of log2(bpm/truth).
 *
 * Run with: npm run bench:tempo            (writes bench/tempo/RESULTS.md and out/wav/*.wav)
 *           npm run bench:tempo -- --fast  (reuses cached streams under out/streams/)
 * Reference libraries: bench/tempo/.venv/bin/python bench/tempo/libs.py, then rerun.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadClip } from '../realvoice/dataset';
import { resample, writeWav } from '../realvoice/wav';
import { SR } from '../voice/synth';
import { median } from '../voice/metrics';
import { KNOWN_BPM, listSongs, loadStitched } from './songs';
import { backingTempo, type TruthEstimate } from './truth';
import { extractStreams } from './streams';
import { VOICE_HI, VOICE_LO, combine, durationCluster, foldBpm, ioiFluxOnsets, ioiNoteOnsets, tempogramMethod, withStability, type TempoEstimate, type TempoMethod, type TempogramOptions, type VoiceStreams } from './methods';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, 'out');
const WAV_DIR = join(OUT_DIR, 'wav');
const STREAM_DIR = join(OUT_DIR, 'streams');
const LIBS_JSON = join(OUT_DIR, 'libs.json');

/** decisions are due by here; the app would otherwise ask for a tap */
export const DECISION_SEC = 12;
const STEP_SEC = 0.5;
const FIRST_SEC = 3;

export interface MethodSpec { name: string; method: TempoMethod; threshold: number }

/** the tempogram configuration that scored best in bench/tempo/explore.ts (see RESULTS.md) */
export const BEST_TEMPOGRAM: TempogramOptions = { envelope: 'flux', harmonic: 0.5, windowSec: 8, minWindowSec: 8, priorBpm: 90, priorOctaves: 0.6, noteOctave: true, fold: true };

export const METHODS: MethodSpec[] = [
  { name: 'a. IOI histogram, flux onsets (current TempoLock)', method: ioiFluxOnsets, threshold: 0 },
  { name: 'b. IOI histogram, note onsets', method: ioiNoteOnsets, threshold: 0 },
  { name: 'c1. tempogram, prior 100/0.5 oct', method: tempogramMethod({}), threshold: 0.3 },
  { name: 'c2. tempogram + note-duration octave', method: tempogramMethod({ noteOctave: true }), threshold: 0.3 },
  { name: 'c3. tempogram + harmonic sum + note octave, prior 90/0.6, folded 70..130', method: tempogramMethod(BEST_TEMPOGRAM), threshold: 0.3 },
  { name: 'd. note-duration clustering', method: durationCluster(), threshold: 0.3 },
  { name: 'e1. c3 + d + b vote', method: combine([{ method: tempogramMethod(BEST_TEMPOGRAM), weight: 1 }, { method: durationCluster(), weight: 0.5 }, { method: ioiNoteOnsets, weight: 0.3 }]), threshold: 0.6 },
  { name: 'e2. c3 + a vote', method: combine([{ method: tempogramMethod(BEST_TEMPOGRAM), weight: 1 }, { method: ioiFluxOnsets, weight: 0.5 }]), threshold: 0.6 },
  { name: 'e3. c3 with stability confidence (best)', method: withStability(tempogramMethod(BEST_TEMPOGRAM)), threshold: 0.6 },
];

export interface Decision { bpm: number | null; confidence: number; at: number | null }

/** Runs a method online and returns its decision: first estimate clearing `threshold`, else the last. */
export function decide(method: TempoMethod, s: VoiceStreams, threshold: number, deadline = DECISION_SEC): Decision {
  let last: TempoEstimate | null = null;
  for (let t = FIRST_SEC; t <= deadline + 1e-9; t += STEP_SEC) {
    const e = method(s, t);
    if (!e) continue;
    last = e;
    if (e.confidence >= threshold) return { bpm: e.bpm, confidence: e.confidence, at: t };
  }
  return last ? { bpm: last.bpm, confidence: last.confidence, at: null } : { bpm: null, confidence: 0, at: null };
}

export const within8 = (bpm: number, truth: number) => Math.abs(bpm / truth - 1) < 0.08;
export const withinOctave = (bpm: number, truth: number) => within8(bpm, truth) || within8(bpm, truth * 2) || within8(bpm, truth / 2);
/** the shipping bar: both folded into the singing band 70..130, then within 8% */
export const withinFolded = (bpm: number, truth: number) => within8(foldBpm(bpm, VOICE_LO, VOICE_HI), foldBpm(truth, VOICE_LO, VOICE_HI));

export interface Score { name: string; n: number; within8: number; octave: number; folded: number; decided: number; medianAt: number | null; errors: number[] }

export function score(name: string, rows: { truth: number; d: Decision }[]): Score {
  const n = rows.length;
  const got = rows.filter(r => r.d.bpm !== null);
  return {
    name, n,
    within8: got.filter(r => within8(r.d.bpm!, r.truth)).length / n,
    octave: got.filter(r => withinOctave(r.d.bpm!, r.truth)).length / n,
    folded: got.filter(r => withinFolded(r.d.bpm!, r.truth)).length / n,
    decided: rows.filter(r => r.d.at !== null).length / n,
    medianAt: median(rows.map(r => r.d.at).filter((x): x is number => x !== null)),
    errors: got.map(r => Math.log2(r.d.bpm! / r.truth)),
  };
}

interface LibResult { bpm?: number; ms?: number; confidence?: number; error?: string }
interface LibsJson { seconds: number; songs: Record<string, { voice: Record<string, LibResult>; backing: Record<string, LibResult> }> }

interface SongRow { name: string; dur: number; clips: number; truth: number; ambiguity: number; peaks: number[]; known: number | null; confirmed: boolean; onsets: number; notes: number; decisions: Record<string, Decision> }

const fmt = (n: number | null | undefined, d = 1) => (n === null || n === undefined || Number.isNaN(n)) ? '—' : n.toFixed(d);
const pct = (x: number) => (100 * x).toFixed(0) + '%';

function loadStreams(name: string, audio: Float32Array | null, fast: boolean): VoiceStreams {
  const path = join(STREAM_DIR, `${name}.json`);
  if (fast && existsSync(path)) {
    const j = JSON.parse(readFileSync(path, 'utf8'));
    return { ...j, flux: Float32Array.from(j.flux), level: Float32Array.from(j.level) };
  }
  if (!audio) throw new Error(`no cached streams for ${name}; run without --fast`);
  const s = extractStreams(audio);
  mkdirSync(STREAM_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify({ ...s, flux: Array.from(s.flux), level: Array.from(s.level) }));
  return s;
}

export function run(opts: { fast?: boolean; limit?: number } = {}): { rows: SongRow[]; scores: Score[]; libScores: { voice: Score[]; backing: Score[] } | null; md: string } {
  const durations = new Map<string, number>();
  const durationOf = (c: string) => { let d = durations.get(c); if (d === undefined) { d = loadClip(c).durationSec; durations.set(c, d); } return d; };
  const specs = listSongs(durationOf).slice(0, opts.limit ?? Infinity);
  const libs: LibsJson | null = existsSync(LIBS_JSON) ? JSON.parse(readFileSync(LIBS_JSON, 'utf8')) : null;
  mkdirSync(WAV_DIR, { recursive: true });
  const rows: SongRow[] = [];
  for (const spec of specs) {
    const truthPath = join(OUT_DIR, 'truth', `${spec.name}.json`);
    const cached = opts.fast && existsSync(truthPath) && existsSync(join(STREAM_DIR, `${spec.name}.json`));
    const song = cached ? null : loadStitched(spec);
    const truth: TruthEstimate | null = cached ? JSON.parse(readFileSync(truthPath, 'utf8')) : backingTempo(song!.accomp);
    if (!truth) continue;
    if (!cached) { mkdirSync(join(OUT_DIR, 'truth'), { recursive: true }); writeFileSync(truthPath, JSON.stringify({ ...truth, dur: song!.durationSec })); }
    const dur = cached ? (truth as TruthEstimate & { dur: number }).dur : song!.durationSec;
    if (song) {
      writeWav(join(WAV_DIR, `${spec.name}.voice.wav`), 16000, [resample(song.audio, SR, 16000)]);
      writeWav(join(WAV_DIR, `${spec.name}.backing.wav`), 16000, [resample(song.accomp, SR, 16000)]);
    }
    const s = loadStreams(spec.name, song?.audio ?? null, opts.fast ?? false);
    const decisions: Record<string, Decision> = {};
    for (const m of METHODS) decisions[m.name] = decide(m.method, s, m.threshold);
    // truth is confirmed when a hand-established bpm or the reference libraries on the backing agree with the measure
    const lib = libs?.songs[spec.name]?.backing;
    const libBpms = lib ? Object.values(lib).map(r => r.bpm).filter((b): b is number => typeof b === 'number') : [];
    const known = KNOWN_BPM[spec.name] ?? null;
    const confirmed = known !== null ? within8(truth.bpm, known) : libBpms.length ? libBpms.filter(b => within8(b, truth.bpm)).length * 2 >= libBpms.length : truth.ambiguity < 0.8;
    rows.push({ name: spec.name, dur, clips: spec.clips.length, truth: truth.bpm, ambiguity: truth.ambiguity, peaks: truth.peaks, known, confirmed, onsets: s.onsets.filter(o => o.t <= DECISION_SEC).length, notes: s.notes.filter(n => n.end <= DECISION_SEC).length, decisions });
    process.stdout.write(`${spec.name.padEnd(18)} truth ${fmt(truth.bpm, 0).padStart(4)}${known ? ` (known ${known})` : ''}${confirmed ? '' : ' [unconfirmed]'}  ${METHODS.map(m => fmt(decisions[m.name].bpm, 0).padStart(4)).join(' ')}\n`);
  }
  const confirmedRows = rows.filter(r => r.confirmed);
  const scoreOn = (set: SongRow[]) => METHODS.map(m => score(m.name, set.map(r => ({ truth: r.truth, d: r.decisions[m.name] }))));
  const scores = scoreOn(confirmedRows);
  let libScores: { voice: Score[]; backing: Score[] } | null = null;
  if (libs) {
    const libNames = [...new Set(rows.flatMap(r => Object.keys(libs.songs[r.name]?.voice ?? {})))].filter(n => !n.endsWith('madmom'));
    const on = (which: 'voice' | 'backing') => libNames.map(n => score(n, confirmedRows.map(r => {
      const e = libs.songs[r.name]?.[which]?.[n];
      return { truth: r.truth, d: { bpm: e && typeof e.bpm === 'number' ? e.bpm : null, confidence: 1, at: e && typeof e.bpm === 'number' ? libs.seconds : null } };
    })));
    libScores = { voice: on('voice'), backing: on('backing') };
  }
  const md = report(rows, scores, scoreOn(rows), libScores, libs?.seconds ?? null);
  writeFileSync(join(__dirname, 'RESULTS.md'), md);
  return { rows, scores, libScores, md };
}

function errorSummary(errors: number[]): string {
  if (!errors.length) return '—';
  const s = [...errors].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  const bins = { under: errors.filter(e => e < -0.11).length, ok: errors.filter(e => Math.abs(e) <= 0.11).length, over: errors.filter(e => e > 0.11).length };
  return `p10 ${q(0.1).toFixed(2)} / p50 ${q(0.5).toFixed(2)} / p90 ${q(0.9).toFixed(2)} oct; ${bins.under} slow, ${bins.ok} near, ${bins.over} fast`;
}

function scoreTable(scores: Score[]): string[] {
  const L = ['| method | songs | within 8% | within 8% or exact half/double | folded into 70..130, within 8% | decided by 12 s | median s to decision | log2(bpm/truth) distribution |', '|---|---|---|---|---|---|---|---|'];
  for (const s of scores) L.push(`| ${s.name} | ${s.n} | ${pct(s.within8)} | ${pct(s.octave)} | ${pct(s.folded)} | ${pct(s.decided)} | ${fmt(s.medianAt)} | ${errorSummary(s.errors)} |`);
  return L;
}

function report(rows: SongRow[], scores: Score[], allScores: Score[], libScores: { voice: Score[]; backing: Score[] } | null, libSeconds: number | null): string {
  const confirmed = rows.filter(r => r.confirmed);
  const L: string[] = [];
  L.push('# Tempo from a solo voice', '');
  L.push(`Generated by \`npm run bench:tempo\` on ${new Date().toISOString().slice(0, 10)}. ${rows.length} stitched MIR-1K songs (consecutive clips of one singer singing one song, ~30 s each); truth = the backing track's tempo measured from the left channel, confirmed on ${confirmed.length} songs (a hand-established bpm agrees, or a majority of the reference libraries on the backing agree, or the tempogram has no runner-up above 0.8 of the winner). Scores below are over the confirmed songs; the all-songs table follows. Each method decides online, asked every 0.5 s from 3 s to ${DECISION_SEC} s; its decision is the first estimate whose confidence clears the method's threshold, or its last estimate at ${DECISION_SEC} s.`, '');
  L.push('## Methods on the solo voice (confirmed truth)', '', ...scoreTable(scores), '');
  L.push('## Methods on the solo voice (all songs, unconfirmed truth included)', '', ...scoreTable(allScores), '');
  if (libScores) {
    L.push(`## Reference libraries (first ${libSeconds} s of the voice; full backing track as the sanity check)`, '', '### Solo voice', '', ...scoreTable(libScores.voice), '', '### Backing track', '', ...scoreTable(libScores.backing), '');
  } else {
    L.push('## Reference libraries', '', 'Not run: `bench/tempo/out/libs.json` is missing. Run `bench/tempo/.venv/bin/python bench/tempo/libs.py` after this bench has written `out/wav/`, then rerun with `--fast`.', '');
  }
  L.push('## Per song', '', `| song | s | clips | truth bpm | known | truth peaks | ambiguity | confirmed | onsets ≤12 s | notes ≤12 s | ${METHODS.map(m => m.name.split(',')[0].split(' (')[0]).join(' | ')} |`, `|${'---|'.repeat(11 + METHODS.length)}`);
  for (const r of rows) L.push(`| ${r.name} | ${fmt(r.dur)} | ${r.clips} | ${fmt(r.truth, 0)} | ${r.known ?? '—'} | ${r.peaks.join(', ')} | ${fmt(r.ambiguity, 2)} | ${r.confirmed ? 'yes' : 'no'} | ${r.onsets} | ${r.notes} | ${METHODS.map(m => { const d = r.decisions[m.name]; return d.bpm === null ? '—' : `${fmt(d.bpm, 0)}${within8(d.bpm, r.truth) ? ' ✓' : withinOctave(d.bpm, r.truth) ? ' ~' : ''} (${fmt(d.confidence, 2)}${d.at !== null ? ` @${fmt(d.at, 1)}s` : ''})`; }).join(' | ')} |`);
  L.push('', '✓ within 8% of the truth, ~ within 8% of its exact half or double. Confidence in parentheses, with the decision time when the threshold was cleared before 12 s.', '');
  return L.join('\n');
}

if (!process.argv.includes('--no-main')) {
  const fast = process.argv.includes('--fast');
  const limitArg = process.argv.find(a => a.startsWith('--limit='));
  const { scores, libScores } = run({ fast, limit: limitArg ? Number(limitArg.split('=')[1]) : undefined });
  console.log('\n' + scoreTable(scores).join('\n'));
  if (libScores) console.log('\nlibraries, voice:\n' + scoreTable(libScores.voice).join('\n') + '\nlibraries, backing:\n' + scoreTable(libScores.backing).join('\n'));
}
