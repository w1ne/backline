import * as Tone from 'tone';
import { Soundfont } from 'smplr';
import type { Genre, Instrument, NoteEvent } from '../types';
import { DRUM, INSTRUMENTS } from '../types';
import { makeSoundSet, type SoundOuts, type SoundSet } from './soundsets';
import { DEFAULT_DRUM_KIT, type DrumKit } from './sampledVoices';
import type { PlayersLike, ScheduleConfirmation } from '../band/bandleader';
import { routeTargets, type MorphRoute } from '../audio/routing';
import { GM_INSTRUMENTS } from './gmInstruments';

/** The bit of a Tone/Web Audio node the routing actually uses. Keeps `route()` testable
 *  with plain fakes instead of a real audio graph. */
interface Routable {
  connect(destination: never): unknown;
  disconnect(): unknown;
}

/** Master bus: a shared reverb return (fed by a per-instrument send off each bus, more on
 *  keys/lead, less on drums/bass), a gentle compressor to even out the band, and a limiter
 *  so nothing clips. No lookahead effects — this must not add scheduling latency. */
interface MixBus {
  reverb: Tone.Reverb;
  sends: Record<Instrument, Tone.Gain>;
}

/** Reverb send amount per instrument — a light room ambience overall, with keys and lead
 *  sitting further back in it than the low, percussive drums/bass. Exported for a
 *  construction-free unit test; real wiring happens in Players.init(). */
export const REVERB_SEND: Record<Instrument, number> = { drums: 0.06, bass: 0.05, keys: 0.22, lead: 0.15 };

/** Master chain settings, exported for the same reason — Players.init() needs a live
 *  AudioContext to actually build these nodes, so this is what a unit test can check. */
export const MASTER_CHAIN = {
  reverbDecay: 1.4,
  compressor: { threshold: -18, ratio: 3, attack: 0.01, release: 0.2 },
  limiterCeilingDb: -1,
} as const;

export class Players implements PlayersLike {
  private set?: SoundSet;
  private out!: Tone.Volume;
  /** one gain per instrument, between its synths and the outputs — the re-routing point */
  private busses?: Record<Instrument, Tone.Gain>;
  private mix?: MixBus;
  /** master compressor, exposed so an outboard chain (e.g. the vocal chain) can join the
   *  band ahead of the limiter instead of bypassing it. */
  private compressorNode?: Tone.Compressor;
  /** the MORPH bus input, when an output device has been chosen */
  private morphNode?: AudioNode;
  private routes: Record<Instrument, MorphRoute> = { drums: 'main', bass: 'main', keys: 'main', lead: 'main' };
  private analyser?: AnalyserNode;
  private bandAmount = 1;
  private enabled: Record<Instrument, boolean> = { drums: true, bass: true, keys: true, lead: true };
  private accompanimentEpoch = 0;
  private genre: Genre = 'lofi';
  private drumKit: DrumKit = DEFAULT_DRUM_KIT;
  /**
   * Fires for every batch of notes that actually reaches a voice, with absolute times,
   * so the visualiser can draw what the band is about to play. Notes dropped as stale or
   * as mono-voice collisions are excluded — the hook reports what will be heard.
   */
  onSchedule?: (instrument: Instrument, events: NoteEvent[], barStartTime: number, bpm: number) => void;
  /** AMT only: fires per GM program actually scheduled through scheduleAccompaniment(), so
   *  the AMT panel can show which preset(s) are currently sounding. */
  onAccompSchedule?: (gmProgram: number, events: NoteEvent[], barStartTime: number, bpm: number) => void;
  /** Count of note events dropped because they were stale (too close to/before now) or a
   * duplicate on the same monophonic voice within the merge window. Test/diagnostic hook. */
  dropped = 0;
  /** Last actually-triggered time per mono voice, so dedup also catches a note at the start
   * of one bar colliding with the tail of the previous bar's schedule() call. */
  private lastVoiceTime = new Map<string, number>();
  /** Lazily-created real-instrument sampler per GM program, for AMT accompaniment. */
  private accompVoices = new Map<number, ReturnType<typeof Soundfont>>();
  private accompanimentStops = new Set<() => void>();

  async init() {
    if (!this.out) {
      Tone.setContext(new Tone.Context({ latencyHint: 'interactive' }));
      this.out = new Tone.Volume(-6);
      // Master chain: out -> compressor -> limiter -> speakers. Both are plain dynamics
      // nodes (no lookahead delay beyond what DynamicsCompressorNode always has), so this
      // adds no scheduling latency.
      const compressor = new Tone.Compressor(MASTER_CHAIN.compressor);
      const limiter = new Tone.Limiter(MASTER_CHAIN.limiterCeilingDb);
      this.out.chain(compressor, limiter, Tone.getDestination());
      this.compressorNode = compressor;
      // Reverb is a send effect (100% wet): each instrument's bus feeds it at its own level
      // via `sends`, and its output joins the same compressor/limiter chain as the dry signal.
      const reverb = new Tone.Reverb({ decay: MASTER_CHAIN.reverbDecay, wet: 1 }).connect(compressor);
      const sends = Object.fromEntries(
        INSTRUMENTS.map(i => [i, new Tone.Gain(REVERB_SEND[i]).connect(reverb)]),
      ) as Record<Instrument, Tone.Gain>;
      this.mix = { reverb, sends };
      this.busses = {
        drums: new Tone.Gain(),
        bass: new Tone.Gain(),
        keys: new Tone.Gain(),
        lead: new Tone.Gain(),
      };
      INSTRUMENTS.forEach(i => { this.applyRoute(i); this.applyGain(i); });
    }
    // Resolves only after a user gesture in every browser; never block boot on it.
    void Tone.start().catch(() => undefined);
    this.setGenre(this.genre);
  }

  /** Hands the players the MORPH bus input (or undefined when the output is off).
   *  Every instrument's route is re-applied, so "morph" pads become audible on the box
   *  and fall back to the main output when it goes away. */
  setMorphBus(node: AudioNode | undefined): void {
    this.morphNode = node;
    INSTRUMENTS.forEach(i => this.applyRoute(i));
  }

  /** Remove old-tempo events and tails when an engine transport restarts. */
  cancelScheduled(): void {
    this.accompanimentEpoch++;
    for (const stop of this.accompanimentStops) stop();
    this.accompanimentStops.clear();
    this.accompVoices.forEach(voice => voice.stop());
    if (!this.set) return;
    this.set.dispose();
    this.set = makeSoundSet(this.genre, (this.busses ?? this.fallbackOuts()) as SoundOuts, this.drumKit);
    this.lastVoiceTime.clear();
  }

  /** Switch drum kits (e.g. from the default acoustic kit to the electronic one). Rebuilds
   *  the current SoundSet so the new kit takes effect immediately. */
  setDrumKit(kit: DrumKit): void {
    if (kit === this.drumKit) return;
    this.drumKit = kit;
    if (!this.set) return;
    this.set.dispose();
    this.set = makeSoundSet(this.genre, (this.busses ?? this.fallbackOuts()) as SoundOuts, this.drumKit);
    this.lastVoiceTime.clear();
  }

  /** Apply after synthesis, including notes already scheduled, on every output route. */
  setBandAmount(amount: number): void {
    this.bandAmount = Number.isFinite(amount) ? Math.min(1, Math.max(0, amount)) : 0;
    INSTRUMENTS.forEach(i => this.applyGain(i));
  }

  /** Mute the role bus, including GM samplers and notes already scheduled. */
  setEnabled(inst: Instrument, enabled: boolean): void {
    this.enabled[inst] = enabled;
    this.applyGain(inst);
  }

  private applyGain(inst: Instrument): void {
    this.busses?.[inst].gain.rampTo(this.enabled[inst] ? this.bandAmount : 0, .03);
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
    if (to.main && this.mix) bus.connect(this.mix.sends[inst] as never);
    if (to.morph && this.morphNode) bus.connect(this.morphNode as never);
  }

  /** An analyser on the Tone output bus, created on first use. */
  getAnalyser(): AnalyserNode | undefined {
    if (this.analyser) return this.analyser;
    if (!this.out) return undefined;
    const ctx = this.rawContext();
    this.analyser = ctx.createAnalyser();
    this.out.connect(this.analyser);
    return this.analyser;
  }

  /** The band's shared reverb send bus (a plate-style return, 100% wet) — anything else
   *  that wants a touch of the same room, such as the vocal chain, sends into this
   *  instead of building a second reverb. Undefined until init() has run. */
  reverbBus(): Tone.Reverb | undefined {
    return this.mix?.reverb;
  }

  /** The master compressor's input, i.e. the point right before the limiter. An outboard
   *  chain (the vocal chain) connects here so it rides through the same compressor/limiter
   *  as the band, rather than hitting the limiter alone or bypassing it. */
  preLimiterInput(): Tone.Compressor | undefined {
    return this.compressorNode;
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
    this.set = makeSoundSet(g, (this.busses ?? this.fallbackOuts()) as SoundOuts, this.drumKit);
    this.lastVoiceTime.clear();
  }

  /** setGenre() before init() (tests, and the demo state) has no busses yet: everything
   *  goes straight to the main output, exactly as it did before routing existed. */
  private fallbackOuts(): SoundOuts {
    return { drums: this.out, bass: this.out, keys: this.out, lead: this.out };
  }

  schedule(inst: Instrument, events: NoteEvent[], barStart: number, bpm: number, onScheduled?: ScheduleConfirmation) {
    if (!(bpm > 0) || !this.enabled[inst] || !this.bandAmount) return;
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
      if (item.t < minT || !(item.e.velocity > 0)) {
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

    for (const { e, t, d } of kept) {
      const voice = inst === 'drums' ? `drums:${e.note}` : inst;
      if (inst !== 'keys') this.lastVoiceTime.set(voice, t);
      if (inst === 'drums') this.hit(e.note, t, e.velocity);
      else if (inst === 'keys')
        this.set.keys.triggerAttackRelease(Tone.Frequency(e.note, 'midi').toFrequency(), d, t, e.velocity);
      else this.set[inst].triggerAttackRelease(Tone.Frequency(e.note, 'midi').toFrequency(), d, t, e.velocity);
    }
    if (kept.length) {
      const accepted = kept.map(k => k.e);
      this.onSchedule?.(inst, accepted, barStart, bpm);
      onScheduled?.(accepted);
    }
  }

  /** AMT's real-instrument accompaniment: one smplr Soundfont voice per GM program,
   *  connected through its musical role's bus. Amount, mute, MORPH routing and the
   *  master chain therefore apply equally to model notes and local instruments.
   *
   *  smplr silently drops a note whose sample buffer hasn't finished loading yet (no error,
   *  just no sound) — monitor.ts always awaits `.ready` before playing for that reason, and
   *  this must too, or a freshly-toggled preset's first bars are inaudible. */
  scheduleAccompaniment(gmProgram: number, events: NoteEvent[], barStart: number, bpm: number, onScheduled?: ScheduleConfirmation): void {
    if (!(bpm > 0)) return;
    const gm = GM_INSTRUMENTS[gmProgram];
    if (!gm || !this.busses || !this.enabled[gm.role] || !this.bandAmount) return;
    let voice = this.accompVoices.get(gmProgram);
    if (!voice) {
      const ctx = this.rawContext();
      const destination = ctx.createGain();
      Tone.connect(destination, this.busses[gm.role]);
      voice = Soundfont(ctx, { instrument: gm.name, kit: 'MusyngKite', destination });
      this.accompVoices.set(gmProgram, voice);
    }
    const spb = 60 / bpm;
    const minT = Tone.getContext().currentTime + 0.005;
    const kept: NoteEvent[] = [];
    const notes: { note: number; time: number; duration: number; velocity: number }[] = [];
    for (const e of events) {
      const t = barStart + e.time * spb;
      if (t < minT || !(e.velocity > 0)) {
        this.dropped++;
        continue;
      }
      kept.push(e);
      notes.push({ note: e.note, time: t, duration: Math.max(0.05, e.duration * spb), velocity: Math.max(1, Math.round(e.velocity * 127)) });
    }
    if (!kept.length) return;
    const epoch = this.accompanimentEpoch;
    voice.ready.then(() => {
      if (epoch !== this.accompanimentEpoch || !this.enabled[gm.role] || !this.bandAmount) return;
      // Loading may take longer than the scheduling lead. Never burst overdue
      // notes on readiness or report them as sounding in the activity display.
      const minReadyTime = Tone.getContext().currentTime + .005;
      const sounding: NoteEvent[] = [];
      notes.forEach((note, index) => {
        if (note.time < minReadyTime) { this.dropped++; return; }
        let stop: (() => void) | undefined;
        let ended = false;
        stop = voice.start({...note, onEnded: () => {
          ended = true;
          if (stop) this.accompanimentStops.delete(stop);
        }});
        // start() owns a scheduler event before a source exists. Soundfont.stop()
        // alone cannot cancel it, so retain its handle until it ends or we stop.
        if (stop && !ended) this.accompanimentStops.add(stop);
        sounding.push(kept[index]);
      });
      if (!sounding.length) return;
      this.onSchedule?.(gm.role, sounding, barStart, bpm);
      this.onAccompSchedule?.(gmProgram, sounding, barStart, bpm);
      onScheduled?.(sounding);
    }, () => { this.dropped += notes.length; });
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
