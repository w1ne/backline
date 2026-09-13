import { describe, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rampTo: vi.fn(), noise: vi.fn(), filter: vi.fn(), filterFreq: vi.fn() }));
vi.mock('tone', () => ({
  Gain: class { gain = {rampTo:mocks.rampTo}; toDestination(){return this;} connect(){return this;} disconnect(){return this;} dispose(){} },
  Noise: class { constructor(type:string){mocks.noise(type);} connect(){return this;} start(){return this;} dispose(){} },
  Filter: class { frequency = {rampTo:mocks.filterFreq}; constructor(options:unknown){mocks.filter(options);} connect(){return this;} dispose(){} },
  connect: (src:{connect:(d:unknown)=>unknown},dst:unknown)=>src.connect(dst),
}));
import { WhiteNoise } from './whiteNoise';
describe('white noise volume', () => {
  it('uses only white noise, clamps 0..1, and respects pause', () => {
    const noise = new WhiteNoise();
    noise.setLevel(.5);
    expect(mocks.noise).toHaveBeenCalledWith('white');
    expect(mocks.rampTo).toHaveBeenLastCalledWith(.025, .03);
    noise.setLevel(2);
    expect(mocks.rampTo).toHaveBeenLastCalledWith(.1, .03);
    noise.setLevel(-1);
    expect(mocks.rampTo).toHaveBeenLastCalledWith(0, .03);
    noise.setLevel(.7);
    noise.setEnabled(false);
    expect(mocks.rampTo).toHaveBeenLastCalledWith(0, .03);
    noise.setEnabled(true);
    expect(mocks.rampTo).toHaveBeenLastCalledWith(.7 * .7 * .1, .03);
    noise.setLevel(NaN);
    expect(mocks.rampTo).toHaveBeenLastCalledWith(0, .03);
  });

  it('filters the noise through a bandpass centered at the base frequency by default', () => {
    const noise = new WhiteNoise();
    noise.setLevel(.5);
    expect(mocks.filter).toHaveBeenCalledWith({ frequency: 800, type: 'bandpass', Q: 0.7 });
  });

  it('setRegister sweeps the filter by fractional octaves with a short glide, clamped to ±2', () => {
    const noise = new WhiteNoise();
    noise.setLevel(.5); // creates the filter/noise nodes
    noise.setRegister(1);
    expect(mocks.filterFreq).toHaveBeenLastCalledWith(1600, .05);
    noise.setRegister(-2);
    expect(mocks.filterFreq).toHaveBeenLastCalledWith(200, .05);
    noise.setRegister(-99);
    expect(mocks.filterFreq).toHaveBeenLastCalledWith(200, .05); // clamped, unchanged from -2
  });
});
