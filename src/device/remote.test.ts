// @vitest-environment jsdom
import {describe,it,expect,vi} from 'vitest';
import {createRemoteActions, applyRemoteStatus} from './remote';
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
