import { describe, it, expect } from 'vitest';
import {
  BARS_VISIBLE,
  NOW_FRAC,
  NoteRing,
  PITCH_MAX,
  PITCH_MIN,
  drumLane,
  logSpacedBins,
  pitchToY,
  pxPerSecond,
  timeToX,
} from './viz';
import { DRUM } from '../types';

describe('timeToX', () => {
  const left = 20;
  const width = 400;
  const pps = 2;

  it('puts "now" at NOW_FRAC across the plot', () => {
    expect(timeToX(10, 10, pps, left, width)).toBeCloseTo(left + width * NOW_FRAC);
  });

  it('places upcoming notes to the right of the playhead and past notes to the left', () => {
    const nowX = timeToX(10, 10, pps, left, width);
    expect(timeToX(11, 10, pps, left, width)).toBeGreaterThan(nowX);
    expect(timeToX(9, 10, pps, left, width)).toBeLessThan(nowX);
  });

  it('scrolls right to left: the same note moves left as time advances', () => {
    const at0 = timeToX(12, 10, pps, left, width);
    const at1 = timeToX(12, 10.5, pps, left, width);
    expect(at1).toBeLessThan(at0);
    expect(at0 - at1).toBeCloseTo(0.5 * pps);
  });

  it('spans exactly one pixel per second per pps', () => {
    expect(timeToX(13, 10, pps, left, width) - timeToX(10, 10, pps, left, width)).toBeCloseTo(3 * pps);
  });
});

describe('pxPerSecond', () => {
  it('fits BARS_VISIBLE bars of 4/4 into the plot width', () => {
    const pps = pxPerSecond(480, 120);
    const barSec = 2; // 120 bpm => 0.5 s a beat
    expect(pps * barSec * BARS_VISIBLE).toBeCloseTo(480);
  });

  it('scales with tempo', () => {
    expect(pxPerSecond(480, 180)).toBeCloseTo(pxPerSecond(480, 90) * 2);
  });
});

describe('pitchToY', () => {
  it('maps the top of the range to the top edge and the bottom to the bottom edge', () => {
    expect(pitchToY(PITCH_MAX, 10, 110)).toBeCloseTo(10);
    expect(pitchToY(PITCH_MIN, 10, 110)).toBeCloseTo(110);
  });

  it('is monotonic: higher pitch is higher on screen', () => {
    expect(pitchToY(72, 10, 110)).toBeLessThan(pitchToY(60, 10, 110));
  });

  it('clamps notes outside 36..96', () => {
    expect(pitchToY(12, 10, 110)).toBeCloseTo(110);
    expect(pitchToY(127, 10, 110)).toBeCloseTo(10);
  });

  it('puts middle C halfway up the range', () => {
    expect(pitchToY(66, 0, 120)).toBeCloseTo(60);
  });
});

describe('drumLane', () => {
  it('gives each drum voice its own lane, cymbals up top and kick at the bottom', () => {
    const lanes = [DRUM.crash, DRUM.openHat, DRUM.hat, DRUM.snare, DRUM.kick].map(drumLane);
    expect(lanes).toEqual([0, 1, 2, 3, 4]);
  });

  it('parks unknown drum notes on a middle lane instead of off the strip', () => {
    expect(drumLane(99)).toBe(2);
  });
});

describe('NoteRing', () => {
  it('keeps notes in insertion order', () => {
    const ring = new NoteRing(4);
    ring.add('you', 60, 1, 0.5, 0.9);
    ring.add('bass', 40, 2, 0.5, 0.7);
    expect(ring.length).toBe(2);
    expect(ring.at(0).midi).toBe(60);
    expect(ring.at(1).source).toBe('bass');
    expect(ring.at(0).end).toBeCloseTo(1.5);
  });

  it('never grows past capacity and drops the oldest note first', () => {
    const ring = new NoteRing(4);
    for (let i = 0; i < 10; i++) ring.add('keys', 60 + i, i, 0.1, 1);
    expect(ring.length).toBe(4);
    expect(ring.at(0).midi).toBe(66);
    expect(ring.at(3).midi).toBe(69);
  });

  it('reuses its slots instead of allocating per note', () => {
    const ring = new NoteRing(2);
    ring.add('you', 60, 0, 1, 1);
    const slot = ring.at(0);
    ring.add('you', 61, 1, 1, 1);
    ring.add('you', 62, 2, 1, 1);
    ring.add('you', 63, 3, 1, 1);
    // the first slot has been rewritten twice over but is still the same object
    expect(ring.at(0)).toBe(slot);
    expect(slot.midi).toBe(62);
  });

  it('prunes notes that finished before the cutoff', () => {
    const ring = new NoteRing(8);
    ring.add('drums', 36, 0, 0.2, 1); // ends 0.2
    ring.add('drums', 38, 1, 0.2, 1); // ends 1.2
    ring.add('drums', 42, 2, 0.2, 1); // ends 2.2
    ring.prune(1);
    expect(ring.length).toBe(2);
    expect(ring.at(0).midi).toBe(38);
  });

  it('keeps a note that is still sounding at the cutoff', () => {
    const ring = new NoteRing(8);
    ring.add('lead', 72, 0, 4, 1);
    ring.prune(2);
    expect(ring.length).toBe(1);
  });

  it('stops pruning at the first note worth keeping, even if a later one is stale', () => {
    const ring = new NoteRing(8);
    ring.add('keys', 60, 10, 1, 1); // scheduled ahead, pushed first
    ring.add('you', 64, 0, 0.1, 1); // played now, pushed after
    ring.prune(5);
    expect(ring.length).toBe(2);
  });

  it('clears back to empty', () => {
    const ring = new NoteRing(4);
    ring.add('you', 60, 0, 1, 1);
    ring.clear();
    expect(ring.length).toBe(0);
  });

  it('drops notes with a negative duration to a zero-length pill', () => {
    const ring = new NoteRing(2);
    ring.add('you', 60, 3, -1, 1);
    expect(ring.at(0).end).toBe(3);
  });
});

describe('logSpacedBins', () => {
  const sampleRate = 48000;
  const fftSize = 2048;
  const hzPerBin = sampleRate / fftSize; // 23.4375 Hz

  it('returns one edge per requested step', () => {
    expect(logSpacedBins(49, 60, 8000, sampleRate, fftSize).length).toBe(49);
  });

  it('starts at the 60 Hz bin and ends at the 8 kHz bin', () => {
    const edges = logSpacedBins(49, 60, 8000, sampleRate, fftSize);
    expect(edges[0]).toBe(Math.round(60 / hzPerBin));
    expect(edges[48]).toBe(Math.round(8000 / hzPerBin));
  });

  it('is monotonically non-decreasing', () => {
    const edges = logSpacedBins(49, 60, 8000, sampleRate, fftSize);
    for (let i = 1; i < edges.length; i++) expect(edges[i]).toBeGreaterThanOrEqual(edges[i - 1]);
  });

  it('spaces logarithmically: later bands cover more bins than early ones', () => {
    const edges = logSpacedBins(49, 60, 8000, sampleRate, fftSize);
    expect(edges[48] - edges[47]).toBeGreaterThan(edges[1] - edges[0]);
  });

  it('never exceeds the analyser bin count', () => {
    const edges = logSpacedBins(49, 60, 20000, sampleRate, fftSize);
    expect(edges[48]).toBeLessThanOrEqual(fftSize / 2 - 1);
  });

  it('handles a sample rate where the low edge falls below the first bin', () => {
    const edges = logSpacedBins(10, 1, 8000, sampleRate, fftSize);
    expect(edges[0]).toBe(0);
    expect(edges.every(e => e >= 0)).toBe(true);
  });
});
