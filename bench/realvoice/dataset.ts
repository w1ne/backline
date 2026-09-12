/**
 * MIR-1K access for the real-voice bench. The dataset is not in git: download MIR-1K and
 * unpack `Wavfile/`, `PitchLabel/` and `UnvoicedFrameLabel/` under bench/realvoice/data/MIR-1K/.
 *
 * Each clip is a 16 kHz stereo WAV (left = karaoke accompaniment, right = the raw, unprocessed
 * voice of an amateur singer). PitchLabel/*.pv holds the sung pitch in MIDI semitones every
 * 20 ms (0 = unvoiced); the first frame is centred at 20 ms.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Note } from '../voice/synth';
import { SR } from '../voice/synth';
import { concat, readWav, resample } from './wav';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(__dirname, 'data', 'MIR-1K');
export const LABEL_HOP_SEC = 0.02;

export interface PitchLabel {
  /** seconds, centre of the 40 ms label frame */
  t: number;
  /** MIDI semitones (fractional); 0 when the frame is unvoiced */
  midi: number;
}

export interface RealClip {
  name: string;
  singer: string;
  /** 'f' | 'm': the singer's range, taken from the published MIR-1K singer list */
  sex: 'f' | 'm';
  /** raw voice channel at 48 kHz */
  audio: Float32Array;
  /** the karaoke accompaniment the singer heard (left channel), 48 kHz; only used to estimate the true tempo */
  accomp: Float32Array;
  durationSec: number;
  labels: PitchLabel[];
}

/** The 8 female / 11 male singers of MIR-1K as published by the dataset's authors. */
const FEMALE = new Set(['amy', 'Ani', 'annar', 'ariel', 'heycat', 'tammy', 'titon', 'yifen']);

/**
 * 24 clips, 12 singers (6 female, 6 male), two clips each from different songs, so the
 * numbers are not dominated by one voice or one tune.
 */
export const CLIPS: string[] = [
  'amy_4_01', 'amy_15_03',
  'Ani_1_01', 'Ani_4_02',
  'ariel_1_01', 'ariel_3_02',
  'heycat_2_01', 'heycat_4_01',
  'titon_1_01', 'titon_4_03',
  'yifen_1_01', 'yifen_3_02',
  'abjones_1_01', 'abjones_3_02',
  'davidson_1_01', 'davidson_3_02',
  'geniusturtle_4_01', 'geniusturtle_7_02',
  'jmzen_1_01', 'jmzen_3_02',
  'leon_1_01', 'leon_5_02',
  'Kenshin_1_01', 'Kenshin_5_03',
];

/** Four ~30 s "songs": consecutive clips of one singer singing one song, concatenated. */
export const SONGS: { name: string; clips: string[] }[] = [
  { name: 'amy_15', clips: ['amy_15_01', 'amy_15_02', 'amy_15_03', 'amy_15_04'] },
  { name: 'yifen_1', clips: ['yifen_1_01', 'yifen_1_02', 'yifen_1_03', 'yifen_1_04', 'yifen_1_05', 'yifen_1_06'] },
  { name: 'abjones_2', clips: ['abjones_2_01', 'abjones_2_02', 'abjones_2_03', 'abjones_2_04'] },
  { name: 'leon_8', clips: ['leon_8_01', 'leon_8_02', 'leon_8_03', 'leon_8_04', 'leon_8_05'] },
];

export function datasetPresent(): boolean {
  return existsSync(join(DATA_DIR, 'Wavfile'));
}

export function singerOf(name: string): string {
  return name.split('_')[0];
}

export function loadClip(name: string): RealClip {
  const wav = readWav(join(DATA_DIR, 'Wavfile', `${name}.wav`));
  const voice = wav.channels[1] ?? wav.channels[0];
  const audio = resample(voice, wav.sampleRate, SR);
  const accomp = resample(wav.channels[0], wav.sampleRate, SR);
  const pv = readFileSync(join(DATA_DIR, 'PitchLabel', `${name}.pv`), 'utf8').trim().split(/\r?\n/).map(Number);
  const labels: PitchLabel[] = pv.map((midi, i) => ({ t: LABEL_HOP_SEC * (i + 1), midi }));
  const singer = singerOf(name);
  return { name, singer, sex: FEMALE.has(singer) ? 'f' : 'm', audio, accomp, durationSec: audio.length / SR, labels };
}

/** Concatenates clips back to back; label times are shifted by the running duration. */
export function loadSong(song: { name: string; clips: string[] }): RealClip {
  const parts = song.clips.map(loadClip);
  let offset = 0;
  const labels: PitchLabel[] = [];
  for (const p of parts) {
    for (const l of p.labels) labels.push({ t: l.t + offset, midi: l.midi });
    offset += p.durationSec;
  }
  const audio = concat(parts.map(p => p.audio));
  const accomp = concat(parts.map(p => p.accomp));
  return { name: song.name, singer: parts[0].singer, sex: parts[0].sex, audio, accomp, durationSec: audio.length / SR, labels };
}

/**
 * Notes implied by the labels: a run of consecutive voiced frames that all round to the same
 * semitone (i.e. stay within ±50 cents of it) and last at least `minSec`.
 */
export function labelNotes(labels: PitchLabel[], minSec = 0.12): Note[] {
  const notes: Note[] = [];
  let runMidi: number | null = null;
  let runStart = 0;
  let runEnd = 0;
  const flush = () => {
    if (runMidi !== null && runEnd - runStart >= minSec - 1e-9) notes.push({ midi: runMidi, start: runStart, end: runEnd });
    runMidi = null;
  };
  for (const l of labels) {
    const m = l.midi > 0 ? Math.round(l.midi) : null;
    if (m === null) { flush(); continue; }
    if (runMidi === m) { runEnd = l.t + LABEL_HOP_SEC / 2; continue; }
    flush();
    runMidi = m;
    runStart = l.t - LABEL_HOP_SEC / 2;
    runEnd = l.t + LABEL_HOP_SEC / 2;
  }
  flush();
  return notes;
}

/** Duration-weighted pitch-class histogram of the voiced label frames. */
export function labelPitchClassWeights(labels: PitchLabel[]): number[] {
  const w = new Array(12).fill(0);
  for (const l of labels) if (l.midi > 0) w[((Math.round(l.midi) % 12) + 12) % 12] += LABEL_HOP_SEC;
  return w;
}

/** The labelled pitch at time t (nearest frame), or null if unvoiced / out of range. */
export function labelAt(labels: PitchLabel[], t: number): number | null {
  const i = Math.round(t / LABEL_HOP_SEC) - 1;
  if (i < 0 || i >= labels.length) return null;
  const m = labels[i].midi;
  return m > 0 ? m : null;
}
