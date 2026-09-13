/**
 * Stitched ~30 s solo-voice "songs" for the tempo bench: consecutive MIR-1K clips of one
 * singer singing one song (`<singer>_<song>_<nn>.wav`), concatenated in clip order until the
 * song is at least TARGET_SEC long. Every singer/song group in the dataset with enough material
 * becomes a song, so the bench is as wide as the dataset allows instead of four hand-picked ones.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, loadSong, type RealClip } from '../realvoice/dataset';

export const TARGET_SEC = 30;
/** songs shorter than this after stitching every clip are dropped */
export const MIN_SEC = 20;

/** Backing tempos established by hand (bench/realvoice/RESULTS.md); cross-checked against the measured truth. */
export const KNOWN_BPM: Record<string, number> = { amy_15: 117, yifen_1: 84, abjones_2: 87, leon_8: 148 };

export interface SongSpec { name: string; clips: string[] }

/** Clip names grouped by `<singer>_<song>`, each group in clip order. */
export function groupClips(names: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const n of names) {
    const m = /^(.+)_(\d+)$/.exec(n);
    if (!m) continue;
    const list = groups.get(m[1]) ?? [];
    list.push(n);
    groups.set(m[1], list);
  }
  for (const list of groups.values()) list.sort((a, b) => Number(a.split('_').pop()) - Number(b.split('_').pop()));
  return groups;
}

/** Lists every stitchable song in the dataset: consecutive clips until TARGET_SEC, groups under MIN_SEC dropped. */
export function listSongs(durationOf: (clip: string) => number, names = wavNames()): SongSpec[] {
  const out: SongSpec[] = [];
  for (const [name, clips] of groupClips(names)) {
    const take: string[] = [];
    let total = 0;
    for (const c of clips) {
      if (total >= TARGET_SEC) break;
      take.push(c);
      total += durationOf(c);
    }
    if (total >= MIN_SEC) out.push({ name, clips: take });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function wavNames(): string[] {
  return readdirSync(join(DATA_DIR, 'Wavfile')).filter(f => f.endsWith('.wav')).map(f => f.slice(0, -4));
}

export function loadStitched(spec: SongSpec): RealClip {
  return loadSong(spec);
}
