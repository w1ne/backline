import { GoogleGenAI } from '@google/genai';
import type { LiveMusicGenerationConfig, LiveMusicSession } from '@google/genai';
import type { BandState, Instrument, Key } from '../types';
import { IDLE_DYNAMICS } from '../types';
import type { BandEngine } from './engine';
import { promptsFor, configFor } from './lyriaMap';
import { PcmPlayer } from './pcmPlayer';
import type { MorphRoute } from '../audio/routing';
import { RELAY_URL } from '../config';

const MODEL = 'models/lyria-realtime-exp';
const COALESCE_MS = 250;
const RESET_FADE_SEC = 0.15;
const RESET_MIN_INTERVAL_MS = 8000;

function sameKey(a: Key, b: Key): boolean {
  return a.root === b.root && a.mode === b.mode;
}

/** Streams a Lyria RealTime session and keeps its prompts/config in sync with BandState. */
export class LyriaEngine implements BandEngine {
  readonly changeLatencyMs = 600;
  readonly bpmStep = 2;
  onBar?: (bar: number) => void;
  onError?: (msg: string) => void;
  onFirstBlock?: () => void;
  onStats?: (s: { loops: number; starvedSec: number }) => void;
  private gotFirstBlock = false;

  private state: BandState = {
    genre: 'lofi',
    key: { root: 0, mode: 'major' },
    chord: null,
    creativity: 0.3,
    enabled: { drums: false, bass: false, keys: false, lead: false },
    dynamics: { ...IDLE_DYNAMICS },
  };
  /** true once a queued apply must also reset the model's context (bpm/key/genre changes);
   *  a dynamics-only change must not, or the stream would cut every beat */
  private applyReset = false;
  private session?: LiveMusicSession;
  private player?: PcmPlayer;
  private barTimer?: ReturnType<typeof setInterval>;
  private startTimer?: ReturnType<typeof setTimeout>;
  private bar = 0;
  private bpm = 0;
  private applyTimer?: ReturnType<typeof setTimeout>;
  private firstDirtyAt?: number;
  /** true while an intentional stop() is in flight, so the resulting onclose is not reported as an error */
  private stopping = false;
  private bpmResetTimer?: ReturnType<typeof setTimeout>;
  private lastBpmResetAt = 0;

  private bandRoute: MorphRoute = 'main';
  private morphNode?: AudioNode;

  constructor(private ctx: AudioContext) {}

  /** Sends the generated stream to the main output, the MORPH output, or both. */
  routeBand(route: MorphRoute, morphNode?: AudioNode): void {
    this.bandRoute = route;
    this.morphNode = morphNode;
    this.player?.routeBand(route, morphNode);
  }


  async start(bpm: number, firstBarAt: number): Promise<void> {
    this.stopping = false;
    this.bpm = bpm;
    this.gotFirstBlock = false;
    this.player = new PcmPlayer(this.ctx, undefined, this.morphNode);
    this.player.routeBand(this.bandRoute, this.morphNode);
    this.player.setBarSeconds(240 / bpm);

    try {
      // apiKey is a placeholder the relay Worker ignores; auth is via the bl_session
      // cookie (SameSite=None; Secure) sent on the cross-site WebSocket upgrade. The
      // @google/genai SDK gives websockets no hook for extra headers/subprotocols, so
      // there's no way to also send a token-based fallback here.
      const client = new GoogleGenAI({
        apiKey: 'relay',
        httpOptions: { baseUrl: RELAY_URL, apiVersion: 'v1alpha' },
      });
      this.session = await client.live.music.connect({
        model: MODEL,
        callbacks: {
          onmessage: msg => {
            // The @google/genai SDK invokes this callback from inside an async
            // handler with no .catch (`void handleWebSocketMessage(...)`), so any
            // synchronous throw here (malformed base64, AudioContext already
            // closed, etc.) would otherwise surface as an unhandled promise
            // rejection with no message. Catch it and route to onError instead.
            try {
              const chunks = msg?.serverContent?.audioChunks;
              if (!chunks) return;
              for (const chunk of chunks) {
                if (!chunk.data) continue;
                this.player!.push(base64ToBytes(chunk.data));
                if (!this.gotFirstBlock) {
                  this.gotFirstBlock = true;
                  this.onFirstBlock?.();
                }
              }
            } catch (err) {
              this.onError?.(`Lyria: ${err instanceof Error ? err.message : String(err)}`);
            }
          },
          onerror: e => {
            this.onError?.(`Lyria: ${e?.message ?? 'connection error'}`);
          },
          onclose: e => {
            if (this.stopping) return;
            this.onError?.(`Lyria: closed${e?.reason ? ` (${e.reason})` : ''}`);
          },
        },
      });

      await this.applyAll();
      await this.session.play();
    } catch (err) {
      this.onError?.(`Lyria: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }

    const barLenMs = (240000 / bpm) | 0;
    const delay = Math.max(0, (firstBarAt - this.ctx.currentTime) * 1000);
    this.startTimer = setTimeout(() => {
      this.startTimer = undefined;
      this.barTimer = setInterval(() => {
        this.onBar?.(this.bar++);
        if (this.player) this.onStats?.(this.player.stats);
      }, barLenMs);
      this.onBar?.(this.bar++);
    }, delay);
  }

  stop(): void {
    this.stopping = true;
    if (this.startTimer !== undefined) clearTimeout(this.startTimer);
    this.startTimer = undefined;
    if (this.barTimer !== undefined) clearInterval(this.barTimer);
    this.barTimer = undefined;
    if (this.applyTimer !== undefined) clearTimeout(this.applyTimer);
    this.applyTimer = undefined;
    if (this.bpmResetTimer !== undefined) clearTimeout(this.bpmResetTimer);
    this.bpmResetTimer = undefined;
    this.session?.stop();
    this.session?.close();
    this.session = undefined;
    this.player?.stop();
    this.player = undefined;
  }

  /** Note the deliberate asymmetry with `key`: a *chord* change is recorded but never marks
   *  the session dirty. Lyria applies a harmonic change by resetting the stream, which costs a
   *  reconnect and an audible gap — far too expensive to pay every half bar. Key changes are
   *  rare and keep the existing reset path; chord following on Lyria is left to the player. */
  set(p: Partial<Pick<BandState, 'genre' | 'key' | 'chord' | 'creativity' | 'dynamics'>>): void {
    let dirty = false;
    if (p.dynamics !== undefined) {
      // Dynamics land on every beat. Only a real change of behaviour is worth a round trip —
      // the lead coming in or out, or a visible step in density — and it never resets context.
      const prev = this.state.dynamics;
      const stepped =
        p.dynamics.space !== prev.space ||
        Math.round(p.dynamics.intensity * 5) !== Math.round(prev.intensity * 5);
      this.state.dynamics = p.dynamics;
      if (stepped) this.scheduleApply(false);
    }
    if (p.chord !== undefined) this.state.chord = p.chord;
    if (p.genre !== undefined && p.genre !== this.state.genre) {
      this.state.genre = p.genre;
      dirty = true;
    }
    if (p.key !== undefined && !sameKey(p.key, this.state.key)) {
      this.state.key = p.key;
      dirty = true;
    }
    if (p.creativity !== undefined && p.creativity !== this.state.creativity) {
      this.state.creativity = p.creativity;
      dirty = true;
    }
    if (dirty) this.scheduleApply();
  }

  setEnabled(i: Instrument, on: boolean): void {
    if (this.state.enabled[i] === on) return;
    this.state.enabled[i] = on;
    this.scheduleApply();
  }

  setBpm(bpm: number): void {
    if (bpm === this.bpm) return;
    this.bpm = bpm;
    this.player?.setBarSeconds(240 / bpm);
    this.restartBarTimer(bpm);
    this.scheduleBpmReset();
  }

  /** Restarts the running bar-tick interval at the new bpm's bar length, keeping the bar count going.
   *  Does nothing before the first bar has started (start()'s initial delay timer is unaffected). */
  private restartBarTimer(bpm: number): void {
    if (this.barTimer === undefined) return;
    clearInterval(this.barTimer);
    const barLenMs = (240000 / bpm) | 0;
    this.barTimer = setInterval(() => {
      this.onBar?.(this.bar++);
      if (this.player) this.onStats?.(this.player.stats);
    }, barLenMs);
  }

  /** setBpm changes reset Lyria's generation context, which is audible as a hard cut. Rate-limit
   *  those resets to at most one per RESET_MIN_INTERVAL_MS, coalescing rapid bpm changes so the
   *  latest one wins. */
  private scheduleBpmReset(): void {
    const now = Date.now();
    const wait = Math.max(0, RESET_MIN_INTERVAL_MS - (now - this.lastBpmResetAt));
    if (this.bpmResetTimer !== undefined) clearTimeout(this.bpmResetTimer);
    this.bpmResetTimer = setTimeout(() => {
      this.bpmResetTimer = undefined;
      this.lastBpmResetAt = Date.now();
      this.applyAll(true).catch(err => {
        this.onError?.(`Lyria: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, wait);
  }

  /** Coalesces rapid control changes, firing at most COALESCE_MS after the FIRST change in a burst. */
  private scheduleApply(reset = true): void {
    const now = Date.now();
    if (reset) this.applyReset = true;
    if (this.firstDirtyAt === undefined) this.firstDirtyAt = now;
    if (this.applyTimer !== undefined) clearTimeout(this.applyTimer);
    const remaining = Math.max(0, COALESCE_MS - (now - this.firstDirtyAt));
    this.applyTimer = setTimeout(() => {
      this.applyTimer = undefined;
      this.firstDirtyAt = undefined;
      const reset = this.applyReset;
      this.applyReset = false;
      this.applyAll(reset).catch(err => {
        this.onError?.(`Lyria: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, remaining);
  }

  private async applyAll(reset = false): Promise<void> {
    if (!this.session) return;
    const { genre, key, creativity, enabled, dynamics } = this.state;
    await this.session.setWeightedPrompts({ weightedPrompts: promptsFor(genre, enabled, dynamics) });
    await this.session.setMusicGenerationConfig({
      musicGenerationConfig: configFor(this.bpm, key, creativity, enabled, dynamics) as unknown as LiveMusicGenerationConfig,
    });
    if (reset) {
      this.player?.cut(RESET_FADE_SEC);
      this.session.resetContext();
    }
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
