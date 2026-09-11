import './ui/styles.css';
import * as Tone from 'tone';
import { Store } from './ui/state';
import { getSession } from './auth';
import { renderSetup } from './ui/setup';
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
import { forwardBpm } from './band/bpmForward';
import { installDebug, recordToggle } from './debug';

const root = document.getElementById('app')!;
const store = new Store();
let listener: Listener | undefined;
let band: BandEngine | undefined;
const players = new Players();
let lastFollowedBpm: number | undefined;

async function start() {
  store.update({ error: null });
  await players.init();
  players.setGenre(store.state.genre);

  const source = store.state.source === 'mic' ? new MicSource() : new MidiSource();
  const perfOffset = Tone.now() - performance.now() / 1000; // MIDI times are performance.now-based

  listener = new Listener(source);
  if (store.state.engine === 'lyria') {
    band = new LyriaEngine(players.rawContext());
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

  listener.onChange(input => {
    store.update({ input });
    if (input.key) band!.set({ key: input.key });
    if (input.bpm && !store.state.locked) {
      const db = listener!.downbeat! + (store.state.source === 'midi' ? perfOffset : 0);
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

  await listener.start();
  store.update({ screen: 'live' });
}

function stop() {
  band?.stop();
  listener?.stop();
  lastFollowedBpm = undefined;
  store.update({ screen: 'setup', locked: false, bar: 0, tempoMode: 'locked', error: null, loops: 0, loopsUpdatedAt: undefined });
}

store.subscribe(s => {
  if (s.screen === 'setup') {
    root.innerHTML = '';
    renderSetup(root, store, start);
    return;
  }
  renderLive(root, store, {
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
    setCreativity: c => {
      band?.set({ creativity: c });
      store.update({ creativity: c });
    },
    stop,
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
});

installDebug({
  store,
  get band() {
    return band;
  },
});

getSession().then(user => {
  const clearSignInError = user && store.state.error === 'Sign in with GitHub to use Lyria';
  store.update({ user, ...(clearSignInError ? { error: null } : {}) });
});
store.update({});
