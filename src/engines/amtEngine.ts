import * as Tone from 'tone';
import type { BandState, Instrument, Key, NoteEvent } from '../types';
import type { BandEngine } from './engine';
import { ToneClock } from '../band/clock';
import type { ClockLike } from '../band/clockTypes';
import type { PlayersLike } from '../band/bandleader';
import { RELAY_URL } from '../config';

const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BEATS_PER_BAR = 4;
const LOOKAHEAD_BEATS = 4;
const COMMIT_BEATS = 2;
const LISTEN_BEATS = 8;
const NOTE_BATCH_MS = 100;
const DEFAULT_NOTE_DUR_BEATS = 0.5;

function keyString(k: Key): string {
  return `${KEY_NAMES[k.root]} ${k.mode === 'major' ? 'major' : 'minor'}`;
}

interface PlanNote {
  beat: number;
  pitch: number;
  dur: number;
  vel: number;
  voice: 'keys' | 'bass';
}

/** Minimal notifier interface the engine needs from the app's Listener, kept narrow so
 *  tests can pass a fake without pulling in the real Listener. */
export interface NoteSource {
  onNote(cb: (n: { midi: number; velocity: number; timeSec: number }) => void): void;
}

/** Follows the player's notes through the AMT relay and plays the model's accompaniment
 *  plan back through the existing Tone.js Players (keys/bass voices). The server keeps a
 *  rolling lookahead/commit window; plan notes inside the commit window are frozen and are
 *  scheduled here only once they enter it (`lookahead - commit` beats early at most) — the
 *  simpler alternative to cancelling already-scheduled Tone events, which Players has no API
 *  for. */
export class AmtEngine implements BandEngine {
  readonly bpmStep = 2;
  onBar?: (bar: number) => void;
  onError?: (msg: string) => void;
  onFirstBlock?: () => void;

  private state: BandState = {
    genre: 'lofi',
    key: { root: 0, mode: 'major' },
    creativity: 0.3,
    enabled: { drums: false, bass: false, keys: false, lead: false },
  };
  private ws?: WebSocket;
  private clock: ClockLike;
  private bpm = 0;
  private firstBarAt = 0;
  private bar = 0;
  private stopping = false;
  private gotFirstNotes = false;

  private noteBuf: { beat: number; pitch: number; dur: number; vel: number }[] = [];
  private noteFlushTimer?: ReturnType<typeof setInterval>;
  private commitPollTimer?: ReturnType<typeof setInterval>;
  /** Plan notes not yet scheduled, keyed by bar they land in. */
  private pending: PlanNote[] = [];
  /** bar -> voice -> scheduled beats, so a later plan for the same bar doesn't re-schedule
   *  notes already committed to Players. */
  private scheduled = new Map<number, Set<'keys' | 'bass'>>();
  private detach?: () => void;

  constructor(
    private players: PlayersLike,
    private notes: NoteSource,
    clock: ClockLike = new ToneClock(),
    /** Returns "now" in the same time base as `firstBarAt`/note timestamps. Defaults to
     *  Tone's clock; tests inject a fake for determinism. */
    private now: () => number = () => Tone.now(),
  ) {
    this.clock = clock;
  }

  get changeLatencyMs(): number {
    if (!this.bpm) return 0;
    return (COMMIT_BEATS * 60000) / this.bpm;
  }

  async start(bpm: number, firstBarAt: number): Promise<void> {
    this.stopping = false;
    this.bpm = bpm;
    this.bar = 0;
    this.gotFirstNotes = false;
    this.firstBarAt = firstBarAt;
    this.pending = [];
    this.scheduled.clear();

    const wsUrl = RELAY_URL.replace(/^http/, 'ws') + '/amt';
    this.ws = new WebSocket(wsUrl);
    this.ws.addEventListener('open', () => {
      this.send({
        type: 'start',
        bpm: this.bpm,
        key: keyString(this.state.key),
        genre: this.state.genre,
        lookaheadBeats: LOOKAHEAD_BEATS,
        commitBeats: COMMIT_BEATS,
        listenBeats: LISTEN_BEATS,
      });
    });
    this.ws.addEventListener('message', ev => this.onMessage(ev));
    this.ws.addEventListener('error', () => {
      this.onError?.('AMT: connection error');
    });
    this.ws.addEventListener('close', ev => {
      if (this.stopping) return;
      this.onError?.(`AMT: closed${ev.reason ? ` (${ev.reason})` : ''}`);
    });

    this.clock.onBar((bar) => {
      this.bar = bar;
      this.send({ type: 'bar', bar });
      this.onBar?.(bar);
    });
    this.clock.start(bpm, firstBarAt);

    this.detach = undefined;
    this.notes.onNote(n => {
      const beat = ((n.timeSec - this.firstBarAt) * this.bpm) / 60;
      if (beat < 0) return;
      this.noteBuf.push({ beat, pitch: n.midi, dur: DEFAULT_NOTE_DUR_BEATS, vel: n.velocity });
    });

    this.noteFlushTimer = setInterval(() => this.flushNotes(), NOTE_BATCH_MS);
    this.commitPollTimer = setInterval(() => this.scheduleDue(), NOTE_BATCH_MS);
  }

  stop(): void {
    this.stopping = true;
    this.clock.stop();
    if (this.noteFlushTimer !== undefined) clearInterval(this.noteFlushTimer);
    this.noteFlushTimer = undefined;
    if (this.commitPollTimer !== undefined) clearInterval(this.commitPollTimer);
    this.commitPollTimer = undefined;
    this.ws?.close();
    this.ws = undefined;
    this.pending = [];
    this.scheduled.clear();
  }

  set(p: Partial<Pick<BandState, 'genre' | 'key' | 'creativity'>>): void {
    if (p.genre !== undefined) this.state.genre = p.genre;
    if (p.key !== undefined) this.state.key = p.key;
    if (p.creativity !== undefined) this.state.creativity = p.creativity;
    this.send({ type: 'set', genre: this.state.genre, creativity: this.state.creativity });
  }

  setEnabled(i: Instrument, on: boolean): void {
    this.state.enabled[i] = on;
  }

  setBpm(bpm: number): void {
    if (bpm === this.bpm) return;
    const firstBarAt = this.now() + 0.1;
    this.stop();
    this.start(bpm, firstBarAt).catch(err => {
      this.onError?.(`AMT: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** Current absolute beat position (fractional), used to decide which plan notes are
   *  inside the commit window. */
  private currentBeat(): number {
    return ((this.now() - this.firstBarAt) * this.bpm) / 60;
  }

  /** Test-only: force an immediate notes-batch flush instead of waiting for the timer. */
  flushNotesForTest(): void {
    this.flushNotes();
  }

  /** Test-only: force an immediate commit-window sweep instead of waiting for the timer. */
  pollScheduleForTest(): void {
    this.scheduleDue();
  }

  private flushNotes(): void {
    if (!this.noteBuf.length) return;
    this.send({ type: 'notes', notes: this.noteBuf.splice(0, this.noteBuf.length) });
  }

  /** Moves plan notes that have entered the commit window (beat < now + commit) from
   *  `pending` into Players.schedule. Notes further out stay pending until a later tick. */
  private scheduleDue(): void {
    if (!this.pending.length || !this.bpm) return;
    const boundary = this.currentBeat() + COMMIT_BEATS;
    const due = this.pending.filter(n => n.beat < boundary);
    if (!due.length) return;
    this.pending = this.pending.filter(n => n.beat >= boundary);

    const barSeconds = (60 / this.bpm) * BEATS_PER_BAR;
    const byBarVoice = new Map<string, PlanNote[]>();
    for (const n of due) {
      const barNum = Math.floor(n.beat / BEATS_PER_BAR);
      const key = `${barNum}:${n.voice}`;
      const list = byBarVoice.get(key) ?? [];
      list.push(n);
      byBarVoice.set(key, list);
    }
    for (const [key, list] of byBarVoice) {
      const [barNumStr, voice] = key.split(':') as [string, 'keys' | 'bass'];
      if (!this.state.enabled[voice]) continue;
      const barNum = Number(barNumStr);
      const barStart = this.firstBarAt + barNum * barSeconds;
      const events: NoteEvent[] = list.map(n => ({
        time: n.beat - barNum * BEATS_PER_BAR,
        note: n.pitch,
        duration: n.dur,
        velocity: n.vel,
      }));
      this.players.schedule(voice, events, barStart, this.bpm);
      const voices = this.scheduled.get(barNum) ?? new Set();
      voices.add(voice);
      this.scheduled.set(barNum, voices);
    }
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onMessage(ev: MessageEvent): void {
    let msg: { type: string; [k: string]: unknown };
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === 'error') {
      this.onError?.(`AMT: ${String(msg.message)}`);
      return;
    }
    if (msg.type === 'plan') {
      const notes = (msg.notes as PlanNote[] | undefined) ?? [];
      for (const n of notes) {
        const barNum = Math.floor(n.beat / BEATS_PER_BAR);
        // A bar already committed for this voice keeps whatever was scheduled for it —
        // Players has no way to cancel already-triggered Tone events.
        if (this.scheduled.get(barNum)?.has(n.voice)) continue;
        this.pending.push(n);
      }
      if (!this.gotFirstNotes) {
        this.gotFirstNotes = true;
        this.onFirstBlock?.();
      }
      this.scheduleDue();
    }
  }
}
