import * as Tone from 'tone';
import { PI_EDITION } from '../device/profile';
import { LOCAL_SOUNDS } from '../device/arturia';
import { ElectricPiano, Mellotron, Soundfont, SplendidGrandPiano } from 'smplr';

/** One entry in the keyboard-sound menu. */
export interface SoundDef {
  id: string;
  label: string;
  group: string;
  kind: 'grand' | 'ep' | 'mellotron' | 'soundfont' | 'synth';
  name?: string;
}

const sf = (id: string, label: string, group: string, name = id): SoundDef => ({ id, label, group, kind: 'soundfont', name });
const tron = (id: string, label: string, name: string): SoundDef => ({ id, label, group: 'Mellotron', kind: 'mellotron', name });

/** Curated keyboard sounds, grouped for the <select>. */
export const SOUNDS: readonly SoundDef[] = [
  sf('acoustic_grand_piano', 'Acoustic piano', 'Keys'),
  sf('electric_piano_1', 'Electric piano', 'Keys'),
  { id: 'grand', label: 'Grand piano', group: 'Keys', kind: 'grand' },
  { id: 'wurlitzer', label: 'Wurlitzer EP', group: 'Keys', kind: 'ep', name: 'WurlitzerEP200' },
  { id: 'cp80', label: 'CP-80 electric grand', group: 'Keys', kind: 'ep', name: 'CP80' },
  sf('clavinet', 'Clavinet', 'Keys'),
  sf('drawbar_organ', 'Hammond organ', 'Keys'),
  sf('rock_organ', 'Rock organ', 'Keys'),
  tron('tron_violins', 'MkII violins', 'MKII VIOLINS'),
  tron('tron_cello', 'Cello', 'TRON CELLO'),
  tron('tron_flute', 'Flute', 'TRON FLUTE'),
  tron('tron_choir', '8-voice choir', '8VOICE CHOIR'),
  tron('tron_brass', 'MkII brass', 'MKII BRASS'),
  tron('tron_sax', 'MkII sax', 'MKII SAX'),
  sf('violin', 'Violin', 'Orchestra'),
  sf('viola', 'Viola', 'Orchestra'),
  sf('cello', 'Cello', 'Orchestra'),
  sf('string_ensemble_1', 'String ensemble', 'Orchestra'),
  sf('pizzicato_strings', 'Pizzicato strings', 'Orchestra'),
  sf('orchestral_harp', 'Harp', 'Orchestra'),
  sf('flute', 'Flute', 'Orchestra'),
  sf('clarinet', 'Clarinet', 'Orchestra'),
  sf('oboe', 'Oboe', 'Orchestra'),
  sf('french_horn', 'French horn', 'Orchestra'),
  sf('alto_sax', 'Alto sax', 'Band'),
  sf('tenor_sax', 'Tenor sax', 'Band'),
  sf('trumpet', 'Trumpet', 'Band'),
  sf('trombone', 'Trombone', 'Band'),
  sf('harmonica', 'Harmonica', 'Band'),
  sf('acoustic_guitar_nylon', 'Nylon guitar', 'Guitars'),
  sf('acoustic_guitar_steel', 'Steel guitar', 'Guitars'),
  sf('electric_guitar_clean', 'Clean electric', 'Guitars'),
  sf('electric_guitar_jazz', 'Jazz guitar', 'Guitars'),
  sf('overdriven_guitar', 'Overdriven guitar', 'Guitars'),
  sf('vibraphone', 'Vibraphone', 'Mallets'),
  sf('marimba', 'Marimba', 'Mallets'),
  sf('kalimba', 'Kalimba', 'Mallets'),
  sf('lead_2_sawtooth', 'Saw lead', 'Synths'),
  sf('lead_1_square', 'Square lead', 'Synths'),
  sf('pad_2_warm', 'Warm pad', 'Synths'),
  sf('pad_3_polysynth', 'Polysynth pad', 'Synths'),
  sf('synth_brass_1', 'Synth brass', 'Synths'),
  sf('synth_strings_1', 'Synth strings', 'Synths'),
  sf('choir_aahs', 'Choir aahs', 'Synths'),
  ...[['synth_soft', 'Soft keys'], ['synth_bell', 'Bell keys'], ['synth_pluck', 'Pluck'], ['synth_pad', 'Warm pad'], ['synth_square', 'Square lead']].map(([id, label]): SoundDef => ({ id, label, group: 'Offline synths', kind: 'synth' })),
  { id: 'synth', label: 'Fat saw (built-in)', group: 'Synths', kind: 'synth' },
];
export const SOUND_GROUPS = [...new Set(SOUNDS.map(s => s.group))];
export const DEFAULT_SOUND = 'grand';
export type MonitorSound = string;
export function soundDef(id: MonitorSound): SoundDef {
  return SOUNDS.find(s => s.id === id) ?? SOUNDS[0];
}

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

function sampled(ctx: AudioContext, def: SoundDef): Voice {
  const opts = { destination: ctx.destination, volume: 75 };
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

function synth(id = 'synth'): Voice {
  const soft = id === 'synth_soft';
  const bell = id === 'synth_bell';
  const pluck = id === 'synth_pluck';
  const pad = id === 'synth_pad';
  const s = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: soft || bell ? 'sine' : pluck || pad ? 'triangle' : id === 'synth_square' ? 'square' : 'fatsawtooth', count: 3, spread: 20 },
    envelope: { attack: pad ? 0.2 : 0.01, decay: bell ? 1.2 : pluck ? 0.18 : 0.2, sustain: bell || pluck ? 0 : 0.5, release: pad ? 1.2 : 0.4 },
    volume: -10,
  }).toDestination();
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
  ) {}

  async start() {
    const lifecycle = this.lifecycle;
    await this.setSound(this.sound);
    if (lifecycle !== this.lifecycle) return;
    this.access = await navigator.requestMIDIAccess();
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
      }
    };
    this.access.addEventListener('statechange', this.stateHandler);
  }

  private load(sound: MonitorSound): Voice {
    let voice = this.voices.get(sound);
    if (!voice) {
      const def = soundDef(sound);
      voice = def.kind === 'synth' ? synth(def.id) : sampled(this.ctx, def);
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
