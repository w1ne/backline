/**
 * Offline bench for the harmony layer: runs a couple of chord progressions through
 * voiceLead + colorChord for every genre and prints a table of voice movement, leaps,
 * distinct-voicing counts and the colored chord name. Run with: npm run bench:harmony
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Chord, Genre, Key } from '../../src/types';
import { GENRES } from '../../src/types';
import { voiceLead } from '../../src/music/voiceLeading';
import { colorChord } from '../../src/music/chordColor';
import { chordName } from '../../src/listener/chordDetector';

const __dirname = dirname(fileURLToPath(import.meta.url));

const RANGE = { low: 55, high: 76 };

const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const chordLabel = (c: Chord): string => `${NOTE[c.root]}${c.quality === 'maj' ? '' : c.quality === 'min' ? 'm' : c.quality}`;

interface Progression {
  name: string;
  key: Key;
  chords: Chord[];
}

const PROGRESSIONS: Progression[] = [
  {
    name: 'A minor (Am F C G Am Dm Em Am)',
    key: { root: 9, mode: 'minor' },
    chords: [
      { root: 9, quality: 'min' }, { root: 5, quality: 'maj' }, { root: 0, quality: 'maj' },
      { root: 7, quality: 'maj' }, { root: 9, quality: 'min' }, { root: 2, quality: 'min' },
      { root: 4, quality: 'min' }, { root: 9, quality: 'min' },
    ],
  },
  {
    name: 'Cmaj (C Am F G)',
    key: { root: 0, mode: 'major' },
    chords: [
      { root: 0, quality: 'maj' }, { root: 9, quality: 'min' }, { root: 5, quality: 'maj' }, { root: 7, quality: 'maj' },
    ],
  },
];

interface Row {
  progression: string;
  genre: Genre;
  change: string;
  totalMovement: number;
  maxLeap: number;
  distinctVoicings: number;
  coloredChord: string;
}

function fmtRow(r: Row): string {
  return `| ${r.progression} | ${r.genre} | ${r.change} | ${r.totalMovement} | ${r.maxLeap} | ${r.distinctVoicings} | ${r.coloredChord} |`;
}

export interface HarmonyBenchResult {
  rows: Row[];
  md: string;
}

export function run(): HarmonyBenchResult {
  const rows: Row[] = [];

  for (const prog of PROGRESSIONS) {
    for (const genre of GENRES) {
      let prev: number[] | null = null;
      let prevChordName = '';
      const seen = new Set<string>();
      let distinct = 0;
      let prevLabel: string | null = null;

      for (const rawChord of prog.chords) {
        const colored = colorChord(rawChord, genre, prog.key);
        const voicing = voiceLead(prev, colored, RANGE);
        const key = [...voicing].sort((a, b) => a - b).join(',');
        if (!seen.has(key)) { seen.add(key); distinct++; }

        let totalMovement = 0;
        let maxLeap = 0;
        if (prev) {
          const a = [...prev].sort((x, y) => x - y);
          const b = [...voicing].sort((x, y) => x - y);
          for (let i = 0; i < a.length; i++) {
            const d = Math.abs(a[i] - (b[i] ?? b[b.length - 1]));
            totalMovement += d;
            if (d > maxLeap) maxLeap = d;
          }
        }

        const label = chordLabel(rawChord);
        const change = prevLabel ? `${prevLabel}->${label}` : `(start) ${label}`;
        rows.push({
          progression: prog.name,
          genre,
          change,
          totalMovement,
          maxLeap,
          distinctVoicings: distinct,
          coloredChord: chordName(colored),
        });

        prev = voicing;
        prevLabel = label;
        prevChordName = chordName(colored);
      }
      void prevChordName;
    }
  }

  const header = '| progression | genre | chord change | total movement | max leap | distinct voicings | colored chord |';
  const sep = '|---|---|---|---|---|---|---|';
  const lines = [header, sep, ...rows.map(fmtRow)];
  const table = lines.join('\n');
  const md = `# Harmony bench results\n\n${table}\n`;
  return { rows, md };
}

function main() {
  const { md } = run();
  console.log(md);
  writeFileSync(join(__dirname, 'RESULTS.md'), md);
}

if (!process.env.BENCH_GATE) main();
