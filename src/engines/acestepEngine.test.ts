import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AceStepEngine } from './acestepEngine';

/** Minimal fake AudioContext covering exactly what PcmPlayer/AceStepEngine touch. */
class FakeGainParam {
  value = 1;
  cancelScheduledValues = vi.fn();
  setValueAtTime = vi.fn((v: number) => {
    this.value = v;
  });
  linearRampToValueAtTime = vi.fn();
}
class FakeGainNode {
  gain = new FakeGainParam();
  connect = vi.fn();
  disconnect = vi.fn();
}
class FakeBufferSourceNode {
  buffer: unknown;
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}
class FakeAudioContext {
  currentTime = 0;
  createGain() {
    return new FakeGainNode() as unknown as GainNode;
  }
  createBufferSource() {
    return new FakeBufferSourceNode() as unknown as AudioBufferSourceNode;
  }
  createBuffer(channels: number, frames: number) {
    const channelsData: Float32Array[] = [];
    for (let i = 0; i < channels; i++) channelsData.push(new Float32Array(frames));
    return {
      duration: frames / 48000,
      getChannelData: (ch: number) => channelsData[ch],
    } as unknown as AudioBuffer;
  }
  destination = {} as AudioDestinationNode;
}

/** Fake WebSocket capturing every sent 'block' request and letting the test push replies. */
class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  binaryType = '';
  sent: unknown[] = [];
  listeners: Record<string, ((ev: unknown) => void)[]> = {};

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, cb: (ev: unknown) => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.emit('close', { reason: '' });
  }
  emit(type: string, ev: unknown) {
    (this.listeners[type] ?? []).forEach(cb => cb(ev));
  }
  open() {
    this.emit('open', {});
  }
  /** Simulate the server's single binary reply: 4-byte LE seq + PCM16 stereo. */
  receiveBlock(seq: number, frames = 10) {
    const buf = new ArrayBuffer(4 + frames * 2 * 2);
    new DataView(buf).setUint32(0, seq, true);
    this.emit('message', { data: buf });
  }
  receiveJson(msg: unknown) {
    this.emit('message', { data: JSON.stringify(msg) });
  }
  get blockRequests(): { seq: number; bpm: number; instruments: string[] }[] {
    return this.sent.filter((m): m is { type: string } => (m as { type: string }).type === 'block') as never;
  }
}

vi.stubGlobal('WebSocket', FakeWebSocket);

describe('AceStepEngine', () => {
  let ctx: FakeAudioContext;

  beforeEach(() => {
    ctx = new FakeAudioContext();
    FakeWebSocket.instances = [];
  });

  function startedSocket(): FakeWebSocket {
    return FakeWebSocket.instances[0];
  }

  it('requests block 1 with the given bpm/key/genre/instruments on start', async () => {
    const engine = new AceStepEngine(ctx as unknown as AudioContext);
    engine.set({ genre: 'funk', key: { root: 9, mode: 'minor' }, creativity: 0.5 });
    engine.setEnabled('drums', true);
    engine.setEnabled('bass', true);
    await engine.start(100, 0);
    startedSocket().open();

    const [req] = startedSocket().sent as Array<Record<string, unknown>>;
    expect(req).toMatchObject({
      type: 'block',
      seq: 1,
      bpm: 100,
      key: 'A minor',
      genre: 'funk',
      instruments: ['drums', 'bass'],
    });
  });

  it('pushes block 1 audio to the player and immediately requests seq 2', async () => {
    const engine = new AceStepEngine(ctx as unknown as AudioContext);
    await engine.start(100, 0);
    const ws = startedSocket();
    ws.open();

    ws.receiveBlock(1);

    expect(ws.sent.filter((m: unknown) => (m as { type: string }).type === 'block')).toHaveLength(2);
    expect((ws.sent[1] as { seq: number }).seq).toBe(2);
  });

  it('setEnabled before block 2 is requested excludes the disabled instrument', async () => {
    const engine = new AceStepEngine(ctx as unknown as AudioContext);
    engine.setEnabled('bass', true);
    engine.setEnabled('drums', true);
    await engine.start(100, 0);
    const ws = startedSocket();
    ws.open();

    engine.setEnabled('bass', false);
    ws.receiveBlock(1);

    const second = ws.sent[1] as { instruments: string[] };
    expect(second.instruments).not.toContain('bass');
    expect(second.instruments).toContain('drums');
  });

  it('setBpm cuts the player and sends a new higher-seq request with the new bpm', async () => {
    const engine = new AceStepEngine(ctx as unknown as AudioContext);
    await engine.start(100, 0);
    const ws = startedSocket();
    ws.open();
    ws.receiveBlock(1); // now 2 outstanding requests sent (seq 1, seq 2)

    const cutSpy = vi.spyOn(
      (engine as unknown as { player: { cut: () => void } }).player,
      'cut',
    );

    engine.setBpm(120);

    expect(cutSpy).toHaveBeenCalled();
    const blockMsgs = ws.sent.filter((m: unknown) => (m as { type: string }).type === 'block') as {
      seq: number;
      bpm: number;
    }[];
    const last = blockMsgs[blockMsgs.length - 1];
    expect(last.bpm).toBe(120);
    expect(last.seq).toBeGreaterThan(2);
  });

  it('ignores a stale block whose seq is below the latest requested after a restart', async () => {
    const engine = new AceStepEngine(ctx as unknown as AudioContext);
    await engine.start(100, 0);
    const ws = startedSocket();
    ws.open();
    ws.receiveBlock(1); // pushed; seq 2 now outstanding

    const pushSpy = vi.spyOn(
      (engine as unknown as { player: { push: () => void } }).player,
      'push',
    );

    engine.setBpm(120); // restarts: cuts, requests a fresh higher-seq block (e.g. seq 3)
    pushSpy.mockClear();

    // Stale reply for the old seq 2 request arrives after the restart.
    ws.receiveBlock(2);

    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('calls onError when the socket errors', async () => {
    const engine = new AceStepEngine(ctx as unknown as AudioContext);
    const onError = vi.fn();
    engine.onError = onError;
    await engine.start(100, 0);
    const ws = startedSocket();

    ws.emit('error', {});

    expect(onError).toHaveBeenCalledWith(expect.stringContaining('ACE'));
  });

  it('calls onFirstBlock exactly once, on the first received block', async () => {
    const engine = new AceStepEngine(ctx as unknown as AudioContext);
    const onFirstBlock = vi.fn();
    engine.onFirstBlock = onFirstBlock;
    await engine.start(100, 0);
    const ws = startedSocket();
    ws.open();

    ws.receiveBlock(1);
    ws.receiveBlock(2);

    expect(onFirstBlock).toHaveBeenCalledTimes(1);
  });

  it('stop closes the socket', async () => {
    const engine = new AceStepEngine(ctx as unknown as AudioContext);
    await engine.start(100, 0);
    const ws = startedSocket();
    ws.open();

    engine.stop();

    expect(ws.readyState).toBe(3);
  });
});
