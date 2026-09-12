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
    const engine = new AmtEngine(players, notes, clock, nowFn, nowFn);
    return { players, notes, clock, engine };
  }

  it('does not call an empty or stale plan ready', async () => {
    const { engine } = mk();
    const ready = vi.fn(); engine.onFirstBlock = ready;
    engine.setEnabled('keys', true);
    await engine.start(120, 0);
    const ws = startedSocket(); ws.open();
    ws.receiveJson({type:'plan', notes:[]});
    ws.receiveJson({type:'plan', notes:[{beat:0,pitch:60,dur:1,vel:.5,voice:'keys'}]});
    expect(ready).not.toHaveBeenCalled();
    ws.receiveJson({type:'plan', notes:[{beat:4,pitch:60,dur:1,vel:.5,voice:'keys'}]});
    expect(ready).toHaveBeenCalledTimes(1);
    engine.stop();
  });

  it('plays the rhythm section with AMT and keeps lead out of busy phrases', async () => {
    const { engine, clock, players } = mk();
    engine.setEnabled('drums', true); engine.setEnabled('lead', true);
    await engine.start(100, 0);
    clock.tick(0, 1);
    expect(players.calls.some(c => c.i === 'drums' && c.events.length)).toBe(true);
    expect(players.calls.some(c => c.i === 'lead')).toBe(false);
    engine.set({ dynamics: {intensity:.3,space:true,fillDue:true,silenceBeats:2} });
    clock.tick(3, 8);
    expect(players.calls.some(c => c.i === 'lead' && c.events.length)).toBe(true);
    engine.stop();
  });

  it('applies band amount to model voices, with zero silent', async () => {
    const {engine,players} = mk(); engine.setEnabled('keys',true);
    await engine.start(120,0); startedSocket().open();
    engine.setAmount(0);
    startedSocket().receiveJson({type:'plan',notes:[{beat:4,pitch:60,dur:1,vel:.8,voice:'keys'}]});
    expect(players.calls).toHaveLength(0);
    engine.setAmount(.5);
    startedSocket().receiveJson({type:'plan',notes:[{beat:8,pitch:64,dur:1,vel:.8,voice:'keys'}]});
    expect(players.calls[0].events[0].velocity).toBeCloseTo(.4);
    engine.stop();
  });

  it('reports a stalled model socket without mistaking empty replies for failure', async () => {
    vi.useFakeTimers();
    const {engine,clock} = mk(); const error=vi.fn();engine.onError=error;
    await engine.start(120,0);startedSocket().open();clock.tick(1,2);
    vi.advanceTimersByTime(7000);
    startedSocket().receiveJson({type:'plan',notes:[]});
    vi.advanceTimersByTime(2000); expect(error).not.toHaveBeenCalled();
    clock.tick(2,4);vi.advanceTimersByTime(8100);expect(error).toHaveBeenCalled();
    engine.stop();vi.useRealTimers();
  });

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

  it('aligns performance-clock input with the audio-clock bar origin', async () => {
    const notes = new FakeNoteSource();
    const engine = new AmtEngine(new FakePlayers(), notes, new FakeClock(), () => 10, () => 1000);
    await engine.start(120, 11);
    const ws = startedSocket();
    ws.open();
    notes.fire({ midi: 60, velocity: 0.8, timeSec: 1001.5 });
    engine.flushNotesForTest();
    expect(ws.sent.find((m: any) => m.type === 'notes')).toMatchObject({
      notes: [{ beat: 1, pitch: 60 }],
    });
    engine.stop();
  });

  it('sends the last input batch before asking the model for a bar', async () => {
    const { engine, notes, clock } = mk();
    await engine.start(120, 0);
    const ws = startedSocket();
    ws.open();
    notes.fire({ midi: 60, velocity: 0.8, timeSec: 1.9 });
    clock.tick(1, 2);
    expect(ws.sent.slice(-2).map((m: any) => m.type)).toEqual(['notes', 'bar']);
    engine.stop();
  });

  it('does not carry unflushed or stopped-session input into a restart', async () => {
    const { engine, notes } = mk();
    await engine.start(120, 0);
    startedSocket().open();
    notes.fire({ midi: 60, velocity: 0.8, timeSec: 1 });
    engine.stop();
    notes.fire({ midi: 62, velocity: 0.8, timeSec: 2 });
    await engine.start(120, 3);
    const ws = startedSocket();
    ws.open();
    engine.flushNotesForTest();
    expect(ws.sent.some((m: any) => m.type === 'notes')).toBe(false);
    engine.stop();
  });

  it('schedules plan notes bar-relative, on the right voice', async () => {
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

  it('schedules a plan note a full bar ahead straight away, bar-relative', async () => {
    const { engine, players } = mk();
    now = 0;
    await engine.start(120, 0); // 0.5s/beat
    startedSocket().open();
    engine.setEnabled('bass', true);

    startedSocket().receiveJson({
      type: 'plan',
      fromBeat: 4,
      notes: [{ beat: 5, pitch: 40, dur: 1, vel: 0.9, voice: 'bass' }],
    });

    expect(players.calls).toHaveLength(1);
    expect(players.calls[0].i).toBe('bass');
    expect(players.calls[0].barStart).toBe(2); // bar 1 (beats 4-8) at 120bpm barSeconds=2
    expect(players.calls[0].events[0].time).toBeCloseTo(1); // beat 5 - bar*4(=4) = 1
  });

  // The regression this file exists for: the plan for the bar that has just started arrives
  // a fraction of a bar late, so most of it sits inside `currentBeat + commitBeats`. The old
  // commit-window gate handed exactly the notes in that span to Players (where the ones
  // already in the past were dropped) and made the rest wait — so the slower the server got,
  // the more of every bar went silent.
  it('schedules every still-playable note of a plan anchored at the current bar', async () => {
    const { engine, players } = mk();
    now = 4.2; // bar 2 started at beat 8 = t=4.0s; we are 0.4 beats into it
    await engine.start(120, 0);
    startedSocket().open();
    engine.setEnabled('keys', true);

    // A full bar of keys, anchored at the bar that just started (beats 8..12).
    const beats = [8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5];
    startedSocket().receiveJson({
      type: 'plan',
      fromBeat: 8,
      toBeat: 12,
      notes: beats.map(beat => ({ beat, pitch: 60, dur: 0.5, vel: 0.8, voice: 'keys' as const })),
    });

    const scheduled = players.calls.flatMap(c => c.events.map(e => c.barStart + e.time * 0.5));
    // beat 8 is at t=4.0, already 200ms in the past — unplayable, and counted as such.
    expect(engine.tooLate).toBe(1);
    // Everything from beat 8.5 (t=4.25) on is still in the future and must be scheduled now,
    // not left to a later poll.
    expect(scheduled).toEqual([4.25, 4.5, 4.75, 5, 5.25, 5.5, 5.75]);
    expect(players.calls.every(c => c.i === 'keys')).toBe(true);
  });

  it('does not re-schedule a note a later plan repeats', async () => {
    const { engine, players } = mk();
    now = 0;
    await engine.start(120, 0);
    startedSocket().open();
    engine.setEnabled('keys', true);

    const note = { beat: 5, pitch: 62, dur: 0.5, vel: 0.8, voice: 'keys' as const };
    startedSocket().receiveJson({ type: 'plan', fromBeat: 4, notes: [note] });
    startedSocket().receiveJson({ type: 'plan', fromBeat: 4, notes: [{ ...note }] });

    expect(players.calls.flatMap(c => c.events)).toHaveLength(1);
  });

  it('holds a muted voice pending and plays it when the voice comes back before its time', async () => {
    const { engine, players } = mk();
    now = 0;
    await engine.start(120, 0);
    startedSocket().open();
    // keys stays off for now.

    startedSocket().receiveJson({
      type: 'plan',
      fromBeat: 4,
      notes: [{ beat: 6, pitch: 67, dur: 0.5, vel: 0.8, voice: 'keys' }],
    });
    expect(players.calls).toHaveLength(0);

    now = 1.0; // beat 2, the note at beat 6 (t=3.0s) is still ahead
    engine.setEnabled('keys', true);
    engine.pollScheduleForTest();
    expect(players.calls).toHaveLength(1);
    expect(players.calls[0].events[0].note).toBe(67);
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

  it('ignores delayed events from the socket replaced by a tempo change', async () => {
    const { engine } = mk();
    engine.onError = vi.fn();
    await engine.start(100, 0);
    const old = startedSocket();
    engine.setBpm(110);
    old.emit('close', { reason: '' });
    old.emit('error', {});
    expect(engine.onError).not.toHaveBeenCalled();
    engine.stop();
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
