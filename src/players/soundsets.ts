import * as Tone from 'tone';
import type { Genre, Instrument } from '../types';
import { makeSampledDrums, DEFAULT_DRUM_KIT, type DrumKit, type Voice } from './sampledVoices';

export interface SoundSet {
  drums: {
    kick: Voice;
    snare: Voice;
    hat: Voice;
    openHat: Voice;
    crash: Voice;
  };
  bass: Tone.MonoSynth;
  keys: Tone.PolySynth;
  lead: Tone.PluckSynth;
  dispose(): void;
}

/** Where each instrument's synths land: one node per instrument, so a single instrument
 *  can be re-routed (main / morph / both) without touching the others. */
export type SoundOuts = Record<Instrument, Tone.ToneAudioNode>;

/** A native GainNode wired into `out`'s Tone graph, for handing to a smplr instrument as
 *  its `destination` — smplr writes to a plain AudioNode, Tone nodes are not one. */
function nativeDestination(out: Tone.ToneAudioNode): { ctx: AudioContext; node: AudioNode } {
  const ctx = out.context.rawContext as unknown as AudioContext;
  const node = ctx.createGain();
  Tone.connect(node, out);
  return { ctx, node };
}

export function makeSoundSet(genre: Genre, outs: SoundOuts, drumKit: DrumKit = DEFAULT_DRUM_KIT): SoundSet {
  const out = outs.drums;
  const kickSynth = new Tone.MembraneSynth({ pitchDecay: 0.04, octaves: 6 }).connect(out);
  const snareSynth = new Tone.NoiseSynth({
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
  const hatSynth = mkHat(0.05);
  const openHatSynth = mkHat(0.3);
  const crashSynth = mkHat(1.2);
  const bass = new Tone.MonoSynth({
    oscillator: { type: genre === 'funk' ? 'sawtooth' : 'triangle' },
    filter: { Q: 2, frequency: 400 },
    envelope: { attack: 0.01, decay: 0.2, sustain: 0.6, release: 0.2 },
  }).connect(outs.bass);
  const keys = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: genre === 'rock' ? 'sawtooth' : 'sine' },
    envelope: { attack: 0.02, decay: 0.3, sustain: 0.4, release: 0.6 },
  }).connect(outs.keys);
  // Plucked/Karplus-Strong guitar tone: clean, longer resonance for lofi/jazz;
  // brighter attack noise and shorter sustain (more bite) for rock/funk.
  const lead = new Tone.PluckSynth(
    genre === 'rock' || genre === 'funk'
      ? { attackNoise: 4, dampening: 3000, resonance: 0.85, release: 0.4 }
      : { attackNoise: 1, dampening: 5000, resonance: 0.95, release: 1.2 },
  ).connect(outs.lead);

  // Sampled drums, falling back to the synths above until the kit has loaded from the CDN —
  // so the band is never silent while it fetches.
  const drumsOut = nativeDestination(out);
  const drums = makeSampledDrums(drumsOut.ctx, drumsOut.node, drumKit, {
    kick: kickSynth, snare: snareSynth, hat: hatSynth, openHat: openHatSynth, crash: crashSynth,
  });

  const set = {
    drums,
    bass,
    keys,
    lead,
    dispose() {
      [bass, keys, lead].forEach((n) => n.dispose());
      Object.values(drums).forEach(d => d.dispose());
    },
  };
  return set;
}
