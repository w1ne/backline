import * as Tone from 'tone';
import { DrumMachine, ElectricPiano, Soundfont } from 'smplr';
import type { DRUM } from '../types';

/** A voice good enough for Players.hit()/schedule(): same call shape as a Tone mono/poly
 *  synth, so it drops into SoundSet without Players.ts caring whether it is synthesized
 *  or sampled. */
export interface Voice {
  triggerAttackRelease(...args: unknown[]): void;
  dispose(): void;
}

export type DrumKit = 'acoustic' | 'electronic';
export const DEFAULT_DRUM_KIT: DrumKit = 'acoustic';
/** smplr ships these under smpldsnds.github.io/drum-machines; LM-2 (Linndrum) is built
 *  from sampled acoustic drums and is the closest "natural kit" smplr's DrumMachine offers,
 *  TR-808 is the classic all-electronic alternative. */
const KIT_NAME: Record<DrumKit, string> = { acoustic: 'LM-2', electronic: 'TR-808' };

type DrumName = keyof typeof DRUM;
/** Each kit's sample-group name for our five drum roles (see dm.json manifests). */
const GROUP: Record<DrumKit, Record<DrumName, string>> = {
  acoustic: { kick: 'kick', snare: 'snare', hat: 'hhclosed', openHat: 'hhopen', crash: 'crash' },
  electronic: { kick: 'kick', snare: 'snare', hat: 'hihat-close', openHat: 'hihat-open', crash: 'cymbal' },
};

type DrumMachineInstance = ReturnType<typeof DrumMachine>;
type SoundfontInstance = ReturnType<typeof Soundfont>;

/** Each wrapper owns its scheduled voices, while sample buffers remain cached. */
class SampleHandles {
  private active = new Set<{ stop?: () => void }>();
  start(play: (onEnded: () => void) => () => void): void {
    const handle: { stop?: () => void } = {};
    this.active.add(handle);
    try { handle.stop = play(() => this.active.delete(handle)); }
    catch (error) { this.active.delete(handle); throw error; }
  }
  stop(): void {
    for (const handle of this.active) handle.stop?.();
    this.active.clear();
  }
}

/** One DrumMachine instrument per (context, kit): fetching its sample manifest and buffers
 *  is expensive, so genre/route changes that recreate the SoundSet must reuse it rather than
 *  re-fetching the kit from the CDN every time. */
const drumMachineCache = new WeakMap<AudioContext, Map<DrumKit, DrumMachineInstance>>();

function getDrumMachine(ctx: AudioContext, kit: DrumKit, destination: AudioNode): DrumMachineInstance {
  let byKit = drumMachineCache.get(ctx);
  if (!byKit) {
    byKit = new Map();
    drumMachineCache.set(ctx, byKit);
  }
  let dm = byKit.get(kit);
  if (!dm) {
    dm = DrumMachine(ctx, { instrument: KIT_NAME[kit], destination });
    byKit.set(kit, dm);
  }
  return dm;
}

/** One Soundfont/ElectricPiano instrument per (context, id), same reuse rationale. */
const melodicCache = new WeakMap<AudioContext, Map<string, SoundfontInstance>>();

function getMelodic(ctx: AudioContext, id: string, make: () => SoundfontInstance): SoundfontInstance {
  let byId = melodicCache.get(ctx);
  if (!byId) {
    byId = new Map();
    melodicCache.set(ctx, byId);
  }
  let inst = byId.get(id);
  if (!inst) {
    inst = make();
    byId.set(id, inst);
  }
  return inst;
}

/** A drum voice: plays `fallback` (the existing synth) until the sampled kit is ready, then
 *  switches to sampled hits. Mirrors Players.hit()'s call shape, which varies per drum
 *  (kick/snare/hat/openHat/crash each pass different leading args) but always ends in
 *  (..., time, velocity). */
class SampledDrumVoice implements Voice {
  private ready = false;
  private handles = new SampleHandles();
  constructor(
    private dm: DrumMachineInstance,
    private group: string,
    private fallback: Voice,
  ) {
    dm.ready.then(() => { this.ready = true; }).catch(() => undefined);
  }
  triggerAttackRelease(...args: unknown[]): void {
    if (!this.ready) {
      this.fallback.triggerAttackRelease(...args);
      return;
    }
    const time = args[args.length - 2] as number;
    const velocity = (args[args.length - 1] as number) ?? 1;
    this.handles.start(onEnded => this.dm.start({ note: this.group, time, velocity: Math.max(1, Math.round(velocity * 127)), onEnded }));
  }
  dispose(): void {
    this.handles.stop();
    this.fallback.dispose();
  }
}

/** A melodic voice (bass/keys): (note, duration, time, velocity), `note` given as a
 *  frequency in Hz — the same value Players.schedule() already hands the Tone synths —
 *  converted back to a MIDI note for the sampled instrument. */
class SampledMelodicVoice implements Voice {
  private ready = false;
  private handles = new SampleHandles();
  constructor(
    private inst: SoundfontInstance,
    private fallback: Voice,
  ) {
    inst.ready.then(() => { this.ready = true; }).catch(() => undefined);
  }
  triggerAttackRelease(note: number, duration: number, time: number, velocity = 1): void {
    if (!this.ready) {
      this.fallback.triggerAttackRelease(note, duration, time, velocity);
      return;
    }
    const midi = Tone.Frequency(note).toMidi();
    this.handles.start(onEnded => this.inst.start({ note: midi, time, duration, velocity: Math.max(1, Math.round(velocity * 127)), onEnded }));
  }
  dispose(): void {
    this.handles.stop();
    this.fallback.dispose();
  }
}

/** Builds the five sampled drum voices sharing one DrumMachine instrument, each falling
 *  back to the matching synth voice (built by `fallback`) until the kit loads. */
export function makeSampledDrums(
  ctx: AudioContext,
  destination: AudioNode,
  kit: DrumKit,
  fallback: Record<DrumName, Voice>,
): Record<DrumName, Voice> {
  const dm = getDrumMachine(ctx, kit, destination);
  const group = GROUP[kit];
  const names: DrumName[] = ['kick', 'snare', 'hat', 'openHat', 'crash'];
  return Object.fromEntries(
    names.map(name => [name, new SampledDrumVoice(dm, group[name], fallback[name])]),
  ) as unknown as Record<DrumName, Voice>;
}

export function makeSampledBass(ctx: AudioContext, destination: AudioNode, fallback: Voice): Voice {
  const inst = getMelodic(ctx, 'bass:electric_bass_finger', () =>
    Soundfont(ctx, { instrument: 'electric_bass_finger', destination }));
  return new SampledMelodicVoice(inst, fallback);
}

export function makeSampledKeys(ctx: AudioContext, destination: AudioNode, fallback: Voice): Voice {
  const inst = getMelodic(ctx, 'keys:WurlitzerEP200', () =>
    ElectricPiano(ctx, { instrument: 'WurlitzerEP200', destination }) as unknown as SoundfontInstance);
  return new SampledMelodicVoice(inst, fallback);
}

/** Nylon guitar: warm and expressive, sits above the electric piano without a synth's edge. */
export function makeSampledLead(ctx: AudioContext, destination: AudioNode, fallback: Voice): Voice {
  const inst = getMelodic(ctx, 'lead:acoustic_guitar_nylon', () =>
    Soundfont(ctx, { instrument: 'acoustic_guitar_nylon', destination }));
  return new SampledMelodicVoice(inst, fallback);
}
