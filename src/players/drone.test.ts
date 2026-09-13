import { describe, it, expect, vi } from 'vitest';
const m = vi.hoisted(() => ({gain:vi.fn(), frequency:vi.fn(), oscillator:vi.fn()}));
vi.mock('tone',()=>({
 Gain:class {gain={rampTo:m.gain};toDestination(){return this;}connect(){return this;}disconnect(){return this;}dispose(){}},
 Oscillator:class {frequency={rampTo:m.frequency};constructor(options:unknown){m.oscillator(options);}connect(){return this;}start(){return this;}dispose(){}},
 connect:(src:{connect:(d:unknown)=>unknown},dst:unknown)=>src.connect(dst),
}));
import { Drone } from './drone';
describe('continuous drone',()=>{
 it('starts silent, uses a pitched tone, and keeps volume gentle and gated',()=>{
  const d=new Drone(); d.setLevel(0);expect(m.oscillator).not.toHaveBeenCalled();
  d.setLevel(1);expect(m.oscillator).toHaveBeenCalledWith({frequency:expect.closeTo(65.406,2),type:'triangle'});
  expect(m.gain).toHaveBeenLastCalledWith(.18,.08);
  d.setLevel(.5);expect(m.gain).toHaveBeenLastCalledWith(.045,.08);
  d.setEnabled(false);expect(m.gain).toHaveBeenLastCalledWith(0,.08);
  d.setEnabled(true);expect(m.gain).toHaveBeenLastCalledWith(.045,.08);
  d.setLevel(NaN);expect(m.gain).toHaveBeenLastCalledWith(0,.08);
 });
 it('glides to the detected key tonic in the low register',()=>{
  const d=new Drone();d.setLevel(.5);d.setRoot(9);
  expect(m.frequency).toHaveBeenLastCalledWith(110,.3);
 });
 it('setRegister shifts by fractional octaves with a short glide, clamped to ±2',()=>{
  const d=new Drone();d.setLevel(.5);
  d.setRegister(1);
  expect(m.frequency).toHaveBeenLastCalledWith(expect.closeTo(130.813,2),.05);
  d.setRegister(-1.5);
  expect(m.frequency).toHaveBeenLastCalledWith(expect.closeTo(23.125,2),.05);
  d.setRegister(99);
  expect(m.frequency).toHaveBeenLastCalledWith(expect.closeTo(261.626,2),.05); // clamped to +2
 });
});
