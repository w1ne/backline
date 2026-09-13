import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ instruments: [] as any[] }));
vi.mock('smplr', () => {
  const make = () => {
    let resolve!: () => void, reject!: (e: Error) => void;
    const inst = {ready: new Promise<void>((a,b) => {resolve=a;reject=b;}), start:vi.fn(), stop:vi.fn(), resolve:()=>resolve(), reject:()=>reject(new Error('offline'))};
    m.instruments.push(inst); return inst;
  };
  return {Soundfont:make, ElectricPiano:make, Mellotron:make, SplendidGrandPiano:make};
});
import { MidiMonitor } from './monitor';
beforeEach(() => {m.instruments.length=0;});
it('keeps the current voice until ready, ignores stale loads, and reuses loaded sounds', async () => {
  const monitor = new MidiMonitor({destination:{}} as AudioContext);
  const first = monitor.setSound('grand'); m.instruments[0].resolve(); await first;
  const second = monitor.setSound('wurlitzer');
  expect(m.instruments[0].stop).not.toHaveBeenCalled();
  const third = monitor.setSound('vibraphone'); m.instruments[2].resolve(); await third;
  expect(m.instruments[0].stop).toHaveBeenCalledTimes(1);
  m.instruments[1].resolve(); await second;
  expect(m.instruments[2].stop).not.toHaveBeenCalled();
  await monitor.setSound('grand');
  expect(m.instruments).toHaveLength(3);
  monitor.stop();
});
it('retains the current voice on a failed load and does not activate after stop', async () => {
  const monitor = new MidiMonitor({destination:{}} as AudioContext);
  const first = monitor.setSound('grand'); m.instruments[0].resolve(); await first;
  const failed = monitor.setSound('wurlitzer'); m.instruments[1].reject();
  await expect(failed).rejects.toThrow('offline');
  expect(m.instruments[0].stop).not.toHaveBeenCalled();
  const next = monitor.setSound('vibraphone'); monitor.stop(); m.instruments[2].resolve(); await next;
  const stops = m.instruments[2].stop.mock.calls.length;
  monitor.stop(); expect(m.instruments[2].stop).toHaveBeenCalledTimes(stops);
});
it('starts without Web MIDI without fetching unused keyboard samples', async () => {
  vi.stubGlobal('navigator', {});
  try {
    const monitor = new MidiMonitor({destination:{}} as AudioContext, 'grand');
    const started = monitor.start();
    expect(m.instruments).toHaveLength(0);
    await expect(started).resolves.toBeUndefined();
    monitor.stop();
  } finally {
    vi.unstubAllGlobals();
  }
});
it('treats a denied Web MIDI permission as no controller, not an error', async () => {
  vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.reject(new DOMException('nope', 'NotAllowedError')) });
  try {
    const monitor = new MidiMonitor({destination:{}} as AudioContext, 'grand');
    const started = monitor.start();
    expect(m.instruments).toHaveLength(0);
    await expect(started).resolves.toBeUndefined();
    monitor.stop();
  } finally {
    vi.unstubAllGlobals();
  }
});

it('loads the keyboard voice on real input hotplug and reports active load failures', async () => {
  const access = new EventTarget() as EventTarget & { inputs: Map<string, EventTarget> };
  access.inputs = new Map();
  vi.stubGlobal('navigator', { requestMIDIAccess: async () => access });
  try {
    const monitor = new MidiMonitor({destination:{}} as AudioContext, 'grand');
    const onError = vi.fn(); monitor.onError = onError;
    await monitor.start();
    expect(m.instruments).toHaveLength(0);
    const port = Object.assign(new EventTarget(), { id: 'keys', name: 'Keyboard', type: 'input', state: 'connected' });
    access.inputs.set('keys', port);
    access.dispatchEvent(Object.assign(new Event('statechange'), { port }));
    expect(m.instruments).toHaveLength(1);
    m.instruments[0].resolve(); await Promise.resolve(); await Promise.resolve();
    port.dispatchEvent(Object.assign(new Event('midimessage'), { data: new Uint8Array([0x90, 60, 100]) }));
    expect(m.instruments[0].start).toHaveBeenCalled();
    monitor.stop();
    access.inputs.clear();
    await monitor.start();
    access.inputs.set('keys', port);
    access.dispatchEvent(Object.assign(new Event('statechange'), { port }));
    m.instruments[1].reject(); await Promise.resolve(); await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'offline' }));
    monitor.stop();
  } finally { vi.unstubAllGlobals(); }
});
it('preloads for an attached keyboard and surfaces its sample failure', async () => {
  const port = Object.assign(new EventTarget(), { id: 'keys', name: 'Keyboard', type: 'input', state: 'connected' });
  const access = Object.assign(new EventTarget(), { inputs: new Map([['keys', port]]) });
  vi.stubGlobal('navigator', { requestMIDIAccess: async () => access });
  try {
    const monitor = new MidiMonitor({destination:{}} as AudioContext, 'grand');
    const started = monitor.start();
    const failure = expect(started).rejects.toThrow('offline');
    await Promise.resolve();
    expect(m.instruments).toHaveLength(1);
    m.instruments[0].reject(); await failure;
    monitor.stop();
  } finally { vi.unstubAllGlobals(); }
});
it('does not fetch keyboard samples for an ALSA MIDI Through port', async () => {
  const port = Object.assign(new EventTarget(), { id: 'through', name: 'Midi Through Port-0', type: 'input', state: 'connected' });
  const access = Object.assign(new EventTarget(), { inputs: new Map([['through', port]]) });
  vi.stubGlobal('navigator', { requestMIDIAccess: async () => access });
  try {
    const monitor = new MidiMonitor({destination:{}} as AudioContext, 'grand');
    await monitor.start();
    access.dispatchEvent(Object.assign(new Event('statechange'), { port }));
    expect(m.instruments).toHaveLength(0);
    monitor.stop();
  } finally { vi.unstubAllGlobals(); }
});
