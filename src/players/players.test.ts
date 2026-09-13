import { describe, it, expect, vi } from 'vitest';
import * as Tone from 'tone';
vi.mock('tone', async importOriginal => ({
  ...await importOriginal<typeof import('tone')>(), connect: vi.fn(),
}));
const sf = vi.hoisted(() => ({ instruments: [] as any[] }));
vi.mock('smplr', () => ({
  Soundfont: (_ctx: unknown, options: unknown) => {
    let resolveReady!: () => void;
    const inst = { options, stop: vi.fn(), dispose: vi.fn(), ready: new Promise<void>(r => { resolveReady = r; }), start: vi.fn(), resolveReady: () => resolveReady() };
    sf.instruments.push(inst);
    return inst;
  },
}));
import { Players } from './players';
import { PATTERNS } from '../patterns';
import { mulberry32 } from '../rng';

/** Mirrors Tone's guard on mono instruments (MonoSynth/Synth/MembraneSynth/NoiseSynth/
 * MetalSynth): triggerAttackRelease must be called with strictly increasing start times. */
class FakeMonoVoice {
  triggers: { t: number; v: number }[] = [];
  private lastT = -Infinity;
  // NoiseSynth.triggerAttackRelease(duration, time, velocity) has no note; every other mono
  // voice used here (MembraneSynth/MetalSynth/MonoSynth/Synth) is (note, duration, time,
  // velocity). Either way time/velocity are the last two arguments.
  triggerAttackRelease(...args: unknown[]) {
    const time = args[args.length - 2] as number;
    const velocity = (args[args.length - 1] as number) ?? 1;
    if (time <= this.lastT) {
      throw new Error('Start time must be strictly greater than previous start time');
    }
    this.lastT = time;
    this.triggers.push({ t: time, v: velocity });
  }
}

/** PolySynth: multiple voices, so simultaneous notes (chords) are fine. */
class FakePolyVoice {
  triggers: { t: number; v: number }[] = [];
  triggerAttackRelease(_note: unknown, _dur: number, time: number, velocity = 1) {
    this.triggers.push({ t: time, v: velocity });
  }
}

interface FakeSoundSet {
  drums: {
    kick: FakeMonoVoice;
    snare: FakeMonoVoice;
    hat: FakeMonoVoice;
    openHat: FakeMonoVoice;
    crash: FakeMonoVoice;
  };
  bass: FakeMonoVoice;
  keys: FakePolyVoice;
  lead: FakeMonoVoice;
  dispose(): void;
}

function fakeSoundSet(): FakeSoundSet {
  return {
    drums: {
      kick: new FakeMonoVoice(),
      snare: new FakeMonoVoice(),
      hat: new FakeMonoVoice(),
      openHat: new FakeMonoVoice(),
      crash: new FakeMonoVoice(),
    },
    bass: new FakeMonoVoice(),
    keys: new FakePolyVoice(),
    lead: new FakeMonoVoice(),
    dispose() {},
  };
}

function withFakeSet(players: Players) {
  const set = fakeSoundSet();
  // Players' `set` field is private; tests inject a fake SoundSet directly rather than
  // spinning up real Tone.js audio nodes.
  (players as unknown as { set: FakeSoundSet }).set = set;
  return set;
}

describe('Players.schedule', () => {
  it('never triggers a mono voice twice at a non-increasing time across many realistic bars', () => {
    const players = new Players();
    withFakeSet(players);
    const rng = mulberry32(1234);
    const key = { root: 0, mode: 'major' as const };
    const bpm = 90;

    expect(() => {
      for (let bar = 0; bar < 32; bar++) {
        const barStart = 100 + bar * (60 / bpm) * 4;
        for (const inst of ['drums', 'bass', 'keys', 'lead'] as const) {
          const events = PATTERNS.lofi[inst].nextBar({ bar, key, creativity: 1, rng });
          players.schedule(inst, events, barStart, bpm);
        }
      }
    }).not.toThrow();
  });

  it('merges two notes on the same mono voice within 1ms, keeping the louder', () => {
    const players = new Players();
    const set = withFakeSet(players);
    players.schedule(
      'bass',
      [
        { time: 0, note: 40, duration: 0.5, velocity: 0.3 },
        { time: 0.0001, note: 43, duration: 0.5, velocity: 0.9 },
      ],
      100,
      120,
    );
    expect(set.bass.triggers.length).toBe(1);
    expect(set.bass.triggers[0].v).toBeCloseTo(0.9);
  });

  it('merges duplicate drum hits on the same voice (e.g. two snare notes on one beat)', () => {
    const players = new Players();
    const set = withFakeSet(players);
    players.schedule(
      'drums',
      [
        { time: 3.5, note: 38, duration: 0.25, velocity: 0.5 },
        { time: 3.5001, note: 38, duration: 0.25, velocity: 0.6 },
      ],
      0,
      120,
    );
    expect(set.drums.snare.triggers.length).toBe(1);
  });

  it('allows a chord (simultaneous notes) on the polyphonic keys voice', () => {
    const players = new Players();
    const set = withFakeSet(players);
    players.schedule(
      'keys',
      [
        { time: 0, note: 60, duration: 1, velocity: 0.5 },
        { time: 0, note: 64, duration: 1, velocity: 0.5 },
        { time: 0, note: 67, duration: 1, velocity: 0.5 },
      ],
      100,
      120,
    );
    expect(set.keys.triggers.length).toBe(3);
  });

  it('drops events scheduled at or before now and counts them, without throwing', () => {
    const players = new Players();
    const set = withFakeSet(players);
    const before = players.dropped;
    players.schedule('lead', [{ time: 0, note: 60, duration: 0.2, velocity: 1 }], -5, 120);
    expect(set.lead.triggers.length).toBe(0);
    expect(players.dropped).toBe(before + 1);
  });
});

/** A node that records what it was wired to, standing in for a Tone.Gain / Volume. */
class FakeNode {
  gain = { rampTo: vi.fn() };
  connected: unknown[] = [];
  disconnects = 0;
  connect(dest: unknown) {
    this.connected.push(dest);
    return this;
  }
  disconnect() {
    this.disconnects++;
    this.connected = [];
    return this;
  }
}

/** Players builds its busses in init(), which needs a real AudioContext; tests wire the
 *  same shape by hand so routing can be checked without starting audio. */
function withFakeBusses(players: Players) {
  const out = new FakeNode();
  const busses = { drums: new FakeNode(), bass: new FakeNode(), keys: new FakeNode(), lead: new FakeNode() };
  Object.assign(players as unknown as Record<string, unknown>, { out, busses });
  vi.spyOn(players, 'rawContext').mockReturnValue({ createGain: () => new FakeNode() } as unknown as AudioContext);
  return { out, busses };
}

describe('Players.scheduleAccompaniment', () => {
  it('does not start notes before the soundfont is ready, then plays every kept note once it is', async () => {
    sf.instruments.length = 0;
    const players = new Players();
    withFakeBusses(players);
    const now = 100;
    players.scheduleAccompaniment(65, [{ time: 0, note: 60, duration: 1, velocity: 0.5 }], now + 1, 120);

    const voice = sf.instruments[0];
    expect(voice.start).not.toHaveBeenCalled();

    voice.resolveReady();
    await voice.ready;
    expect(voice.start).toHaveBeenCalledTimes(1);
    expect(voice.start).toHaveBeenCalledWith(expect.objectContaining({ note: 60 }));
  });

  it('reuses the same soundfont voice for repeated calls with the same GM program', () => {
    sf.instruments.length = 0;
    const players = new Players();
    withFakeBusses(players);
    players.scheduleAccompaniment(65, [{ time: 0, note: 60, duration: 1, velocity: 0.5 }], 100, 120);
    players.scheduleAccompaniment(65, [{ time: 1, note: 62, duration: 1, velocity: 0.5 }], 100, 120);
    expect(sf.instruments).toHaveLength(1);
  });

  it('ignores an unknown GM program instead of throwing', () => {
    const players = new Players();
    withFakeBusses(players);
    expect(() => players.scheduleAccompaniment(999, [{ time: 0, note: 60, duration: 1, velocity: 0.5 }], 100, 120)).not.toThrow();
  });
});

describe('Players.route', () => {
  it('leaves every instrument on the main output until a morph bus exists', () => {
    const players = new Players();
    const { out, busses } = withFakeBusses(players);
    players.route('keys', 'morph');
    expect(busses.keys.connected).toEqual([out]);
    expect(players.routeOf('keys')).toBe('morph');
  });

  it('moves one instrument to the morph bus and leaves the others alone', () => {
    const players = new Players();
    const { out, busses } = withFakeBusses(players);
    const morph = new FakeNode() as unknown as AudioNode;
    players.setMorphBus(morph);
    players.route('keys', 'morph');
    expect(busses.keys.connected).toEqual([morph]);
    expect(busses.drums.connected).toEqual([out]);
    expect(busses.bass.connected).toEqual([out]);
  });

  it('feeds both outputs in "both", and disconnects before every re-wire', () => {
    const players = new Players();
    const { out, busses } = withFakeBusses(players);
    const morph = new FakeNode() as unknown as AudioNode;
    players.setMorphBus(morph);
    const before = busses.lead.disconnects;
    players.route('lead', 'both');
    expect(busses.lead.connected).toEqual([out, morph]);
    expect(busses.lead.disconnects).toBe(before + 1);
  });

  it('falls back to the main output when the morph device goes away', () => {
    const players = new Players();
    const { out, busses } = withFakeBusses(players);
    players.setMorphBus(new FakeNode() as unknown as AudioNode);
    players.route('lead', 'morph');
    players.setMorphBus(undefined);
    expect(busses.lead.connected).toEqual([out]);
    // the pad keeps its setting, so plugging the box back in restores the route
    expect(players.routeOf('lead')).toBe('morph');
  });

  it('applies a route chosen before the audio graph existed, once the busses appear', () => {
    const players = new Players();
    players.route('bass', 'morph'); // no busses yet — nothing to wire
    const { busses } = withFakeBusses(players);
    const morph = new FakeNode() as unknown as AudioNode;
    players.setMorphBus(morph);
    expect(busses.bass.connected).toEqual([morph]);
  });
});

 it('band amount changes all routed instrument gains, including scheduled tails', () => {
    const players = new Players();
    const ramps: number[][] = [];
    const busses = Object.fromEntries(['drums','bass','keys','lead'].map(name =>
      [name, {gain:{rampTo:(value:number, seconds:number) => ramps.push([value,seconds])}}]));
    Object.assign(players, { busses });
    players.setBandAmount(.3);
    expect(ramps).toEqual(Array.from({length:4}, () => [.3,.03]));
    ramps.length = 0;
    players.setBandAmount(0);
    expect(ramps).toEqual(Array.from({length:4}, () => [0,.03]));
 });


describe('GM role buses and asynchronous playback', () => {
  it.each([[24, 'lead'], [42, 'bass'], [65, 'keys']] as const)(
    'routes GM %i to %s and reports its real role only once ready', async (program, role) => {
      sf.instruments.length = 0;
      const players = new Players();
      const { busses } = withFakeBusses(players);
      const scheduled = vi.fn();
      const accomp = vi.fn();
      players.onSchedule = scheduled;
      players.onAccompSchedule = accomp;
      players.setBandAmount(.3);
      players.scheduleAccompaniment(program, [{ time: 0, note: 60, duration: 1, velocity: .8 }], 100, 120);
      const voice = sf.instruments[0];
      expect(voice.options.destination).toBeDefined();
      expect(Tone.connect).toHaveBeenCalledWith(voice.options.destination, busses[role]);
      expect(scheduled).not.toHaveBeenCalled();
      voice.resolveReady();
      await voice.ready;
      expect(voice.start).toHaveBeenCalledWith(expect.objectContaining({ velocity: 102 }));
      expect(scheduled).toHaveBeenCalledWith(role, expect.any(Array), 100, 120);
      expect(accomp).toHaveBeenCalledWith(program, expect.any(Array), 100, 120);
      expect(busses[role].gain.rampTo).toHaveBeenLastCalledWith(.3, .03);
    },
  );

  it('keys mute does not silence guitar, and role gain survives later amount changes', async () => {
    sf.instruments.length = 0;
    const players = new Players();
    const { busses } = withFakeBusses(players);
    players.setEnabled('keys', false);
    players.setBandAmount(.4);
    expect(busses.keys.gain.rampTo).toHaveBeenLastCalledWith(0, .03);
    expect(busses.lead.gain.rampTo).toHaveBeenLastCalledWith(.4, .03);
    players.scheduleAccompaniment(24, [{ time: 0, note: 60, duration: 1, velocity: .8 }], 100, 120);
    const voice = sf.instruments[0];
    voice.resolveReady();
    await voice.ready;
    expect(voice.start).toHaveBeenCalledTimes(1);
    players.setEnabled('lead', false);
    expect(busses.lead.gain.rampTo).toHaveBeenLastCalledWith(0, .03);
  });

  it.each(['muted', 'zero', 'cancelled'] as const)('does not start or report notes after becoming %s while loading', async reason => {
    sf.instruments.length = 0;
    const players = new Players();
    withFakeBusses(players);
    players.onSchedule = vi.fn();
    players.onAccompSchedule = vi.fn();
    players.scheduleAccompaniment(24, [{ time: 0, note: 60, duration: 1, velocity: .8 }], 100, 120);
    const voice = sf.instruments[0];
    if (reason === 'muted') players.setEnabled('lead', false);
    if (reason === 'zero') players.setBandAmount(0);
    if (reason === 'cancelled') players.cancelScheduled();
    voice.resolveReady();
    await voice.ready;
    expect(voice.start).not.toHaveBeenCalled();
    expect(players.onSchedule).not.toHaveBeenCalled();
    expect(players.onAccompSchedule).not.toHaveBeenCalled();
  });
});


it('drops notes that become stale while the soundfont loads', async () => {
  sf.instruments.length = 0;
  const players = new Players();
  withFakeBusses(players);
  const context = vi.spyOn(Tone, 'getContext');
  context.mockReturnValue({ currentTime: 99 } as ReturnType<typeof Tone.getContext>);
  try {
    players.onSchedule = vi.fn();
    players.scheduleAccompaniment(24, [{ time: 0, note: 60, duration: 1, velocity: .8 }], 100, 120);
    context.mockReturnValue({ currentTime: 101 } as ReturnType<typeof Tone.getContext>);
    const voice = sf.instruments[0];
    voice.resolveReady();
    await voice.ready;
    expect(voice.start).not.toHaveBeenCalled();
    expect(players.onSchedule).not.toHaveBeenCalled();
    expect(players.dropped).toBe(1);
  } finally {
    context.mockRestore();
  }
});

it('cancels GM notes already handed to the sampler without needing a local SoundSet', async () => {
  sf.instruments.length = 0;
  const players = new Players();
  withFakeBusses(players);
  players.scheduleAccompaniment(42, [{ time: 0, note: 48, duration: 4, velocity: .8 }], 100, 120);
  const voice = sf.instruments[0];
  voice.resolveReady();
  await voice.ready;
  expect(voice.start).toHaveBeenCalledTimes(1);
  players.cancelScheduled();
  expect(voice.stop).toHaveBeenCalledTimes(1);
});


it('confirms only accepted nonzero events after sample readiness', async () => {
  sf.instruments.length = 0;
  const players = new Players();
  withFakeBusses(players);
  const confirmed = vi.fn();
  const audible = { time: 0, note: 60, duration: 1, velocity: .8 };
  players.scheduleAccompaniment(24, [audible, {...audible,note:62,velocity:0}], 100, 120, confirmed);
  expect(confirmed).not.toHaveBeenCalled();
  const voice = sf.instruments[0];
  voice.resolveReady(); await voice.ready;
  expect(confirmed).toHaveBeenCalledWith([audible]);
  expect(voice.start).toHaveBeenCalledTimes(1);
});

it('does not confirm notes dropped as stale during sample loading', async () => {
  sf.instruments.length = 0;
  const players = new Players();
  withFakeBusses(players);
  const context = vi.spyOn(Tone, 'getContext');
  context.mockReturnValue({ currentTime: 99 } as ReturnType<typeof Tone.getContext>);
  try {
    const confirmed = vi.fn();
    players.scheduleAccompaniment(24, [{time:0,note:60,duration:1,velocity:.8}], 100, 120, confirmed);
    context.mockReturnValue({ currentTime: 101 } as ReturnType<typeof Tone.getContext>);
    const voice = sf.instruments[0];
    voice.resolveReady(); await voice.ready;
    expect(confirmed).not.toHaveBeenCalled();
  } finally { context.mockRestore(); }
});

it('does not publish AMT response timing when a real Players sampler finishes loading too late', async () => {
  const { AmtEngine } = await import('../engines/amtEngine');
  sf.instruments.length = 0;
  class Socket {
    static OPEN = 1;
    readyState = 1;
    listeners = new Map<string, (event: any) => void>();
    addEventListener(type: string, callback: (event: any) => void) { this.listeners.set(type, callback); }
    send() {}
    close() {}
    constructor() { socket = this; }
  }
  let socket!: Socket;
  vi.stubGlobal('WebSocket', Socket);
  const players = new Players();
  withFakeBusses(players);
  const context = vi.spyOn(Tone, 'getContext');
  context.mockReturnValue({ currentTime: 10 } as ReturnType<typeof Tone.getContext>);
  const clock = { bpm: 120, onBar: vi.fn(), start: vi.fn(), stop: vi.fn(), setBpm: vi.fn() };
  const engine = new AmtEngine(players, { onNote: () => undefined }, clock, () => Tone.getContext().currentTime, () => 100);
  try {
    engine.setEnabled('lead', true);
    await engine.start(120, 10);
    const timing = vi.fn(); engine.onResponseTiming = timing;
    socket.listeners.get('message')?.({data:JSON.stringify({type:'plan',latestCaptureTimeSec:100,notes:[
      {voice:'lead',gmInstr:24,beat:2,pitch:60,dur:1,vel:.8},
    ]})});
    expect(sf.instruments).toHaveLength(1);
    context.mockReturnValue({ currentTime: 13 } as ReturnType<typeof Tone.getContext>);
    const voice = sf.instruments[0];
    voice.resolveReady(); await voice.ready; await Promise.resolve();
    expect(voice.start).not.toHaveBeenCalled();
    expect(timing).not.toHaveBeenCalled();
  } finally {
    engine.stop();
    context.mockRestore();
    vi.unstubAllGlobals();
  }
});

it('cancels GM events still queued inside the sampler, not just active sound sources', async () => {
  sf.instruments.length = 0;
  const players = new Players();
  withFakeBusses(players);
  players.scheduleAccompaniment(24, [{time:0,note:60,duration:2,velocity:.8}], 100, 120);
  const voice = sf.instruments[0];
  let queued = false;
  const cancelQueued = vi.fn(() => { queued = false; });
  // smplr.stop() only stops active BufferVoices. Its start() return value also
  // removes future events from the internal scheduler before sources exist.
  voice.start.mockImplementation(() => { queued = true; return cancelQueued; });
  voice.resolveReady(); await voice.ready;
  expect(queued).toBe(true);
  players.cancelScheduled();
  expect(cancelQueued).toHaveBeenCalledOnce();
  expect(queued).toBe(false);
  players.cancelScheduled();
  expect(cancelQueued).toHaveBeenCalledOnce();
});

it('forgets completed GM handles instead of retaining one cancellation per note forever', async () => {
  sf.instruments.length = 0;
  const players = new Players();
  withFakeBusses(players);
  players.scheduleAccompaniment(24, [{time:0,note:60,duration:2,velocity:.8}], 100, 120);
  const voice = sf.instruments[0];
  const cancelQueued = vi.fn();
  let ended!: () => void;
  voice.start.mockImplementation((event: {onEnded:()=>void}) => {ended=event.onEnded;return cancelQueued;});
  voice.resolveReady(); await voice.ready;
  ended();
  players.cancelScheduled();
  expect(cancelQueued).not.toHaveBeenCalled();
});

it.each([false, true])('aborts only a phrase batch (sampler ready: %s), preserving backing on the same instrument', async readyFirst => {
  sf.instruments.length = 0;
  const players = new Players(); withFakeBusses(players);
  const response = new AbortController();
  const confirmed = vi.fn();
  const event = {time:0,note:60,duration:2,velocity:.8};
  players.scheduleAccompaniment(24, [event], 100, 120, confirmed, response.signal);
  players.scheduleAccompaniment(24, [{...event,note:64}], 100, 120);
  const voice = sf.instruments[0];
  const backing = sf.instruments[1];
  const phraseStop = vi.fn(); const backingStop = vi.fn();
  voice.start.mockImplementation((n: {note:number}) => n.note === 60 ? phraseStop : backingStop);
  backing.start.mockReturnValue(backingStop);
  backing.resolveReady(); await backing.ready;
  if (readyFirst) { voice.resolveReady(); await voice.ready; }
  response.abort();
  if (!readyFirst) { voice.resolveReady(); await voice.ready; }
  expect(voice.start.mock.calls.map((c: any[]) => c[0].note)).toEqual(readyFirst ? [60] : []);
  expect(backing.start).toHaveBeenCalledOnce();
  expect(phraseStop).toHaveBeenCalledTimes(readyFirst ? 1 : 0);
  expect(backingStop).not.toHaveBeenCalled();
  expect(voice.stop).not.toHaveBeenCalled();
  if (!readyFirst) expect(confirmed).not.toHaveBeenCalled();
});

it('silences phrase sources already promoted into native WebAudio lookahead even when sampler stop is ineffective', async () => {
  sf.instruments.length = 0;
  const players = new Players(); withFakeBusses(players);
  const response = new AbortController();
  players.scheduleAccompaniment(24, [{time:0,note:60,duration:2,velocity:.8}], 100, 120, undefined, response.signal);
  const phrase = sf.instruments[0];
  const disconnected = vi.spyOn(phrase.options.destination, 'disconnect');
  phrase.start.mockReturnValue(vi.fn()); // Native duration release makes smplr stop a no-op.
  phrase.resolveReady(); await phrase.ready;
  response.abort();
  expect(disconnected).toHaveBeenCalled();
});

it('reuses a fully ended response sampler without reloading its samples', async () => {
  sf.instruments.length = 0;
  const players = new Players(); withFakeBusses(players);
  const signal = new AbortController().signal;
  const event = {time:0,note:60,duration:2,velocity:.8};
  players.scheduleAccompaniment(24, [event], 100, 120, undefined, signal);
  const voice = sf.instruments[0];
  voice.start.mockReturnValue(vi.fn()); voice.resolveReady(); await voice.ready;
  voice.start.mock.calls[0][0].onEnded();
  players.scheduleAccompaniment(24, [event], 110, 120, undefined, signal);
  await Promise.resolve();
  expect(sf.instruments).toHaveLength(1);
  expect(voice.start).toHaveBeenCalledTimes(2);
  players.cancelScheduled();
});
