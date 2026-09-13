import type { PerformanceEvent } from '../listener/performanceEvent';
import * as Tone from 'tone';
import type { AccompPreset, BandState, Chord, Instrument, Key, NoteEvent } from '../types';
import { IDLE_DYNAMICS } from '../types';
import { chordName, parseChordName } from '../listener/chordDetector';
import type { FormResult, Section } from '../band/form';
import type { BandEngine, EngineStatusStats } from './engine';
import { ToneClock } from '../band/clock';
import type { ClockLike } from '../band/clockTypes';
import { Bandleader, type PlayersLike } from '../band/bandleader';
import { RELAY_URL } from '../config';
import { PATTERNS } from '../patterns';

const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BEATS_PER_BAR = 4;
// Two beats: with half-bar commits at ~240 ms cue-to-plan the model has a beat of slack, and
// the harmony brain lands the chord on the downbeat 62% of bars at 2 vs 50% at 4 (HARMONY_BENCH.md).
const LOOKAHEAD_BEATS = 2;
const COMMIT_BEATS = 2;
const LISTEN_BEATS = 8;
const NOTE_BATCH_MS = 100;
const MAX_BUFFERED_NOTES = 512;
const DEFAULT_NOTE_DUR_BEATS = 0.5;
/** How far in the future a plan note has to land to be worth handing to Players: Tone needs a
 *  strictly future start time, and Players itself drops anything inside 5 ms of now. */
const MIN_LEAD_SEC = 0.02;
/** Beats of scheduling history kept for the dedupe key set. Two bars of slack past the
 *  server's own commit horizon is plenty; the rest is just memory. */
const DEDUPE_WINDOW_BEATS = 32;
/** Upper bound on how often a `set` frame goes out, however fast the store churns. */
const SET_THROTTLE_MS = 250;

function keyString(k: Key): string {
  return `${KEY_NAMES[k.root]} ${k.mode === 'major' ? 'major' : 'minor'}`;
}

/** The clock the local drums' Bandleader subscribes to. It never runs on its own: the engine
 *  fires it from its own bar handler, so the drums sit on exactly the grid the plan is cued on. */
class DrivenClock implements ClockLike {
  private cb?: (bar: number, t: number) => void;
  bpm = 0;
  onBar(cb: (bar: number, t: number) => void): void { this.cb = cb; }
  start(bpm: number): void { this.bpm = bpm; }
  stop(): void {}
  setBpm(bpm: number): void { this.bpm = bpm; }
  fire(bar: number, t: number): void { this.cb?.(bar, t); }
}

interface PlanNote {
  beat: number;
  pitch: number;
  dur: number;
  vel: number;
  voice: 'keys' | 'bass' | 'lead';
  /** Preserve the model instrument within any melodic role. */
  gmInstr?: number;
  captureTimeSec?: number;
  phraseSignal?: AbortSignal;
}

/** Minimal notifier interface the engine needs from the app's Listener, kept narrow so
 *  tests can pass a fake without pulling in the real Listener. */
export interface NoteSource {
  onPerformance?(cb: (e: PerformanceEvent) => void): void | (() => void);
  onNote(cb: (n: { midi: number; velocity: number; timeSec: number }) => void): void | (() => void);
}

/** Follows the player's notes through the AMT relay and plays the model's accompaniment
 *  plan back through the existing Tone.js Players (keys/bass voices).
 *
 *  Every note in a `plan` frame is already committed server-side: the window it covers starts
 *  at the server's monotonic commit horizon and is never rewritten by a later plan. So the
 *  client schedules each plan note as soon as it arrives, as long as its absolute time is at
 *  least `MIN_LEAD_SEC` in the future, and de-duplicates by voice+beat+pitch instead of
 *  re-deriving a commit window of its own. Gating on `currentBeat + commitBeats` the way this
 *  used to meant a plan that arrived less than `commitBeats` before its own first note had the
 *  front of that plan handed to Players in the past, where Players dropped it — so the slower
 *  the server got, the more of each bar went silent. */
export class AmtEngine implements BandEngine {
  readonly bpmStep = 2;
  onBar?: (bar: number) => void;
  onError?: (msg: string) => void;
  onFirstBlock?: () => void;
  onConnected?: () => void;
  onStatus?: (message: string, latencyMs?: number, stats?: EngineStatusStats) => void;
  onResponseTiming?: (estimatedMs: number | null) => void;
  private lastResponseCapture = -Infinity;
  private lastResponseEstimate = Infinity;
  private responseTimings = new Map<number, number>();
  private timingFlushPending = false;
  onChord?: (chord: Chord, fromBeat: number) => void;
  onSection?: (section: Section) => void;
  /** The local drums' own song form (see `drums`), bar by bar. */
  onForm?: (bar: number, form: FormResult) => void;
  private amount = 1;
  private responseTimer?: ReturnType<typeof setTimeout>;
  setAmount(value: number): void {
    this.amount = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    this.players.setBandAmount?.(this.amount);
    this.queueSet();
  }
  private get velocityAmount(): number { return this.players.setBandAmount ? 1 : this.amount; }
  /** The model plays keys, bass and lead; the drums are the pattern band's, run through a real
   *  Bandleader (humanize, fills, arrangement, chord timeline) with only drums enabled. */
  private drums: Bandleader;
  private drumClock = new DrivenClock();

  private state: BandState = {
    genre: 'lofi',
    key: { root: 0, mode: 'major' },
    chord: null,
    creativity: 0.3,
    enabled: { drums: false, bass: false, keys: false, lead: false },
    dynamics: { ...IDLE_DYNAMICS },
  };
  private accompPresets: AccompPreset[] = [];
  private accompBias = 2.0;
  private ws?: WebSocket;
  private clock: ClockLike;
  private bpm = 0;
  private firstBarAt = 0;
  private bar = 0;
  private stopping = false;
  private gotFirstNotes = false;
  /** Set by the server's `ready {tick:true}`: it plans per half bar from `tick` cues. Until
   *  then (and against an older server, forever) the engine cues with `bar` once a bar. */
  private tickCapable = false;
  private performanceCapable = false;
  private cueId = 0;
  private latestCaptureTimeSec?: number;
  private releaseBuf: { id: string; dur: number; captureTimeSec: number }[] = [];
  /** Timer fallback for the half-bar cue, only for a clock without `onHalfBar`. */
  private halfBarTimer?: ReturnType<typeof setTimeout>;
  /** Wall-clock send time of each cue still awaiting its plan, by cueId. */
  private cueSentAt = new Map<number, number>();
  /** cueId of the last plan received, so the following `status` can be matched to its cue. */
  private lastPlanCueId?: number;
  /** Last measured client<->server hop (cue-to-plan minus the server's own request age), ms.
   *  Sent with every tick so the server can size its generation deadline; undefined until
   *  the first plan has come back. */
  private rttMs?: number;

  private noteBuf: { beat: number; pitch: number; dur: number; vel: number; id?: string; source?: string; confidence?: number; captureTimeSec?: number; held?: boolean }[] = [];
  private noteFlushTimer?: ReturnType<typeof setInterval>;
  private commitPollTimer?: ReturnType<typeof setInterval>;
  /** Last `set` payload the server was actually told, and the throttle bookkeeping for it. */
  private lastSetPayload?: string;
  private pendingSet?: string;
  private setTimer?: ReturnType<typeof setTimeout>;
  private lastSetAt = 0;
  /** Plan notes held back because their voice is muted — kept so that un-muting mid-bar picks
   *  the rest of the bar up instead of playing into a hole. */
  private pending: PlanNote[] = [];
  /** voice:beat:pitch -> beat, so a plan note already handed to Players is never scheduled
   *  twice. Pruned to `DEDUPE_WINDOW_BEATS` behind the playhead. */
  private scheduled = new Map<string, number>();
  /** Plan notes that arrived too late to play (their time was already past). Diagnostic. */
  tooLate = 0;
  private detach?: () => void;
  private inputSession = 0;
  private phraseController = new AbortController();
  private heldNotes = new Set<string>();
  private legacyOnsetAt = -Infinity;
  private latestOnsetCapture = -Infinity;

  /** Each onset invalidates the entire outstanding answer, including sampler loads
   * and native scheduled starts. Backing batches never receive this signal. */
  private interruptPhrase(): void {
    this.phraseController.abort();
    this.phraseController = new AbortController();
    this.pending = this.pending.filter(n => !n.phraseSignal);
  }

  constructor(
    private players: PlayersLike,
    private notes: NoteSource,
    clock: ClockLike = new ToneClock(),
    /** Returns "now" in the same time base as `firstBarAt`/note timestamps. Defaults to
     *  Tone's clock; tests inject a fake for determinism. */
    private now: () => number = () => Tone.getContext().currentTime,
    /** Listener timestamps use performance time, independently of AudioContext startup. */
    private inputNow: () => number = () => performance.now() / 1000,
    private outputDelayMs: () => number = () => 0,
  ) {
    this.clock = clock;
    this.drums = new Bandleader(this.drumClock, {
      schedule: (i, events, t, bpm) => {
        if (!this.amount) return;
        this.players.schedule(i, events.map(e => ({ ...e, velocity: e.velocity * this.velocityAmount })), t, bpm);
      },
    }, PATTERNS, undefined, this.now);
    this.drums.onFormCb = (bar, form) => this.onForm?.(bar, form);
  }

  get changeLatencyMs(): number {
    if (!this.bpm) return 0;
    return (COMMIT_BEATS * 60000) / this.bpm;
  }

  async start(bpm: number, firstBarAt: number): Promise<void> {
    this.interruptPhrase();
    this.heldNotes.clear();
    this.legacyOnsetAt = -Infinity;
    this.latestOnsetCapture = -Infinity;
    this.stopping = false;
    this.lastResponseCapture = -Infinity;
    this.lastResponseEstimate = Infinity;
    this.responseTimings.clear();
    this.timingFlushPending = false;
    this.onResponseTiming?.(null);
    this.players.setBandAmount?.(this.amount);
    for (const i of ['drums', 'bass', 'keys', 'lead'] as const) this.players.setEnabled?.(i, this.state.enabled[i]);
    this.onStatus?.('Listening');
    this.bpm = bpm;
    this.bar = 0;
    this.gotFirstNotes = false;
    this.tickCapable = false;
    this.performanceCapable = false;
    this.cueId = 0;
    this.latestCaptureTimeSec = undefined;
    this.releaseBuf = [];
    this.firstBarAt = firstBarAt;
    this.noteBuf = [];
    this.pending = [];
    this.scheduled.clear();
    this.tooLate = 0;
    this.cueSentAt.clear();
    this.lastPlanCueId = undefined;
    this.rttMs = undefined;
    // A fresh socket means a fresh server session, so nothing has been told to it yet.
    this.lastSetPayload = undefined;
    this.lastSetAt = 0;

    const wsUrl = RELAY_URL.replace(/^http/, 'ws') + '/amt';
    const ws = this.ws = new WebSocket(wsUrl);
    ws.addEventListener('open', () => {
      if (this.ws !== ws || this.stopping) return;
      this.send({
        type: 'start',
        bpm: this.bpm,
        key: keyString(this.state.key),
        genre: this.state.genre,
        lookaheadBeats: LOOKAHEAD_BEATS,
        commitBeats: COMMIT_BEATS,
        listenBeats: LISTEN_BEATS,
        phraseResponses: true,
        enabledRoles: { keys: this.state.enabled.keys, bass: this.state.enabled.bass, lead: this.state.enabled.lead },
        accompInstruments: this.effectiveAccompPresets,
        accompBias: this.accompBias,
      });
      this.queueSet();
      this.flushSet();
      this.onConnected?.();
    });
    ws.addEventListener('message', ev => { if (this.ws === ws && !this.stopping) this.onMessage(ev); });
    ws.addEventListener('error', () => {
      if (this.ws !== ws || this.stopping) return;
      this.onError?.('AMT: connection error');
    });
    ws.addEventListener('close', ev => {
      if (this.ws !== ws || this.stopping) return;
      this.onError?.(`AMT: closed${ev.reason ? ` (${ev.reason})` : ''}`);
    });

    this.clock.onBar((bar, time) => {
      if (bar === 0) this.firstBarAt = time;
      this.bar = bar;
      this.onBar?.(bar);
      this.cue(bar, bar * BEATS_PER_BAR);
      // The second half-bar cue: one bar of lead time for the model, a half bar of commit. It
      // comes from the clock's transport (see onHalfBar below); the timer is only for a clock
      // without one, and a browser clamps it to a second in a background tab.
      if (!this.clock.onHalfBar) {
        if (this.halfBarTimer !== undefined) clearTimeout(this.halfBarTimer);
        const halfBarAt = time + (COMMIT_BEATS * 60) / this.bpm;
        this.halfBarTimer = setTimeout(() => {
          this.halfBarTimer = undefined;
          if (this.stopping) return;
          this.cue(bar, bar * BEATS_PER_BAR + COMMIT_BEATS);
        }, Math.max(0, (halfBarAt - this.now()) * 1000));
      }
      this.drumClock.fire(bar, time);
    });
    this.clock.onHalfBar?.(bar => {
      if (this.stopping) return;
      this.cue(bar, bar * BEATS_PER_BAR + COMMIT_BEATS);
    });
    this.drums.start(bpm, firstBarAt);
    this.clock.start(bpm, firstBarAt);

    this.detach?.();
    const session = ++this.inputSession;
    const inputOffset = this.now() - this.inputNow();
    this.detach = this.notes.onPerformance ? this.notes.onPerformance(e => {
      if (this.stopping || session !== this.inputSession) return;
      this.latestCaptureTimeSec = e.timeSec;
      if (e.type === 'note_off') {
        this.heldNotes.delete(e.id);
        if (e.durationSec !== undefined) {
          this.releaseBuf.push({ id: e.id, dur: e.durationSec * this.bpm / 60, captureTimeSec: e.timeSec });
          this.flushNotes();
        }
        return;
      }
      this.latestOnsetCapture = e.timeSec;
      this.heldNotes.add(e.id);
      this.interruptPhrase();
      const beat = ((e.timeSec + inputOffset - this.firstBarAt) * this.bpm) / 60;
      if (beat < 0) return;
      this.noteBuf.push({ id: e.id, beat, pitch: e.midi, dur: DEFAULT_NOTE_DUR_BEATS,
        vel: e.velocity, source: e.source, confidence: e.confidence, captureTimeSec: e.timeSec, held: true });
      this.flushNotes();
    }) || undefined : this.notes.onNote(n => {
      if (this.stopping || session !== this.inputSession) return;
      this.legacyOnsetAt = this.now();
      this.latestOnsetCapture = n.timeSec;
      this.latestCaptureTimeSec = n.timeSec;
      this.interruptPhrase();
      const beat = ((n.timeSec + inputOffset - this.firstBarAt) * this.bpm) / 60;
      if (beat < 0) return;
      this.noteBuf.push({ beat, pitch: n.midi, dur: DEFAULT_NOTE_DUR_BEATS, vel: n.velocity });
    }) || undefined;

    this.noteFlushTimer = setInterval(() => this.flushNotes(), NOTE_BATCH_MS);
    this.commitPollTimer = setInterval(() => this.scheduleDue(), NOTE_BATCH_MS);
  }

  stop(): void {
    this.stopping = true;
    this.interruptPhrase();
    this.heldNotes.clear();
    this.responseTimings.clear();
    this.timingFlushPending = false;
    this.onResponseTiming?.(null);
    this.players.cancelScheduled?.();
    this.players.setBandAmount?.(1);
    for (const i of ['drums', 'bass', 'keys', 'lead'] as const) this.players.setEnabled?.(i, true);
    clearTimeout(this.responseTimer);
    this.responseTimer = undefined;
    clearTimeout(this.halfBarTimer);
    this.halfBarTimer = undefined;
    ++this.inputSession;
    this.detach?.();
    this.detach = undefined;
    this.noteBuf = [];
    this.releaseBuf = [];
    this.drums.stop();
    this.clock.stop();
    if (this.noteFlushTimer !== undefined) clearInterval(this.noteFlushTimer);
    this.noteFlushTimer = undefined;
    if (this.commitPollTimer !== undefined) clearInterval(this.commitPollTimer);
    this.commitPollTimer = undefined;
    if (this.setTimer !== undefined) clearTimeout(this.setTimer);
    this.setTimer = undefined;
    this.pendingSet = undefined;
    this.lastSetPayload = undefined;
    this.ws?.close();
    this.ws = undefined;
    this.pending = [];
    this.scheduled.clear();
  }

  set(p: Partial<Pick<BandState, 'genre' | 'key' | 'chord' | 'creativity' | 'dynamics'>> & { chordBeat?: number }): void {
    if (p.dynamics !== undefined) this.state.dynamics = p.dynamics;
    if (p.genre !== undefined) this.state.genre = p.genre;
    if (p.key !== undefined) this.state.key = p.key;
    // The model follows actual notes; detected harmony also anchors the supporting bass.
    if (p.chord !== undefined) this.state.chord = p.chord;
    if (p.creativity !== undefined) this.state.creativity = p.creativity;
    this.drums.set(p);
    this.queueSet();
  }

  setEnabled(i: Instrument, on: boolean): void {
    this.state.enabled[i] = on;
    if (i === 'drums') this.drums.setEnabled(i, on);
    this.players.setEnabled?.(i, on);
    this.queueSet();
  }

  /** The visible Guitar role directly requests the model's guitar voice. Other
   * preset selections remain intact, including explicit selections while muted. */
  private get effectiveAccompPresets(): AccompPreset[] {
    return this.state.enabled.lead ? [...new Set([...this.accompPresets, 'guitar' as const])] : this.accompPresets;
  }

  setAccompaniment(presets: AccompPreset[], accompBias: number): void {
    this.accompPresets = presets;
    this.accompBias = accompBias;
    this.queueSet();
  }

  /** The store re-emits on every update, and `set()` used to put a frame on the wire for each
   *  one — 1255 `set` messages in 40 seconds of playing. Send only when the payload actually
   *  differs from what the server was last told, and never more than once per
   *  `SET_THROTTLE_MS`; changes arriving inside that window are coalesced into one frame
   *  carrying the latest values. */
  private queueSet(): void {
    const payload = JSON.stringify({
      type: 'set',
      genre: this.state.genre,
      key: keyString(this.state.key),
      chord: this.state.chord ? chordName(this.state.chord) : null,
      space: this.state.dynamics.space,
      creativity: this.state.creativity,
      amount: this.amount,
      instruments: { ...this.state.enabled },
      enabledRoles: { keys: this.state.enabled.keys, bass: this.state.enabled.bass, lead: this.state.enabled.lead },
      // Dynamics hint; the manual amount also scales local playback directly.
      intensity: Math.round(this.state.dynamics.intensity * 5) / 5,
      accompInstruments: this.effectiveAccompPresets,
      accompBias: this.accompBias,
      silenceBeats: this.state.dynamics.silenceBeats,
    });
    if (payload === this.lastSetPayload) {
      // Back to what the server already has — drop anything queued in between.
      this.pendingSet = undefined;
      return;
    }
    this.pendingSet = payload;
    if (this.setTimer !== undefined) return;
    const wait = SET_THROTTLE_MS - (Date.now() - this.lastSetAt);
    if (wait <= 0) {
      this.flushSet();
      return;
    }
    this.setTimer = setTimeout(() => {
      this.setTimer = undefined;
      this.flushSet();
    }, wait);
  }

  private flushSet(): void {
    const payload = this.pendingSet;
    if (payload === undefined) return;
    if (payload === this.lastSetPayload) {
      this.pendingSet = undefined;
      return;
    }
    // Socket not open yet: keep it pending, the `open` handler flushes it.
    if (!this.sendRaw(payload)) return;
    this.pendingSet = undefined;
    this.lastSetPayload = payload;
    this.lastSetAt = Date.now();
  }

  /** Test-only: force an immediate `set` flush instead of waiting for the throttle timer. */
  flushSetForTest(): void {
    this.flushSet();
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
    // An unavailable socket must not retain an unbounded performance history.
    if (this.noteBuf.length > MAX_BUFFERED_NOTES) this.noteBuf.splice(0, this.noteBuf.length - MAX_BUFFERED_NOTES);
    if (this.releaseBuf.length > MAX_BUFFERED_NOTES) this.releaseBuf.splice(0, this.releaseBuf.length - MAX_BUFFERED_NOTES);
    if (this.noteBuf.length && this.sendRaw(JSON.stringify({ type: 'notes', notes: this.noteBuf }))) this.noteBuf = [];
    if (this.performanceCapable && this.releaseBuf.length && this.sendRaw(JSON.stringify({ type: 'note_updates', notes: this.releaseBuf }))) this.releaseBuf = [];
  }

  /** Asks the server for the next plan: `tick {beat}` at every half bar when it has said it
   *  plans per half bar, else the old `bar {bar}` at downbeats only. The latest input and
   *  controls go out first so the plan answers what was actually just played. */
  private cue(bar: number, beat: number): void {
    const msg = this.tickCapable ? { type: 'tick', beat }
      : beat === bar * BEATS_PER_BAR ? { type: 'bar', bar } : undefined;
    if (!msg) return;
    this.flushSet();
    this.flushNotes();
    const cueId = ++this.cueId;
    const sent = this.sendRaw(JSON.stringify({ ...msg, cueId, latestCaptureTimeSec: this.latestCaptureTimeSec,
      ...(this.rttMs !== undefined ? { rttMs: this.rttMs } : {}) }));
    if (sent) {
      this.cueSentAt.set(cueId, Date.now());
      // A cue whose plan never came (superseded server-side) must not pin memory for the set.
      for (const id of this.cueSentAt.keys()) if (id < cueId - 8) this.cueSentAt.delete(id);
    }
    if (sent && this.responseTimer === undefined) {
      this.responseTimer = setTimeout(() => {
        this.responseTimer = undefined;
        this.onError?.('AMT: model response timed out');
      }, 8000);
    }
  }

  private static noteKey(n: PlanNote): string {
    return `${n.voice}:${n.gmInstr ?? ''}:${n.beat.toFixed(4)}:${n.pitch}`;
  }

  /** Hands every pending plan note that can still be played to Players, grouped by the bar it
   *  lands in (Players schedules bar-relative). A note whose voice is muted stays pending; a
   *  note whose absolute time has already gone by is counted and dropped, because Players
   *  would drop it anyway and it would otherwise be retried on every tick. */
  private scheduleDue(): void {
    if (!this.pending.length || !this.bpm) return;
    const spb = 60 / this.bpm;
    const barSeconds = spb * BEATS_PER_BAR;
    const minTime = this.now() + MIN_LEAD_SEC;

    const keep: PlanNote[] = [];
    const byBarVoice = new Map<string, PlanNote[]>();
    for (const n of this.pending) {
      if (n.phraseSignal?.aborted) continue;
      if (this.firstBarAt + n.beat * spb < minTime) {
        this.tooLate++;
        continue;
      }
      if (!this.amount) continue;
      if (!this.state.enabled[n.voice]) {
        keep.push(n);
        continue;
      }
      const barNum = Math.floor(n.beat / BEATS_PER_BAR);
      // Notes on the 'keys' voice with different gmInstr are different real instruments
      // (see gmInstruments.ts) and must reach separate Players.scheduleAccompaniment() calls.
      const key = `${barNum}:${n.voice}:${n.gmInstr ?? ''}:${n.phraseSignal ? 'phrase' : 'backing'}`;
      const list = byBarVoice.get(key) ?? [];
      list.push(n);
      byBarVoice.set(key, list);
    }
    this.pending = keep;

    for (const [key, list] of byBarVoice) {
      const [barNumStr, voice, gmInstrStr] = key.split(':') as [string, 'keys' | 'bass' | 'lead', string];
      const barNum = Number(barNumStr);
      const barStart = this.firstBarAt + barNum * barSeconds;
      const events: NoteEvent[] = list.map(n => ({
        time: n.beat - barNum * BEATS_PER_BAR,
        note: n.pitch,
        duration: n.dur,
        velocity: n.vel * this.velocityAmount,
      }));
      const session = this.inputSession;
      const signal = list[0].phraseSignal;
      const original = new Map(events.map((event, i) => [event, list[i]]));
      const onScheduled = (accepted: readonly NoteEvent[]) => {
        if (signal?.aborted || this.stopping || session !== this.inputSession || !this.amount || !this.state.enabled[voice]) return;
        if (!accepted.length) return;
        if (!this.gotFirstNotes) {
          this.gotFirstNotes = true;
          this.onFirstBlock?.();
        }
        this.onStatus?.('Playing');
        for (const event of accepted) {
          const note = original.get(event);
          if (!note || !(event.velocity > 0) || note.captureTimeSec === undefined) continue;
          this.queueResponseTiming(note.captureTimeSec, barStart + event.time * spb, session);
        }
      };
      const gmInstr = gmInstrStr ? Number(gmInstrStr) : undefined;
      if (gmInstr !== undefined && this.players.scheduleAccompaniment) {
        this.players.scheduleAccompaniment(gmInstr, events, barStart, this.bpm, onScheduled, signal);
      } else {
        this.players.schedule(voice, events, barStart, this.bpm, onScheduled);
      }
      for (const n of list) this.scheduled.set(AmtEngine.noteKey(n), n.beat);
    }
  }

  /** Coalesce synchronous role callbacks; asynchronous sample loads may refine
   * the same capture's estimate downward when an earlier note becomes playable. */
  private queueResponseTiming(capture: number, audioTime: number, session: number): void {
    if (capture < this.lastResponseCapture) return;
    const captureAudio = capture + this.now() - this.inputNow();
    const estimate = (audioTime - captureAudio) * 1000 + this.outputDelayMs();
    if (!Number.isFinite(estimate) || estimate < 0) return;
    this.responseTimings.set(capture, Math.min(estimate, this.responseTimings.get(capture) ?? Infinity));
    if (this.timingFlushPending) return;
    this.timingFlushPending = true;
    void Promise.resolve().then(() => {
      if (this.stopping || session !== this.inputSession) return;
      this.timingFlushPending = false;
      if (!this.responseTimings.size) return;
      const latest = Math.max(...this.responseTimings.keys());
      const best = this.responseTimings.get(latest)!;
      this.responseTimings.clear();
      if (latest > this.lastResponseCapture || (latest === this.lastResponseCapture && best < this.lastResponseEstimate - .01)) {
        this.lastResponseCapture = latest;
        this.lastResponseEstimate = best;
        this.onResponseTiming?.(best);
      }
    });
  }

  /** The hop for the plan that just arrived: wall time from its cue to now, minus the time
   *  the server itself held the request. The `status` frame follows its `plan`, which carries
   *  the cueId, so this runs on the status. */
  private measureRtt(serverMs: number): void {
    if (this.lastPlanCueId === undefined) return;
    const sentAt = this.cueSentAt.get(this.lastPlanCueId);
    this.cueSentAt.delete(this.lastPlanCueId);
    this.lastPlanCueId = undefined;
    if (sentAt === undefined) return;
    const hop = Date.now() - sentAt - serverMs;
    if (Number.isFinite(hop)) this.rttMs = Math.max(0, Math.round(hop));
  }

  /** Keeps the dedupe key set from growing for the length of the session. */
  private pruneScheduled(): void {
    const cutoff = this.currentBeat() - DEDUPE_WINDOW_BEATS;
    if (cutoff <= 0) return;
    for (const [key, beat] of this.scheduled) {
      if (beat < cutoff) this.scheduled.delete(key);
    }
  }

  private send(msg: unknown): void {
    this.sendRaw(JSON.stringify(msg));
  }

  /** Returns false when the socket isn't open, so the caller can keep the payload queued. */
  private sendRaw(payload: string): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(payload);
    return true;
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
    if (msg.type === 'ready') {
      this.tickCapable = msg.tick === true;
      this.performanceCapable = msg.performanceEvents === true;
      this.flushNotes();
      return;
    }
    if (msg.type === 'plan' || msg.type === 'status') {
      clearTimeout(this.responseTimer); this.responseTimer = undefined;
    }
    if (msg.type === 'status' && typeof msg.latencyMs === 'number') {
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      const requestAgeMs = num(msg.requestAgeMs);
      this.measureRtt(requestAgeMs ?? msg.latencyMs);
      this.onStatus?.('', msg.latencyMs, { tooLate: this.tooLate, queueLatencyMs: num(msg.queueLatencyMs), requestAgeMs });
    }
    if (msg.type === 'plan') {
      this.lastPlanCueId = typeof msg.cueId === 'number' ? msg.cueId : undefined;
      const notes = Array.isArray(msg.notes) ? (msg.notes as PlanNote[]).filter(n =>
        n && ['keys','bass','lead'].includes(n.voice) && Number.isFinite(n.beat) && n.beat >= 0 &&
        Number.isInteger(n.pitch) && n.pitch >= 0 && n.pitch <= 127 &&
        Number.isFinite(n.dur) && n.dur > 0 && Number.isFinite(n.vel) && n.vel >= 0 && n.vel <= 1) : [];
      if (!notes.length) this.onStatus?.('Listening · resting');
      // Legacy full-bar plans replace only their first two beats with an answer.
      // New servers identify the exact shaped interval explicitly.
      const phraseFrom = typeof msg.phraseFromBeat === 'number' && Number.isFinite(msg.phraseFromBeat)
        ? msg.phraseFromBeat : typeof msg.fromBeat === 'number' && Number.isFinite(msg.fromBeat)
          ? msg.fromBeat : Math.min(...notes.map(n => n.beat));
      const phraseTo = typeof msg.phraseToBeat === 'number' && Number.isFinite(msg.phraseToBeat)
        ? msg.phraseToBeat : Math.min(phraseFrom + COMMIT_BEATS,
          typeof msg.toBeat === 'number' && Number.isFinite(msg.toBeat) ? msg.toBeat : Infinity);
      for (const n of notes) {
        const phrase = msg.phraseResponse === true && Number.isInteger(msg.phraseInstrument)
          && n.gmInstr === msg.phraseInstrument && n.beat >= phraseFrom && n.beat < phraseTo;
        // Legacy listeners have no release lifecycle; retain a short onset guard.
        // A cancellable GM sampler is required for remembered responses.
        const stalePhrase = this.latestOnsetCapture > -Infinity
          && (typeof msg.latestCaptureTimeSec !== 'number' || !Number.isFinite(msg.latestCaptureTimeSec)
            || msg.latestCaptureTimeSec < this.latestOnsetCapture);
        if (phrase && (stalePhrase || this.heldNotes.size || this.now() - this.legacyOnsetAt < .25
          || !this.players.scheduleAccompaniment)) continue;
        // Keep the first scheduling of a note; canceled responses must not be
        // resurrected by a duplicate plan after the performer resumes.
        const key = AmtEngine.noteKey(n);
        if (this.scheduled.has(key)) continue;
        if (this.pending.some(p => AmtEngine.noteKey(p) === key)) continue;
        this.pending.push({ ...n, phraseSignal: phrase ? this.phraseController.signal : undefined, captureTimeSec: typeof msg.latestCaptureTimeSec === 'number' && Number.isFinite(msg.latestCaptureTimeSec) ? msg.latestCaptureTimeSec : undefined });
      }
      this.pruneScheduled();
      this.scheduleDue();
      if (typeof msg.chord === 'string' && Number.isFinite(msg.chordFrom as number)) {
        const chord = parseChordName(msg.chord);
        if (chord) this.onChord?.(chord, msg.chordFrom as number);
      }
      if (typeof msg.section === 'string') this.onSection?.(msg.section as Section);
    }
  }
}
