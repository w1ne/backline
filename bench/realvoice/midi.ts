/**
 * Tiny Standard MIDI File (type 0) writer so the band's offline notes can be rendered with
 * fluidsynth. No dependencies.
 */
import { writeFileSync } from 'node:fs';
import type { Instrument } from '../../src/types';

export interface BandNote {
  inst: Instrument;
  /** seconds from the start of the voice recording */
  t: number;
  durSec: number;
  note: number;
  velocity: number;
}

const CHANNEL: Record<Instrument, number> = { drums: 9, bass: 0, keys: 1, lead: 2 };
/** General MIDI programs: fingered bass, electric piano, vibraphone */
const PROGRAM: Partial<Record<Instrument, number>> = { bass: 33, keys: 4, lead: 11 };
const TPQ = 480;

function vlq(n: number): number[] {
  const out = [n & 0x7f];
  n >>= 7;
  while (n > 0) { out.unshift((n & 0x7f) | 0x80); n >>= 7; }
  return out;
}

export function writeMidi(path: string, notes: BandNote[], bpm: number): void {
  const spb = 60 / bpm;
  type Ev = { tick: number; bytes: number[]; order: number };
  const evs: Ev[] = [];
  const usPerBeat = Math.round(60_000_000 / bpm);
  evs.push({ tick: 0, bytes: [0xff, 0x51, 0x03, (usPerBeat >> 16) & 0xff, (usPerBeat >> 8) & 0xff, usPerBeat & 0xff], order: -2 });
  for (const inst of ['bass', 'keys', 'lead'] as Instrument[]) evs.push({ tick: 0, bytes: [0xc0 | CHANNEL[inst], PROGRAM[inst]!], order: -1 });
  for (const n of notes) {
    const ch = CHANNEL[n.inst];
    const on = Math.round((n.t / spb) * TPQ);
    const off = Math.max(on + 1, Math.round(((n.t + n.durSec) / spb) * TPQ));
    const vel = Math.max(1, Math.min(127, Math.round(n.velocity * 127)));
    evs.push({ tick: on, bytes: [0x90 | ch, n.note & 0x7f, vel], order: 1 });
    evs.push({ tick: off, bytes: [0x80 | ch, n.note & 0x7f, 0], order: 0 });
  }
  evs.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const body: number[] = [];
  let last = 0;
  for (const e of evs) { body.push(...vlq(e.tick - last), ...e.bytes); last = e.tick; }
  body.push(0x00, 0xff, 0x2f, 0x00);
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (TPQ >> 8) & 0xff, TPQ & 0xff];
  const trk = [0x4d, 0x54, 0x72, 0x6b, (body.length >>> 24) & 0xff, (body.length >>> 16) & 0xff, (body.length >>> 8) & 0xff, body.length & 0xff];
  writeFileSync(path, Buffer.from([...header, ...trk, ...body]));
}
