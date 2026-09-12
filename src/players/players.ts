import * as Tone from 'tone';
import type { Genre, Instrument, NoteEvent } from '../types';
import { DRUM, INSTRUMENTS } from '../types';
import { makeSoundSet, type SoundOuts, type SoundSet } from './soundsets';
import type { PlayersLike } from '../band/bandleader';
import { routeTargets, type MorphRoute } from '../audio/routing';

/** The bit of a Tone/Web Audio node the routing actually uses. Keeps `route()` testable
 *  with plain fakes instead of a real audio graph. */
interface Routable {
  connect(destination: never): unknown;
  disconnect(): unknown;
}

export class Players implements PlayersLike {
  private set?: SoundSet;
  private out!: Tone.Volume;
  /** one gain per instrument, between its synths and the outputs — the re-routing point */
  private busses?: Record<Instrument, Tone.Gain>;
  /** the MORPH bus input, when an output device has been chosen */
  private morphNode?: AudioNode;
  private routes: Record<Instrument, MorphRoute> = { drums: 'main', bass: 'main', keys: 'main', lead: 'main' };
  private genre: Genre = 'lofi';
  /** Count of note events dropped because they were stale (too close to/before now) or a
   * duplicate on the same monophonic voice within the merge window. Test/diagnostic hook. */
  dropped = 0;
  /** Last actually-triggered time per mono voice, so dedup also catches a note at the start
   * of one bar colliding with the tail of the previous bar's schedule() call. */
  private lastVoiceTime = new Map<string, number>();
  /** Diagnostic tap: every schedule() call, after dropping/merging, as it goes to the synths. */
  onSchedule?: (inst: Instrument, events: NoteEvent[], barStart: number, bpm: number) => void;

  async init() {
    if (!this.out) {
      Tone.setContext(new Tone.Context({ latencyHint: 'interactive' }));
      this.out = new Tone.Volume(-6).toDestination();
      this.busses = {
        drums: new Tone.Gain(),
        bass: new Tone.Gain(),
        keys: new Tone.Gain(),
        lead: new Tone.Gain(),
      };
      INSTRUMENTS.forEach(i => this.applyRoute(i));
    }
    await Tone.start();
    this.setGenre(this.genre);
  }

  /** Hands the players the MORPH bus input (or undefined when the output is off).
   *  Every instrument's route is re-applied, so "morph" pads become audible on the box
   *  and fall back to the main output when it goes away. */
  setMorphBus(node: AudioNode | undefined): void {
    this.morphNode = node;
    INSTRUMENTS.forEach(i => this.applyRoute(i));
  }

  /** Sends one instrument to the main output, the MORPH output, or both. */
  route(inst: Instrument, route: MorphRoute): void {
    this.routes[inst] = route;
    this.applyRoute(inst);
  }

  routeOf(inst: Instrument): MorphRoute {
    return this.routes[inst];
  }

  private applyRoute(inst: Instrument): void {
    const bus = this.busses?.[inst] as Routable | undefined;
    if (!bus || !this.out) return;
    const to = routeTargets(this.routes[inst], !!this.morphNode);
    bus.disconnect();
    if (to.main) bus.connect(this.out as never);
    if (to.morph && this.morphNode) bus.connect(this.morphNode as never);
  }

  /** The AudioContext backing this Players' Tone context; shared with LyriaEngine's PcmPlayer. */
  rawContext(): AudioContext {
    return Tone.getContext().rawContext as unknown as AudioContext;
  }

  latencyMs(): number {
    const ctx = Tone.getContext().rawContext as unknown as AudioContext;
    return (ctx.baseLatency + (ctx.outputLatency ?? 0)) * 1000;
  }

  setGenre(g: Genre) {
    if (this.set && g === this.genre) return;
    this.set?.dispose();
    this.genre = g;
    this.set = makeSoundSet(g, (this.busses ?? this.fallbackOuts()) as SoundOuts);
    this.lastVoiceTime.clear();
  }

  /** setGenre() before init() (tests, and the demo state) has no busses yet: everything
   *  goes straight to the main output, exactly as it did before routing existed. */
  private fallbackOuts(): SoundOuts {
    return { drums: this.out, bass: this.out, keys: this.out, lead: this.out };
  }

  schedule(inst: Instrument, events: NoteEvent[], barStart: number, bpm: number) {
    if (!(bpm > 0)) return;
    if (!this.set) return;
    const spb = 60 / bpm;
    const minT = Tone.getContext().currentTime + 0.005;

    const items = events
      .map((e) => ({ e, t: barStart + e.time * spb, d: Math.max(0.05, e.duration * spb) }))
      .sort((a, b) => a.t - b.t);

    // Keys is a PolySynth: multiple notes at the same time are a chord, not a collision.
    // Every other instrument is a mono voice, so two events within 1ms of each other on the
    // same voice (e.g. two notes for the same beat) would otherwise throw in Tone.js
    // ("Start time must be strictly greater than previous start time") — merge them, keeping
    // the louder one.
    const kept: typeof items = [];
    const lastInBatch = new Map<string, (typeof items)[number]>();
    for (const item of items) {
      if (item.t < minT) {
        this.dropped++;
        continue;
      }
      if (inst === 'keys') {
        kept.push(item);
        continue;
      }
      const voice = inst === 'drums' ? `drums:${item.e.note}` : inst;
      // A note that lands at or before the last one actually triggered on this voice
      // (whether from earlier in this batch or a previous schedule() call) can't be played —
      // Tone.js requires strictly increasing start times per mono voice.
      const lastFired = this.lastVoiceTime.get(voice);
      if (lastFired !== undefined && item.t - lastFired < 0.001) {
        this.dropped++;
        continue;
      }
      const last = lastInBatch.get(voice);
      if (last && item.t - last.t < 0.001) {
        if (item.e.velocity > last.e.velocity) {
          kept[kept.indexOf(last)] = item;
          lastInBatch.set(voice, item);
        }
        this.dropped++;
        continue;
      }
      lastInBatch.set(voice, item);
      kept.push(item);
    }

    this.onSchedule?.(inst, kept.map(k => k.e), barStart, bpm);

    for (const { e, t, d } of kept) {
      const voice = inst === 'drums' ? `drums:${e.note}` : inst;
      if (inst !== 'keys') this.lastVoiceTime.set(voice, t);
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
