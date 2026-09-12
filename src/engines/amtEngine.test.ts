import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AmtEngine } from './amtEngine';
import type { ClockLike } from '../band/clockTypes';
import type { Instrument, NoteEvent } from '../types';

class FakeClock implements ClockLike {
  cb?: (bar: number, t: number) => void;
  bpm = 0;
  started = false;
  stopped = false;
  start(bpm: number) {
    this.bpm = bpm;
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  onBar(cb: (bar: number, t: number) => void) {
    this.cb = cb;
  }
  setBpm(bpm: number) {
    this.bpm = bpm;
  }
  tick(bar: number, t: number) {
    this.cb?.(bar, t);
  }
}

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  sent: unknown[] = [];
  listeners: Record<string, ((ev: unknown) => void)[]> = {};
  closed = false;

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
    this.closed = true;
    this.readyState = 3;
    this.emit('close', { reason: '' });
  }
  emit(type: string, ev: unknown) {
    (this.listeners[type] ?? []).forEach(cb => cb(ev));
  }
  open() {
    this.emit('open', {});
  }
  receiveJson(msg: unknown) {
    this.emit('message', { data: JSON.stringify(msg) });
  }
}

class FakeNoteSource {
  cb?: (n: { midi: number; velocity: number; timeSec: number }) => void;
  onNote(cb: (n: { midi: number; velocity: number; timeSec: number }) => void) {
    this.cb = cb;
  }
  fire(n: { midi: number; velocity: number; timeSec: number }) {
    this.cb?.(n);
  }
}

class FakePlayers {
  calls: { i: Instrument; events: NoteEvent[]; barStart: number; bpm: number }[] = [];
  schedule(i: Instrument, events: NoteEvent[], barStart: number, bpm: number) {
    this.calls.push({ i, events, barStart, bpm });
  }
}

vi.stubGlobal('WebSocket', FakeWebSocket);

function startedSocket(): FakeWebSocket {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

describe('AmtEngine', () => {
  let now: number;
  const nowFn = () => now;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    now = 0;
  });

  function mk() {
    const players = new FakePlayers();
    const notes = new FakeNoteSource();
    const clock = new FakeClock();
    const engine = new AmtEngine(players, notes, clock, nowFn);
    return { players, notes, clock, engine };
  }

  it('sends a start message with lookahead/commit/listen beats on open', async () => {
    const { engine } = mk();
    engine.set({ genre: 'jazz', key: { root: 9, mode: 'minor' }, creativity: 0.4 });
    await engine.start(100, 0);
    startedSocket().open();

    expect(startedSocket().sent[0]).toMatchObject({
      type: 'start',
      bpm: 100,
      key: 'A minor',
      genre: 'jazz',
      lookaheadBeats: 4,
      commitBeats: 2,
      listenBeats: 8,
    });
  });

  it('forwards player notes with absolute beats computed from firstBarAt', async () => {
    const { engine, notes } = mk();
    now = 0;
    await engine.start(120, 0); // 120bpm: 0.5s/beat
    startedSocket().open();

    notes.fire({ midi: 60, velocity: 0.8, timeSec: 1 }); // beat 2
    notes.fire({ midi: 64, velocity: 0.6, timeSec: 1.5 }); // beat 3

    // Notes are batched; flush manually by invoking the private timer isn't accessible,
    // so drive it via the exposed flush path: wait isn't available in fake timers here,
    // so call stop/start is avoided — instead assert via a direct flush hook.
    engine.flushNotesForTest();

    const notesMsg = startedSocket().sent.find((m): m is { type: string; notes: unknown[] } => (m as { type: string }).type === 'notes');
    expect(notesMsg?.notes).toEqual([
      { beat: 2, pitch: 60, dur: 0.5, vel: 0.8 },
      { beat: 3, pitch: 64, dur: 0.5, vel: 0.6 },
    ]);
  });

  it('schedules plan notes bar-relative once inside the commit window, on the right voice', async () => {
    const { engine, players } = mk();
    now = 0;
    await engine.start(120, 0); // barSeconds = 2s, 4 beats/bar
    startedSocket().open();
    engine.setEnabled('keys', true);
    engine.setEnabled('bass', true);

    // now=0 -> currentBeat=0, commit boundary = 2. A note at beat 1 is inside the window.
    startedSocket().receiveJson({
      type: 'plan',
      fromBeat: 0,
      notes: [{ beat: 1, pitch: 64, dur: 1, vel: 0.7, voice: 'keys' }],
    });

    expect(players.calls).toHaveLength(1);
    expect(players.calls[0].i).toBe('keys');
    expect(players.calls[0].barStart).toBe(0);
    expect(players.calls[0].events).toEqual([{ time: 1, note: 64, duration: 1, velocity: 0.7 }]);
  });

  it('does not schedule (yet) a plan note beyond the commit boundary, then schedules it once time advances', async () => {
    const { engine, players } = mk();
    now = 0;
    await engine.start(120, 0); // 0.5s/beat, commit=2 beats -> boundary at beat 2
    startedSocket().open();
    engine.setEnabled('bass', true);

    startedSocket().receiveJson({
      type: 'plan',
      fromBeat: 0,
      notes: [{ beat: 5, pitch: 40, dur: 1, vel: 0.9, voice: 'bass' }],
    });
    expect(players.calls).toHaveLength(0);

    // Advance time so currentBeat + commit passes beat 5 (need currentBeat >= 3 -> t >= 1.5s)
    now = 1.6;
    engine.pollScheduleForTest();
    expect(players.calls).toHaveLength(1);
    expect(players.calls[0].i).toBe('bass');
    expect(players.calls[0].barStart).toBe(2); // bar 1 (beats 4-8) at 120bpm barSeconds=2
    expect(players.calls[0].events[0].time).toBeCloseTo(1); // beat 5 - bar*4(=4) = 1
  });

  function setFrames(ws: FakeWebSocket) {
    return ws.sent.filter(m => (m as { type: string }).type === 'set');
  }

  it('collapses repeated identical set() calls into a single set message', async () => {
    const { engine } = mk();
    await engine.start(100, 0);
    startedSocket().open();

    for (let i = 0; i < 200; i++) engine.set({ genre: 'lofi', creativity: 0.3 });
    engine.flushSetForTest();

    expect(setFrames(startedSocket())).toHaveLength(1);
  });

  it('sends at most one set message per 250ms while values keep changing', async () => {
    vi.useFakeTimers();
    try {
      const { engine } = mk();
      await engine.start(100, 0);
      startedSocket().open();

      // 40 distinct values over 400ms of wall time — one per 10ms, as the store churns.
      for (let i = 0; i < 40; i++) {
        engine.set({ creativity: i / 100 });
        vi.advanceTimersByTime(10);
      }
      vi.advanceTimersByTime(300); // let the trailing coalesced frame go out

      const frames = setFrames(startedSocket());
      expect(frames.length).toBeGreaterThanOrEqual(1);
      expect(frames.length).toBeLessThanOrEqual(3); // 400ms / 250ms, plus the trailing flush
      // The last frame carries the newest value, not a stale one.
      expect(frames[frames.length - 1]).toMatchObject({ type: 'set', creativity: 0.39 });
      engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends a set message again when a value actually changes', async () => {
    const { engine } = mk();
    await engine.start(100, 0);
    startedSocket().open();

    engine.set({ genre: 'jazz' });
    engine.flushSetForTest();
    engine.setEnabled('keys', true);
    engine.flushSetForTest();

    const frames = setFrames(startedSocket());
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ type: 'set', genre: 'jazz' });
    expect(frames[1]).toMatchObject({ type: 'set', instruments: { keys: true } });
  });

  it('stop closes the socket', async () => {
    const { engine } = mk();
    await engine.start(120, 0);
    const ws = startedSocket();
    ws.open();
    engine.stop();
    expect(ws.closed).toBe(true);
  });
});
