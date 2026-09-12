import { describe, expect, it } from 'vitest';
import { encodeMidi, PPQ } from './midiFile';
import { MidiRecorder, MAX_SUNG_NOTE_SEC } from './midiRecorder';

/** Minimal SMF reader: returns tracks as lists of {tick, status, data}. */
function parse(bytes: Uint8Array) {
  let p = 0;
  const str = (n: number) => String.fromCharCode(...bytes.slice(p, (p += n)));
  const u32 = () => (bytes[p++] << 24 | bytes[p++] << 16 | bytes[p++] << 8 | bytes[p++]) >>> 0;
  const u16 = () => bytes[p++] << 8 | bytes[p++];
  const vlq = () => { let v = 0, b; do { b = bytes[p++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
  expect(str(4)).toBe('MThd'); expect(u32()).toBe(6);
  const format = u16(), ntracks = u16(), ppq = u16();
  const tracks = [];
  for (let i = 0; i < ntracks; i++) {
    expect(str(4)).toBe('MTrk');
    const end = p + 4 + u32();
    const evs: { tick: number; status: number; data: number[] }[] = [];
    let tick = 0;
    while (p < end) {
      tick += vlq();
      const status = bytes[p++];
      if (status === 0xff) { const type = bytes[p++]; const len = vlq(); evs.push({ tick, status: 0xff00 | type, data: [...bytes.slice(p, p + len)] }); p += len; }
      else evs.push({ tick, status, data: [bytes[p++], bytes[p++]] });
    }
    expect(p).toBe(end);
    tracks.push(evs);
  }
  expect(p).toBe(bytes.length);
  return { format, ppq, tracks };
}

describe('encodeMidi', () => {
  it('writes a type-1 file with tempo track and correctly timed notes', () => {
    const bytes = encodeMidi(120, [{ name: 'Lead', channel: 3, notes: [
      { time: 0.5, duration: 0.5, note: 60, velocity: 1 },
      { time: 0, duration: 0.25, note: 62, velocity: 0.5 },
    ] }]);
    const f = parse(bytes);
    expect(f.format).toBe(1); expect(f.ppq).toBe(PPQ); expect(f.tracks).toHaveLength(2);
    const tempo = f.tracks[0].find(e => e.status === 0xff51)!;
    expect((tempo.data[0] << 16 | tempo.data[1] << 8 | tempo.data[2])).toBe(500_000);
    const name = f.tracks[1].find(e => e.status === 0xff03)!;
    expect(String.fromCharCode(...name.data)).toBe('Lead');
    const notes = f.tracks[1].filter(e => e.status < 0xff);
    expect(notes).toEqual([
      { tick: 0, status: 0x93, data: [62, 64] },
      { tick: 240, status: 0x83, data: [62, 0] },
      { tick: 480, status: 0x93, data: [60, 127] },
      { tick: 960, status: 0x83, data: [60, 0] },
    ]);
  });

  it('puts note-off before a retrigger of the same note at the same tick', () => {
    const f = parse(encodeMidi(120, [{ name: 'x', channel: 0, notes: [
      { time: 0, duration: 0.5, note: 60, velocity: 1 }, { time: 0.5, duration: 0.5, note: 60, velocity: 1 },
    ] }]));
    const s = f.tracks[1].filter(e => e.status < 0xff).map(e => e.status);
    expect(s).toEqual([0x90, 0x80, 0x90, 0x80]);
  });
});

describe('MidiRecorder', () => {
  it('starts empty and reports emptiness', () => {
    const r = new MidiRecorder();
    expect(r.empty).toBe(true);
    r.addYou(60, 0.8, 10);
    expect(r.empty).toBe(false);
    r.reset();
    expect(r.empty).toBe(true);
  });

  it('shifts to the first event, maps drums to channel 10, and ends sung notes at the next one', () => {
    const r = new MidiRecorder();
    r.addBand('drums', [{ time: 0, duration: 0.25, note: 36, velocity: 1 }], 100, 120);
    r.addYou(60, 0.8, 100.5);
    r.addYou(64, 0.8, 101);
    r.addYou(67, 0.8, 110);
    const f = parse(r.toMidi());
    const names = f.tracks.slice(1).map(t => String.fromCharCode(...t.find(e => e.status === 0xff03)!.data));
    expect(names).toEqual(['You', 'Drums']);
    const you = f.tracks[1].filter(e => e.status < 0xff);
    expect(you[0]).toEqual({ tick: 480, status: 0x90, data: [60, 102] });
    expect(you[1].tick).toBe(960); // ends at next note
    expect(you.at(-1)!.tick).toBe(Math.round((10 + MAX_SUNG_NOTE_SEC) * 2 * PPQ)); // capped
    expect(f.tracks[2].filter(e => e.status < 0xff)[0]).toEqual({ tick: 0, status: 0x99, data: [36, 127] });
  });
});
