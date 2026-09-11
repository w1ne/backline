import * as Tone from 'tone';
import type { Genre, Instrument, NoteEvent } from '../types';
import { DRUM } from '../types';
import { makeSoundSet, type SoundSet } from './soundsets';
import type { PlayersLike } from '../band/bandleader';

export class Players implements PlayersLike {
  private set?: SoundSet;
  private out!: Tone.Volume;
  private genre: Genre = 'lofi';

  async init() {
    Tone.setContext(new Tone.Context({ latencyHint: 'interactive' }));
    await Tone.start();
    this.out = new Tone.Volume(-6).toDestination();
    this.setGenre(this.genre);
  }

  latencyMs(): number {
    const ctx = Tone.getContext().rawContext as unknown as AudioContext;
    return (ctx.baseLatency + (ctx.outputLatency ?? 0)) * 1000;
  }

  setGenre(g: Genre) {
    if (this.set && g === this.genre) return;
    this.set?.dispose();
    this.genre = g;
    this.set = makeSoundSet(g, this.out);
  }

  schedule(inst: Instrument, events: NoteEvent[], barStart: number, bpm: number) {
    if (!(bpm > 0)) return;
    if (!this.set) return;
    const spb = 60 / bpm;
    for (const e of events) {
      const t = barStart + e.time * spb,
        d = Math.max(0.05, e.duration * spb);
      if (inst === 'drums') this.hit(e.note, t, e.velocity);
      else if (inst === 'keys')
        this.set.keys.triggerAttackRelease(Tone.Frequency(e.note, 'midi').toFrequency(), d, t, e.velocity);
      else this.set[inst].triggerAttackRelease(Tone.Frequency(e.note, 'midi').toFrequency(), d, t, e.velocity);
    }
  }

  private hit(note: number, t: number, v: number) {
    const d = this.set!.drums;
    if (note === DRUM.kick) d.kick.triggerAttackRelease('C1', 0.2, t, v);
    else if (note === DRUM.snare) d.snare.triggerAttackRelease(0.15, t, v);
    else if (note === DRUM.hat) d.hat.triggerAttackRelease('C6', 0.05, t, v * 0.5);
    else if (note === DRUM.openHat) d.openHat.triggerAttackRelease('C6', 0.3, t, v * 0.5);
    else if (note === DRUM.crash) d.crash.triggerAttackRelease('C6', 1.2, t, v * 0.6);
  }
}
