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

it('acknowledges failed actions once, continues later commands, and publishes the error', async () => {
  vi.useFakeTimers();
  const store = new Store();
  const toggle = vi.fn();
  const actions = {wake:vi.fn(),toggle,setGenre:vi.fn(),setEngine:vi.fn(),setCreativity:vi.fn()};
  const transport = vi.fn().mockRejectedValue(new Error('Invalid audio connection'));
  const fetchMock = vi.fn(async (url: string, _options?: RequestInit) => ({ok:true,json:async()=>
    url.startsWith('/api/commands') ? {epoch:'test',commands:[
      {id:1,type:'transport',playing:false},
      {id:2,type:'toggle',instrument:'keys'},
    ]} : {ok:true}}));
  vi.stubGlobal('fetch', fetchMock);
  const stop = startDeviceRuntime(store,()=>actions,transport);
  try {
    await vi.advanceTimersByTimeAsync(400);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(toggle.mock.calls).toEqual([['keys']]);
    expect(fetchMock).toHaveBeenCalledWith('/api/commands?ack=2&epoch=test',expect.any(Object));
    const statuses = fetchMock.mock.calls.filter(([url]) => url === '/api/status');
    expect(statuses.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(statuses[0][1]!.body as string).error).toBe('Device transport failed: Invalid audio connection');
  } finally { stop();vi.unstubAllGlobals();vi.useRealTimers(); }
});

it('still publishes status when retrieving commands fails', async () => {
  vi.useFakeTimers();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const actions = {wake:vi.fn(),toggle:vi.fn(),setGenre:vi.fn(),setEngine:vi.fn(),setCreativity:vi.fn()};
  const fetchMock = vi.fn(async (url: string) => {
    if (url.startsWith('/api/commands')) throw new Error('control timeout');
    return {ok:true};
  });
  vi.stubGlobal('fetch', fetchMock);
  const stop = startDeviceRuntime(new Store(),()=>actions,async()=>{});
  try {
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/status').length).toBeGreaterThanOrEqual(2);
  } finally { stop();warning.mockRestore();vi.unstubAllGlobals();vi.useRealTimers(); }
});
