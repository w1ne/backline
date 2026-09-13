import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AceStepEngine, selectBlockInstruments, encodeMicFrame, MIC_FRAME_MAGIC, MIC_STREAM_RATE } from './acestepEngine';
import type { Instrument } from '../types';

const allOn: Record<Instrument, boolean> = { drums: true, bass: true, keys: true, lead: true };

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

  it('carries the last four distinct chords as a progression, without restarting playback', async () => {
    const engine = new AceStepEngine(ctx as unknown as AudioContext);
    engine.setEnabled('bass', true);
    await engine.start(100, 0);
    const ws = startedSocket();
    ws.open();
    ws.receiveBlock(1);
    const before = ws.sent.length;

    for (const chord of [
      { root: 9, quality: 'min' as const },
      { root: 9, quality: 'min' as const }, // repeat: same chord held, not a new entry
      { root: 5, quality: 'maj' as const },
      { root: 7, quality: 'maj' as const },
      { root: 0, quality: 'maj' as const },
    ])
      engine.set({ chord });

    // A chord change must never cut playback the way a key change does.
    expect(ws.sent.length).toBe(before);

    ws.receiveBlock(2);
    const last = ws.sent[ws.sent.length - 1] as { chords: string[] };
    expect(last.chords).toEqual(['Am', 'F', 'G', 'C']);
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

describe('selectBlockInstruments', () => {
  it('busy player (high intensity, no space) → rhythm section only, no fill', () => {
    const sel = selectBlockInstruments({ intensity: 0.8, space: false }, allOn);
    expect(sel.instruments).toEqual(['drums', 'bass']);
    expect(sel.fill).toBe(false);
    expect(sel.density).toBeGreaterThan(0.6);
  });

  it('medium player → drums, bass, keys; no lead, no fill', () => {
    const sel = selectBlockInstruments({ intensity: 0.45, space: false }, allOn);
    expect(sel.instruments).toEqual(['drums', 'bass', 'keys']);
    expect(sel.fill).toBe(false);
  });

  it('space → full set incl. guitar lead, marked as a fill', () => {
    const sel = selectBlockInstruments({ intensity: 0.9, space: true }, allOn);
    expect(sel.instruments).toEqual(['drums', 'bass', 'keys', 'lead']);
    expect(sel.fill).toBe(true);
    expect(sel.density).toBe(0);
  });

  it('soft playing still owns the melody; low intensity alone does not invite a fill', () => {
    const sel = selectBlockInstruments({ intensity: 0.1, space: false }, allOn);
    expect(sel.instruments).toEqual(['drums', 'bass', 'keys']);
    expect(sel.fill).toBe(false);
  });

  it('user-muted instruments are never added (hard mask)', () => {
    const enabled: Record<Instrument, boolean> = { drums: true, bass: false, keys: false, lead: false };
    // space would normally bring the full set incl. lead, but the mask wins.
    const sel = selectBlockInstruments({ intensity: 0.1, space: true }, enabled);
    expect(sel.instruments).toEqual(['drums']);
    // still flagged as a fill even though the muted lead cannot sound.
    expect(sel.fill).toBe(true);
  });

  it('busy with lead muted stays drums + bass', () => {
    const enabled: Record<Instrument, boolean> = { drums: true, bass: true, keys: true, lead: false };
    const sel = selectBlockInstruments({ intensity: 0.85, space: false }, enabled);
    expect(sel.instruments).toEqual(['drums', 'bass']);
  });
});


describe('encodeMicFrame', () => {
  it('decimates to 16 kHz PCM16 behind the MIC0 prefix', () => {
    const src = new Float32Array(4800);
    for (let i = 0; i < src.length; i++) src[i] = Math.sin((2 * Math.PI * 440 * i) / 48000);
    const frame = encodeMicFrame(src, 48000);
    expect(String.fromCharCode(...frame.slice(0, 4))).toBe(MIC_FRAME_MAGIC);
    expect((frame.length - 4) / 2).toBe(src.length / (48000 / MIC_STREAM_RATE));
    const pcm = new Int16Array(frame.buffer, 4, (frame.length - 4) / 2);
    let peak = 0;
    for (const v of pcm) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(30000);
    expect(peak).toBeLessThanOrEqual(32768);
  });
});
