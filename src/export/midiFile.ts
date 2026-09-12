/** Standard MIDI File (type 1) writer. No dependencies; every value is absolute seconds. */

export interface MidiNote { time: number; duration: number; note: number; velocity: number }
export interface MidiTrack { name: string; channel: number; notes: MidiNote[] }

export const PPQ = 480;

/** Serialise `tracks` at a fixed `bpm`. Track 0 carries the tempo, then one track per entry. */
export function encodeMidi(bpm: number, tracks: MidiTrack[]): Uint8Array {
  const chunks: number[][] = [];
  chunks.push(trackChunk([...vlq(0), 0xff, 0x51, 0x03, ...u24(Math.round(60_000_000 / bpm))]));
  for (const t of tracks) chunks.push(trackChunk(noteTrack(t, bpm)));
  const header = [
    ...ascii('MThd'), ...u32(6), ...u16(1), ...u16(chunks.length), ...u16(PPQ),
  ];
  return new Uint8Array([...header, ...chunks.flat()]);
}

function noteTrack(t: MidiTrack, bpm: number): number[] {
  const ch = Math.max(0, Math.min(15, t.channel)) & 0x0f;
  const name = new TextEncoder().encode(t.name);
  const out: number[] = [...vlq(0), 0xff, 0x03, ...vlq(name.length), ...name];
  const events: { tick: number; order: number; bytes: number[] }[] = [];
  for (const n of t.notes) {
    const note = Math.max(0, Math.min(127, Math.round(n.note)));
    const vel = Math.max(1, Math.min(127, Math.round(n.velocity * 127)));
    const on = ticks(n.time, bpm);
    const off = Math.max(on + 1, ticks(n.time + n.duration, bpm));
    events.push({ tick: off, order: 0, bytes: [0x80 | ch, note, 0] });
    events.push({ tick: on, order: 1, bytes: [0x90 | ch, note, vel] });
  }
  // note-offs before note-ons at the same tick so a repeated note retriggers
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  let last = 0;
  for (const e of events) { out.push(...vlq(e.tick - last), ...e.bytes); last = e.tick; }
  return out;
}

function ticks(sec: number, bpm: number): number { return Math.max(0, Math.round((sec * bpm / 60) * PPQ)); }
function trackChunk(body: number[]): number[] {
  const end = [...vlq(0), 0xff, 0x2f, 0x00];
  return [...ascii('MTrk'), ...u32(body.length + end.length), ...body, ...end];
}
function ascii(s: string): number[] { return [...s].map(c => c.charCodeAt(0)); }
function u16(n: number): number[] { return [(n >> 8) & 0xff, n & 0xff]; }
function u24(n: number): number[] { return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]; }
function u32(n: number): number[] { return [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]; }
function vlq(n: number): number[] {
  const out = [n & 0x7f];
  while ((n >>= 7) > 0) out.unshift((n & 0x7f) | 0x80);
  return out;
}
