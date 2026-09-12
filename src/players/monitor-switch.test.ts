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
it('starts without Web MIDI (iOS Safari): the voice loads and no error is thrown', async () => {
  vi.stubGlobal('navigator', {});
  try {
    const monitor = new MidiMonitor({destination:{}} as AudioContext, 'grand');
    const started = monitor.start(); m.instruments[0].resolve();
    await expect(started).resolves.toBeUndefined();
    monitor.stop();
  } finally {
    vi.unstubAllGlobals();
  }
});
