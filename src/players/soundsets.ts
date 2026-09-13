import * as Tone from 'tone';
import type { Genre, Instrument } from '../types';
import { makeSampledBass, makeSampledDrums, makeSampledKeys, makeSampledLead, DEFAULT_DRUM_KIT, type DrumKit, type Voice } from './sampledVoices';

export interface SoundSet {
  drums: {
    kick: Voice;
    snare: Voice;
    hat: Voice;
    openHat: Voice;
    crash: Voice;
  };
  bass: Voice;
  keys: Voice;
  lead: Voice;
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

/** Cuts sub-rumble under the bass's own low end without touching it -- below this, a note is
 *  felt as mud, not pitch. */
export const BASS_HIGHPASS_HZ = 32;

/** Deliberate per-instrument balance, so loudness is a choice rather than whatever each
 *  synth/sample library's raw output happens to be. Modest on purpose -- a starting point to
 *  tune by ear, not a remix. */
export const INSTRUMENT_TRIM_DB: Record<Instrument, number> = { drums: 0, bass: -1.5, keys: -1, lead: -2 };

/** Where an instrument's own voices actually connect: the trim (and, for bass, a highpass
 *  ahead of it) sits between the synths/samples and the real output bus, so both the synth
 *  fallback and the sampled voice get it for free without either knowing it's there.
 *  `input` is what to `.connect()` voices to; `dispose()` tears down every node this made. */
function instrumentBus(inst: Instrument, dest: Tone.ToneAudioNode): { input: Tone.ToneAudioNode; dispose(): void } {
  const trim = new Tone.Gain(Tone.dbToGain(INSTRUMENT_TRIM_DB[inst]));
  trim.connect(dest);
  if (inst !== 'bass') return { input: trim, dispose: () => trim.dispose() };
  const hpf = new Tone.Filter(BASS_HIGHPASS_HZ, 'highpass');
  hpf.connect(trim);
  return { input: hpf, dispose: () => { hpf.dispose(); trim.dispose(); } };
}

export function makeSoundSet(genre: Genre, outs: SoundOuts, drumKit: DrumKit = DEFAULT_DRUM_KIT): SoundSet {
  const drumsBus = instrumentBus('drums', outs.drums);
  const bassBus = instrumentBus('bass', outs.bass);
  const keysBus = instrumentBus('keys', outs.keys);
  const leadBus = instrumentBus('lead', outs.lead);

  const kickSynth = new Tone.MembraneSynth({ pitchDecay: 0.04, octaves: 6 }).connect(drumsBus.input);
  const snareSynth = new Tone.NoiseSynth({
    noise: { type: genre === 'lofi' ? 'brown' : 'white' },
    envelope: { attack: 0.001, decay: 0.15, sustain: 0 },
  }).connect(drumsBus.input);
  const mkHat = (decay: number) =>
    new Tone.MetalSynth({
      envelope: { attack: 0.001, decay, release: 0.01 },
      harmonicity: 5.1,
      modulationIndex: 32,
      resonance: 4000,
      octaves: 1.5,
    }).connect(drumsBus.input);
  const hatSynth = mkHat(0.05);
  const openHatSynth = mkHat(0.3);
  const crashSynth = mkHat(1.2);
  const bassSynth = new Tone.MonoSynth({
    oscillator: { type: genre === 'funk' ? 'sawtooth' : 'triangle' },
    filter: { Q: 2, frequency: 400 },
    envelope: { attack: 0.01, decay: 0.2, sustain: 0.6, release: 0.2 },
  }).connect(bassBus.input);
  const keysSynth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: genre === 'rock' ? 'sawtooth' : 'sine' },
    envelope: { attack: 0.02, decay: 0.3, sustain: 0.4, release: 0.6 },
  }).connect(keysBus.input);
  // Plucked/Karplus-Strong guitar tone: clean, longer resonance for lofi/jazz;
  // brighter attack noise and shorter sustain (more bite) for rock/funk.
  const leadSynth = new Tone.PluckSynth(
    genre === 'rock' || genre === 'funk'
      ? { attackNoise: 4, dampening: 3000, resonance: 0.85, release: 0.4 }
      : { attackNoise: 1, dampening: 5000, resonance: 0.95, release: 1.2 },
  ).connect(leadBus.input);

  // Sampled instruments, each falling back to the synth above until it has loaded from the
  // CDN — so the band is never silent while a kit/soundfont fetches.
  const drumsOut = nativeDestination(drumsBus.input);
  const drums = makeSampledDrums(drumsOut.ctx, drumsOut.node, drumKit, {
    kick: kickSynth, snare: snareSynth, hat: hatSynth, openHat: openHatSynth, crash: crashSynth,
  });
  const bassOut = nativeDestination(bassBus.input);
  const bass = makeSampledBass(bassOut.ctx, bassOut.node, bassSynth);
  const keysOut = nativeDestination(keysBus.input);
  // Chords are simultaneous triggerAttackRelease calls on the same voice; the sampled
  // electric piano supports that directly (each call starts an independent sample).
  const keysFallback: Voice = {
    triggerAttackRelease: (...a: unknown[]) =>
      keysSynth.triggerAttackRelease(a[0] as never, a[1] as number, a[2] as number, a[3] as number),
    dispose: () => keysSynth.dispose(),
  };
  const keys = makeSampledKeys(keysOut.ctx, keysOut.node, keysFallback);
  const leadOut = nativeDestination(leadBus.input);
  const leadFallback: Voice = {
    triggerAttackRelease: (...a: unknown[]) =>
      leadSynth.triggerAttackRelease(a[0] as never, a[1] as number, a[2] as number, a[3] as number),
    dispose: () => leadSynth.dispose(),
  };
  const lead = makeSampledLead(leadOut.ctx, leadOut.node, leadFallback);

  const set = {
    drums,
    bass,
    keys,
    lead,
    dispose() {
      Object.values(drums).forEach(d => d.dispose());
      bass.dispose();
      keys.dispose();
      lead.dispose();
      drumsBus.dispose();
      bassBus.dispose();
      keysBus.dispose();
      leadBus.dispose();
    },
  };
  return set;
}
