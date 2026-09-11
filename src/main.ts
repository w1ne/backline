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
import { forwardBpm } from './band/bpmForward';
import { installDebug, recordToggle } from './debug';

const root = document.getElementById('app')!;
const store = new Store();
let listener: Listener | undefined;
let band: BandEngine | undefined;
const players = new Players();
let lastFollowedBpm: number | undefined;

async function power() {
  store.update({ error: null });
  await players.init();
  players.setGenre(store.state.genre);

  const engine = store.state.engine;

  const midi = new MidiSource();
  const mic = new MicSource();
  const perfOffset = Tone.now() - performance.now() / 1000; // MIDI times are performance.now-based

  listener = new Listener([midi, mic], ['midi', 'mic']);
  if (engine === 'lyria') {
    band = new LyriaEngine(players.rawContext());
  } else if (engine === 'acestep') {
    band = new AceStepEngine(players.rawContext());
  } else {
    band = new PatternEngine(players, PATTERNS);
  }
  band.set({ genre: store.state.genre, creativity: store.state.creativity });
  INSTRUMENTS.forEach(i => band!.setEnabled(i, store.state.enabled[i]));
  band.onBar = bar => {
    store.update({ bar });
    setLatency(root, players.latencyMs());
  };
  band.onError = msg => store.update({ error: msg });
  band.onStats = s => {
    const increased = s.loops > store.state.loops;
    store.update({ loops: s.loops, loopsUpdatedAt: increased ? Date.now() : store.state.loopsUpdatedAt });
  };

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
      band!.start(input.bpm, first).catch(err => {
        store.update({ error: `Lyria: ${err instanceof Error ? err.message : String(err)}` });
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
    input: { bpm: null, key: null, notesNow: [], inputLevel: 0, onsets: 0 },
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
      band.stop();
      band =
        e === 'lyria'
          ? new LyriaEngine(players.rawContext())
          : e === 'acestep'
            ? new AceStepEngine(players.rawContext())
            : new PatternEngine(players, PATTERNS);
      band.set({ genre: store.state.genre, creativity: store.state.creativity, key: key ?? undefined });
      INSTRUMENTS.forEach(i => band!.setEnabled(i, store.state.enabled[i]));
      band.onBar = bar => {
        store.update({ bar });
        setLatency(root, players.latencyMs());
      };
      band.onError = msg => store.update({ error: msg });
      band.onStats = s => {
        const increased = s.loops > store.state.loops;
        store.update({ loops: s.loops, loopsUpdatedAt: increased ? Date.now() : store.state.loopsUpdatedAt });
      };
      if (bpm) {
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
    input: { bpm: 96, key: { root: 9, mode: 'minor' }, notesNow: [57, 60, 64], inputLevel: 0.72, onsets: 12 },
  });
  setLatency(root, 38);
}
