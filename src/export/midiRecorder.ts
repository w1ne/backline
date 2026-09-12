import type { Instrument, NoteEvent } from '../types';
import { INSTRUMENTS } from '../types';
import { encodeMidi, type MidiNote, type MidiTrack } from './midiFile';

/** A sung note has no note-off: it lasts until the next one, at most this long. */
export const MAX_SUNG_NOTE_SEC = 2;
const GM_DRUM_CHANNEL = 9;
const CHANNELS: Record<Instrument, number> = { drums: GM_DRUM_CHANNEL, bass: 1, keys: 2, lead: 3 };

/** Collects what the band scheduled and what the player sang/played, in absolute audio-clock
 *  seconds, and turns it into a type-1 MIDI file: track "You" first, then one per instrument. */
export class MidiRecorder {
  private band: Record<Instrument, MidiNote[]> = { drums: [], bass: [], keys: [], lead: [] };
  private you: { time: number; note: number; velocity: number }[] = [];
  private bpm: number | null = null;

  addBand(inst: Instrument, events: NoteEvent[], barStart: number, bpm: number): void {
    if (!(bpm > 0)) return;
    this.bpm ??= bpm;
    const spb = 60 / bpm;
    for (const e of events)
      this.band[inst].push({ time: barStart + e.time * spb, duration: e.duration * spb, note: e.note, velocity: e.velocity });
  }

  addYou(note: number, velocity: number, time: number): void {
    this.you.push({ time, note, velocity });
  }

  get empty(): boolean { return !this.you.length && INSTRUMENTS.every(i => !this.band[i].length); }

  /** Encode everything recorded so far; `bpm` overrides the first band bpm seen. */
  toMidi(bpm = this.bpm ?? 120): Uint8Array {
    const you = [...this.you].sort((a, b) => a.time - b.time);
    const yourNotes: MidiNote[] = you.map((n, i) => {
      const next = you[i + 1]?.time ?? Infinity;
      return { ...n, duration: Math.min(MAX_SUNG_NOTE_SEC, Math.max(0.05, next - n.time)) };
    });
    const all = [...yourNotes, ...INSTRUMENTS.flatMap(i => this.band[i])];
    const t0 = all.length ? Math.min(...all.map(n => n.time)) : 0;
    const shift = (ns: MidiNote[]) => ns.map(n => ({ ...n, time: n.time - t0 }));
    const tracks: MidiTrack[] = [{ name: 'You', channel: 0, notes: shift(yourNotes) }];
    for (const i of INSTRUMENTS)
      if (this.band[i].length) tracks.push({ name: i[0].toUpperCase() + i.slice(1), channel: CHANNELS[i], notes: shift(this.band[i]) });
    return encodeMidi(bpm, tracks);
  }

  reset(): void {
    this.band = { drums: [], bass: [], keys: [], lead: [] };
    this.you = [];
    this.bpm = null;
  }
}
