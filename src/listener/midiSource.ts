import { performanceNoteId, type PerformanceEvent } from './performanceEvent';
import type { Source, SourceState } from './listener';
import type { DeviceOption } from '../audio/devices';

/** Whether a message from `portId` should be listened to, given the picker's choice
 *  (null = every connected input). Pure, so the filter is testable without Web MIDI. */
export function midiPortAllowed(selected: string | null, portId: string): boolean {
  return selected === null || selected === portId;
}

/** The connected inputs, as the picker lists them: id + the name the OS reports
 *  (e.g. "Minilab3 MIDI"). */
export function midiInputOptions(inputs: Iterable<MIDIInput>): DeviceOption[] {
  const out: DeviceOption[] = [];
  for (const i of inputs) {
    if (i.state === 'disconnected') continue;
    const label = (i.name ?? '').trim() || i.id;
    // ALSA's virtual loopback port is not a keyboard; hide it from pickers and status lines.
    if (/^midi through/i.test(label)) continue;
    out.push({ id: i.id, label });
  }
  return out;
}

export class MidiSource implements Source {
  private events = new Set<(e: PerformanceEvent) => void>();
  private held = new Map<string, { event: PerformanceEvent; released: boolean }>();
  private sustain = new Set<string>();
  onPerformance(cb: (e: PerformanceEvent) => void): () => void {
    this.events.add(cb);
    return () => { this.events.delete(cb); };
  }
  private release(key: string, timeSec: number): void {
    const held = this.held.get(key);
    if (!held) return;
    this.held.delete(key);
    const e = held.event;
    this.events.forEach(cb => cb({ ...e, type: 'note_off', timeSec,
      durationSec: Math.max(0, timeSec - e.timeSec) }));
  }
  private releaseAll(timeSec: number): void {
    for (const key of this.held.keys()) this.release(key, timeSec);
    this.sustain.clear();
  }
  private generation = 0;
  private access?: MIDIAccess;
  private handler?: (e: MIDIMessageEvent) => void;
  private stateHandler?: (e: MIDIConnectionEvent) => void;
  private state: SourceState = 'none';
  /** chosen MIDI input id, or null for "all" */
  private selected: string | null = null;
  private inputsCb?: (inputs: DeviceOption[]) => void;

  constructor(selected: string | null = null) {
    this.selected = selected;
  }

  /** Narrows to one input (by id) or back to every connected one. */
  setInput(id: string | null): void {
    this.releaseAll(performance.now() / 1000);
    this.selected = id;
    this.state = this.inputs().length > 0 ? 'on' : 'none';
  }

  get input(): string | null {
    return this.selected;
  }

  /** Connected inputs right now — empty before start() or without Web MIDI. */
  inputs(): DeviceOption[] {
    if (!this.access) return [];
    const ports: MIDIInput[] = [];
    this.access.inputs.forEach(i => ports.push(i));
    return midiInputOptions(ports);
  }

  /** Called on start and on every plug/unplug, so the picker can follow hot-plug. */
  onInputs(cb: (inputs: DeviceOption[]) => void): void {
    this.inputsCb = cb;
    if (this.access) cb(this.inputs());
  }

  async start(onNote: (m: number, v: number, t: number) => void, onLevel: (l: number) => void) {
    this.stop();
    const generation = ++this.generation;
    if (typeof navigator.requestMIDIAccess !== 'function') {
      this.state = 'none';
      return;
    }
    try {
      const access = await navigator.requestMIDIAccess();
      if (generation !== this.generation) return;
      this.access = access;
    } catch {
      this.state = 'none';
      return;
    }
    this.handler = e => {
      const port = e.target as MIDIInput | null;
      if (port?.id && !midiPortAllowed(this.selected, port.id)) return;
      if (!e.data || e.data.length < 3) return;
      const [s, n, v] = e.data;
      const channel = `${port?.id ?? 'default'}:${s & 15}`;
      const key = `${channel}:${n}`;
      const timeSec = (Number.isFinite(e.timeStamp) ? e.timeStamp : performance.now()) / 1000;
      if ((s & 0xf0) === 0x90 && v > 0) {
        this.release(key, timeSec);
        const event: PerformanceEvent = { type: 'note_on', id: performanceNoteId('midi'),
          source: 'midi', midi: n, velocity: v / 127, confidence: 1, timeSec };
        this.held.set(key, { event, released: false });
        this.events.forEach(cb => cb(event));
        onNote(n, v / 127, timeSec);
        onLevel(v / 127);
      } else if ((s & 0xf0) === 0x80 || ((s & 0xf0) === 0x90 && v === 0)) {
        const held = this.held.get(key);
        if (held && this.sustain.has(channel)) held.released = true;
        else this.release(key, timeSec);
      } else if ((s & 0xf0) === 0xb0 && n === 64) {
        if (v >= 64) this.sustain.add(channel);
        else {
          this.sustain.delete(channel);
          for (const [key, held] of this.held) {
            if (key.startsWith(`${channel}:`) && held.released) this.release(key, timeSec);
          }
        }
      } else if ((s & 0xf0) === 0xb0 && (n === 120 || n === 123)) {
        for (const key of this.held.keys()) if (key.startsWith(`${channel}:`)) this.release(key, timeSec);
      }
    };
    let count = 0;
    this.access.inputs.forEach(i => {
      count++;
      i.addEventListener('midimessage', this.handler!);
    });
    this.state = count > 0 ? 'on' : 'none';
    this.inputsCb?.(this.inputs());
    this.stateHandler = e => {
      const port = e.port;
      if (port && port.type === 'input' && port.state === 'connected') {
        // re-adding the same listener to the same port is a no-op, so a re-plug of a
        // keyboard that was already wired does not double up its notes
        (port as MIDIInput).addEventListener('midimessage', this.handler!);
        this.state = 'on';
      }
      if (port?.state === 'disconnected') {
        for (const key of this.held.keys()) if (key.startsWith(`${port.id}:`)) this.release(key, performance.now() / 1000);
      }
      this.inputsCb?.(this.inputs());
    };
    this.access.addEventListener('statechange', this.stateHandler);
  }

  getStatus(): SourceState {
    return this.state;
  }

  stop() {
    ++this.generation;
    this.releaseAll(performance.now() / 1000);
    this.access?.inputs.forEach(i => i.removeEventListener('midimessage', this.handler!));
    if (this.stateHandler) this.access?.removeEventListener('statechange', this.stateHandler);
  }
}
