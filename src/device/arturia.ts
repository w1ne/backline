import type { LiveActions } from '../ui/live';
import type { Store } from '../ui/state';

export const LOCAL_SOUNDS = ['grand', 'electric_piano_1', 'drawbar_organ', 'acoustic_guitar_nylon', 'string_ensemble_1', 'vibraphone'] as const;
type Command = { field: 'sound'; value: string } | { field: 'noiseVolume' | 'droneVolume' | 'droneRegister' | 'noiseRegister' | 'bpm' | 'soundStep'; value: number };

export function arturiaCommand(port: string, data: ArrayLike<number>): Command | null {
  if (!/^minilab\s*3 midi$/i.test(port) || data.length < 2) return null;
  const kind = data[0] & 0xf0;
  if (kind === 0xc0 && data[1] < LOCAL_SOUNDS.length)
    return { field: 'sound', value: LOCAL_SOUNDS[data[1]] };
  if (kind !== 0xb0 || data.length < 3 || data[2] > 127 || data[2] < 0) return null;
  const value = data[2];
  const cc = ({28:114,86:74,87:71,89:76} as Record<number, number>)[data[1]] ?? data[1];
  if (cc === 114 && value !== 64 && value !== 0) return { field: 'soundStep', value: value > 64 ? 1 : -1 };
  if (cc === 74) return { field: 'noiseVolume', value: value / 127 };
  if (cc === 71) return { field: 'droneVolume', value: value / 127 };
  if (cc === 76) return { field: 'bpm', value: Math.round(60 + value * 100 / 127) };
  // Best-guess knob assignments (the two encoders the DAW template leaves either side of the
  // ones above) for the Register controls -- unverified against real hardware; if these turn
  // out to be the wrong physical knobs, remap the raw CC numbers here.
  if (cc === 88) return { field: 'droneRegister', value: value / 127 * 4 - 2 };
  if (cc === 90) return { field: 'noiseRegister', value: value / 127 * 4 - 2 };
  return null;
}

export function applyArturiaCommand(c: Command, state: {sound: string}, actions: LiveActions) {
  if (c.field === 'soundStep') {
    const index = LOCAL_SOUNDS.indexOf(state.sound as typeof LOCAL_SOUNDS[number]);
    actions.setSound?.(LOCAL_SOUNDS[(Math.max(0, index) + c.value + LOCAL_SOUNDS.length) % LOCAL_SOUNDS.length]);
  }
  if (c.field === 'sound' && c.value !== state.sound) actions.setSound?.(c.value);
  if (c.field === 'noiseVolume') actions.setNoiseVolume?.(c.value);
  if (c.field === 'droneVolume') actions.setDroneVolume?.(c.value);
  if (c.field === 'droneRegister') actions.setDroneRegister?.(c.value);
  if (c.field === 'noiseRegister') actions.setNoiseRegister?.(c.value);
  if (c.field === 'bpm') actions.setBpmOverride?.(c.value);
}

/** A separate subscription keeps controls available through transport pause/resume. */
export async function startArturiaControls(store: Store, actions: () => LiveActions) {
  if (!navigator.requestMIDIAccess) return () => {};
  const access = await navigator.requestMIDIAccess();
  const wired = new Set<MIDIInput>();
  let tempoTimer: ReturnType<typeof setTimeout> | undefined;
  const receive = (event: MIDIMessageEvent) => {
    const command = arturiaCommand((event.target as MIDIInput).name ?? '', event.data!);
    if (command?.field === 'bpm') {
      clearTimeout(tempoTimer);
      tempoTimer = setTimeout(() => applyArturiaCommand(command, store.state, actions()), 300);
    } else if (command) applyArturiaCommand(command, store.state, actions());
  };
  const connect = () => access.inputs.forEach(port => {
    if (!wired.has(port)) { port.addEventListener('midimessage', receive); wired.add(port); }
  });
  connect();
  access.addEventListener('statechange', connect);
  return () => {
    clearTimeout(tempoTimer);
    access.removeEventListener('statechange', connect);
    wired.forEach(port => port.removeEventListener('midimessage', receive));
  };
}
