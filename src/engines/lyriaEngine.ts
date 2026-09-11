import { GoogleGenAI } from '@google/genai';
import type { LiveMusicGenerationConfig, LiveMusicSession } from '@google/genai';
import type { BandState, Instrument } from '../types';
import type { BandEngine } from './engine';
import { promptsFor, configFor } from './lyriaMap';
import { PcmPlayer } from './pcmPlayer';

const MODEL = 'models/lyria-realtime-exp';
const COALESCE_MS = 250;
const RESET_FADE_SEC = 0.15;

/** Streams a Lyria RealTime session and keeps its prompts/config in sync with BandState. */
export class LyriaEngine implements BandEngine {
  readonly changeLatencyMs = 600;
  onBar?: (bar: number) => void;

  private state: BandState = {
    genre: 'lofi',
    key: { root: 0, mode: 'major' },
    creativity: 0.3,
    enabled: { drums: false, bass: false, keys: false, lead: false },
  };
  private session?: LiveMusicSession;
  private player?: PcmPlayer;
  private barTimer?: number;
  private bar = 0;
  private bpm = 0;
  private applyTimer?: number;

  constructor(private apiKey: string, private ctx: AudioContext) {}

  async start(bpm: number, firstBarAt: number): Promise<void> {
    this.bpm = bpm;
    this.player = new PcmPlayer(this.ctx);

    const client = new GoogleGenAI({ apiKey: this.apiKey, apiVersion: 'v1alpha' });
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
        onerror: () => {
          // connection errors surface via onclose; nothing actionable here yet
        },
        onclose: () => undefined,
      },
    });

    await this.applyAll();
    await this.session.play();

    const barLenMs = (240000 / bpm) | 0;
    const delay = Math.max(0, firstBarAt * 1000 - performance.now());
    window.setTimeout(() => {
      this.barTimer = window.setInterval(() => {
        this.onBar?.(this.bar++);
      }, barLenMs);
      this.onBar?.(this.bar++);
    }, delay);
  }

  stop(): void {
    if (this.barTimer !== undefined) window.clearInterval(this.barTimer);
    this.barTimer = undefined;
    this.session?.stop();
    this.session?.close();
    this.session = undefined;
    this.player?.stop();
    this.player = undefined;
  }

  set(p: Partial<Pick<BandState, 'genre' | 'key' | 'creativity'>>): void {
    Object.assign(this.state, p);
    this.scheduleApply();
  }

  setEnabled(i: Instrument, on: boolean): void {
    this.state.enabled[i] = on;
    this.scheduleApply();
  }

  setBpm(bpm: number): void {
    this.bpm = bpm;
    this.scheduleApply();
  }

  /** Coalesces rapid control changes within COALESCE_MS into a single reset. */
  private scheduleApply(): void {
    if (this.applyTimer !== undefined) window.clearTimeout(this.applyTimer);
    this.applyTimer = window.setTimeout(() => {
      this.applyTimer = undefined;
      void this.applyAll(true);
    }, COALESCE_MS);
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
