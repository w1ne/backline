// @vitest-environment jsdom
import {describe,it,expect,vi} from 'vitest';
import {createRemoteActions, applyRemoteStatus, startRemoteUI} from './remote';
import {Store} from '../ui/state';
import {renderLive} from '../ui/live';

describe('shared Pi controller',()=>{
  it('uses the real live UI and forwards controls to the Pi',()=>{
    const store=new Store();store.update({power:'on'});
    const send=vi.fn();const root=document.createElement('div');
    document.body.append(root);
    const actions=createRemoteActions(send,store);
    renderLive(root,store,actions);
    const amount=root.querySelector<HTMLInputElement>('#intensity')!;
    amount.value='.7';amount.dispatchEvent(new Event('input'));
    expect(send).toHaveBeenCalledWith({type:'set',field:'intensity',value:.7});
    root.querySelector<HTMLButtonElement>('[data-inst="keys"]')!.click();
    expect(send).toHaveBeenCalledWith({type:'toggle',instrument:'keys'});
    actions.setKeyOverride?.({root:2,mode:'minor'});
    expect(send).toHaveBeenCalledWith({type:'key',key:{root:2,mode:'minor'}});
    expect(root.querySelector('#playback-target')?.textContent).toBe('Playback: Pi');
    expect(root.querySelectorAll('#sound option').length).toBe(6);
    root.remove();
  });
  it('waking the controller never starts local audio or changes Pi transport',()=>{
    const send=vi.fn();createRemoteActions(send,new Store()).wake();
    expect(send).not.toHaveBeenCalled();
  });
  it('hydrates the actual Pi state and marks stale state disconnected',()=>{
    const local=new Store();local.update({sound:'acoustic_guitar_nylon',creativity:.8});
    const remote=new Store();
    expect(applyRemoteStatus(remote,{online:true,state:local.state})).toBe(true);
    expect(remote.state.sound).toBe('acoustic_guitar_nylon');
    expect(remote.state.creativity).toBe(.8);
    expect(applyRemoteStatus(remote,{online:false,state:local.state})).toBe(false);
    expect(remote.state.error).toMatch(/disconnected/i);
  });
});

it('forwards preset selection from real remote tiles without altering role mutes', () => {
  const store = new Store();
  store.update({power:'on',engine:'amt',enabled:{drums:false,bass:false,keys:false,lead:false}});
  const send = vi.fn(); const root = document.createElement('div');
  const actions = createRemoteActions(send, store);
  renderLive(root, store, actions);
  root.querySelector<HTMLButtonElement>('[data-preset="sax"]')!.click();
  root.querySelector<HTMLButtonElement>('[data-preset="strings"]')!.click();
  expect(send.mock.calls).toEqual([
    [{type:'accompPreset',preset:'sax',on:true}],
    [{type:'accompPreset',preset:'strings',on:false}],
  ]);
  expect(store.state.enabled).toEqual({drums:false,bass:false,keys:false,lead:false});
});


it('keeps quick selections of different presets as independent remote commands', async () => {
  vi.useFakeTimers();
  const store = new Store(); store.update({power:'on',engine:'amt'});
  const commands: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/command') commands.push(JSON.parse(options!.body as string));
    return {ok:true,json:async()=>url==='/api/status'?{online:true,state:store.state}:{id:commands.length}};
  }));
  const root=document.createElement('div');
  const stop=startRemoteUI(root);
  try {
    await vi.advanceTimersByTimeAsync(0);
    root.querySelector<HTMLButtonElement>('[data-preset="sax"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-preset="orchestral"]')!.click();
    await vi.advanceTimersByTimeAsync(75);
    expect(commands).toEqual([{type:'accompPreset',preset:'sax',on:true},{type:'accompPreset',preset:'orchestral',on:true}]);
  } finally {stop();vi.unstubAllGlobals();vi.useRealTimers();}
});
