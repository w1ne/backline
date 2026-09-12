import { describe, it, expect } from 'vitest';
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
  return { out, busses };
}

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
