import { describe, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rampTo: vi.fn(), noise: vi.fn() }));
vi.mock('tone', () => ({
  Gain: class { gain = {rampTo:mocks.rampTo}; toDestination(){return this;} connect(){return this;} disconnect(){return this;} dispose(){} },
  Noise: class { constructor(type:string){mocks.noise(type);} connect(){return this;} start(){return this;} dispose(){} },
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
});
