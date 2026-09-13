import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { OnsetDetector, FLUX_K, FLUX_LO_HZ, FLUX_HI_HZ } from './onset';
import { FFT_SIZE, HOP_SIZE, magnitudeSpectrum } from './fft';
import { estimateTempo } from './tempoLock';

const SR = 48000;
const BPM = 100;
const BEAT = 60 / BPM;

/** deterministic noise, so a flaky threshold cannot hide behind Math.random */
function rng(seed = 1): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Runs a 48 kHz signal through the detector exactly like the worklet would. */
function onsetsOf(x: Float32Array, d = new OnsetDetector()): number[] {
  const out: number[] = [];
  for (let i = 0; i + FFT_SIZE <= x.length; i += HOP_SIZE) {
    const mag = magnitudeSpectrum(x.slice(i, i + FFT_SIZE));
    const t = (i + FFT_SIZE / 2) / SR;
    if (d.process(mag, t)) out.push(d.lastOnsetTime);
  }
  return out;
}

const seconds = (s: number) => new Float32Array(Math.round(s * SR));
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** hats/pick attacks: decaying noise bursts on the beat */
function hits(count: number, gap = BEAT, amp = 0.5): Float32Array {
  const r = rng(7);
  const x = seconds(count * gap + 1);
  for (let k = 0; k < count; k++) {
    const start = Math.round((0.25 + k * gap) * SR);
    for (let n = 0; n < 0.2 * SR && start + n < x.length; n++) {
      x[start + n] += amp * Math.exp(-n / (0.03 * SR)) * (r() * 2 - 1);
    }
  }
  return x;
}

/**
 * Legato: one continuous band-limited sawtooth, constant amplitude, pitch
 * changing on the beat and nowhere near a gap or a level dip between notes.
 * `vib` adds 5 Hz vibrato, the thing that makes a held note wobble in the
 * spectrum without being a new note.
 */
function legato(notes: number[], gap = BEAT, amp = 0.3, vib = 0): Float32Array {
  const x = seconds(notes.length * gap + 1);
  let phase = 0;
  for (let n = 0; n < x.length; n++) {
    const t = n / SR;
    if (t < 0.25) continue;
    const idx = Math.min(notes.length - 1, Math.max(0, Math.floor((t - 0.25) / gap)));
    const f = hz(notes[idx]) * (1 + vib * Math.sin(2 * Math.PI * 5 * t));
    phase += f / SR;
    phase -= Math.floor(phase);
    let v = 0;
    for (let k = 1; k * f < 10000; k++) v += Math.sin(2 * Math.PI * k * phase) / k;
    x[n] = amp * v * 0.6;
  }
  return x;
}

function pinkNoise(sec: number, amp = 0.1, seed = 3): Float32Array {
  const x = seconds(sec);
  const r = rng(seed);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let n = 0; n < x.length; n++) {
    const w = r() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    x[n] = amp * (b0 + b1 + b2 + w * 0.1848) * 0.2;
  }
  return x;
}

/** tempo from the detected onsets, asserted to land within +/-2 bpm of `want` */
function expectTempo(onsets: number[], want: number): void {
  const est = estimateTempo(onsets);
  expect(est).not.toBeNull();
  expect(est!.bpm).toBeGreaterThan(want - 2);
  expect(est!.bpm).toBeLessThan(want + 2);
}

describe('OnsetDetector (spectral flux)', () => {
  it('finds 16 percussive hits at 100 bpm', () => {
    const onsets = onsetsOf(hits(16));
    expect(onsets.length).toBeGreaterThanOrEqual(15);
    expect(onsets.length).toBeLessThanOrEqual(17);
    expectTempo(onsets, 100);
  });

  it('finds legato note changes with no level dip between them', () => {
    const notes = [57, 60, 62, 64, 62, 60, 57, 59, 60, 64, 67, 65, 64, 62, 60, 59];
    const onsets = onsetsOf(legato(notes));
    expect(onsets.length).toBeGreaterThanOrEqual(14);
    expect(onsets.length).toBeLessThanOrEqual(18);
    expectTempo(onsets, 100);
  });

  it('does not re-fire on a single sustained note', () => {
    const onsets = onsetsOf(legato([60, 60, 60, 60, 60, 60, 60]));
    expect(onsets.length).toBeLessThanOrEqual(1);
  });

  it('does not mistake vibrato on a held note for new notes', () => {
    const onsets = onsetsOf(legato([60, 60, 60, 60, 60, 60, 60], BEAT, 0.3, 0.004));
    expect(onsets.length).toBeLessThanOrEqual(1);
  });

  it('stays silent on steady pink noise', () => {
    expect(onsetsOf(pinkNoise(4)).length).toBe(0);
  });

  it('keeps finding hits as the background noise rises', () => {
    const x = hits(16);
    const r = rng(11);
    const dur = x.length / SR;
    for (let n = 0; n < x.length; n++) {
      const ramp = 0.005 + 0.06 * (n / SR / dur);
      x[n] += ramp * (r() * 2 - 1);
    }
    const onsets = onsetsOf(x);
    expect(onsets.length).toBeGreaterThanOrEqual(14);
    expectTempo(onsets, 100);
  });

  it('honours the minimum gap between onsets', () => {
    const onsets = onsetsOf(hits(8, 0.04, 0.5));
    for (let i = 1; i < onsets.length; i++) expect(onsets[i] - onsets[i - 1]).toBeGreaterThanOrEqual(0.08);
  });

  it('keeps the worklet copy of the analysis constants in step', () => {
    const src = readFileSync(new URL('../../public/worklet/onset-processor.js', import.meta.url), 'utf8');
    expect(src).toContain(`const FFT_SIZE = ${FFT_SIZE}`);
    expect(src).toContain(`const HOP_SIZE = ${HOP_SIZE}`);
    expect(src).toContain(`const FLUX_K = ${FLUX_K}`);
    expect(src).toContain(`const FLUX_LO_HZ = ${FLUX_LO_HZ}`);
    expect(src).toContain(`const FLUX_HI_HZ = ${FLUX_HI_HZ}`);
  });
});
