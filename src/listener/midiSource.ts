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
    out.push({ id: i.id, label: (i.name ?? '').trim() || i.id });
  }
  return out;
}

export class MidiSource implements Source {
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
    if (typeof navigator.requestMIDIAccess !== 'function') {
      this.state = 'none';
      return;
    }
    try {
      this.access = await navigator.requestMIDIAccess();
    } catch {
      this.state = 'none';
      return;
    }
    this.handler = e => {
      const port = e.target as MIDIInput | null;
      if (port?.id && !midiPortAllowed(this.selected, port.id)) return;
      const [s, n, v] = e.data!;
      if ((s & 0xf0) === 0x90 && v > 0) {
        onNote(n, v / 127, performance.now() / 1000);
        onLevel(v / 127);
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
      this.inputsCb?.(this.inputs());
    };
    this.access.addEventListener('statechange', this.stateHandler);
  }

  getStatus(): SourceState {
    return this.state;
  }

  stop() {
    this.access?.inputs.forEach(i => i.removeEventListener('midimessage', this.handler!));
    if (this.stateHandler) this.access?.removeEventListener('statechange', this.stateHandler);
  }
}
