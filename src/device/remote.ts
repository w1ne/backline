import '../ui/styles.css';
import { renderLive, type LiveActions } from '../ui/live';
import { Store, type AppState } from '../ui/state';
import { LOCAL_SOUNDS } from './arturia';

type Command = Record<string, unknown>;

/** Same controls, different action destination. Never opens MIDI, mic, or an engine. */
export function createRemoteActions(send: (command: Command) => void, store: Store): LiveActions {
  const set = (field: string, value: unknown) => send({type:'set',field,value});
  return {
    playbackTarget:'Pi', soundIds:LOCAL_SOUNDS,
    wake:()=>{},
    setPlaying:playing=>send({type:'transport',playing}),
    toggle:instrument=>send({type:'toggle',instrument}),
    toggleAccompPreset:(preset,on)=>send({type:'accompPreset',preset,on}),
    setGenre:value=>set('genre',value), setEngine:value=>set('engine',value),
    setCreativity:value=>set('creativity',value), setIntensity:value=>set('intensity',value),
    setSound:value=>set('sound',value), setNoiseVolume:value=>set('noiseVolume',value),
    setDroneVolume:value=>set('droneVolume',value),
    setMicMuted:muted=>send({type:'mic',muted}),
    setBpmOverride:bpm=>send({type:'bpm',bpm:bpm??null}),
    setKeyOverride:key=>send({type:'key',key:key??null}),
    get changeLatencyMs() { return store.state.input.bpm ? 120000/store.state.input.bpm : 0; },
  };
}

export function applyRemoteStatus(store: Store, packet: {online?: boolean; state?: AppState}): boolean {
  if (!packet.online || !packet.state) {
    store.update({error:'Pi disconnected · reconnecting…'});
    return false;
  }
  store.update(packet.state);
  return true;
}

export function startRemoteUI(root: HTMLElement): () => void {
  const store = new Store();
  let online = false, stopped = false, sending = false, sequence = 0;
  let commandError: string | null = null;
  const pending = new Map<string, Command>();
  let pollTimer: ReturnType<typeof setTimeout>;
  let sendTimer: ReturnType<typeof setTimeout> | undefined;
  const drain = async () => {
    if (sending || stopped || !online) return;
    sending = true;
    try {
      while (pending.size && online && !stopped) {
        const [key, command] = pending.entries().next().value!;
        pending.delete(key);
        const r = await fetch('/api/command', {method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify(command),signal:AbortSignal.timeout(3000)});
        if (!r.ok) throw new Error((await r.json()).error || 'Pi command failed');
        commandError = null;
      }
    } catch (e) {
      // Do not replay toggles after an ambiguous network failure.
      pending.clear();
      commandError = e instanceof Error ? e.message : String(e);
      draw();
    } finally { sending = false; }
  };
  const actions = createRemoteActions(command => {
    if (!online) return;
    const key = command.type === 'toggle' ? `toggle:${sequence++}` : `${command.type}:${command.field??command.preset??''}`;
    pending.set(key,command);
    if (sendTimer === undefined) sendTimer = setTimeout(()=>{sendTimer=undefined;void drain();},75);
  }, store);
  const draw = () => {
    renderLive(root,store,actions);
    root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select')
      .forEach(el=>{ if (!online) el.disabled=true; else if (el.id !== 'mic-mute') el.disabled=false; });
    root.querySelectorAll<HTMLElement>('[role="slider"]').forEach(el=>{
      el.setAttribute('aria-disabled',String(!online)); el.tabIndex=online?0:-1;
    });
    if (commandError) root.querySelector<HTMLElement>('#live-pill')!.textContent=commandError;
  };
  const poll = async () => {
    try {
      const r = await fetch('/api/status',{signal:AbortSignal.timeout(3000),cache:'no-store'});
      if (!r.ok) throw new Error('Pi status unavailable');
      online = applyRemoteStatus(store,await r.json());
    } catch { online=false; applyRemoteStatus(store,{}); }
    if (!online) pending.clear();
    if (!stopped) { draw(); pollTimer=setTimeout(poll,300); }
  };
  draw(); void poll();
  return ()=>{stopped=true;pending.clear();clearTimeout(pollTimer);clearTimeout(sendTimer);};
}
