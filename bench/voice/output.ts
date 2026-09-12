/**
 * Output side of the voice bench: does the harmony the band will play relate to
 * what was sung? The band voices every bar against the listener's chord reading
 * (Patterns via chordAt, AMT as the chord it sends upstream), falling back to the
 * key's tonic triad. So the question reduces to: over each bar, how many of the
 * sung notes are tones of the chord the band was holding, and how often does the
 * chord merely chase the last sung note?
 *
 * Run with: npm run bench:voice:output
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { VOICE_PROFILE } from '../../src/listener/pitchTracker';
import { chordName, chordTones, tonicTriad } from '../../src/listener/chordDetector';
import type { Chord } from '../../src/types';
import { buildClipAudio, buildClips } from './synth';
import { runClip } from './driver';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mod12 = (n: number) => ((n % 12) + 12) % 12;

interface BarScore { bar: number; chord: string; coverage: number; retro: number; chasing: boolean; truth?: string; hitInForce?: boolean; hitRetro?: boolean }

function scoreClip(name: string) {
  const spec = buildClips().find(c => c.truth.name === name)!;
  const audio = buildClipAudio(spec);
  const bpm = spec.truth.bpm ?? 90;
  const r = runClip(audio.audio, VOICE_PROFILE, { bpm, t0: spec.truth.notes[0].start });
  const barSec = (60 / bpm) * 4;
  const t0 = spec.truth.notes[0].start;
  const nBars = Math.ceil((spec.truth.durationSec - t0) / barSec);
  const key = r.key ?? spec.truth.key!;
  const chordAt = (t: number): Chord => {
    let c: Chord | null = null;
    for (const e of r.chords) { if (e.t <= t) c = e.chord; else break; }
    return c ?? tonicTriad(key);
  };
  const bars: BarScore[] = [];
  const staticTonic = tonicTriad(key);
  let staticCoverage = 0, followCoverage = 0, retroCoverage = 0, changes = 0, chased = 0, hitsInForce = 0, hitsRetro = 0;
  let prev = '';
  for (let b = 0; b < nBars; b++) {
    const start = t0 + b * barSec, end = start + barSec;
    const sung = spec.truth.notes.filter(n => n.start >= start && n.start < end);
    if (!sung.length) continue;
    const chord = chordAt(start);
    const tones = chordTones(chord);
    const cov = sung.filter(n => tones.includes(mod12(n.midi))).length / sung.length;
    const covStatic = sung.filter(n => chordTones(staticTonic).includes(mod12(n.midi))).length / sung.length;
    // retrospective: the chord decided at the END of this bar against what was sung in it —
    // what a listener hears as "the band caught my phrase", one half bar late
    const after = chordTones(chordAt(end + 0.01));
    const retro = sung.filter(n => after.includes(mod12(n.midi))).length / sung.length;
    // "chasing": the chord's root is simply the last note sung before the bar
    const before = spec.truth.notes.filter(n => n.start < start).pop();
    const chasing = !!before && mod12(before.midi) === mod12(chord.root) && chordName(chord) !== chordName(staticTonic);
    const name_ = chordName(chord);
    if (prev && name_ !== prev) changes++;
    prev = name_;
    if (chasing) chased++;
    followCoverage += cov; staticCoverage += covStatic; retroCoverage += retro;
    const truthChord = spec.truth.chords?.[b];
    const decided = chordAt(end + 0.01);
    const hitInForce = truthChord ? chordName(chord) === chordName(truthChord) : undefined;
    const hitRetro = truthChord ? chordName(decided) === chordName(truthChord) : undefined;
    if (hitInForce) hitsInForce++;
    if (hitRetro) hitsRetro++;
    bars.push({ bar: b + 1, chord: name_, coverage: cov, retro, chasing, truth: truthChord && chordName(truthChord), hitInForce, hitRetro });
  }
  // half-bar resolution: the chord is re-decided every two beats, so score what was in force per half bar
  let halfHits = 0, halves = 0;
  if (spec.truth.chords) {
    for (let b = 0; b < nBars; b++) for (const h of [0, 0.5]) {
      const t = t0 + (b + h) * barSec;
      if (t >= spec.truth.durationSec || !spec.truth.chords[b]) continue;
      halves++;
      if (chordName(chordAt(t + 0.01)) === chordName(spec.truth.chords[b])) halfHits++;
    }
  }
  const n = bars.length;
  return { name, bars, hasTruth: !!spec.truth.chords, accInForce: hitsInForce / n, accRetro: hitsRetro / n, accHalf: halves ? halfHits / halves : 0, retroCoverage: retroCoverage / n, followCoverage: followCoverage / n, staticCoverage: staticCoverage / n, changesPerBar: changes / n, chasedPct: (100 * chased) / n, chordEvents: r.chords.filter(c => c.chord).length };
}

const rows = ['melody-A2-root-low', 'melody-A3-root', 'melody-A4-root-high', 'arpeggio-Am-progression'].map(scoreClip);
let md = '| clip | coverage, chord in force during the bar | coverage, chord decided from the bar | coverage, static tonic | chord changes / bar | bars where chord root = last sung note | chord readings |\n|---|---|---|---|---|---|---|\n';
for (const r of rows) md += `| ${r.name} | ${(100 * r.followCoverage).toFixed(0)}% | ${(100 * r.retroCoverage).toFixed(0)}% | ${(100 * r.staticCoverage).toFixed(0)}% | ${r.changesPerBar.toFixed(2)} | ${r.chasedPct.toFixed(0)}% | ${r.chordEvents} |\n`;
md += '\nChord accuracy where the melody outlines a known progression:\n\n| clip | chord in force at bar start = truth | chord in force per half bar = truth | chord decided from the bar = truth |\n|---|---|---|---|\n';
for (const r of rows.filter(r => r.hasTruth)) md += `| ${r.name} | ${(100 * r.accInForce).toFixed(0)}% | ${(100 * r.accHalf).toFixed(0)}% | ${(100 * r.accRetro).toFixed(0)}% |\n`;
md += '\nPer-bar chords (following):\n\n';
for (const r of rows) md += `- ${r.name}: ${r.bars.map(b => `${b.chord}${b.chasing ? '*' : ''}`).join(' ')}${r.hasTruth ? `  (truth: ${r.bars.map(b => b.truth).join(' ')})` : ''}\n`;
md += '\n`*` = chord root equals the last note sung before the bar.\n';
console.log(md);
writeFileSync(join(__dirname, 'OUTPUT.md'), md);
