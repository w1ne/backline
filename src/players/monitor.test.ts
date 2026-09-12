import { describe, expect, it } from 'vitest';
import { parseNote } from './monitor';

describe('parseNote', () => {
  it('parses note on with velocity', () => {
    expect(parseNote(new Uint8Array([0x91, 60, 127]))).toEqual({ note: 60, velocity: 1, on: true });
  });
  it('treats note on with zero velocity as note off', () => {
    expect(parseNote(new Uint8Array([0x90, 60, 0]))).toEqual({ note: 60, velocity: 0, on: false });
  });
  it('parses note off', () => {
    expect(parseNote(new Uint8Array([0x80, 62, 40]))).toEqual({ note: 62, velocity: 0, on: false });
  });
  it('ignores control changes', () => {
    expect(parseNote(new Uint8Array([0xb0, 1, 100]))).toBeNull();
  });
});
