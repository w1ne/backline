import { describe, it, expect, vi } from 'vitest';

const calls = vi.hoisted(() => ({ connect: [] as [unknown, unknown][], disconnect: [] as [unknown, unknown][] }));

vi.mock('tone', () => {
  class FakeNode {
    dispose = vi.fn();
    connect = vi.fn((dest: unknown) => {
      calls.connect.push([this, dest]);
      return this;
    });
    disconnect = vi.fn((dest: unknown) => {
      calls.disconnect.push([this, dest]);
      return this;
    });
  }
  return {
    Filter: class extends FakeNode {
      constructor(public freq: number, public type: string) {
        super();
      }
    },
    Compressor: class extends FakeNode {
      constructor(public opts: unknown) {
        super();
      }
    },
    Gain: class extends FakeNode {
      constructor(public gain: number) {
        super();
      }
    },
    dbToGain: (db: number) => 10 ** (db / 20),
    connect: (src: { connect: (d: unknown) => unknown }, dst: unknown) => src.connect(dst),
    disconnect: (src: { disconnect: (d: unknown) => unknown }, dst: unknown) => src.disconnect(dst),
  };
});

import { VocalChain, VOCAL_HPF_HZ, VOCAL_COMPRESSOR, VOCAL_TRIM_DB } from './vocalChain';

function fakeInputNode() {
  return { connect: vi.fn(), disconnect: vi.fn() } as unknown as never;
}

describe('VocalChain', () => {
  it('builds mic -> hpf -> compressor -> trim, with the documented settings', () => {
    calls.connect.length = 0;
    const mic = { connect: vi.fn(), disconnect: vi.fn() };
    const reverb = fakeInputNode();
    const master = fakeInputNode();
    const chain = new VocalChain(mic as unknown as never, reverb, master);
    expect(chain).toBeTruthy();
    expect(mic.connect).toHaveBeenCalledWith(expect.any(Object));
    // two internal Tone-side hops: hpf->compressor, compressor->trim
    expect(calls.connect.length).toBe(2);
  });

  it('starts disabled: the trim never reaches the reverb bus or the master chain until enabled', () => {
    calls.connect.length = 0;
    const chain = new VocalChain(fakeInputNode(), fakeInputNode(), fakeInputNode());
    const connectsAfterBuild = calls.connect.length;
    expect(chain.isEnabled()).toBe(false);
    chain.setEnabled(true);
    expect(calls.connect.length).toBe(connectsAfterBuild + 2); // trim->reverb, trim->master
    expect(chain.isEnabled()).toBe(true);
  });

  it('setEnabled is idempotent — calling it twice with the same value makes no extra connections', () => {
    const chain = new VocalChain(fakeInputNode(), fakeInputNode(), fakeInputNode());
    chain.setEnabled(true);
    const n = calls.connect.length;
    chain.setEnabled(true);
    expect(calls.connect.length).toBe(n);
  });

  it('disabling disconnects the trim from both destinations', () => {
    const chain = new VocalChain(fakeInputNode(), fakeInputNode(), fakeInputNode());
    chain.setEnabled(true);
    calls.disconnect.length = 0;
    chain.setEnabled(false);
    expect(calls.disconnect.length).toBe(2);
    expect(chain.isEnabled()).toBe(false);
  });

  it('dispose disables first, then tears down every node it built', () => {
    const chain = new VocalChain(fakeInputNode(), fakeInputNode(), fakeInputNode());
    chain.setEnabled(true);
    chain.dispose();
    expect(chain.isEnabled()).toBe(false);
  });

  it('uses the documented level trim, high-pass corner and compressor settings', () => {
    expect(VOCAL_TRIM_DB).toBe(-6);
    expect(VOCAL_HPF_HZ).toBe(90);
    expect(VOCAL_COMPRESSOR).toEqual({ threshold: -20, ratio: 2.5, attack: 0.005, release: 0.12 });
  });
});

/** A native AudioNode throws on targeted disconnect of a missing edge; disconnect()
 * without a target, as MicSource.stop uses, removes all current graph edges. */
function nativeMicNode() {
  const destinations = new Set<unknown>();
  return {
    destinations,
    connect: vi.fn((destination: unknown) => { destinations.add(destination); }),
    disconnect: vi.fn((destination?: unknown) => {
      if (destination === undefined) { destinations.clear(); return; }
      if (!destinations.delete(destination)) throw new DOMException('The given destination is not connected', 'InvalidAccessError');
    }),
  };
}

it('finishes vocal teardown when the listener already disconnected its shared microphone source', () => {
  const mic = nativeMicNode();
  const chain = new VocalChain(mic as unknown as never, fakeInputNode(), fakeInputNode());
  const filter = mic.connect.mock.calls[0][0] as {dispose:ReturnType<typeof vi.fn>};
  chain.setEnabled(true);
  mic.disconnect();
  expect(() => chain.dispose()).not.toThrow();
  expect(chain.isEnabled()).toBe(false);
  expect(filter.dispose).toHaveBeenCalledOnce();
});

it('vocal teardown owns only its graph edge and is idempotent across repeated power-off', () => {
  const mic = nativeMicNode();
  const listenerAnalysis = {};
  mic.connect(listenerAnalysis);
  const chain = new VocalChain(mic as unknown as never, fakeInputNode(), fakeInputNode());
  const filter = mic.connect.mock.calls[1][0] as {dispose:ReturnType<typeof vi.fn>};
  chain.dispose();
  expect(() => chain.dispose()).not.toThrow();
  expect(filter.dispose).toHaveBeenCalledOnce();
  expect(mic.destinations).toEqual(new Set([listenerAnalysis]));
  chain.setEnabled(true);
  expect(chain.isEnabled()).toBe(false);
});
