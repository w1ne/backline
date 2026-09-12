import type { BandState, Instrument, Key } from '../types';
import { INSTRUMENTS } from '../types';
import type { BandEngine } from './engine';
import { PcmPlayer } from './pcmPlayer';
import { RELAY_URL } from '../config';

const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const CUT_FADE_SEC = 0.15;
const KEEPALIVE_MS = 30000;
const BARS_PER_BLOCK = 2;

function keyString(k: Key): string {
  return `${KEY_NAMES[k.root]} ${k.mode === 'major' ? 'major' : 'minor'}`;
}

function sameKey(a: Key, b: Key): boolean {
  return a.root === b.root && a.mode === b.mode;
}

interface BlockRequest {
  type: 'block';
  seq: number;
  bpm: number;
  key: string;
  genre: string;
  instruments: Instrument[];
  creativity: number;
  bars: number;
}

/** Streams bar-quantized blocks from the ACE-Step service and schedules them back-to-back
 *  on the AudioContext clock, one request ahead, via PcmPlayer. */
export class AceStepEngine implements BandEngine {
  readonly bpmStep = 4;
  onBar?: (bar: number) => void;
  onError?: (msg: string) => void;
  onFirstBlock?: () => void;
  onStats?: (s: { loops: number; starvedSec: number }) => void;
  private gotFirstBlock = false;

  private state: BandState = {
    genre: 'lofi',
    key: { root: 0, mode: 'major' },
    creativity: 0.3,
    enabled: { drums: false, bass: false, keys: false, lead: false },
  };
  private ws?: WebSocket;
  private player?: PcmPlayer;
  private bpm = 0;
  private nextSeq = 1;
  private latestRequestedSeq = 0;
  private blockSeconds = 0;
  private firstBarAt = 0;
  private nextBlockAt = 0;
  private bar = 0;
  private barTimer?: ReturnType<typeof setInterval>;
  private startTimer?: ReturnType<typeof setTimeout>;
  private keepalive?: ReturnType<typeof setInterval>;
  private stopping = false;

  constructor(private ctx: AudioContext) {}

  get changeLatencyMs(): number {
    if (!this.bpm) return 0;
    const remaining = this.nextBlockAt - this.ctx.currentTime;
    return Math.max(0, Math.round(remaining * 1000));
  }

  async start(bpm: number, firstBarAt: number): Promise<void> {
    this.stopping = false;
    this.bpm = bpm;
    this.bar = 0;
    this.nextSeq = 1;
    this.latestRequestedSeq = 0;
    this.gotFirstBlock = false;
    this.blockSeconds = (240 / bpm) * BARS_PER_BLOCK;
    this.firstBarAt = firstBarAt;
    this.nextBlockAt = firstBarAt;
    this.player = new PcmPlayer(this.ctx);
    this.player.setBarSeconds(240 / bpm);

    const wsUrl = RELAY_URL.replace(/^http/, 'ws') + '/acestep';
    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = 'arraybuffer';

    this.ws.addEventListener('open', () => {
      this.requestBlock();
      this.keepalive = setInterval(() => {
        this.send({ type: 'ping' });
      }, KEEPALIVE_MS);
    });
    this.ws.addEventListener('message', ev => this.onMessage(ev));
    this.ws.addEventListener('error', () => {
      this.onError?.('ACE: connection error');
    });
    this.ws.addEventListener('close', ev => {
      if (this.stopping) return;
      this.onError?.(`ACE: closed${ev.reason ? ` (${ev.reason})` : ''}`);
    });

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
    if (this.keepalive !== undefined) clearInterval(this.keepalive);
    this.keepalive = undefined;
    this.ws?.close();
    this.ws = undefined;
    this.player?.stop();
    this.player = undefined;
  }

  set(p: Partial<Pick<BandState, 'genre' | 'key' | 'creativity'>>): void {
    let keyChanged = false;
    if (p.genre !== undefined) this.state.genre = p.genre;
    if (p.key !== undefined && !sameKey(p.key, this.state.key)) {
      this.state.key = p.key;
      keyChanged = true;
    }
    if (p.creativity !== undefined) this.state.creativity = p.creativity;
    if (keyChanged) this.restart();
  }

  setEnabled(i: Instrument, on: boolean): void {
    this.state.enabled[i] = on;
  }

  setBpm(bpm: number): void {
    if (bpm === this.bpm) return;
    this.bpm = bpm;
    this.blockSeconds = (240 / bpm) * BARS_PER_BLOCK;
    this.player?.setBarSeconds(240 / bpm);
    this.restartBarTimer(bpm);
    this.restart();
  }

  /** bpm/key change: server restarts from a fresh text2music block, so cut playback,
   *  resync to the next bar, and request a new block that supersedes anything in flight. */
  private restart(): void {
    if (!this.player) return;
    this.player.cut(CUT_FADE_SEC);
    const now = this.ctx.currentTime;
    let next = this.nextBlockAt;
    while (next < now + CUT_FADE_SEC) next += this.blockSeconds;
    this.firstBarAt = next;
    this.nextBlockAt = next;
    this.requestBlock();
  }

  private restartBarTimer(bpm: number): void {
    if (this.barTimer === undefined) return;
    clearInterval(this.barTimer);
    const barLenMs = (240000 / bpm) | 0;
    this.barTimer = setInterval(() => {
      this.onBar?.(this.bar++);
      if (this.player) this.onStats?.(this.player.stats);
    }, barLenMs);
  }

  private requestBlock(): void {
    const seq = this.nextSeq++;
    this.latestRequestedSeq = seq;
    const req: BlockRequest = {
      type: 'block',
      seq,
      bpm: this.bpm,
      key: keyString(this.state.key),
      genre: this.state.genre,
      instruments: INSTRUMENTS.filter(i => this.state.enabled[i]),
      creativity: this.state.creativity,
      bars: BARS_PER_BLOCK,
    };
    this.send(req);
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onMessage(ev: MessageEvent): void {
    if (typeof ev.data === 'string') {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'error') this.onError?.(`ACE: ${msg.message}`);
      } catch {
        // ignore malformed control messages
      }
      return;
    }
    try {
      const buf = ev.data as ArrayBuffer;
      const view = new DataView(buf);
      const seq = view.getUint32(0, true);
      // Stale block from before a restart: a later request has already superseded it.
      if (seq < this.latestRequestedSeq) return;
      const pcm = new Uint8Array(buf, 4);
      this.player?.push(pcm);
      if (!this.gotFirstBlock) {
        this.gotFirstBlock = true;
        this.onFirstBlock?.();
      }
      this.nextBlockAt += this.blockSeconds;
      this.requestBlock();
    } catch (err) {
      this.onError?.(`ACE: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
