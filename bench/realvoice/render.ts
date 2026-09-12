/**
 * Renders a band note list with fluidsynth and mixes it under the raw voice with ffmpeg.
 * Voice at -3 dB, band at -9 dB, so the singer stays in front the way the app's own mix does.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SR } from '../voice/synth';
import { writeWav } from './wav';
import { writeMidi, type BandNote } from './midi';

const SOUNDFONTS = ['/usr/share/sounds/sf2/FluidR3_GM.sf2', '/usr/share/sounds/sf2/default-GM.sf2', '/usr/share/sounds/sf2/TimGM6mb.sf2'];

function run(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.status !== 0) {
    console.error(`${cmd} failed: ${r.stderr?.toString().slice(-400)}`);
    return false;
  }
  return true;
}

export function toolsAvailable(): boolean {
  const have = (c: string) => spawnSync('which', [c]).status === 0;
  return have('fluidsynth') && have('ffmpeg') && SOUNDFONTS.some(existsSync);
}

/** Writes <outDir>/<name>.mp3; returns the path or null when rendering failed. */
export function renderMix(outDir: string, name: string, voice: Float32Array, band: BandNote[], bpm: number): string | null {
  mkdirSync(outDir, { recursive: true });
  const sf2 = SOUNDFONTS.find(existsSync);
  if (!sf2) return null;
  const mid = join(outDir, `${name}.band.mid`);
  const bandWav = join(outDir, `${name}.band.wav`);
  const voiceWav = join(outDir, `${name}.voice.wav`);
  const mp3 = join(outDir, `${name}.mp3`);
  writeMidi(mid, band, bpm);
  writeWav(voiceWav, SR, [voice]);
  if (!run('fluidsynth', ['-ni', '-q', '-g', '0.7', '-r', String(SR), '-F', bandWav, sf2, mid])) return null;
  const ok = run('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', voiceWav, '-i', bandWav,
    '-filter_complex', '[0:a]volume=-3dB,aformat=channel_layouts=stereo[v];[1:a]volume=-9dB,aformat=channel_layouts=stereo[b];[v][b]amix=inputs=2:duration=first:normalize=0[m]',
    '-map', '[m]', '-c:a', 'libmp3lame', '-q:a', '2', mp3,
  ]);
  for (const f of [mid, bandWav, voiceWav]) rmSync(f, { force: true });
  return ok ? mp3 : null;
}
