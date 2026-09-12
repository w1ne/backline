import './ui/styles.css';
import * as Tone from 'tone';
import { Store } from './ui/state';
import { renderLive } from './ui/live';
import { Listener } from './listener/listener';
import { MidiSource } from './listener/midiSource';
import { MidiMonitor } from './players/monitor';
import { MicSource } from './listener/micSource';
import { Players } from './players/players';
import { PATTERNS } from './patterns';
import { INSTRUMENTS, IDLE_DYNAMICS } from './types';
import { effectiveDynamics } from './listener/activity';
import type { BandEngine } from './engines/engine';
import { PatternEngine } from './engines/patternEngine';
import { LyriaEngine } from './engines/lyriaEngine';
import { AceStepEngine } from './engines/acestepEngine';
import { AmtEngine } from './engines/amtEngine';
import { forwardBpm } from './band/bpmForward';
import { DEBUG, installDebug, recordToggle } from './debug';
import { chooseFallback } from './engines/fallback';
import { RELAY_URL } from './config';
import type { EngineChoice } from './ui/state';
import { MorphBus, setSinkSupported } from './audio/morphBus';
import {
  listInputs,
  listOutputs,
  loadDeviceId,
  onDeviceChange,
  resolveDeviceId,
  MIC_DEVICE_KEY,
  MIDI_INPUT_KEY,
  MORPH_SINK_KEY,
  MIC_MUTE_KEY,
  loadBool,
  saveBool,
} from './audio/devices';
import { defaultRouting } from './audio/routing';
import { createViz, type Viz } from './ui/viz';

const FALLBACK_TIMEOUT_MS = 8000;
const BEATS_PER_BAR = 4;
/** seconds a played note is drawn for — the listener reports onsets, not note-offs */
const YOU_NOTE_SEC = 0.25;

const root = document.getElementById('app')!;
const store = new Store();
const demo = new URLSearchParams(location.search).has('demo');
let listener: Listener | undefined;
let band: BandEngine | undefined;
let monitor: MidiMonitor | undefined;
const players = new Players();
let morph: MorphBus | undefined;
let mic: MicSource | undefined;
let midi: MidiSource | undefined;
/** true once players.init() has built the AudioContext the morph bus has to live in */
let audioReady = false;
let viz: Viz | undefined;
let lastFollowedBpm: number | undefined;
let disarmFallback: (() => void) | undefined;
let halfBarTimer: ReturnType<typeof setTimeout> | undefined;
let beatTimers: ReturnType<typeof setTimeout>[] = [];

/** Re-reads the player's activity for one beat and hands the result to the band. Engines only
 *  call back on the bar, so beats 1..3 come off timers re-armed from every downbeat — they
 *  never drift more than a bar, and a bpm change lands on the next one. */
function tickBeat(beat: number): void {
  if (!listener) return;
  // Fold the manual INTENSITY knob into the auto activity before it reaches the band, so every
  // consumer (patterns, Lyria density, ACE/AMT requests) sees the effective value. The store keeps
  // the effective number too, for the INTENSITY bar to show what the band is actually playing at.
  const eff = effectiveDynamics(listener.tickBeat(beat), store.state.intensity, beat);
  band?.set({ dynamics: eff });
  store.update({ effectiveIntensity: eff.intensity });
}

function clearBeatTimers(): void {
  beatTimers.forEach(t => clearTimeout(t));
  beatTimers = [];
}

/** Re-decides the chord from what the player just played and hands it to the band.
 *  Driven by the engine's bar callback plus a timer at the half bar, so the band gets a
 *  fresh chord twice a bar — often enough to follow a change, rarely enough to stay stable. */
function tickChord(beat: number): void {
  if (!listener) return;
  const chord = listener.tickChord(beat);
  band?.set({ chord, chordBeat: beat });
}


/** Re-reads the device pickers, dropping a remembered device that is no longer plugged in. */
async function refreshDevices(): Promise<void> {
  const [outputs, inputs] = await Promise.all([listOutputs(), listInputs()]);
  store.update({
    audioOutputs: outputs,
    audioInputs: inputs,
    morphOut: resolveDeviceId(store.state.morphOut, outputs),
    micIn: resolveDeviceId(store.state.micIn, inputs),
  });
  if (audioReady) await applyMorph();
}

/** Builds (or tears down) the morph bus for the currently chosen output device. */
async function applyMorph(): Promise<void> {
  if (!audioReady) return; // no AudioContext yet; power() applies it
  const id = store.state.morphOut;
  if (!id) {
    players.setMorphBus(undefined);
    morph?.dispose();
    morph = undefined;
    applyRouting();
    return;
  }
  morph ??= new MorphBus(players.rawContext());
  try {
    await morph.setSink(id);
  } catch (err) {
    store.update({ error: `morph out: ${err instanceof Error ? err.message : String(err)}` });
  }
  players.setMorphBus(morph.input);
  applyRouting();
}

/** Pushes the store's routing into the audio graph: pads via Players, engines via the band. */
function applyRouting(): void {
  const r = store.state.routing;
  INSTRUMENTS.forEach(i => players.route(i, r[i]));
  band?.routeBand?.(r.band, morph?.input);
}

/** Starts a band engine and points the visualiser at the same bar grid and, for the
 *  audio engines, the same output. */
function startBand(b: BandEngine, bpm: number, firstBarAt: number): Promise<void> {
  viz?.setClock(firstBarAt, bpm);
  return b.start(bpm, firstBarAt).then(() => {
    viz?.setAnalyser(b.getAnalyser?.());
  });
}

function setBandBpm(b: BandEngine, bpm: number): void {
  b.setBpm(bpm);
  viz?.setBpm(bpm);
}

function makeBand(engine: EngineChoice): BandEngine {
  if (engine === 'lyria') return new LyriaEngine(players.rawContext());
  if (engine === 'acestep') return new AceStepEngine(players.rawContext());
  if (engine === 'amt') return new AmtEngine(players, listener!);
  return new PatternEngine(players, PATTERNS);
}

function wireBand(b: BandEngine): void {
  INSTRUMENTS.forEach(i => b.setEnabled(i, store.state.enabled[i]));
  b.routeBand?.(store.state.routing.band, morph?.input);
  b.onBar = bar => {
    store.update({ bar });
    const beat = bar * BEATS_PER_BAR;
    // The downbeat's dynamics have to be in the band's hands before it schedules this bar,
    // and onBar runs ahead of scheduling, so tick the beat first.
    tickBeat(beat);
    tickChord(beat);
    if (halfBarTimer !== undefined) clearTimeout(halfBarTimer);
    clearBeatTimers();
    const bpm = lastFollowedBpm ?? store.state.input.bpm;
    if (bpm) halfBarTimer = setTimeout(() => tickChord(beat + BEATS_PER_BAR / 2), 120000 / bpm);
    if (bpm)
      for (let b = 1; b < BEATS_PER_BAR; b++)
        beatTimers.push(setTimeout(() => tickBeat(beat + b), (b * 60000) / bpm));
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
      startBand(band, bpm, Tone.now() + 0.1).catch(err => {
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
  audioReady = true;
  const ctx = players.rawContext();
  store.update({ audioSuspended: ctx.state !== 'running' });
  ctx.addEventListener('statechange', () => store.update({ audioSuspended: ctx.state !== 'running' }));
  players.setGenre(store.state.genre);
  await applyMorph();

  const engine = store.state.engine;

  midi = new MidiSource(store.state.midiIn);
  mic = new MicSource(store.state.micIn);
  midi.onInputs(inputs => store.update({ midiInputs: inputs }));
  // MIDI times are performance.now-based. Read at use, not at boot: the AudioContext clock
  // stands still until the first gesture resumes it.
  const perfOffset = (): number => Tone.now() - performance.now() / 1000;

  listener = new Listener([midi, mic], ['midi', 'mic']);
  listener.setMicMuted(store.state.micMuted);
  monitor = new MidiMonitor(players.rawContext(), store.state.sound);
  monitor.start().catch(() => undefined);
  band = makeBand(engine);
  band.set({ genre: store.state.genre, creativity: store.state.creativity });
  wireBand(band);

  listener.onSourceStatus(sources => store.update({ sources: { ...sources } }));

  // The listener timestamps notes on the performance.now clock; the strip draws on the
  // AudioContext one, which is what every scheduled band note is already in.
  listener.onNote(n => viz?.addNote('you', n.midi, n.timeSec + perfOffset(), YOU_NOTE_SEC, n.velocity));

  listener.onChange(input => {
    store.update({ input });
    if (input.key) band!.set({ key: input.key });
    if (input.bpm && !store.state.locked) {
      const db = listener!.downbeat! + perfOffset();
      const barLen = 240 / input.bpm;
      let first = db;
      while (first < Tone.now() + 0.1) first += barLen;
      store.update({ locked: true });
      lastFollowedBpm = input.bpm;
      disarmFallback?.();
      disarmFallback = armFallback(store.state.engine, band!);
      startBand(band!, input.bpm, first).catch(err => {
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
      setBandBpm(band!, input.bpm);
    }
  });

  store.update({ power: 'on', error: null });
  await listener.start();
  store.update({ sources: { ...listener.sourceStatus } });
  // labels only come back from enumerateDevices() once a media permission has been
  // granted, so the pickers are worth re-reading right after the mic starts
  await refreshDevices();
}

function powerOff() {
  disarmFallback?.();
  disarmFallback = undefined;
  if (halfBarTimer !== undefined) clearTimeout(halfBarTimer);
  halfBarTimer = undefined;
  clearBeatTimers();
  band?.stop();
  listener?.stop();
  listener = undefined;
  monitor?.stop();
  monitor = undefined;
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
    effectiveIntensity: 0,
    input: { bpm: null, key: null, chord: null, notesNow: [], pitch: null, inputLevel: 0, onsets: 0, pendingBpm: null, dynamics: { ...IDLE_DYNAMICS } },
  });
}

store.subscribe(s => {
  renderLive(root, store, {
    wake: () => {
      if (store.state.audioSuspended) {
        Tone.start()
          .then(() => store.update({ audioSuspended: false }))
          .catch(() => undefined);
      }
      // The boot-time getUserMedia had no user activation; this tap does.
      if (store.state.sources.mic !== 'on' && mic && listener) {
        const l = listener;
        mic
          .retry()
          .then(started => {
            if (started) l.setSourceState('mic', 'on');
          })
          .catch(() => l.setSourceState('mic', 'denied'));
      }
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
        startBand(band, bpm, Tone.now() + 0.1).catch(err => {
          store.update({ error: `${e}: ${err instanceof Error ? err.message : String(err)}` });
        });
      }
    },
    setCreativity: c => {
      band?.set({ creativity: c });
      store.update({ creativity: c });
    },
    setIntensity: i => {
      // The knob only stores the manual setting; tickBeat folds it into the band's dynamics on
      // the next beat. Nothing to push to the engine here.
      store.update({ intensity: Math.min(1, Math.max(0, i)) });
    },
    setBpmOverride: bpm => {
      const clamped = bpm === undefined ? undefined : Math.min(240, Math.max(40, bpm));
      listener?.setOverride({ bpm: clamped });
      if (clamped !== undefined) {
        lastFollowedBpm = clamped;
        if (band) setBandBpm(band, clamped);
      } else {
        // Override cleared: setOverride() above emits synchronously, so
        // listener's input already reflects the recovered detected tempo.
        const recovered = listener?.input.bpm;
        if (recovered) {
          lastFollowedBpm = recovered;
          if (band) setBandBpm(band, recovered);
        }
      }
    },
    setKeyOverride: key => {
      listener?.setOverride({ key });
    },
    setMicMuted: muted => {
      saveBool(MIC_MUTE_KEY, muted);
      store.update({ micMuted: muted });
      listener?.setMicMuted(muted);
    },
    changeLatencyMs: band?.changeLatencyMs,
  });
  void s;
});

/** ?debug=1 only: the last few bars of scheduled notes, so chord following can be checked
 *  against what the band actually played rather than against the readout. */
const scheduled: { t: number; inst: string; bar: number; notes: number[] }[] = [];

store.update({
  morphSupported: setSinkSupported(),
  morphOut: loadDeviceId(MORPH_SINK_KEY),
  micIn: loadDeviceId(MIC_DEVICE_KEY),
  midiIn: loadDeviceId(MIDI_INPUT_KEY),
  micMuted: loadBool(MIC_MUTE_KEY),
});
if (store.state.morphOut) store.update({ routing: defaultRouting(true) });
void refreshDevices();
onDeviceChange(() => void refreshDevices());

installDebug({
  store,
  scheduled,
  get band() {
    return band;
  },
});

store.update({}); // first render, which is what puts the canvas in the DOM

// No power key: the band boots with the page. Audio stays suspended until the
// first tap (browser autoplay policy); the LCD says so until then.
if (!demo) {
  power().catch(err => {
    store.update({ error: err instanceof Error ? err.message : String(err) });
  });
}

// The strip runs on the AudioContext clock, the same one every scheduled note is timed
// against. In demo mode there is no running context, so it follows the wall clock instead.
viz = createViz(
  root.querySelector<HTMLCanvasElement>('#viz')!,
  store,
  demo ? () => performance.now() / 1000 : () => Tone.now(),
);
// Both note engines schedule through Players, so one hook covers Patterns and AMT. It feeds
// the visualiser and, in ?debug=1, also records the schedule for chord-following checks.
players.onSchedule = (inst, events, barStart, bpm) => {
  const spb = 60 / bpm;
  for (const e of events) viz?.addNote(inst, e.note, barStart + e.time * spb, e.duration * spb, e.velocity);
  if (DEBUG) {
    scheduled.push({ t: Date.now(), inst, bar: store.state.bar, notes: events.map(e => e.note) });
    if (scheduled.length > 200) scheduled.shift();
  }
};

// ?demo=1 paints the live panel with sample state (design review / screenshots only).
if (demo) {
  store.update({
    power: 'on',
    sources: { mic: 'on', midi: 'on' },
    genre: 'funk',
    creativity: 0.65,
    locked: true,
    bar: 9,
    enabled: { drums: true, bass: true, keys: false, lead: true },
    input: { bpm: 96, key: { root: 9, mode: 'minor' }, chord: { root: 9, quality: 'min' }, notesNow: [57, 60, 64], pitch: { midi: 64, cents: 3, stable: true }, inputLevel: 0.72, onsets: 12, pendingBpm: null, dynamics: { intensity: 0.62, space: false, fillDue: false, silenceBeats: 0.25 } },
  });
  runVizDemo(96, 9);
}

/** Feeds the strip a rolling funk pattern so ?demo=1 shows a live timeline, not an empty grid. */
function runVizDemo(bpm: number, startBar: number): void {
  const beat = 60 / bpm;
  const barSec = beat * 4;
  const firstBarAt = performance.now() / 1000 - startBar * barSec;
  viz!.setClock(firstBarAt, bpm);

  const drums: [number, number][] = [
    [0, 36], [0, 42], [0.5, 42], [1, 38], [1, 42], [1.5, 42],
    [2, 36], [2, 42], [2.5, 36], [2.75, 42], [3, 38], [3, 42], [3.5, 46],
  ];
  const bass = [45, 45, 52, 48, 45, 43, 45, 50];
  const lead = [69, 72, 76, 74, 72, 69, 76, 79];
  const you = [57, 60, 64, 62, 60, 57];

  const fillBar = (bar: number): void => {
    const at = firstBarAt + bar * barSec;
    for (const [b, note] of drums) viz!.addNote('drums', note, at + b * beat, 0.12, 0.9);
    for (let i = 0; i < bass.length; i++) viz!.addNote('bass', bass[i], at + i * 0.5 * beat, 0.4 * beat, 0.85);
    for (let i = 0; i < lead.length; i++)
      if (i % 3 !== 2) viz!.addNote('lead', lead[(i + bar) % lead.length], at + i * 0.5 * beat, 0.45 * beat, 0.8);
    // the player, slightly behind the grid and only in bars already gone by
    for (let i = 0; i < you.length; i++)
      viz!.addNote('you', you[(i + bar) % you.length], at + i * 0.66 * beat + 0.02, 0.3 * beat, 0.9);
  };

  // two bars behind the playhead, three ahead, topped up every bar
  for (let b = startBar - 2; b <= startBar + 3; b++) fillBar(b);
  let next = startBar + 4;
  setInterval(() => {
    fillBar(next++);
    store.update({ bar: next - 4 }); // keep the BAR readout on the bar the playhead is in
  }, barSec * 1000);
}
