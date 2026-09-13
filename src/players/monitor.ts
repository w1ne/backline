import * as Tone from 'tone';
import { midiInputOptions } from '../listener/midiSource';
import { PI_EDITION } from '../device/profile';
import { LOCAL_SOUNDS } from '../device/arturia';
import { ElectricPiano, Mellotron, Soundfont, SplendidGrandPiano } from 'smplr';

import { soundDef, DEFAULT_SOUND, type SoundDef, type MonitorSound } from './soundCatalog';
export { SOUNDS, SOUND_GROUPS, DEFAULT_SOUND, soundDef, type SoundDef, type MonitorSound } from './soundCatalog';

/** Parsed note message, or null for anything that is not a note on/off. */
export function parseNote(data: Uint8Array): { note: number; velocity: number; on: boolean } | null {
  const [s, n, v] = data;
  const kind = s & 0xf0;
  if (kind === 0x90 && v > 0) return { note: n, velocity: v / 127, on: true };
  if (kind === 0x80 || (kind === 0x90 && v === 0)) return { note: n, velocity: 0, on: false };
  return null;
}

interface Voice {
  ready?: Promise<void>;
  noteOn(note: number, velocity: number): void;
  noteOff(note: number): void;
  dispose(): void;
}

/** Reverb send level into the shared plate bus, once connected. */
export const MONITOR_REVERB_SEND = 0.15;

/** A plain destination `AudioNode` wired into the band's master chain (dry) and reverb send,
 *  for handing to a smplr instrument, which writes to a raw AudioNode, not a Tone one. */
function routedDestination(ctx: AudioContext, masterInput: Tone.ToneAudioNode | AudioNode, reverbBus: Tone.ToneAudioNode | AudioNode, tap?: AudioNode): AudioNode {
  const node = ctx.createGain();
  Tone.connect(node, masterInput);
  if (tap) node.connect(tap);
  const send = ctx.createGain();
  send.gain.value = MONITOR_REVERB_SEND;
  node.connect(send);
  Tone.connect(send, reverbBus);
  return node;
}

function sampled(ctx: AudioContext, def: SoundDef, reverbBus?: Tone.ToneAudioNode | AudioNode, masterInput?: Tone.ToneAudioNode | AudioNode, tap?: AudioNode): Voice {
  const destination = masterInput && reverbBus ? routedDestination(ctx, masterInput, reverbBus, tap) : ctx.destination;
  const opts = { destination, volume: 75 };
  const inst =
    def.kind === 'grand'
      ? SplendidGrandPiano(ctx, PI_EDITION ? { ...opts, baseUrl: `${import.meta.env.BASE_URL}samples/grand`, formats: ['ogg'] } : opts)
      : def.kind === 'ep'
        ? ElectricPiano(ctx, { ...opts, instrument: def.name! })
        : def.kind === 'mellotron'
          ? Mellotron(ctx, { ...opts, instrument: def.name! })
          : Soundfont(ctx, PI_EDITION && LOCAL_SOUNDS.some(id => id === def.id)
            ? { ...opts, instrumentUrl: `${import.meta.env.BASE_URL}samples/${def.name}-mp3.js` }
            : { ...opts, instrument: def.name!, kit: 'MusyngKite' });
  return {
    ready: inst.ready,
    noteOn: (note, velocity) => inst.start({ note, velocity: Math.round(velocity * 127), stopId: note }),
    noteOff: note => inst.stop({ stopId: note }),
    dispose: () => inst.stop(),
  };
}

function synth(id = 'synth', reverbBus?: Tone.ToneAudioNode | AudioNode, masterInput?: Tone.ToneAudioNode | AudioNode, tap?: AudioNode): Voice {
  const soft = id === 'synth_soft';
  const bell = id === 'synth_bell';
  const pluck = id === 'synth_pluck';
  const pad = id === 'synth_pad';
  const s = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: soft || bell ? 'sine' : pluck || pad ? 'triangle' : id === 'synth_square' ? 'square' : 'fatsawtooth', count: 3, spread: 20 },
    envelope: { attack: pad ? 0.2 : 0.01, decay: bell ? 1.2 : pluck ? 0.18 : 0.2, sustain: bell || pluck ? 0 : 0.5, release: pad ? 1.2 : 0.4 },
    volume: -10,
  });
  if (tap) Tone.connect(s, tap);
  if (masterInput && reverbBus) {
    Tone.connect(s, masterInput);
    const send = new Tone.Gain(MONITOR_REVERB_SEND);
    s.connect(send);
    Tone.connect(send, reverbBus);
  } else {
    s.toDestination();
  }
  const f = (n: number) => Tone.Frequency(n, 'midi').toFrequency();
  return {
    noteOn: (n, v) => s.triggerAttack(f(n), Tone.immediate(), v),
    noteOff: n => s.triggerRelease(f(n), Tone.immediate()),
    dispose: () => {
      s.releaseAll();
      s.dispose();
    },
  };
}

/**
 * Plays the player's own MIDI notes through the app output, so a controller
 * with no sound of its own (e.g. an Arturia Minilab) is audible next to the band.
 */
export class MidiMonitor {
  onError?: (error: unknown) => void;
  private voice?: Voice;
  private voices = new Map<string, Voice>();
  private selection = 0;
  private lifecycle = 0;
  private held = new Set<number>();
  private access?: MIDIAccess;
  private handler?: (e: MIDIMessageEvent) => void;
  private stateHandler?: (e: MIDIConnectionEvent) => void;

  constructor(
    private ctx: AudioContext,
    private sound: MonitorSound = DEFAULT_SOUND,
    private reverbBus?: Tone.ToneAudioNode | AudioNode,
    private masterInput?: Tone.ToneAudioNode | AudioNode,
  ) {}

  private tapNode?: GainNode;
  private streamDest?: MediaStreamAudioDestinationNode;

  /** A silent side bus every keyboard voice also feeds, so the sound can be captured. */
  private tap(): AudioNode | undefined {
    if (!this.tapNode && typeof this.ctx.createGain === 'function') this.tapNode = this.ctx.createGain();
    return this.tapNode;
  }

  /** The keyboard sound as a MediaStream, so the band can follow what the player plays the
   *  same way it follows the mic. Undefined where the context cannot make one. */
  get stream(): MediaStream | undefined {
    if (this.streamDest) return this.streamDest.stream;
    const tap = this.tap();
    if (!tap || typeof this.ctx.createMediaStreamDestination !== 'function') return undefined;
    this.streamDest = this.ctx.createMediaStreamDestination();
    tap.connect(this.streamDest);
    return this.streamDest.stream;
  }

  async start() {
    const lifecycle = this.lifecycle;
    // A singer without a controller needs no keyboard samples. Explicit sound changes
    // and Pi preloading still use setSound/preload independently.
    if (typeof navigator.requestMIDIAccess !== 'function') return;
    // A denied Web MIDI permission simply means there is no controller to monitor.
    try { this.access = await navigator.requestMIDIAccess(); }
    catch { return; }
    if (lifecycle !== this.lifecycle) return;
    this.handler = e => {
      const m = parseNote(e.data!);
      if (!m || !this.voice) return;
      if (m.on) {
        this.held.add(m.note);
        this.voice.noteOn(m.note, m.velocity);
      } else {
        this.held.delete(m.note);
        this.voice.noteOff(m.note);
      }
    };
    this.access.inputs.forEach(i => i.addEventListener('midimessage', this.handler!));
    this.stateHandler = e => {
      const port = e.port;
      if (port && port.type === 'input' && port.state === 'connected') {
        (port as MIDIInput).addEventListener('midimessage', this.handler!);
        if (midiInputOptions([port as MIDIInput]).length) {
          void this.setSound(this.sound).catch(error => this.onError?.(error));
        }
      }
    };
    this.access.addEventListener('statechange', this.stateHandler);
    const inputs: MIDIInput[] = [];
    this.access.inputs.forEach(input => inputs.push(input));
    if (midiInputOptions(inputs).length) await this.setSound(this.sound);
  }

  private load(sound: MonitorSound): Voice {
    let voice = this.voices.get(sound);
    if (!voice) {
      const def = soundDef(sound);
      voice = def.kind === 'synth' ? synth(def.id, this.reverbBus, this.masterInput, this.tap()) : sampled(this.ctx, def, this.reverbBus, this.masterInput, this.tap());
      this.voices.set(sound, voice);
    }
    return voice;
  }

  async preload(sounds: readonly string[]) {
    const generation = this.lifecycle;
    for (const sound of sounds) {
      if (generation !== this.lifecycle) return;
      await this.load(sound).ready;
    }
  }

  async setSound(sound: MonitorSound) {
    const generation = ++this.selection;
    const next = this.load(sound);
    try { await next.ready; }
    catch (error) { this.voices.delete(sound); throw error; }
    if (generation !== this.selection) return;
    if (next === this.voice) return;
    this.held.forEach(note => this.voice?.noteOff(note));
    // Sampled voices remain cached; stop their notes without discarding buffers.
    if (this.voice && this.sound && soundDef(this.sound).kind !== 'synth') this.voice.dispose();
    this.held.clear();
    this.sound = sound;
    this.voice = next;
  }

  stop() {
    ++this.lifecycle;
    ++this.selection;
    this.access?.inputs.forEach(i => i.removeEventListener('midimessage', this.handler!));
    if (this.stateHandler) this.access?.removeEventListener('statechange', this.stateHandler);
    this.voices.forEach(voice => voice.dispose());
    this.voices.clear();
    this.voice = undefined;
    this.held.clear();
  }
}
