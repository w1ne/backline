import type { BandState, Chord, Dynamics, Instrument, Key } from '../types';
import { IDLE_DYNAMICS } from '../types';
import { chordName } from '../listener/chordDetector';
import type { BandEngine } from './engine';
import { PcmPlayer } from './pcmPlayer';
import type { MorphRoute } from '../audio/routing';
import { RELAY_URL } from '../config';

const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const CUT_FADE_SEC = 0.15;
const KEEPALIVE_MS = 30000;
const BARS_PER_BLOCK = 2;
/** how many recent half-bar chords ride along in the block request as a progression */
const CHORD_HISTORY = 4;

function keyString(k: Key): string {
  return `${KEY_NAMES[k.root]} ${k.mode === 'major' ? 'major' : 'minor'}`;
}

/** intensity above which the player is "busy" and the band should lay back to drums + bass */
export const BUSY_INTENSITY = 0.6;

/** What the ACE block should ask for, chosen from the player's effective dynamics. */
export interface BlockSelection {
  /** instruments to render this block, after the user's on/off toggles are applied */
  instruments: Instrument[];
  /** this block answers the player with a guitar lead fill */
  fill: boolean;
  /** how full the band should sound, 0 (sparse) .. 1 (busy) — a prompt/energy hint */
  density: number;
}

/**
 * Picks the block's instrument set from the effective dynamics, then masks it against the
 * user's on/off toggles (never adding an instrument the user turned off).
 *
 * - busy (intensity > 0.6, not space): rhythm section only — drums + bass.
 * - soft/medium playing: drums + bass + keys, leaving the melody to the player.
 * - space: full set incl. guitar lead, marked as a FILL.
 *
 * Pure so it can be unit-tested and reasoned about independently of the WebSocket engine.
 */
export function selectBlockInstruments(
  dyn: Pick<Dynamics, 'intensity' | 'space'>,
  enabled: Record<Instrument, boolean>,
): BlockSelection {
  const intensity = Math.min(1, Math.max(0, dyn.intensity));
  const quiet = dyn.space;
  const busy = !quiet && intensity > BUSY_INTENSITY;

  let base: Instrument[];
  let fill = false;
  if (quiet) {
    base = ['drums', 'bass', 'keys', 'lead'];
    fill = true;
  } else if (busy) {
    base = ['drums', 'bass'];
  } else {
    base = ['drums', 'bass', 'keys'];
  }

  const instruments = base.filter(i => enabled[i]);
  // density: busy → ~1, quiet → ~0, so the server can pick energy words / guidance.
  const density = dyn.space ? 0 : intensity;
  return { instruments, fill, density };
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
  /** the last few half-bar chords the player outlined, e.g. ['Am','F','G','C'] */
  chords: string[];
  /** how hard the player is working, 0–1; the server turns it into prompt words */
  intensity: number;
  /** the player has left room, so the lead instrument may be prompted for */
  space: boolean;
  /** this block answers the player with a guitar lead fill */
  fill: boolean;
  /** how full the band should sound, 0 (sparse) .. 1 (busy); server maps to energy words */
  density: number;
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
    chord: null,
    creativity: 0.3,
    enabled: { drums: false, bass: false, keys: false, lead: false },
    dynamics: { ...IDLE_DYNAMICS },
  };
  private chords: string[] = [];
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

  private bandRoute: MorphRoute = 'main';
  private morphNode?: AudioNode;

  constructor(private ctx: AudioContext) {}

  /** Sends the generated stream to the main output, the MORPH output, or both. */
  routeBand(route: MorphRoute, morphNode?: AudioNode): void {
    this.bandRoute = route;
    this.morphNode = morphNode;
    this.player?.routeBand(route, morphNode);
  }


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
    this.player = new PcmPlayer(this.ctx, undefined, this.morphNode);
    this.player.routeBand(this.bandRoute, this.morphNode);
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

  /** Tap on the streamed audio, for the visualiser's spectrum. Valid once start() has run. */
  getAnalyser(): AnalyserNode | undefined {
    return this.player?.getAnalyser();
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

  set(p: Partial<Pick<BandState, 'genre' | 'key' | 'chord' | 'creativity' | 'dynamics'>>): void {
    let keyChanged = false;
    // Dynamics ride along on the next block request — blocks are two bars long, so there is
    // nothing to gain from restarting generation the moment they move.
    if (p.dynamics !== undefined) this.state.dynamics = p.dynamics;
    if (p.genre !== undefined) this.state.genre = p.genre;
    if (p.key !== undefined && !sameKey(p.key, this.state.key)) {
      this.state.key = p.key;
      keyChanged = true;
    }
    if (p.chord !== undefined) this.pushChord(p.chord);
    if (p.creativity !== undefined) this.state.creativity = p.creativity;
    // A chord change deliberately does *not* restart: the progression is prompt text the
    // next block picks up anyway, and cutting playback every half bar would be unlistenable.
    if (keyChanged) this.restart();
  }

  private pushChord(chord: Chord | null): void {
    this.state.chord = chord;
    if (!chord) return;
    const name = chordName(chord);
    if (this.chords[this.chords.length - 1] === name) return;
    this.chords.push(name);
    if (this.chords.length > CHORD_HISTORY) this.chords.shift();
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
    // The instrument set is the strongest "lay back" lever: fewer track_classes and the model
    // thins out. Chosen from the effective dynamics at the moment the block is requested, then
    // masked against the user's on/off toggles.
    const sel = selectBlockInstruments(this.state.dynamics, this.state.enabled);
    const req: BlockRequest = {
      type: 'block',
      seq,
      bpm: this.bpm,
      key: keyString(this.state.key),
      genre: this.state.genre,
      instruments: sel.instruments,
      creativity: this.state.creativity,
      bars: BARS_PER_BLOCK,
      chords: [...this.chords],
      intensity: this.state.dynamics.intensity,
      space: this.state.dynamics.space,
      fill: sel.fill,
      density: sel.density,
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
