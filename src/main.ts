import './ui/styles.css';
import * as Tone from 'tone';
import { Store } from './ui/state';
import { renderLive, setLatency } from './ui/live';
import { Listener } from './listener/listener';
import { MidiSource } from './listener/midiSource';
import { MicSource } from './listener/micSource';
import { Players } from './players/players';
import { PATTERNS } from './patterns';
import { INSTRUMENTS } from './types';
import type { BandEngine } from './engines/engine';
import { PatternEngine } from './engines/patternEngine';
import { LyriaEngine } from './engines/lyriaEngine';
import { AceStepEngine } from './engines/acestepEngine';
import { AmtEngine } from './engines/amtEngine';
import { forwardBpm } from './band/bpmForward';
import { installDebug, recordToggle } from './debug';
import { chooseFallback } from './engines/fallback';
import { RELAY_URL } from './config';
import type { EngineChoice } from './ui/state';

const FALLBACK_TIMEOUT_MS = 8000;

const root = document.getElementById('app')!;
const store = new Store();
let listener: Listener | undefined;
let band: BandEngine | undefined;
const players = new Players();
let lastFollowedBpm: number | undefined;
let disarmFallback: (() => void) | undefined;

function makeBand(engine: EngineChoice): BandEngine {
  if (engine === 'lyria') return new LyriaEngine(players.rawContext());
  if (engine === 'acestep') return new AceStepEngine(players.rawContext());
  if (engine === 'amt') return new AmtEngine(players, listener!);
  return new PatternEngine(players, PATTERNS);
}

function wireBand(b: BandEngine): void {
  INSTRUMENTS.forEach(i => b.setEnabled(i, store.state.enabled[i]));
  b.onBar = bar => {
    store.update({ bar });
    setLatency(root, players.latencyMs());
  };
  b.onError = msg => store.update({ error: msg });
  b.onStats = s => {
    const increased = s.loops > store.state.loops;
    store.update({ loops: s.loops, loopsUpdatedAt: increased ? Date.now() : store.state.loopsUpdatedAt });
  };
}

/** Arms the 8s connect/first-block watchdog for `engine`'s band `b`. If it fails to connect or
 *  produce a first block in time (or errors out sooner), stops it and starts Patterns in its
 *  place at the same bpm. Returns a disposer to call once the engine is confirmed healthy or the
 *  band is torn down for another reason. */
function armFallback(engine: EngineChoice, b: BandEngine): () => void {
  const fallback = chooseFallback(engine, '');
  if (!fallback) return () => {};

  let settled = false;
  store.update({ engineConnecting: true });

  const settle = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (store.state.engine === engine) store.update({ engineConnecting: false });
  };

  const timer = setTimeout(() => trigger('timeout'), FALLBACK_TIMEOUT_MS);

  const userOnError = b.onError;
  b.onFirstBlock = settle;
  b.onError = msg => {
    userOnError?.(msg);
    trigger(msg);
  };

  function trigger(reason: string): void {
    if (settled) return;
    settle();
    const result = chooseFallback(engine, reason);
    if (!result || band !== b) return;
    b.stop();
    band = makeBand(result.engine);
    wireBand(band);
    band.set({ genre: store.state.genre, creativity: store.state.creativity });
    store.update({ engine: result.engine, error: result.note });
    const bpm = lastFollowedBpm ?? store.state.input.bpm ?? undefined;
    if (bpm) {
      band.start(bpm, Tone.now() + 0.1).catch(err => {
        store.update({ error: err instanceof Error ? err.message : String(err) });
      });
    }
  }

  return settle;
}

// Cheap readiness probe: flag ACE/Lyria as offline in the ENGINE switch if the relay is
// unreachable at load time. Both stay selectable — this is advisory, not a lock.
fetch(RELAY_URL + '/health').catch(() => {
  store.update({ offlineEngines: ['acestep', 'lyria', 'amt'] });
});

async function power() {
  store.update({ error: null });
  await players.init();
  players.setGenre(store.state.genre);

  const engine = store.state.engine;

  const midi = new MidiSource();
  const mic = new MicSource();
  const perfOffset = Tone.now() - performance.now() / 1000; // MIDI times are performance.now-based

  listener = new Listener([midi, mic], ['midi', 'mic']);
  band = makeBand(engine);
  band.set({ genre: store.state.genre, creativity: store.state.creativity });
  wireBand(band);

  listener.onSourceStatus(sources => store.update({ sources: { ...sources } }));

  listener.onChange(input => {
    store.update({ input });
    if (input.key) band!.set({ key: input.key });
    if (input.bpm && !store.state.locked) {
      const db = listener!.downbeat! + perfOffset;
      const barLen = 240 / input.bpm;
      let first = db;
      while (first < Tone.now() + 0.1) first += barLen;
      store.update({ locked: true });
      lastFollowedBpm = input.bpm;
      disarmFallback?.();
      disarmFallback = armFallback(store.state.engine, band!);
      band!.start(input.bpm, first).catch(err => {
        store.update({ error: `${store.state.engine}: ${err instanceof Error ? err.message : String(err)}` });
      });
    } else if (
      store.state.locked &&
      store.state.tempoMode === 'follow' &&
      !listener!.hasBpmOverride &&
      input.bpm &&
      forwardBpm(lastFollowedBpm, input.bpm, band!.bpmStep)
    ) {
      lastFollowedBpm = input.bpm;
      band!.setBpm(input.bpm);
    }
  });

  store.update({ power: 'on', error: null });
  await listener.start();
  store.update({ sources: { ...listener.sourceStatus } });
}

function powerOff() {
  disarmFallback?.();
  disarmFallback = undefined;
  band?.stop();
  listener?.stop();
  listener = undefined;
  lastFollowedBpm = undefined;
  store.update({
    power: 'off',
    sources: { mic: 'off', midi: 'off' },
    locked: false,
    bar: 0,
    tempoMode: 'locked',
    error: null,
    loops: 0,
    loopsUpdatedAt: undefined,
    input: { bpm: null, key: null, notesNow: [], pitch: null, inputLevel: 0, onsets: 0, pendingBpm: null },
  });
}

store.subscribe(s => {
  renderLive(root, store, {
    power: () => {
      power().catch(err => {
        store.update({ error: err instanceof Error ? err.message : String(err) });
      });
    },
    toggle: i => {
      // Read live state, not the `s` snapshot from this subscribe callback,
      // which would freeze `enabled` at whatever it was on the render that
      // created this closure.
      const on = !store.state.enabled[i];
      band?.setEnabled(i, on);
      store.update({ enabled: { ...store.state.enabled, [i]: on } });
      recordToggle(i, on, store.state.enabled);
    },
    setGenre: g => {
      players.setGenre(g);
      band?.set({ genre: g });
      store.update({ genre: g });
    },
    setEngine: e => {
      const prevEngine = store.state.engine;
      store.update({ engine: e });
      if (store.state.power !== 'on' || !band || e === prevEngine) return;
      // Power-cycle the band engine in place, at the same bpm/key, instead of
      // making the user power off first.
      const bpm = lastFollowedBpm ?? store.state.input.bpm ?? undefined;
      const key = store.state.input.key ?? undefined;
      disarmFallback?.();
      disarmFallback = undefined;
      band.stop();
      band = makeBand(e);
      band.set({ genre: store.state.genre, creativity: store.state.creativity, key: key ?? undefined });
      wireBand(band);
      if (bpm) {
        disarmFallback = armFallback(e, band);
        band.start(bpm, Tone.now() + 0.1).catch(err => {
          store.update({ error: `${e}: ${err instanceof Error ? err.message : String(err)}` });
        });
      }
    },
    setCreativity: c => {
      band?.set({ creativity: c });
      store.update({ creativity: c });
    },
    powerOff,
    setBpmOverride: bpm => {
      const clamped = bpm === undefined ? undefined : Math.min(240, Math.max(40, bpm));
      listener?.setOverride({ bpm: clamped });
      if (clamped !== undefined) {
        lastFollowedBpm = clamped;
        band?.setBpm(clamped);
      } else {
        // Override cleared: setOverride() above emits synchronously, so
        // listener's input already reflects the recovered detected tempo.
        const recovered = listener?.input.bpm;
        if (recovered) {
          lastFollowedBpm = recovered;
          band?.setBpm(recovered);
        }
      }
    },
    setKeyOverride: key => {
      listener?.setOverride({ key });
    },
    setTempoMode: m => {
      lastFollowedBpm = undefined;
      listener?.setTempoMode(m);
      store.update({ tempoMode: m });
    },
    changeLatencyMs: band?.changeLatencyMs,
  });
  void s;
});

installDebug({
  store,
  get band() {
    return band;
  },
});

store.update({});

// ?demo=1 paints the live panel with sample state (design review / screenshots only).
if (new URLSearchParams(location.search).has('demo')) {
  store.update({
    power: 'on',
    sources: { mic: 'on', midi: 'on' },
    genre: 'funk',
    creativity: 0.65,
    locked: true,
    bar: 9,
    enabled: { drums: true, bass: true, keys: false, lead: true },
    input: { bpm: 96, key: { root: 9, mode: 'minor' }, notesNow: [57, 60, 64], pitch: { midi: 64, cents: 3, stable: true }, inputLevel: 0.72, onsets: 12, pendingBpm: null },
  });
  setLatency(root, 38);
}
