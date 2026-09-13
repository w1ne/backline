import { describe, expect, it } from 'vitest';
import { groupClips, listSongs } from './songs';

describe('stitched song list', () => {
  it('groups clips by singer and song in clip order', () => {
    const g = groupClips(['amy_15_03', 'amy_15_01', 'amy_4_01', 'leon_8_10', 'leon_8_2']);
    expect([...g.keys()].sort()).toEqual(['amy_15', 'amy_4', 'leon_8']);
    expect(g.get('amy_15')).toEqual(['amy_15_01', 'amy_15_03']);
    expect(g.get('leon_8')).toEqual(['leon_8_2', 'leon_8_10']);
  });
  it('takes consecutive clips until 30 s and drops groups under 20 s', () => {
    const names = ['a_1_01', 'a_1_02', 'a_1_03', 'a_1_04', 'b_1_01', 'b_1_02'];
    const songs = listSongs(c => (c.startsWith('a') ? 12 : 8), names);
    expect(songs).toEqual([{ name: 'a_1', clips: ['a_1_01', 'a_1_02', 'a_1_03'] }]);
  });
});
