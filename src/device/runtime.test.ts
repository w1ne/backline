import {describe,it,expect,vi} from 'vitest';
import {startDeviceRuntime} from './runtime';
import type {AccompPreset} from '../types';
import {Store} from '../ui/state';

describe('device accompaniment commands', () => {
  it('applies preset on/off commands through the same local UI action and acknowledges them', async () => {
    vi.useFakeTimers();
    const store = new Store();
    const toggleAccompPreset = vi.fn((preset: AccompPreset, on: boolean) => store.update({accompPresets:on
      ? [...store.state.accompPresets,preset] : store.state.accompPresets.filter(p=>p!==preset)}));
    const actions = {wake:vi.fn(),toggle:vi.fn(),setGenre:vi.fn(),setEngine:vi.fn(),setCreativity:vi.fn(),toggleAccompPreset};
    const fetchMock = vi.fn().mockImplementation(async (url: string) => ({ok:true,json:async()=>
      url.startsWith('/api/commands') ? {epoch:'test',commands:[
        {id:1,type:'accompPreset',preset:'guitar',on:true},
        {id:2,type:'accompPreset',preset:'strings',on:false},
        {id:3,type:'accompPreset',preset:'guitar',on:true},
      ]} : {ok:true}}));
    vi.stubGlobal('fetch', fetchMock);
    const stop = startDeviceRuntime(store,()=>actions,async()=>{});
    try {
      await vi.advanceTimersByTimeAsync(200);
      expect(toggleAccompPreset.mock.calls).toEqual([['guitar',true],['strings',false]]);
      expect(fetchMock).toHaveBeenCalledWith('/api/commands?ack=3&epoch=test',expect.any(Object));
    } finally { stop();vi.unstubAllGlobals();vi.useRealTimers(); }
  });
});
