import type { Instrument, NoteEvent } from '../types';

/** Audio-clock windows for notes accepted by the player, including future scheduling.
 *  Keyed by Instrument for the main tiles; AMT reuses it (keyed by AccompPreset) for the
 *  accompaniment panel's per-instrument LEDs. */
export class PlaybackActivity<K extends string = Instrument> {
  private windows: { key: K; start: number; end: number }[] = [];
  add(key: K, notes: NoteEvent[], barStart: number, bpm: number): void {
    for (const n of notes) {
      const start = barStart + n.time * 60 / bpm;
      this.windows.push({key, start, end:start + Math.max(.08, n.duration * 60 / bpm)});
    }
    if (this.windows.length > 1024) this.windows.splice(0, this.windows.length - 1024);
  }
  at(now: number): Partial<Record<K, boolean>> {
    this.windows = this.windows.filter(w => w.end > now);
    const active: Partial<Record<K, boolean>> = {};
    for (const w of this.windows) if (w.start <= now) active[w.key] = true;
    return active;
  }
  clear(): void { this.windows = []; }
}
