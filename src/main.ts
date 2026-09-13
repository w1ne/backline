import { PlaybackActivity } from './players/activity';
import './ui/styles.css';
import * as Tone from 'tone';
import { Store } from './ui/state';
import { renderLive, type LiveActions } from './ui/live';
import { PI_EDITION, applyDeviceProfile } from './device/profile';
import { startArturiaControls } from './device/arturia';
import { startDeviceRuntime } from './device/runtime';
import { PerformanceGuard } from './device/performanceGuard';
import { Listener } from './listener/listener';
import { MidiSource } from './listener/midiSource';
import { TapTempo } from './listener/tapTempo';
import { countInClicks } from './band/countIn';
import { initialTempo } from './band/startPolicy';
import { SECTION_LABEL, type FormResult, type Section } from './band/form';
import { PlanFreshness, chooseChord, chooseSection } from './band/planOverride';
import { outputLatencyMs } from './audio/outputLatency';
import { Drone } from './players/drone';
import { FoundSoundSampler } from './audio/foundSound';
import { WhiteNoise } from './players/whiteNoise';
import { LOCAL_SOUNDS } from './device/arturia';
import { MidiMonitor } from './players/monitor';
import { MicSource } from './listener/micSource';
import { Players } from './players/players';
import { PATTERNS } from './patterns';
import { INSTRUMENTS, IDLE_DYNAMICS } from './types';
import type { AccompPreset, Chord, Instrument } from './types';
import { GM_INSTRUMENTS } from './players/gmInstruments';
import { mod12 } from './music/pitchClass';

/** AMT's instrument-preference sampling bias; not user-adjustable. The server derives its
 *  sampling temperature from the Creativity knob. */
const ACCOMP_BIAS = 2.0;
import { effectiveDynamics } from './listener/activity';
import type { BandEngine } from './engines/engine';
import { PatternEngine } from './engines/patternEngine';
import { LyriaEngine } from './engines/lyriaEngine';
import { AceStepEngine } from './engines/acestepEngine';
import { AmtEngine } from './engines/amtEngine';
import { SUSTAIN_MS, SustainedBpmFollower } from './band/bpmForward';
import { MidiRecorder } from './export/midiRecorder';
import { downloadBlob, downloadMidi } from './export/download';
import { audioRecorder } from './export/audioRecorder';
import { DEBUG, installDebug, recordToggle } from './debug';
import { chooseFallback } from './engines/fallback';
import { RELAY_URL } from './config';
import type { EngineChoice } from './ui/state';
import { parseHealth } from './engines/health';
import { MorphBus, setSinkSupported } from './audio/morphBus';
import { VocalChain } from './audio/vocalChain';
import { monitorAllowed } from './audio/monitorSafety';
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
  VOICE_MONITOR_KEY,
  COUNT_IN_DISABLED_KEY,
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
const performanceGuard = new PerformanceGuard();
const demo = new URLSearchParams(location.search).has('demo');
let listener: Listener | undefined;
let band: BandEngine | undefined;
let monitor: MidiMonitor | undefined;
const players = new Players();
const playbackActivity = new PlaybackActivity();
let tempoFollower: SustainedBpmFollower | undefined;
/** ACE-Step's audible parts (rendered audio has no note events); see wireBand */
let aceActiveParts: Partial<Record<Instrument, boolean>> = {};
const accompActivity = new PlaybackActivity<AccompPreset>();
const midiRecorder = new MidiRecorder();
/** native tap on Tone's master output so the audio recorder can capture the synth band */
let masterTap: GainNode | undefined;
const whiteNoise = new WhiteNoise();
const drone = new Drone();
let morph: MorphBus | undefined;
let mic: MicSource | undefined;
let vocalChain: VocalChain | undefined;
let foundSound: FoundSoundSampler | undefined;
let midi: MidiSource | undefined;
/** true once players.init() has built the AudioContext the morph bus has to live in */
let audioReady = false;
let viz: Viz | undefined;
let lastFollowedBpm: number | undefined;
const tapTempo = new TapTempo();
/** taps registered since the last restart; the store only adopts a tempo from the 4th tap on */
let tapCount = 0;
let disarmFallback: (() => void) | undefined;
let halfBarTimer: ReturnType<typeof setTimeout> | undefined;
let beatTimers: ReturnType<typeof setTimeout>[] = [];
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let countInSynth: Tone.Synth | undefined;
let countInTimers: ReturnType<typeof setTimeout>[] = [];
/** How recently the AMT service's own plan supplied a chord/section — see
 *  src/band/planOverride.ts. While it's fresh, the engine's own form and the local chord tick
 *  still run (so the fallback path stays warm) but their results are not applied. */
const planFreshness = new PlanFreshness();
let planChord: Chord | null = null;
let planSection: Section | null = null;

/** Shows a self-dismissing notice in the LCD-styled toast. A later call replaces whatever
 *  is currently showing and restarts the dismiss clock, rather than stacking messages. */
function showToast(message: string, ms = 3500): void {
  if (toastTimer !== undefined) clearTimeout(toastTimer);
  store.update({ toast: message });
  toastTimer = setTimeout(() => {
    toastTimer = undefined;
    store.update({ toast: null });
  }, ms);
}

/** Re-reads the player's activity for one beat and hands the result to the band. Engines only
 *  call back on the bar, so beats 1..3 come off timers re-armed from every downbeat — they
 *  never drift more than a bar, and a bpm change lands on the next one. */
function tickBeat(beat: number): void {
  if (!listener) return;
  // Fold the manual INTENSITY knob into the auto activity before it reaches the band, so every
  // consumer (patterns, Lyria density, ACE/AMT requests) sees the effective value. The store keeps
  // the effective number too, for the INTENSITY bar to show what the band is actually playing at.
  const eff = effectiveDynamics(listener.tickBeat(beat), store.state.intensity, beat);
  // A mic-only singer has no keyboard chord to lean on, so the band knows to keep the keys
  // comp plain and out of the sung note's way (see colorChord / chordPattern).
  const pitch = listener.input.pitch;
  const sungPitchClass = pitch?.stable ? mod12(pitch.midi) : undefined;
  // `source`/`sungPitchClass` are Bandleader-only fields (see src/band/bandleader.ts); cast
  // rather than widen BandEngine.set's signature, since the other engines (Lyria/ACE/AMT)
  // don't and shouldn't know about them -- they simply ignore the extra properties.
  band?.set({ dynamics: eff, source: micIsOnlySource() ? 'mic' : 'midi', sungPitchClass } as Parameters<NonNullable<typeof band>['set']>[0]);
  store.update({ effectiveIntensity: eff.intensity });
}

/** The engine's song form has decided this bar's section (it ticks right after tickBeat handed
 *  it the bar's dynamics, see Bandleader.onBar). Shows the section and, on the ending bar,
 *  stops the band: the Bandleader has already scheduled the ending hit and stops its own clock,
 *  the engine as a whole stops here, and the app goes quiet until the singer's next onset
 *  re-arms it through the first-lock path (the `!store.state.locked` branch in
 *  listener.onChange below). */
function onForm(bar: number, form: FormResult): void {
  // Kept running even under AMT (see planFreshness), purely so the fallback stays warm; its
  // result is only applied when the service hasn't sent a fresher section itself.
  const fresh = planFreshness.sectionFresh(bar);
  const section = chooseSection(store.state.engine, fresh, planSection, form.section);
  if (!fresh && form.shouldStop) {
    band?.stop();
    store.update({ locked: false, accompanimentStatus: SECTION_LABEL.ended });
  } else {
    store.update({ accompanimentStatus: SECTION_LABEL[section] });
  }
}

function clearBeatTimers(): void {
  beatTimers.forEach(t => clearTimeout(t));
  beatTimers = [];
}

function clearCountIn(): void {
  countInTimers.forEach(t => clearTimeout(t));
  countInTimers = [];
  store.update({ countInBeat: null });
}

/** True while the only thing feeding the listener is the mic — no MIDI keyboard is plugged
 *  in — which is exactly when a singer most needs the two bars of click before the band comes in. */
function micIsOnlySource(): boolean {
  const s = listener?.sourceStatus;
  return !!s && s.mic === 'on' && s.midi !== 'on';
}

/**
 * Plays two bars of click on the audio clock (never Tone.now(), so it lines up with
 * `bandStartAt`, the same time the band's clock is armed to) and drives the LCD's "1 2 3 4".
 * Returns the time the count-in itself starts, i.e. `bandStartAt` minus two bars.
 */
function scheduleCountIn(bpm: number, bandStartAt: number): number {
  clearCountIn();
  const ctx = Tone.getContext();
  countInSynth ??= new Tone.Synth({
    oscillator: { type: 'square' },
    envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.05 },
  }).toDestination();
  const clicks = countInClicks(bpm, bandStartAt);
  for (const { atSec, beat } of clicks) {
    countInSynth.triggerAttackRelease(beat === 1 ? 'C5' : 'C4', 0.05, atSec);
    const delayMs = Math.max(0, (atSec - ctx.currentTime) * 1000);
    countInTimers.push(setTimeout(() => store.update({ countInBeat: beat }), delayMs));
  }
  const doneMs = Math.max(0, (bandStartAt - ctx.currentTime) * 1000);
  countInTimers.push(setTimeout(() => store.update({ countInBeat: null }), doneMs));
  return clicks[0]?.atSec ?? bandStartAt;
}

/** Re-decides the chord from what the player just played and hands it to the band.
 *  Driven by the engine's bar callback plus a timer at the half bar, so the band gets a
 *  fresh chord twice a bar — often enough to follow a change, rarely enough to stay stable. */
function tickChord(beat: number): void {
  if (!listener) return;
  // Kept running even under AMT (see planFreshness), purely so the fallback stays warm — its
  // result reaches the band (and, via listener.onChange below, the display) only when the
  // service hasn't sent a fresher chord itself.
  const localChord = listener.tickChord(beat);
  if (!planFreshness.chordFresh(store.state.bar)) band?.set({ chord: localChord, chordBeat: beat });
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
    applyVoiceMonitor();
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
  applyVoiceMonitor();
}

/**
 * Builds the vocal chain the first time the mic's source node exists, then keeps it in
 * sync with whether monitoring is currently safe: never on a phone speaker, and even off
 * a phone only with the singer's opt-in or a chosen output device — and always off while
 * the mic itself is muted.
 */
function applyVoiceMonitor(): void {
  if (!audioReady || !mic?.sourceNode) return;
  const reverbBus = players.reverbBus();
  const masterInput = players.preLimiterInput();
  if (!reverbBus || !masterInput) return;
  vocalChain ??= new VocalChain(mic.sourceNode, reverbBus, masterInput);
  const allowed = monitorAllowed({
    userAgent: navigator.userAgent,
    optedIn: store.state.voiceMonitor,
    outputDeviceId: store.state.morphOut,
  });
  vocalChain.setEnabled(allowed && !store.state.micMuted);
}

/** Builds the found-sound sampler the first time the mic's source node and the band's
 *  master chain both exist; a no-op once built. Subscribes it to the MORPH bus once so it
 *  keeps following that device without any further wiring. */
function applyFoundSound(): void {
  if (foundSound || !audioReady || !mic?.sourceNode) return;
  const reverbBus = players.reverbBus();
  const masterInput = players.preLimiterInput();
  if (!reverbBus || !masterInput) return;
  foundSound = new FoundSoundSampler(mic.sourceNode);
  foundSound.connectMaster(masterInput, reverbBus);
  players.onMorphChange(node => foundSound?.setMorphNode(node));
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
  playbackActivity.clear();
  accompActivity.clear();
  store.update({activeParts: {}, accompActive: {}, modelLatencyMs:null, responseLatencyMs:null, queueLatencyMs:null, requestAgeMs:null, tooLate:0, accompanimentStatus: 'Listening'});
  if (engine === 'lyria') return new LyriaEngine(players.rawContext());
  if (engine === 'acestep') return new AceStepEngine(players.rawContext(), () => [mic?.mediaStream, monitor?.stream]);
  if (engine === 'amt') return new AmtEngine(players, listener!, undefined, undefined, undefined, () => outputLatencyMs(players.rawContext()));
  return new PatternEngine(players, PATTERNS);
}

function wireBand(b: BandEngine): void {
  b.setAmount?.(store.state.intensity);
  b.setAccompaniment?.(store.state.accompPresets, ACCOMP_BIAS);
  INSTRUMENTS.forEach(i => b.setEnabled(i, store.state.enabled[i]));
  b.routeBand?.(store.state.routing.band, morph?.input);
  b.onBar = bar => {
    store.update({ bar, barStartedAt: Date.now() });
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
  b.onForm = onForm;
  b.onError = msg => store.update({ error: msg, accompanimentStatus: 'Reconnecting' });
  b.onStatus = (message, latencyMs, stats) => {
    if (band !== b) return;
    store.update({ ...(message ? {accompanimentStatus:message} : {}),
      ...(latencyMs !== undefined ? {modelLatencyMs:latencyMs} : {}),
      ...(stats ? {tooLate: stats.tooLate, queueLatencyMs: stats.queueLatencyMs ?? null, requestAgeMs: stats.requestAgeMs ?? null} : {}) });
  };
  b.onResponseTiming = responseLatencyMs => {
    if (band === b) store.update({ responseLatencyMs });
  };
  b.onStats = s => {
    const increased = s.loops > store.state.loops;
    store.update({ loops: s.loops, loopsUpdatedAt: increased ? Date.now() : store.state.loopsUpdatedAt });
  };
  if (b instanceof AceStepEngine) {
    // rendered audio has no note events: every enabled part is playing once blocks arrive.
    // The meter tick below reads this instead of playbackActivity for the ACE band.
    aceActiveParts = {};
    b.onActive = parts => {
      if (band === b) aceActiveParts = parts;
    };
  } else {
    aceActiveParts = {};
  }
  if (b instanceof AmtEngine) {
    b.onChord = (chord, fromBeat) => {
      planChord = chord;
      planFreshness.noteChord(store.state.bar);
      // AmtEngine doesn't place notes on the beat grid, so it (like the interface note on
      // BandEngine.set says) has no use for chordBeat; only Bandleader-backed engines do.
      b.set({ chord });
      store.update({ input: { ...store.state.input, chord } });
    };
    b.onSection = section => {
      planSection = section;
      planFreshness.noteSection(store.state.bar);
      if (section === 'ending') {
        // Same stop the engine's own form drives on its 'ending' bar (see onForm).
        band?.stop();
        store.update({ locked: false, accompanimentStatus: SECTION_LABEL.ending });
        return;
      }
      store.update({ accompanimentStatus: SECTION_LABEL[section] });
    };
  }
}

/** Arms the 8s connect/first-block watchdog for `engine`'s band `b`. If it fails to connect or
 *  produce a first block in time (or errors out sooner), stops it and starts Patterns in its
 *  place at the same bpm. Returns a disposer to call once the engine is confirmed healthy or the
 *  band is torn down for another reason.
 *
 *  After `settle()` the error hook stays as the terminal fallback only: the AMT engine now keeps a
 *  dropped socket to itself and reconnects with backoff for up to 20 s (resuming the session), so
 *  an error that reaches here mid-set is one it has already given up on, not a blip. */
function armFallback(engine: EngineChoice, b: BandEngine): () => void {
  const fallback = chooseFallback(engine);
  if (!fallback) return () => {};

  let settled = false;
  store.update({ engineConnecting: true });

  const settle = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (store.state.engine === engine) store.update({ engineConnecting: false });
  };

  const timer = setTimeout(trigger, FALLBACK_TIMEOUT_MS);

  // The engine's own onError (status + message) runs first; the fallback decision follows.
  const userOnError = b.onError;
  b.onFirstBlock = settle;
  // AMT is allowed to listen before producing notes; an open socket establishes
  // connectivity, while onStatus/actual scheduled notes report output separately.
  if (engine === 'amt') b.onConnected = settle;
  b.onError = msg => {
    userOnError?.(msg);
    trigger();
  };

  function trigger(): void {
    if (band !== b) return;
    settle();
    const result = chooseFallback(engine);
    if (!result || band !== b) return;
    b.stop();
    planFreshness.reset();
    planChord = null;
    planSection = null;
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

// Readiness probe: the relay reports each upstream's health, so a stopped GPU pod lights the
// engine LED red at load instead of the band silently going generic. Engines stay selectable.
// Re-polled every 30 s: a page opened while the pod was restarting used to keep its red LED
// for the whole visit ("AMT is always offline"), and a pod that dies mid-set never showed.
function pollHealth(): void {
  fetch(RELAY_URL + '/health')
    .then(async res => {
      const body = await res.text();
      const health = parseHealth(body);
      if (health) store.update({ offlineEngines: health });
    })
    .catch(() => {
      store.update({ offlineEngines: ['acestep', 'lyria', 'amt'] });
    });
}
pollHealth();
setInterval(pollHealth, 30_000);

async function power() {
  store.update({ error: null });
  planFreshness.reset();
  planChord = null;
  planSection = null;
  await players.init();
  audioReady = true;
  // Route the utility voices through the band's own master chain (reverb bus, pre-limiter
  // input) instead of the raw destination, so they can't clip independently of the band and
  // sit in the same room as everything else.
  const busReverb = players.reverbBus();
  const busInput = players.preLimiterInput();
  if (busReverb && busInput) {
    whiteNoise.connectTo(busReverb, busInput);
    drone.connectTo(busReverb, busInput);
  }
  whiteNoise.setEnabled(true);
  drone.setEnabled(true);
  const ctx = players.rawContext();
  store.update({ audioSuspended: ctx.state !== 'running' });
  // outputLatency is only meaningful (and on some browsers only populated) once the
  // context is actually running, so read it now and again on every state change.
  const readOutputLatency = () => {
    if (ctx.state === 'running') store.update({ outputLatencyMs: outputLatencyMs(ctx) });
  };
  readOutputLatency();
  ctx.addEventListener('statechange', () => {
    store.update({ audioSuspended: ctx.state !== 'running' });
    readOutputLatency();
  });
  players.setGenre(store.state.genre);
  await applyMorph();

  const engine = store.state.engine;

  midi = new MidiSource(store.state.midiIn);
  mic = new MicSource(store.state.micIn);
  mic.onPitchError = error => store.update({ error });
  midi.onInputs(inputs => store.update({ midiInputs: inputs }));
  // MIDI times are performance.now-based. Read at use, not at boot: the AudioContext clock
  // stands still until the first gesture resumes it.
  //
  // A note scheduled at audio-clock time T is not actually audible until T + outputLatency
  // (on phones this can be tens of ms) — so a band scheduled straight off this offset would
  // always drag behind the singer by that much. Subtracting outputLatency here shifts every
  // downstream schedule time (firstBarAt, count-in clicks) earlier by the same amount, so
  // what comes out of the speaker lines up with the listener's wall-clock timestamps instead
  // of lagging behind them.
  const perfOffset = (): number => Tone.now() - performance.now() / 1000 - (store.state.outputLatencyMs ?? 0) / 1000;

  listener = new Listener([midi, mic], ['midi', 'mic']);
  listener.onPerformance(e => {
    if (e.type === 'note_on') performanceGuard.noteOn(e.id);
    else performanceGuard.noteOff(e.id);
  });
  listener.setMicMuted(store.state.micMuted);
  monitor = new MidiMonitor(players.rawContext(), store.state.sound, players.reverbBus(), players.preLimiterInput());
  const activeMonitor = monitor;
  activeMonitor.onError = error => store.update({ error: `Keyboard sound: ${String(error)}` });
  monitor.start().then(() => PI_EDITION ? activeMonitor.preload(LOCAL_SOUNDS) : undefined)
    .catch(error => store.update({ error: `Keyboard sound: ${String(error)}` }));
  band = makeBand(engine);
  band.set({ genre: store.state.genre, creativity: store.state.creativity });
  wireBand(band);

  listener.onSourceStatus(sources => store.update({ sources: { ...sources } }));

  // The listener timestamps notes on the performance.now clock; the strip draws on the
  // AudioContext one, which is what every scheduled band note is already in.
  listener.onNote(n => {
    // Paused means paused: the performer's own notes are neither shown nor recorded
    // until they let the band play again.
    if (store.state.paused) return;
    const t = n.timeSec + perfOffset();
    viz?.addNote('you', n.midi, t, YOU_NOTE_SEC, n.velocity);
    if (store.state.recording) midiRecorder.addYou(n.midi, n.velocity, t);
  });

  listener.onChange(input => {
    performanceGuard.observeOnsets(input.onsets);
    if (store.state.paused) return;
    // The strip's voice line: the continuous reading, not the snapped note, so a slide looks
    // like a slide. Runs on every listener emit (~20 Hz from the mic's pitch poll).
    const p = input.pitch;
    viz?.addPitch(Tone.now(), p ? p.midi + p.cents / 100 : null, p?.stable ?? false);
    // The service's chord wins the display too while its plan is fresh — see planOverride.ts.
    const startingBpm = !store.state.locked ? initialTempo({
      micOnly: micIsOnlySource(), stablePitch: input.pitch?.stable ?? false,
      bpm: input.bpm, voiceBpm: input.voiceBpm,
    }) : null;
    if (startingBpm != null) {
      listener!.setSessionTempo(startingBpm);
      input = { ...input, bpm: startingBpm };
    }
    const fresh = planFreshness.chordFresh(store.state.bar);
    store.update({ input: fresh ? { ...input, chord: chooseChord(store.state.engine, fresh, planChord, input.chord) } : input });
    if (input.key) drone.setRoot(input.key.root);
    if (input.key) band!.set({ key: input.key });
    if (input.bpm && !store.state.locked) {
      const downbeat = listener!.downbeat;
      const db = downbeat == null ? Tone.now() + 0.15 : downbeat + perfOffset();
      const barLen = 240 / input.bpm;
      let first = db;
      while (first < Tone.now() + 0.1) first += barLen;
      // A singer with no MIDI keyboard plugged in gets no click track from anywhere else,
      // so give them two bars of count-in before the band enters, pushing the band's own
      // first bar back by that much.
      if (store.state.countIn && micIsOnlySource()) {
        first += 2 * barLen;
        scheduleCountIn(input.bpm, first);
      }
      store.update({ locked: true }); // this onset may be the singer re-starting the band after an ending
      lastFollowedBpm = input.bpm;
      disarmFallback?.();
      disarmFallback = armFallback(store.state.engine, band!);
      startBand(band!, input.bpm, first).catch(err => {
        store.update({ error: `${store.state.engine}: ${err instanceof Error ? err.message : String(err)}` });
      });
    } else if (store.state.locked && store.state.tempoMode === 'follow' && input.bpm) {
      // Follow a change of pace, not a rushed phrase: the estimate has to move by the engine's
      // step and hold there for SUSTAIN_MS before the band moves. A tapped tempo is a strong
      // prior, so it takes twice the hold to overrule it.
      const holdMs = listener!.hasBpmOverride ? 2 * SUSTAIN_MS : SUSTAIN_MS;
      if (!tempoFollower || tempoFollower.step !== band!.bpmStep || tempoFollower.sustainMs !== holdMs) {
        tempoFollower = new SustainedBpmFollower(band!.bpmStep, holdMs);
      }
      const next = tempoFollower.observe(lastFollowedBpm, input.bpm, performance.now());
      if (next !== undefined && next !== lastFollowedBpm) {
        lastFollowedBpm = next;
        setBandBpm(band!, next);
      }
    }
  });

  store.update({ power: 'on', error: null });
  await listener.start();
  store.update({ sources: { ...listener.sourceStatus } });
  applyVoiceMonitor();
  applyFoundSound();
  // labels only come back from enumerateDevices() once a media permission has been
  // granted, so the pickers are worth re-reading right after the mic starts
  void refreshDevices().catch(() => undefined);
}

function powerOff() {
  performanceGuard.clear();
  whiteNoise.setEnabled(false);
  drone.setEnabled(false);
  if (toastTimer !== undefined) clearTimeout(toastTimer);
  toastTimer = undefined;
  disarmFallback?.();
  disarmFallback = undefined;
  if (halfBarTimer !== undefined) clearTimeout(halfBarTimer);
  halfBarTimer = undefined;
  clearBeatTimers();
  clearCountIn();
  band?.stop();
  playbackActivity.clear();
  accompActivity.clear();
  // Remove the monitor's owned edge before the listener disconnects the shared
  // microphone source from every destination.
  vocalChain?.dispose();
  vocalChain = undefined;
  listener?.stop();
  listener = undefined;
  monitor?.stop();
  monitor = undefined;
  lastFollowedBpm = undefined;
  store.update({
    power: 'off',
    paused: false,
    activeParts: {},
    accompActive: {},
    accompanimentStatus: 'Paused',
    sources: { mic: 'off', midi: 'off' },
    locked: false,
    bar: 0,
    tempoMode: 'locked',
    error: null,
    loops: 0,
    loopsUpdatedAt: undefined,
    effectiveIntensity: 0,
    input: { bpm: null, key: null, chord: null, notesNow: [], pitch: null, inputLevel: 0, onsets: 0, pendingBpm: null, voiceBpm: null, dynamics: { ...IDLE_DYNAMICS } },
    toast: null,
  });
}

/** Every control the panel can drive. Built once: the store emits on every listener update
 *  (level, pitch, onset), and each entry reads live state when it runs, not a snapshot. */
const liveActions: LiveActions = {
  toggleRecord: () => {
    if (!store.state.recording) {
      midiRecorder.reset();
      const ctx = Tone.getContext().rawContext as AudioContext;
      // the synth band plays through Tone's destination; generated audio and the mic
      // register themselves with the recorder when they are created
      if (!masterTap) {
        masterTap = ctx.createGain();
        Tone.getDestination().connect(masterTap);
        audioRecorder.addSource(masterTap);
      }
      const audioOk = audioRecorder.start(ctx);
      store.update({ recording: true, error: audioOk ? null : 'This browser cannot record audio; only MIDI will be saved' });
      return;
    }
    store.update({ recording: false });
    const name = `duetai-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}`;
    const hadAudio = audioRecorder.recording;
    void audioRecorder.stop().then(audio => {
      if (audio && audio.blob.size) downloadBlob(audio.blob, `${name}.${audio.ext}`);
    });
    if (midiRecorder.empty) {
      store.update({ error: hadAudio ? 'Audio saved. No notes for MIDI: the band was not playing and no sung note was heard' : 'Nothing was recorded: no audio support and no notes heard' });
      return;
    }
    const bpm = lastFollowedBpm ?? store.state.input.bpm ?? undefined;
    downloadMidi(midiRecorder.toMidi(bpm), `${name}.mid`);
  },
  togglePause: () => {
    if (!band) return;
    if (!store.state.paused) {
      if (halfBarTimer !== undefined) clearTimeout(halfBarTimer);
      halfBarTimer = undefined;
      clearBeatTimers();
      band.stop();
      playbackActivity.clear();
      // The band alone isn't the whole mix: the ambient drone/noise beds run independently
      // of the transport, so pause has to silence those too or it isn't actually silent.
      drone.setEnabled(false);
      whiteNoise.setEnabled(false);
      store.update({ paused: true, activeParts: {}, accompanimentStatus: 'Paused' });
      showToast('Paused — mic & MIDI input is not being taken');
      return;
    }
    if (toastTimer !== undefined) clearTimeout(toastTimer);
    toastTimer = undefined;
    drone.setEnabled(true);
    whiteNoise.setEnabled(true);
    store.update({ paused: false, accompanimentStatus: 'Listening', toast: null });
    const bpm = lastFollowedBpm ?? store.state.input.bpm;
    if (bpm && store.state.locked) {
      startBand(band, bpm, Tone.now() + 0.1).catch(err => {
        store.update({ error: `${store.state.engine}: ${err instanceof Error ? err.message : String(err)}` });
      });
    } else store.update({ accompanimentStatus: 'Listening' });
  },
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
  playbackTarget: PI_EDITION ? 'Pi' : 'This browser',
  soundIds: PI_EDITION ? LOCAL_SOUNDS : undefined,
  setEngine: e => {
    const prevEngine = store.state.engine;
    // A fresh pick clears any stale "<ENGINE> OFFLINE" fallback note.
    store.update({ engine: e, error: null });
    if (store.state.power !== 'on' || !band || e === prevEngine) return;
    // Power-cycle the band engine in place, at the same bpm/key, instead of
    // making the user power off first.
    const bpm = lastFollowedBpm ?? store.state.input.bpm ?? undefined;
    const key = store.state.input.key ?? undefined;
    disarmFallback?.();
    disarmFallback = undefined;
    band.stop();
    planFreshness.reset();
    planChord = null;
    planSection = null;
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
  toggleAccompPreset: (preset: AccompPreset, on: boolean) => {
    const presets = on
      ? [...store.state.accompPresets, preset]
      : store.state.accompPresets.filter(p => p !== preset);
    band?.setAccompaniment?.(presets, ACCOMP_BIAS);
    store.update({ accompPresets: presets });
  },
  setIntensity: i => {
    const amount = Math.min(1, Math.max(0, i));
    band?.setAmount?.(amount);
    store.update({ intensity: amount });
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
  tap: () => {
    const t = Tone.now();
    tapCount++;
    const r = tapTempo.push(t);
    if (!r || tapCount < 4) return null;
    // Same path a typed bpm takes: the listener's override wins over any detected tempo.
    listener?.setOverride({ bpm: r.bpm });
    lastFollowedBpm = r.bpm;
    if (band) {
      disarmFallback?.();
      disarmFallback = armFallback(store.state.engine, band);
      store.update({ locked: true });
      // r.downbeat is the audio-clock time of the tap that just completed the estimate:
      // restart the band's clock right there so the next bar starts on the beat the
      // singer just tapped, not on whatever bar the band happened to be in.
      startBand(band, r.bpm, r.downbeat).catch(err => {
        store.update({ error: err instanceof Error ? err.message : String(err) });
      });
    }
    return r;
  },
  setCountIn: on => {
    saveBool(COUNT_IN_DISABLED_KEY, !on);
    store.update({ countIn: on });
  },
  setMicMuted: muted => {
    saveBool(MIC_MUTE_KEY, muted);
    store.update({ micMuted: muted });
    listener?.setMicMuted(muted);
    applyVoiceMonitor();
  },
  setVoiceMonitor: enabled => {
    saveBool(VOICE_MONITOR_KEY, enabled);
    store.update({ voiceMonitor: enabled });
    applyVoiceMonitor();
  },
  setDroneVolume: value => {
    const droneVolume = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    drone.setEnabled(store.state.power === 'on' && !store.state.paused);
    drone.setLevel(droneVolume);
    store.update({ droneVolume });
  },
  setDroneRegister: value => {
    const droneRegister = Number.isFinite(value) ? Math.min(2, Math.max(-2, value)) : 0;
    drone.setRegister(droneRegister);
    store.update({ droneRegister });
  },
  setNoiseVolume: value => {
    const noiseVolume = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    whiteNoise.setEnabled(store.state.power === 'on' && !store.state.paused);
    whiteNoise.setLevel(noiseVolume);
    store.update({ noiseVolume });
  },
  setNoiseRegister: value => {
    const noiseRegister = Number.isFinite(value) ? Math.min(2, Math.max(-2, value)) : 0;
    whiteNoise.setRegister(noiseRegister);
    store.update({ noiseRegister });
  },
  startSampleRecording: () => {
    if (!foundSound || foundSound.isRecording) return;
    store.update({ sampleRecording: true });
    void foundSound.startRecording();
  },
  stopSampleRecording: () => {
    if (!foundSound?.isRecording) return;
    foundSound.stopRecording().then(() => {
      store.update({ sampleRecording: false, sampleReady: foundSound!.hasClip });
    });
  },
  triggerSample: () => {
    if (!foundSound?.hasClip) return;
    // 0 means the Transport isn't running (no lock yet) -- play immediately instead of
    // silently scheduling for a "next beat" that will never come.
    foundSound.trigger(Tone.getTransport().nextSubdivision('4n') || undefined);
  },
  setSound: sound => {
    if (sound === store.state.sound) return;
    monitor?.setSound(sound).catch(error => store.update({error: `Keyboard sound: ${String(error)}`}));
    store.update({ sound });
  },
  get changeLatencyMs() {
    return band?.changeLatencyMs;
  },
};

store.subscribe(() => renderLive(root, store, liveActions));

/** ?debug=1 only: the last few bars of scheduled notes, so chord following can be checked
 *  against what the band actually played rather than against the readout. */
const scheduled: { t: number; inst: string; bar: number; notes: number[] }[] = [];

store.update({
  morphSupported: setSinkSupported(),
  morphOut: loadDeviceId(MORPH_SINK_KEY),
  micIn: loadDeviceId(MIC_DEVICE_KEY),
  midiIn: loadDeviceId(MIDI_INPUT_KEY),
  micMuted: loadBool(MIC_MUTE_KEY),
  voiceMonitor: loadBool(VOICE_MONITOR_KEY),
  countIn: !loadBool(COUNT_IN_DISABLED_KEY),
});
if (store.state.morphOut) store.update({ routing: defaultRouting(true) });
applyDeviceProfile(store, PI_EDITION ? 'lydia' : 'web');
void refreshDevices();
onDeviceChange(() => void refreshDevices());

installDebug({
  store,
  scheduled,
  get band() {
    return band;
  },
  /** The panel's actions, so a headless gate can switch engines the way a tap does. */
  get actions() {
    return liveActions;
  },
});

store.update({}); // first render, which is what puts the canvas in the DOM

// No power key: the band boots with the page. Audio stays suspended until the
// first tap (browser autoplay policy); the LCD says so until then.
if (!demo) {
  void startArturiaControls(store, () => liveActions).catch(error => console.warn('Arturia controls:', error));
  power().catch(err => {
    store.update({ error: err instanceof Error ? err.message : String(err) });
  });
}
if (PI_EDITION && !demo) {
  startDeviceRuntime(store, () => liveActions, async playing => {
    if (playing === (store.state.power === 'on')) return;
    Tone.getDestination().mute = !playing;
    if (playing) await power();
    else powerOff();
  }, () => ({ ...performanceGuard.snapshot(store.state),
    ...(listener?.manualOverrides ?? { bpmOverride: null, keyOverride: null }) }));
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
  playbackActivity.add(inst, events, barStart, bpm);
  if (store.state.recording) midiRecorder.addBand(inst, events, barStart, bpm);
  const spb = 60 / bpm;
  for (const e of events) viz?.addNote(inst, e.note, barStart + e.time * spb, e.duration * spb, e.velocity);
  if (DEBUG) {
    scheduled.push({ t: Date.now(), inst, bar: store.state.bar, notes: events.map(e => e.note) });
    if (scheduled.length > 200) scheduled.shift();
  }
};
const failedAccompSamples = new Set<number>();
const sampleLoadMessage = 'An accompaniment instrument could not load. Retrying…';
players.onSampleError = (gmProgram) => {
  failedAccompSamples.add(gmProgram);
  store.update({ error: sampleLoadMessage });
};
players.onAccompSchedule = (gmProgram, events, barStart, bpm) => {
  failedAccompSamples.delete(gmProgram);
  if (!failedAccompSamples.size && store.state.error === sampleLoadMessage) store.update({ error: null });
  for (const preset of GM_INSTRUMENTS[gmProgram]?.presets ?? []) accompActivity.add(preset, events, barStart, bpm);
};

// Meter state uses the audio clock so future model plans do not look audible early.
setInterval(() => {
  if (!audioReady) return;
  const s = store.state;
  const activeParts = s.power === 'on' && !s.audioSuspended
    ? (band instanceof AceStepEngine && s.locked && !s.paused ? aceActiveParts : playbackActivity.at(Tone.getContext().currentTime))
    : {};
  if (JSON.stringify(activeParts) !== JSON.stringify(s.activeParts)) store.update({activeParts});
  const accompActive = s.power === 'on' && !s.audioSuspended
    ? accompActivity.at(Tone.getContext().currentTime) : {};
  if (JSON.stringify(accompActive) !== JSON.stringify(s.accompActive)) store.update({accompActive});
}, 100);

// ?demo=1 paints the live panel with sample state (design review / screenshots only).
if (demo) {
  store.update({
    power: 'on',
    sources: { mic: 'on', midi: 'on' },
    genre: 'funk',
    accompanimentStatus: 'Playing',
    creativity: 0.65,
    locked: true,
    bar: 9,
    enabled: { drums: true, bass: true, keys: false, lead: true },
    input: { bpm: 96, key: { root: 9, mode: 'minor' }, chord: { root: 9, quality: 'min' }, notesNow: [57, 60, 64], pitch: { midi: 64, cents: 3, stable: true }, inputLevel: 0.72, onsets: 12, pendingBpm: null, voiceBpm: null, dynamics: { intensity: 0.62, space: false, fillDue: false, silenceBeats: 0.25 } },
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
    // and the voice line through those notes: one phrase per bar that scoops into the first
    // note, glides between the rest with a little vibrato on each, then breathes at the bar end
    const phraseEnd = you.length - 1;
    for (let i = 0; i < you.length; i++) {
      const target = you[(i + bar) % you.length];
      const prev = i === 0 ? target - 3 : you[(i - 1 + bar) % you.length];
      const start = at + i * 0.66 * beat + 0.02;
      for (let k = 0; k < 14; k++) {
        const f = k / 14;
        const t = start + f * 0.66 * beat;
        const glide = f < 0.25 ? (prev - target) * Math.pow(1 - f / 0.25, 2) : 0;
        const vib = f > 0.4 ? Math.sin((f - 0.4) * Math.PI * 5) * 0.2 : 0;
        viz!.addPitch(t, target + glide + vib, f >= 0.25);
      }
      if (i === phraseEnd) viz!.addPitch(start + 0.66 * beat, null, false);
    }
  };

  // two bars behind the playhead, three ahead, topped up every bar
  for (let b = startBar - 2; b <= startBar + 3; b++) fillBar(b);
  let next = startBar + 4;
  setInterval(() => {
    fillBar(next++);
    store.update({ bar: next - 4 }); // keep the BAR readout on the bar the playhead is in
  }, barSec * 1000);
}
