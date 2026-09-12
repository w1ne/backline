import { describe, it, expect, vi } from 'vitest';
import { MidiSource, midiInputOptions, midiPortAllowed } from './midiSource';

describe('midiPortAllowed', () => {
  it('passes every port when no input has been picked', () => {
    expect(midiPortAllowed(null, 'port-a')).toBe(true);
    expect(midiPortAllowed(null, 'port-b')).toBe(true);
  });

  it('passes only the picked port otherwise', () => {
    expect(midiPortAllowed('port-a', 'port-a')).toBe(true);
    expect(midiPortAllowed('port-a', 'port-b')).toBe(false);
  });
});

describe('midiInputOptions', () => {
  it('lists connected inputs by name', () => {
    const inputs = [
      { id: 'a', name: 'Minilab3 MIDI', state: 'connected' },
      { id: 'b', name: 'Midi Through Port-0', state: 'connected' },
    ] as MIDIInput[];
    expect(midiInputOptions(inputs)).toEqual([
      { id: 'a', label: 'Minilab3 MIDI' },
      { id: 'b', label: 'Midi Through Port-0' },
    ]);
  });

  it('skips a port that has been unplugged and falls back to the id when unnamed', () => {
    const inputs = [
      { id: 'a', name: '', state: 'connected' },
      { id: 'b', name: 'Gone', state: 'disconnected' },
    ] as MIDIInput[];
    expect(midiInputOptions(inputs)).toEqual([{ id: 'a', label: 'a' }]);
  });
});

/** A MIDI input that hands its listener back so a test can play a note on it. */
class FakePort {
  handlers: ((e: MIDIMessageEvent) => void)[] = [];
  state = 'connected';
  constructor(
    public id: string,
    public name: string,
  ) {}
  addEventListener(_type: string, h: (e: MIDIMessageEvent) => void) {
    if (!this.handlers.includes(h)) this.handlers.push(h);
  }
  removeEventListener(_type: string, h: (e: MIDIMessageEvent) => void) {
    this.handlers = this.handlers.filter(x => x !== h);
  }
  noteOn(note: number) {
    const e = { data: new Uint8Array([0x90, note, 100]), target: this } as unknown as MIDIMessageEvent;
    this.handlers.forEach(h => h(e));
  }
}

function fakeAccess(ports: FakePort[]) {
  return {
    inputs: { forEach: (cb: (p: FakePort) => void) => ports.forEach(cb) },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MIDIAccess;
}

async function startWith(ports: FakePort[], selected: string | null) {
  const access = fakeAccess(ports);
  vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.resolve(access) });
  const src = new MidiSource(selected);
  const notes: number[] = [];
  await src.start(n => notes.push(n), () => {});
  return { src, notes };
}

describe('MidiSource input filtering', () => {
  it('takes notes from every keyboard when set to "all"', async () => {
    const mini = new FakePort('a', 'Minilab3 MIDI');
    const other = new FakePort('b', 'Keystep');
    const { notes } = await startWith([mini, other], null);
    mini.noteOn(60);
    other.noteOn(64);
    expect(notes).toEqual([60, 64]);
  });

  it('ignores the keyboards that were not picked', async () => {
    const mini = new FakePort('a', 'Minilab3 MIDI');
    const through = new FakePort('b', 'Midi Through Port-0');
    const { notes } = await startWith([mini, through], 'a');
    through.noteOn(40);
    mini.noteOn(60);
    expect(notes).toEqual([60]);
  });

  it('switches inputs live, without restarting', async () => {
    const mini = new FakePort('a', 'Minilab3 MIDI');
    const keystep = new FakePort('b', 'Keystep');
    const { src, notes } = await startWith([mini, keystep], 'a');
    mini.noteOn(60);
    src.setInput('b');
    mini.noteOn(62); // no longer listened to
    keystep.noteOn(64);
    expect(notes).toEqual([60, 64]);
    expect(src.input).toBe('b');
  });

  it('reports the connected inputs for the picker', async () => {
    const mini = new FakePort('a', 'Minilab3 MIDI');
    const { src } = await startWith([mini], null);
    expect(src.inputs()).toEqual([{ id: 'a', label: 'Minilab3 MIDI' }]);
    const seen: string[][] = [];
    src.onInputs(list => seen.push(list.map(d => d.label)));
    expect(seen).toEqual([['Minilab3 MIDI']]);
  });
});
