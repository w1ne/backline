import type { Instrument, NoteEvent } from '../types';

/** Audio-clock windows for notes accepted by the player, including future scheduling. */
export class PlaybackActivity {
  private windows: { instrument: Instrument; start: number; end: number }[] = [];
  add(instrument: Instrument, notes: NoteEvent[], barStart: number, bpm: number): void {
    for (const n of notes) {
      const start = barStart + n.time * 60 / bpm;
      this.windows.push({instrument, start, end:start + Math.max(.08, n.duration * 60 / bpm)});
    }
    if (this.windows.length > 1024) this.windows.splice(0, this.windows.length - 1024);
  }
  at(now: number): Partial<Record<Instrument, boolean>> {
    this.windows = this.windows.filter(w => w.end > now);
    const active: Partial<Record<Instrument, boolean>> = {};
    for (const w of this.windows) if (w.start <= now) active[w.instrument] = true;
    return active;
  }
  clear(): void { this.windows = []; }
}
