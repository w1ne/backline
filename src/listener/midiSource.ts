import type { Source } from './listener';

export class MidiSource implements Source {
  private access?: MIDIAccess;
  private handler?: (e: MIDIMessageEvent) => void;

  async start(onNote: (m: number, v: number, t: number) => void, onLevel: (l: number) => void) {
    this.access = await navigator.requestMIDIAccess();
    this.handler = e => {
      const [s, n, v] = e.data!;
      if ((s & 0xf0) === 0x90 && v > 0) {
        onNote(n, v / 127, performance.now() / 1000);
        onLevel(v / 127);
      }
    };
    this.access.inputs.forEach(i => i.addEventListener('midimessage', this.handler!));
  }

  stop() {
    this.access?.inputs.forEach(i => i.removeEventListener('midimessage', this.handler!));
  }
}
