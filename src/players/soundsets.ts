import * as Tone from 'tone';
import type { Genre, Instrument } from '../types';

export interface SoundSet {
  drums: {
    kick: Tone.MembraneSynth;
    snare: Tone.NoiseSynth;
    hat: Tone.MetalSynth;
    openHat: Tone.MetalSynth;
    crash: Tone.MetalSynth;
  };
  bass: Tone.MonoSynth;
  keys: Tone.PolySynth;
  lead: Tone.Synth;
  dispose(): void;
}

/** Where each instrument's synths land: one node per instrument, so a single instrument
 *  can be re-routed (main / morph / both) without touching the others. */
export type SoundOuts = Record<Instrument, Tone.ToneAudioNode>;

export function makeSoundSet(genre: Genre, outs: SoundOuts): SoundSet {
  const out = outs.drums;
  const kick = new Tone.MembraneSynth({ pitchDecay: 0.04, octaves: 6 }).connect(out);
  const snare = new Tone.NoiseSynth({
    noise: { type: genre === 'lofi' ? 'brown' : 'white' },
    envelope: { attack: 0.001, decay: 0.15, sustain: 0 },
  }).connect(out);
  const mkHat = (decay: number) =>
    new Tone.MetalSynth({
      envelope: { attack: 0.001, decay, release: 0.01 },
      harmonicity: 5.1,
      modulationIndex: 32,
      resonance: 4000,
      octaves: 1.5,
    }).connect(out);
  const bass = new Tone.MonoSynth({
    oscillator: { type: genre === 'funk' ? 'sawtooth' : 'triangle' },
    filter: { Q: 2, frequency: 400 },
    envelope: { attack: 0.01, decay: 0.2, sustain: 0.6, release: 0.2 },
  }).connect(outs.bass);
  const keys = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: genre === 'rock' ? 'sawtooth' : 'sine' },
    envelope: { attack: 0.02, decay: 0.3, sustain: 0.4, release: 0.6 },
  }).connect(outs.keys);
  const lead = new Tone.Synth({
    oscillator: { type: genre === 'jazz' ? 'sine' : 'square' },
    envelope: { attack: 0.02, release: 0.3 },
  }).connect(outs.lead);
  const set = {
    drums: { kick, snare, hat: mkHat(0.05), openHat: mkHat(0.3), crash: mkHat(1.2) },
    bass,
    keys,
    lead,
    dispose() {
      [kick, snare, set.drums.hat, set.drums.openHat, set.drums.crash, bass, keys, lead].forEach((n) =>
        n.dispose(),
      );
    },
  };
  return set;
}
