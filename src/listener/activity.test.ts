import { describe, it, expect } from 'vitest';
import { ActivityTracker } from './activity';
import type { Dynamics } from '../types';

const BEAT = 0.5; // 120 bpm

/** Drives the tracker for `beats` beats from `t0`, feeding `onsetsPerBeat` evenly spaced
 *  onsets and a level sample per hop. Returns the frame from every beat. */
function run(
  tr: ActivityTracker,
  t0: number,
  beats: number,
  onsetsPerBeat: number,
  rms: number,
  beatFrom = 0,
): { t: number; frames: Dynamics[] } {
  const frames: Dynamics[] = [];
  let t = t0;
  for (let b = 0; b < beats; b++) {
    // spaced strictly inside the beat, so each one is counted by exactly one tick
    for (let i = 0; i < onsetsPerBeat; i++) tr.onset(t + ((i + 0.5) * BEAT) / onsetsPerBeat);
    for (let i = 0; i < 10; i++) tr.level(rms, t + (i * BEAT) / 10);
    t += BEAT;
    frames.push(tr.tick(beatFrom + b + 1, t));
  }
  return { t, frames };
}

describe('ActivityTracker intensity', () => {
  it('rises within one beat of busy playing', () => {
    const tr = new ActivityTracker();
    const { frames } = run(tr, 0, 1, 4, 0.3);
    expect(frames[0].intensity).toBeGreaterThan(0.5);
  });

  it('reaches near full after a couple of bars of dense playing', () => {
    const tr = new ActivityTracker();
    const { frames } = run(tr, 0, 8, 4, 0.3);
    expect(frames[7].intensity).toBeGreaterThan(0.9);
  });

  it('stays low for a player who is barely playing', () => {
    const tr = new ActivityTracker();
    // one onset every other beat, quiet
    const frames: Dynamics[] = [];
    let t = 0;
    for (let b = 0; b < 8; b++) {
      if (b % 2 === 0) tr.onset(t);
      for (let i = 0; i < 10; i++) tr.level(0.02, t);
      t += BEAT;
      frames.push(tr.tick(b + 1, t));
    }
    expect(frames[7].intensity).toBeLessThan(0.4);
  });

  it('decays over about eight beats after the player stops', () => {
    const tr = new ActivityTracker();
    const busy = run(tr, 0, 8, 4, 0.3);
    const peak = busy.frames[7].intensity;
    expect(peak).toBeGreaterThan(0.9);

    const quiet = run(tr, busy.t, 24, 0, 0, 8);
    // Not a cliff: still clearly audible one beat after stopping…
    expect(quiet.frames[0].intensity).toBeGreaterThan(0.7);
    // …about a third of the way down after one release time constant (8 beats)…
    expect(quiet.frames[7].intensity).toBeLessThan(peak * 0.5);
    expect(quiet.frames[7].intensity).toBeGreaterThan(peak * 0.2);
    // …and effectively gone after three.
    expect(quiet.frames[23].intensity).toBeLessThan(0.1);
  });
});

describe('ActivityTracker space', () => {
  it('opens once the player has been silent for 1.5 beats', () => {
    const tr = new ActivityTracker();
    const busy = run(tr, 0, 4, 2, 0.3);
    expect(busy.frames[3].space).toBe(false);

    const quiet = run(tr, busy.t, 3, 0, 0, 4);
    expect(quiet.frames[0].silenceBeats).toBeLessThan(1.5);
    expect(quiet.frames[0].space).toBe(false);
    expect(quiet.frames[1].silenceBeats).toBeGreaterThanOrEqual(1.5);
    expect(quiet.frames[1].space).toBe(true);
  });

  it('closes again on the next note', () => {
    const tr = new ActivityTracker();
    const busy = run(tr, 0, 2, 2, 0.3);
    const quiet = run(tr, busy.t, 3, 0, 0, 2);
    expect(quiet.frames[2].space).toBe(true);
    const back = run(tr, quiet.t, 1, 2, 0.3, 5);
    expect(back.frames[0].space).toBe(false);
  });

  it('stays shut before the player has played a single note', () => {
    const tr = new ActivityTracker();
    const { frames } = run(tr, 0, 8, 0, 0);
    expect(frames.every(f => f.space === false)).toBe(true);
    expect(frames.every(f => f.silenceBeats === 0)).toBe(true);
  });
});

describe('ActivityTracker fillDue', () => {
  it('fires only on the downbeat of bar 4 of each group, and only when quiet', () => {
    const tr = new ActivityTracker();
    // 16 beats of near-silence (one soft onset at the very start so the tracker is "live")
    tr.onset(0);
    const frames: Dynamics[] = [];
    let t = 0;
    for (let beat = 1; beat <= 16; beat++) {
      for (let i = 0; i < 10; i++) tr.level(0, t);
      t += BEAT;
      frames.push(tr.tick(beat, t));
    }
    const due = frames.map((f, i) => (f.fillDue ? i + 1 : -1)).filter(b => b > 0);
    // beats are 1-indexed here: beat 12 is the downbeat of bar 4 (absolute beat 12)
    expect(due).toEqual([12]);
  });

  it('does not fire while the player is busy', () => {
    const tr = new ActivityTracker();
    const { frames } = run(tr, 0, 16, 4, 0.3, 0);
    expect(frames.some(f => f.fillDue)).toBe(false);
  });
});

describe('ActivityTracker level reference', () => {
  it('treats a quiet player at full tilt the same as a loud one', () => {
    const loud = new ActivityTracker();
    const quiet = new ActivityTracker();
    run(loud, 0, 8, 3, 0.5);
    run(quiet, 0, 8, 3, 0.05);
    expect(Math.abs(loud.dynamics.intensity - quiet.dynamics.intensity)).toBeLessThan(0.05);
  });
});
