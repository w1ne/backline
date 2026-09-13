/**
 * Parameter sweep for the tempogram method over the cached streams and truths written by
 * `npm run bench:tempo`. Prints one line per variant, sorted by "within 8% or octave".
 * Run with: npx vite-node bench/tempo/explore.ts
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { KNOWN_BPM } from './songs';
import { combine, durationCluster, ioiNoteOnsets, tempogramMethod, type TempoMethod, type TempogramOptions, type VoiceStreams } from './methods';
import { decide, score, within8 } from './run';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, 'out');

export function loadCached(): { name: string; truth: number; confirmed: boolean; s: VoiceStreams }[] {
  const libs = existsSync(join(OUT_DIR, 'libs.json')) ? JSON.parse(readFileSync(join(OUT_DIR, 'libs.json'), 'utf8')) : null;
  return readdirSync(join(OUT_DIR, 'truth')).filter(f => f.endsWith('.json')).map(f => {
    const name = f.slice(0, -5);
    const t = JSON.parse(readFileSync(join(OUT_DIR, 'truth', f), 'utf8'));
    const j = JSON.parse(readFileSync(join(OUT_DIR, 'streams', f), 'utf8'));
    const lib = libs?.songs[name]?.backing;
    const libBpms: number[] = lib ? Object.values(lib).map((r: any) => r.bpm).filter((b: unknown) => typeof b === 'number') : [];
    const known = KNOWN_BPM[name];
    const confirmed = known ? within8(t.bpm, known) : libBpms.length ? libBpms.filter(b => within8(b, t.bpm)).length * 2 >= libBpms.length : t.ambiguity < 0.8;
    return { name, truth: t.bpm, confirmed, s: { ...j, flux: Float32Array.from(j.flux), level: Float32Array.from(j.level) } };
  });
}

if (!process.argv.includes('--no-main')) {
  const songs = loadCached().filter(s => s.confirmed);
  console.log(`${songs.length} confirmed songs`);
  const variants: { name: string; m: TempoMethod; thr: number }[] = [];
  for (const envelope of ['flux', 'flux+notes', 'notes'] as const)
    for (const harmonic of [0, 0.5, 1])
      for (const windowSec of [8, 12])
        for (const priorBpm of [90, 100])
          for (const priorOctaves of [0.4, 0.6])
            for (const noteOctave of [false, true])
              for (const fold of [false, true]) {
                const o: TempogramOptions = { envelope, harmonic, windowSec, minWindowSec: Math.min(8, windowSec), priorBpm, priorOctaves, noteOctave, fold };
                variants.push({ name: JSON.stringify(o), m: tempogramMethod(o), thr: 0.3 });
              }
  for (const sigma of [0.08, 0.12, 0.2]) for (const priorBpm of [90, 100]) variants.push({ name: `cluster ${JSON.stringify({ sigma, priorBpm })}`, m: durationCluster({ sigma, priorBpm }), thr: 0.3 });
  const rows = variants.map(v => {
    const sc = score(v.name, songs.map(x => ({ truth: x.truth, d: decide(v.m, x.s, v.thr) })));
    return { ...sc, thr: v.thr };
  }).sort((a, b) => b.octave - a.octave || b.within8 - a.within8);
  for (const r of rows.slice(0, 40)) console.log(`${(100 * r.within8).toFixed(0).padStart(3)}% 8%  ${(100 * r.octave).toFixed(0).padStart(3)}% oct  decided ${(100 * r.decided).toFixed(0).padStart(3)}%  med ${r.medianAt?.toFixed(1)}  ${r.name}`);
}
