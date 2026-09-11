import { GoogleGenAI } from '@google/genai';
import type { LiveMusicGenerationConfig, LiveMusicSession } from '@google/genai';
import type { BandState, Instrument, Key } from '../types';
import type { BandEngine } from './engine';
import { promptsFor, configFor } from './lyriaMap';
import { PcmPlayer } from './pcmPlayer';
import { RELAY_URL } from '../config';

const MODEL = 'models/lyria-realtime-exp';
const COALESCE_MS = 250;
const RESET_FADE_SEC = 0.15;

function sameKey(a: Key, b: Key): boolean {
  return a.root === b.root && a.mode === b.mode;
}

/** Streams a Lyria RealTime session and keeps its prompts/config in sync with BandState. */
export class LyriaEngine implements BandEngine {
  readonly changeLatencyMs = 600;
  onBar?: (bar: number) => void;
  onError?: (msg: string) => void;

  private state: BandState = {
    genre: 'lofi',
    key: { root: 0, mode: 'major' },
    creativity: 0.3,
    enabled: { drums: false, bass: false, keys: false, lead: false },
  };
  private session?: LiveMusicSession;
  private player?: PcmPlayer;
  private barTimer?: ReturnType<typeof setInterval>;
  private startTimer?: ReturnType<typeof setTimeout>;
  private bar = 0;
  private bpm = 0;
  private applyTimer?: ReturnType<typeof setTimeout>;
  private firstDirtyAt?: number;

  constructor(private ctx: AudioContext) {}

  async start(bpm: number, firstBarAt: number): Promise<void> {
    this.bpm = bpm;
    this.player = new PcmPlayer(this.ctx);

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
            const chunks = msg?.serverContent?.audioChunks;
            if (!chunks) return;
            for (const chunk of chunks) {
              if (!chunk.data) continue;
              this.player!.push(base64ToBytes(chunk.data));
            }
          },
          onerror: e => {
            this.onError?.(`Lyria: ${e?.message ?? 'connection error'}`);
          },
          onclose: e => {
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
      }, barLenMs);
      this.onBar?.(this.bar++);
    }, delay);
  }

  stop(): void {
    if (this.startTimer !== undefined) clearTimeout(this.startTimer);
    this.startTimer = undefined;
    if (this.barTimer !== undefined) clearInterval(this.barTimer);
    this.barTimer = undefined;
    if (this.applyTimer !== undefined) clearTimeout(this.applyTimer);
    this.applyTimer = undefined;
    this.session?.stop();
    this.session?.close();
    this.session = undefined;
    this.player?.stop();
    this.player = undefined;
  }

  set(p: Partial<Pick<BandState, 'genre' | 'key' | 'creativity'>>): void {
    let dirty = false;
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
    this.scheduleApply();
  }

  /** Coalesces rapid control changes, firing at most COALESCE_MS after the FIRST change in a burst. */
  private scheduleApply(): void {
    const now = Date.now();
    if (this.firstDirtyAt === undefined) this.firstDirtyAt = now;
    if (this.applyTimer !== undefined) clearTimeout(this.applyTimer);
    const remaining = Math.max(0, COALESCE_MS - (now - this.firstDirtyAt));
    this.applyTimer = setTimeout(() => {
      this.applyTimer = undefined;
      this.firstDirtyAt = undefined;
      this.applyAll(true).catch(err => {
        this.onError?.(`Lyria: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, remaining);
  }

  private async applyAll(reset = false): Promise<void> {
    if (!this.session) return;
    const { genre, key, creativity, enabled } = this.state;
    await this.session.setWeightedPrompts({ weightedPrompts: promptsFor(genre, enabled) });
    await this.session.setMusicGenerationConfig({
      musicGenerationConfig: configFor(this.bpm, key, creativity, enabled) as unknown as LiveMusicGenerationConfig,
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
