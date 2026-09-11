import type { Source, SourceState } from './listener';

export class MidiSource implements Source {
  private access?: MIDIAccess;
  private handler?: (e: MIDIMessageEvent) => void;
  private stateHandler?: (e: MIDIConnectionEvent) => void;
  private state: SourceState = 'none';

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
    this.stateHandler = e => {
      const port = e.port;
      if (port && port.type === 'input' && port.state === 'connected') {
        (port as MIDIInput).addEventListener('midimessage', this.handler!);
        this.state = 'on';
      }
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
