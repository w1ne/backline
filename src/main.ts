import './ui/styles.css';
import * as Tone from 'tone';
import { Store } from './ui/state';
import { renderSetup } from './ui/setup';
import { renderLive, setLatency } from './ui/live';
import { Listener } from './listener/listener';
import { MidiSource } from './listener/midiSource';
import { MicSource } from './listener/micSource';
import { Players } from './players/players';
import { ToneClock } from './band/clock';
import { Bandleader } from './band/bandleader';
import { PATTERNS } from './patterns';
import { INSTRUMENTS } from './types';

const root = document.getElementById('app')!;
const store = new Store();
let listener: Listener | undefined;
let band: Bandleader | undefined;
const players = new Players();

async function start() {
  await players.init();
  players.setGenre(store.state.genre);

  const source = store.state.source === 'mic' ? new MicSource() : new MidiSource();
  const perfOffset = Tone.now() - performance.now() / 1000; // MIDI times are performance.now-based

  listener = new Listener(source);
  band = new Bandleader(new ToneClock(), players, PATTERNS);
  band.set({ genre: store.state.genre, creativity: store.state.creativity });
  INSTRUMENTS.forEach(i => band!.setEnabled(i, store.state.enabled[i]));
  band.onBarCb = bar => {
    store.update({ bar });
    setLatency(root, players.latencyMs());
  };

  listener.onChange(input => {
    store.update({ input });
    if (input.key) band!.set({ key: input.key });
    if (input.bpm && !store.state.locked) {
      const db = listener!.downbeat! + (store.state.source === 'midi' ? perfOffset : 0);
      const barLen = 240 / input.bpm;
      let first = db;
      while (first < Tone.now() + 0.1) first += barLen;
      band!.start(input.bpm, first);
      store.update({ locked: true });
    }
  });

  await listener.start();
  store.update({ screen: 'live' });
}

function stop() {
  band?.stop();
  listener?.stop();
  store.update({ screen: 'setup', locked: false, bar: 0 });
}

store.subscribe(s => {
  if (s.screen === 'setup') {
    root.innerHTML = '';
    renderSetup(root, store, start);
    return;
  }
  renderLive(root, store, {
    toggle: i => {
      const on = !s.enabled[i];
      band?.setEnabled(i, on);
      store.update({ enabled: { ...s.enabled, [i]: on } });
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
    },
    setKeyOverride: key => {
      listener?.setOverride({ key });
    },
  });
});

store.update({});
