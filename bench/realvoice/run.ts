/**
 * Real-voice bench: amateur singers from MIR-1K (raw vocal channel, no processing) replayed
 * through the real Listener / PitchTracker / OnsetDetector, scored against the dataset's
 * hand-labelled pitch, then the band the Patterns engine would play over the resulting chord
 * timeline is scored against what was actually sung and rendered to listenable mixes.
 *
 * Needs the dataset unpacked under bench/realvoice/data/MIR-1K/ (see dataset.ts); needs
 * fluidsynth + ffmpeg + a GM soundfont for the mixes (skipped, with a note, when absent).
 *
 * Run with: npm run bench:realvoice
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { VOICE_PROFILE } from '../../src/listener/pitchTracker';
import { detectKey } from '../../src/listener/keyDetector';
import { tonicTriad } from '../../src/listener/chordDetector';
import { keyName } from '../../src/music/scales';
import type { Key } from '../../src/types';
import { runClip } from '../voice/driver';
import { median, noteSegmentation } from '../voice/metrics';
import { CLIPS, SONGS, datasetPresent, labelAt, labelNotes, labelPitchClassWeights, loadClip, loadSong, type RealClip } from './dataset';
import { KEY_PLAUSIBLE_COVERAGE, accompanimentTempo, bestCoveringKey, intonation, labelPitchAccuracy, scaleCoverage } from './metrics';
import { chordTimeline, driveBand, scoreFit, type BandPlan } from './fit';
import { renderMix, toolsAvailable } from './render';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, 'out');
const FALLBACK_BPM = 90;
const CREATIVITY = 0.5;

const fmt = (n: number | null | undefined, d = 1) => (n === null || n === undefined || Number.isNaN(n)) ? '—' : n.toFixed(d);
const pct = (n: number | null | undefined) => (n === null || n === undefined || Number.isNaN(n)) ? '—' : (100 * n).toFixed(0) + '%';

interface InputRow {
  clip: string; sex: string; dur: number; pitchAcc: number; octave: number; silent: number; other: number;
  f1: number; p: number; r: number; truthNotes: number; detNotes: number; latencyMs: number | null;
  keyLockS: number | null; keyName: string; keyCov: number; keyPlausible: string; labelKey: string; labelKeyCov: number;
  tempoLockS: number | null; bpm: number | null; accompBpm: number | null; offCents: number; offPct: number;
}

function inputRow(clip: RealClip): InputRow {
  const r = runClip(clip.audio, VOICE_PROFILE);
  const acc = labelPitchAccuracy(r.rawFrames, clip.labels);
  const truth = labelNotes(clip.labels);
  const seg = noteSegmentation(r.detectedNotes, truth);
  const lat = median(seg.latencies.filter(l => l >= 0));
  const w = labelPitchClassWeights(clip.labels);
  const best = bestCoveringKey(w);
  const keyCov = r.key ? scaleCoverage(w, r.key) : NaN;
  const into = intonation(clip.labels);
  return {
    clip: clip.name, sex: clip.sex, dur: clip.durationSec,
    pitchAcc: acc.accuratePct, octave: acc.octaveErrorPct, silent: acc.silentPct, other: acc.otherErrorPct,
    f1: seg.f1, p: seg.precision, r: seg.recall, truthNotes: truth.length, detNotes: r.detectedNotes.length,
    latencyMs: lat === null ? null : lat * 1000,
    keyLockS: r.keyLockT, keyName: r.key ? keyName(r.key) : '—', keyCov,
    keyPlausible: r.key ? (keyCov >= KEY_PLAUSIBLE_COVERAGE ? 'yes' : 'no') : '—',
    labelKey: keyName(best.key), labelKeyCov: best.coverage,
    tempoLockS: r.tempoLockT, bpm: r.bpm, accompBpm: accompanimentTempo(clip.accomp), offCents: into.medianCents, offPct: into.offPct,
  };
}

function mean(xs: number[]): number { const v = xs.filter(x => !Number.isNaN(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; }

interface FitRow {
  song: string; dur: number; bpm: number | null; usedBpm: number; accompBpm: number | null; offCents: number; keyUsed: string; labelKey: string; labelKeyCov: number;
  follow: ReturnType<typeof scoreFit>; static: ReturnType<typeof scoreFit>; mp3: string | null; mp3Static: string | null;
}

function fitRow(song: RealClip, render: boolean): FitRow {
  // pass 1: let the listener find a tempo and key on its own
  const first = runClip(song.audio, VOICE_PROFILE);
  const bpm = first.bpm ?? FALLBACK_BPM;
  const barSec = (60 / bpm) * 4;
  const downbeat = first.downbeat ?? 0;
  const t0 = downbeat - Math.floor(downbeat / barSec) * barSec;
  // pass 2: the app's clock ticks chords every half bar at that tempo
  const r = runClip(song.audio, VOICE_PROFILE, { bpm, t0 });
  const w = labelPitchClassWeights(song.labels);
  const labelKey = detectKey(w).key;
  const best = bestCoveringKey(w);
  const key: Key = r.key ?? labelKey;
  const sung = labelNotes(song.labels);
  // These are all mic-only singers (that's the whole point of the bench): the band's chord
  // and key came from the voice, not a keyboard, so comping keeps plain triads, sits below
  // the singer's range, and steers around the sung pitch class at each half bar.
  const sungPitchClassAt = (t: number): number | undefined => {
    const m = labelAt(song.labels, t);
    return m === null ? undefined : ((Math.round(m) % 12) + 12) % 12;
  };
  const base: Omit<BandPlan, 'chordAt'> = { bpm, t0, key, durationSec: song.durationSec, beats: r.beats, creativity: CREATIVITY, seed: 7, source: 'mic', sungPitchClassAt };
  const followPlan: BandPlan = { ...base, chordAt: chordTimeline(r, key) };
  const staticPlan: BandPlan = { ...base, chordAt: () => tonicTriad(key) };
  const followBand = driveBand(followPlan);
  const staticBand = driveBand(staticPlan);
  return {
    song: song.name, dur: song.durationSec, bpm: first.bpm, usedBpm: bpm, accompBpm: accompanimentTempo(song.accomp), offCents: intonation(song.labels).medianCents, keyUsed: keyName(key) + (r.key ? '' : ' (label, no lock)'),
    labelKey: keyName(labelKey), labelKeyCov: best.coverage,
    follow: scoreFit(followPlan, followBand, song.labels, sung, labelKey),
    static: scoreFit(staticPlan, staticBand, song.labels, sung, labelKey),
    mp3: render ? renderMix(OUT_DIR, song.name, song.audio, followBand, bpm) : null,
    mp3Static: render && song.name === SONGS[0].name ? renderMix(OUT_DIR, `${song.name}.static-tonic`, song.audio, staticBand, bpm) : null,
  };
}

function main() {
  if (!datasetPresent()) {
    console.error('MIR-1K not found under bench/realvoice/data/MIR-1K/ — see bench/realvoice/dataset.ts');
    process.exit(1);
  }
  const render = toolsAvailable();
  if (!render) console.error('fluidsynth/ffmpeg/soundfont missing: mixes will be skipped');

  const rows = CLIPS.map(name => inputRow(loadClip(name)));
  const fits = SONGS.map(s => fitRow(loadSong(s), render));

  const L: string[] = [];
  L.push('# Real-voice bench results (MIR-1K amateur singers)');
  L.push('');
  L.push(`Generated ${new Date().toISOString().slice(0, 10)} by bench/realvoice/run.ts. ${CLIPS.length} clips, ${new Set(rows.map(r => r.clip.split('_')[0])).size} singers (${rows.filter(r => r.sex === 'f').length} clips female range, ${rows.filter(r => r.sex === 'm').length} male range), raw vocal channel, no processing, VOICE_PROFILE.`);
  L.push('');
  L.push('## Input: pitch, notes, key, tempo');
  L.push('');
  L.push('| clip | range | s | off-key cents (median) | pitch acc % | octave err % | no pitch % | other err % | note F1 | P | R | notes (label/det) | latency ms | key lock s | key | key plausible | label key (cov) | tempo lock s | bpm | backing bpm |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    L.push(`| ${r.clip} | ${r.sex} | ${fmt(r.dur)} | ${fmt(r.offCents, 0)} | ${fmt(r.pitchAcc)} | ${fmt(r.octave)} | ${fmt(r.silent)} | ${fmt(r.other)} | ${fmt(r.f1, 2)} | ${fmt(r.p, 2)} | ${fmt(r.r, 2)} | ${r.truthNotes}/${r.detNotes} | ${fmt(r.latencyMs, 0)} | ${fmt(r.keyLockS, 2)} | ${r.keyName} | ${r.keyPlausible} | ${r.labelKey} (${pct(r.labelKeyCov)}) | ${fmt(r.tempoLockS, 2)} | ${fmt(r.bpm, 0)} | ${fmt(r.accompBpm, 0)} |`);
  }
  const keyLocked = rows.filter(r => r.keyLockS !== null);
  const tempoLocked = rows.filter(r => r.tempoLockS !== null);
  L.push('');
  L.push(`Means: pitch acc ${fmt(mean(rows.map(r => r.pitchAcc)))}%, octave err ${fmt(mean(rows.map(r => r.octave)))}%, no pitch ${fmt(mean(rows.map(r => r.silent)))}%, note F1 ${fmt(mean(rows.map(r => r.f1)), 2)} (P ${fmt(mean(rows.map(r => r.p)), 2)}, R ${fmt(mean(rows.map(r => r.r)), 2)}), median latency ${fmt(median(rows.map(r => r.latencyMs).filter((x): x is number => x !== null)), 0)} ms. Key locked on ${keyLocked.length}/${rows.length} clips (median ${fmt(median(keyLocked.map(r => r.keyLockS!)), 1)} s), plausible on ${rows.filter(r => r.keyPlausible === 'yes').length}. Tempo locked on ${tempoLocked.length}/${rows.length} clips; of those, ${tempoLocked.filter(r => r.accompBpm !== null && Math.abs(r.bpm! / r.accompBpm - 1) < 0.08).length} within 8% of the backing track's bpm, ${tempoLocked.filter(r => r.accompBpm !== null && (Math.abs(r.bpm! / r.accompBpm - 2) < 0.16 || Math.abs(r.bpm! / r.accompBpm - 0.5) < 0.04)).length} at double or half of it. Median off-key distance of the labelled pitch from the nearest semitone: ${fmt(median(rows.map(r => r.offCents)), 0)} cents; ${fmt(mean(rows.map(r => r.offPct)), 0)}% of voiced frames are more than 30 cents from any semitone.`);
  L.push('');
  L.push('Female-range clips: pitch acc ' + fmt(mean(rows.filter(r => r.sex === 'f').map(r => r.pitchAcc))) + '%, note F1 ' + fmt(mean(rows.filter(r => r.sex === 'f').map(r => r.f1)), 2) + '. Male-range clips: pitch acc ' + fmt(mean(rows.filter(r => r.sex === 'm').map(r => r.pitchAcc))) + '%, note F1 ' + fmt(mean(rows.filter(r => r.sex === 'm').map(r => r.f1)), 2) + '.');
  L.push('');
  L.push('## Fit: the band over four stitched ~30 s songs (lofi, creativity 0.5)');
  L.push('');
  L.push('| song | s | detected bpm | backing bpm | key used | label key (cov) | sung pitch in band chord: following | static tonic | best diatonic triad per half bar | band notes in label key: following | static | dissonant half bars: following (bass / keys) | static (bass / keys) | chord changes |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const f of fits) {
    L.push(`| ${f.song} | ${fmt(f.dur)} | ${f.bpm === null ? `none (used ${FALLBACK_BPM})` : fmt(f.bpm, 0)} | ${fmt(f.accompBpm, 0)} | ${f.keyUsed} | ${f.labelKey} (${pct(f.labelKeyCov)}) | ${pct(f.follow.sungChordToneCoverage)} | ${pct(f.static.sungChordToneCoverage)} | ${pct(f.follow.oracleCoverage)} | ${pct(f.follow.bandInKey)} | ${pct(f.static.bandInKey)} | ${pct(f.follow.dissonantHalves)} (${pct(f.follow.dissonantBass)} / ${pct(f.follow.dissonantKeys)}), ${f.follow.scoredHalves} scored | ${pct(f.static.dissonantHalves)} (${pct(f.static.dissonantBass)} / ${pct(f.static.dissonantKeys)}) | ${f.follow.chordChanges} |`);
  }
  L.push('');
  L.push('Chord per bar, following band:');
  L.push('');
  for (const f of fits) L.push(`- ${f.song}: ${f.follow.timeline}`);
  L.push('');
  L.push('## Mixes');
  L.push('');
  if (render) {
    for (const f of fits) {
      if (f.mp3) L.push(`- ${f.mp3}`);
      if (f.mp3Static) L.push(`- ${f.mp3Static} (static-tonic baseline)`);
    }
    L.push('');
    L.push('Raw voice at -3 dB over the fluidsynth-rendered band at -9 dB; not in git.');
  } else {
    L.push('Not rendered on this run (fluidsynth / ffmpeg / GM soundfont missing).');
  }
  L.push('');
  L.push(...NOTES);
  const md = L.join('\n');
  console.log(md);
  writeFileSync(join(__dirname, 'RESULTS.md'), md);
}

/** Plain-language reading of the numbers above; kept with the script so a rerun keeps them together. */
const NOTES: string[] = [
  '## What the real voices showed',
  '',
  'The pitch detector itself is not the problem. On 24 raw amateur recordings the McLeod estimate is within 50 cents of the hand label on 92% of voiced frames, with 0.1% octave errors and 1.2% frames returning nothing. That is better than the synthetic bench (87-90%), because real vibrato is narrower than the 50-cent synthetic one. The weakest clips belong to the pitchiest singer (abjones, median 30 cents off the nearest semitone): 67-82% accurate, with the misses being slides and scoops between notes, not octave jumps.',
  '',
  'Note segmentation is worse than on synthetic voices: F1 0.60 against 0.78-0.94, and the drop is almost all precision (0.53). The tracker emits about 1.4 notes for every note the labels imply; the extra ones are the intermediate semitones a real voice passes through while sliding or settling, which the synthetic portamento (60 ms) never produced. Recall (0.72) and latency (110 ms median, versus 125-157 ms synthetic) are fine.',
  '',
  'Key detection mostly does not happen. It locked on 12 of 24 clips and on only 2 of the 4 thirty-second songs; of the 12 locks only 2 name a key whose scale holds 85% of what was sung. This is not the detector being slow: the labels themselves, fed straight into the same Krumhansl profiles, reach the 0.6 confidence KeyDetector requires on only 9 of 24 clips, and the best-fitting major or minor scale covers 85% of the sung pitch classes on only 5 of 24. The median sung pitch is 22 cents off the nearest semitone and 41% of voiced frames are more than 30 cents off, so when pitches are rounded to semitones a large share of the energy lands on chromatic neighbours of the intended notes, and the pitch-class histogram stops looking like any key. Splitting each frame\'s weight between its two neighbouring semitones instead of rounding makes it worse (3 of 24 reach 0.6). Lowering the threshold to 0.45 would lock all four songs within 2 s, but leon_8 would lock on G# minor where the labels say E major, so the threshold is not the lever; a coverage-based acceptance (most of the last two bars inside one scale, tonic weighted) is what needs benching.',
  '',
  'Tempo from a solo voice is syllable rate, not beat rate. TempoLock reported a bpm on 17 of 24 clips, typically after 4-6 s, but on three of the four songs it is 1.5-1.9 times the backing track the singer was actually following (174 vs 117, 139 vs 84, 165 vs 87); only leon_8 (144 vs 148) matched. The per-clip backing bpm is an autocorrelation estimate over 5-12 s and is itself octave-ambiguous, so use the song rows for this. The synthetic bench could not show this because its notes sat exactly on the beat.',
  '',
  'Chord following does not separate from a static tonic on these singers. Sung pitch inside the band\'s chord is 36-45% following and 36-45% static; the best diatonic triad per half bar (an oracle that knows the labels) only reaches 48-59%, so even perfect half-bar harmonization would leave half of what was sung outside the chord. On the two songs with no key lock the band holds one chord for the whole song (0 changes), which is what a listener in the app would hear as the band not reacting at all.',
  '',
  'The dissonance was in the keys, and the lofi colour caused it: with the chord/key coming from a keyboard-shaped `colorChord` and a comping register that ignored the singer, 65-94% of half bars had a keys note a minor second or tritone from a sung note sounding at the same time (bass alone was already 19-39%). Fixed: when the fit runs with `source: \'mic\'` (this bench now does, since these are all mic-only singers), `colorChord` leaves every genre as a plain triad instead of maj7/min7/dom7, `chordPattern` (src/patterns/toolkit.ts) caps the keys register at ctx.keysHigh (60, below a typical sung range) instead of the octave-derived ceiling, and drops any keys note a semitone or tritone from ctx.sungPitchClass (the singer\'s pitch class, sampled every beat here) at that hit. Keys dissonance drops to 15/19/6/28% on the four songs -- three under the 25% target, leon_8 still over. leon_8 holds one fixed chord (no key lock, 0 changes) whose only chord tone inside the narrow octave-4 register below the 60 ceiling is a single pitch class; the per-hit filter avoids it at the sampled instant, but the note then sustains for up to two beats and a real singer\'s pitch keeps moving underneath it, so some overlap survives even with per-beat sampling. A genuine fix there needs either a wider comping register below the ceiling (tried: widening it to a full 23-semitone window below 60 gave the voicing more chord tones to choose from, but also more simultaneous voices and pushed dissonance up across all four songs, so it was reverted) or shorter keys note durations under a mic singer, neither applied here. "Sung pitch in band chord" is unchanged (still scored against the always-coloured chord, since that measures the harmonic function the band is thinking in, not the mic-aware voicing) -- not worse, as intended.',
  '',
  'On the mixes: the voice is mixed 6 dB above the band as the app does, so the clashes are audible but not dominant; the amy_15 pair (following vs static tonic) is the direct A/B, and they sound almost the same, which is what the table says.',
  '',
  '## What the columns mean',
  '',
  '**Pitch acc %**: 50 ms analysis windows, on frames the MIR-1K label marks as voiced, where the raw McLeod estimate lands within 50 cents of the labelled pitch. **Octave err %**: the miss is an octave up or down. **No pitch %**: the detector returned nothing (below its RMS floor or no clear period). **Other err %**: everything else, mostly frames where the singer is sliding between notes, or the estimate landed on a fifth or a formant.',
  '',
  '**Note F1 / P / R**: notes derived from the labels (a run of at least 120 ms within ±50 cents of one semitone) matched against the notes the PitchTracker emitted, same midi and within 400 ms of the labelled start, each used once. "notes (label/det)" is how many notes the labels imply versus how many the tracker emitted. **Latency ms**: median delay from labelled note start to the matched detection.',
  '',
  '**Key lock s / key / key plausible**: when KeyDetector first reported a key, what it was, and whether that key\'s scale contains at least 85% of the labelled pitch classes weighted by duration. **Label key (cov)**: the major/minor scale that covers the most of the sung pitch classes, and how much it covers; a low value there means the singer is not in any one key (or is off by more than 50 cents a lot of the time), so no detector can be "right".',
  '',
  '**Tempo lock s / bpm**: when TempoLock (12 onsets, or the 8 s provisional path) first reported a bpm, and what it was. There is no ground-truth tempo in MIR-1K; the singers sang to a karaoke track that is not in the vocal channel.',
  '',
  '**Fit table**: each song runs through the listener twice, once to find a tempo and key, once with chord ticks every half bar at that tempo; the lofi pattern bank is then driven bar by bar over the resulting chord timeline (coloured to maj7/min7 the way the bandleader does), with the listener\'s own dynamics. "Sung pitch in band chord" is the share of voiced label frames whose pitch class is a tone of the chord the band held in that half bar. "Band notes in label key" is the share of bass/keys/lead notes in the scale that best covers the labels. "Dissonant half bars" is the share of half bars (with both a sustained sung note and a bass or keys note) where some bass/keys note is a minor second or tritone against a sung note sounding at the same time. "Static tonic" is the same band told to hold the tonic chord of the same key for the whole song.',
];

main();
