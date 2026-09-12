import { describe, it, expect } from 'vitest';
import { PlaybackActivity } from './activity';
describe('playback activity', () => {
  it('lights only while scheduled audio is due, and clears on restart', () => {
    const a = new PlaybackActivity();
    a.add('keys', [{time:2,note:60,duration:1,velocity:.5}], 10, 120);
    expect(a.at(10).keys).toBeUndefined();
    expect(a.at(11.1).keys).toBe(true);
    expect(a.at(12).keys).toBeUndefined();
    a.add('bass', [{time:0,note:36,duration:4,velocity:.5}], 12, 120);
    a.clear();
    expect(a.at(12.1)).toEqual({});
  });
});
