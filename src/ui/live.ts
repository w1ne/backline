import { GENRES, INSTRUMENTS } from '../types';
import { SOUNDS, SOUND_GROUPS, type MonitorSound } from '../players/monitor';
import type { Genre, Instrument } from '../types';
import { keyName } from '../music/scales';
import { chordName } from '../listener/chordDetector';
import { DEBUG } from '../debug';
import type { AppState, Store } from './state';
import type { SourceState } from '../listener/listener';
import { anyMorph, ROUTE_TARGETS, type MorphRoute, type RouteTarget } from '../audio/routing';
import { shortDeviceName, type DeviceOption } from '../audio/devices';

const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const ALL_KEYS: { root: number; mode: 'major' | 'minor' }[] = [
  ...KEY_NAMES.map((_, root) => ({ root, mode: 'major' as const })),
  ...KEY_NAMES.map((_, root) => ({ root, mode: 'minor' as const })),
];

export interface LiveActions {
  power(): void;
  powerOff(): void;
  toggle(i: Instrument): void;
  setGenre(g: Genre): void;
  setEngine(e: 'lyria' | 'patterns' | 'acestep' | 'amt'): void;
  setCreativity(c: number): void;
  /** manual INTENSITY knob — how much the band adds */
  setIntensity?(i: number): void;
  setBpmOverride?(bpm: number | undefined): void;
  setKeyOverride?(key: { root: number; mode: 'major' | 'minor' } | undefined): void;
  setTempoMode?(m: 'locked' | 'follow'): void;
  setSound?(s: MonitorSound): void;
  /** advance one part's route: main -> morph -> both -> main */
  cycleMorph?(target: RouteTarget): void;
  /** pick the MORPH output device, or null to switch the morph bus off */
  setMorphOutput?(deviceId: string | null): void;
  /** pick the mic input device, or null for the system default */
  setMicInput?(deviceId: string | null): void;
  /** gate the mic out of the listener (onsets/pitch/level); MIDI keeps working */
  setMicMuted?(muted: boolean): void;
  /** pick the MIDI input by id, or null to listen to every connected one */
  setMidiInput?(id: string | null): void;
  /** ms a toggled instrument spends showing "joining…"/"leaving…" before it settles */
  changeLatencyMs?: number;
}

const actionsRef = new WeakMap<HTMLElement, LiveActions>();

const GENRE_COLOR: Record<Genre, string> = {
  lofi: 'var(--orange)',
  funk: 'var(--yellow)',
  rock: 'var(--blue)',
  jazz: 'var(--pink)',
};

export function renderLive(root: HTMLElement, store: Store, actions: LiveActions): void {
  let screen = root.querySelector<HTMLElement>('.screen[data-live]');
  if (!screen) {
    root.innerHTML = skeleton();
    screen = root.querySelector<HTMLElement>('.screen[data-live]')!;
    screen.classList.add('intro');
    actionsRef.set(screen, actions);
    wireControls(screen, store);
  } else {
    // Refresh the stored actions reference so listeners wired once below always
    // call into the latest closure (which may read fresher store state), instead
    // of the actions object captured on the very first render.
    actionsRef.set(screen, actions);
  }
  update(screen, store.state, actions.changeLatencyMs ?? 0);
}

function skeleton(): string {
  return `
    <div class="screen" data-live>
      <div class="bar">
        <div class="bar-top">
          <h1 class="logo">Back<i>line</i></h1>
          <span class="pill" id="live-pill"></span>
        </div>
        <span class="lcd" id="lcd"></span>
      </div>
      <div class="readout">
        <div class="ro-tempo"><small>Tempo</small><strong id="ro-tempo">&mdash;</strong></div>
        <div class="ro-side">
          <div><small>Key</small><strong id="ro-key">&mdash;</strong></div>
          <div><small>Chord</small><strong id="chord">&mdash;</strong></div>
          <div><small>Bar</small><strong id="ro-bar">0</strong></div>
        </div>
        <div class="beats" id="beats">
          <b>Beat</b><i style="--n:0"></i><i style="--n:1"></i><i style="--n:2"></i><i style="--n:3"></i>
        </div>
        <canvas class="viz" id="viz" role="img"
                aria-label="Scrolling timeline of your notes and the band's next bars"></canvas>
      </div>
      <div class="inst" id="inst-tiles">
        ${INSTRUMENTS.map(
          i =>
            `<div class="pad">
              <button type="button" class="pad-btn ${i}" data-inst="${i}">
                <span class="dot"></span>
                <span class="name">${displayLabel(i)}</span>
                <span class="st"><span class="st-text"></span><span class="meter"><i style="width:0"></i></span></span>
              </button>
              <button type="button" class="morph-key" id="morph-${i}" data-morph="${i}"
                      aria-label="Morph route for ${i}">M<span class="morph-led"></span></button>
            </div>`,
        ).join('')}
      </div>
      <div class="row2">
        <div class="zone zone--pink knob-zone">
          <span class="zone-label">Creativity</span>
          <div class="knob" id="creativity-knob" role="slider" tabindex="0"
               aria-label="Creativity" aria-valuemin="0" aria-valuemax="1" aria-valuenow="0">
            <span class="ptr"></span>
          </div>
          <span class="knob-val" id="creativity-val"></span>
          <input class="vh" type="range" id="creativity" min="0" max="1" step="0.05" aria-hidden="true" tabindex="-1" />
        </div>
        <div class="zone zone--pink knob-zone">
          <span class="zone-label">Intensity</span>
          <div class="knob" id="intensity-knob" role="slider" tabindex="0"
               aria-label="Intensity" aria-valuemin="0" aria-valuemax="1" aria-valuenow="0.5">
            <span class="ptr"></span>
          </div>
          <span class="knob-val" id="intensity-val"></span>
          <input class="vh" type="range" id="intensity" min="0" max="1" step="0.05" aria-hidden="true" tabindex="-1" />
        </div>
        <div class="zone zone--blue">
          <span class="zone-label">Genre</span>
          <div class="chips" id="genre-chips">
            ${GENRES.map(g => `<button type="button" class="chip" data-genre="${g}">${g}</button>`).join('')}
          </div>
          <select class="vh" id="genre" aria-label="Genre" tabindex="-1">
            ${GENRES.map(g => `<option value="${g}">${cap(g)}</option>`).join('')}
          </select>
        </div>
        <div class="zone zone--orange engine">
          <span class="zone-label">Engine</span>
          <div class="engine-keys" id="engine-choice">
            <button type="button" class="engine-key" id="engine-patterns" data-engine="patterns">
              <span class="engine-key-text">
                <span class="engine-key-name">Patterns</span>
                <span class="engine-key-desc">offline · instant</span>
              </span>
              <span class="engine-led" data-engine-led="patterns"></span>
            </button>
            <button type="button" class="engine-key" id="engine-lyria" data-engine="lyria">
              <span class="engine-key-text">
                <span class="engine-key-name">Lyria</span>
                <span class="engine-key-desc">Google API · ~0.5 s</span>
              </span>
              <span class="engine-led" data-engine-led="lyria"></span>
            </button>
            <button type="button" class="engine-key" id="engine-acestep" data-engine="acestep">
              <span class="engine-key-text">
                <span class="engine-key-name">Ace</span>
                <span class="engine-key-desc">GPU · 2-bar blocks</span>
              </span>
              <span class="engine-led" data-engine-led="acestep"></span>
            </button>
            <button type="button" class="engine-key" id="engine-amt" data-engine="amt">
              <span class="engine-key-text">
                <span class="engine-key-name">AMT</span>
                <span class="engine-key-desc">follows your notes · MIDI</span>
              </span>
              <span class="engine-led" data-engine-led="amt"></span>
            </button>
          </div>
        </div>
        <div class="zone zone--yellow manual">
          <span class="zone-label">Manual</span>
          <div class="field">
            <span class="fl">Tempo</span>
            <span class="switch" id="tempoMode">
              <button type="button" data-mode="locked">Locked</button>
              <button type="button" data-mode="follow">Follow</button>
            </span>
          </div>
          <div class="field">
            <label for="bpm">Bpm</label>
            <input type="number" id="bpm" min="40" max="240" placeholder="auto" />
          </div>
          <div class="field">
            <label for="key">Key</label>
            <select id="key">
              <option value="auto">auto</option>
              ${ALL_KEYS.map(
                k =>
                  `<option value="${k.root}-${k.mode}">${KEY_NAMES[k.root]} ${k.mode === 'major' ? 'maj' : 'min'}</option>`,
              ).join('')}
            </select>
          </div>
          <div class="field">
            <label for="sound">Keys</label>
            <select id="sound">
              ${SOUND_GROUPS.map(
                g =>
                  `<optgroup label="${g}">${SOUNDS.filter(s => s.group === g)
                    .map(s => `<option value="${s.id}">${s.label}</option>`)
                    .join('')}</optgroup>`,
              ).join('')}
            </select>
          </div>
          <div class="field">
            <label for="mic-in">Mic in</label>
            <select id="mic-in"><option value="">default</option></select>
          </div>
          <div class="field">
            <label for="midi-in">Midi in</label>
            <select id="midi-in"><option value="">all</option></select>
          </div>
          <div class="field">
            <label for="morph-out">Morph out</label>
            <select id="morph-out"><option value="">off</option></select>
          </div>
          <div class="field">
            <button type="button" class="morph-key wide" id="morph-band" data-morph="band"
                    aria-label="Morph route for the band engine">Band &rarr; Morph<span class="morph-led"></span></button>
          </div>
          <small class="hint" id="tempoMode-note" hidden>Follow needs Patterns</small>
          <small class="hint" id="morph-note" hidden>Morph out needs Chrome</small>
        </div>
      </div>
      <div class="bottom">
        <div class="zone zone--green you">
          <span class="label">You</span>
          <span class="meters">
            <span class="level level--main"><i id="you-level"></i></span>
            <span class="level level--intensity" title="Intensity"><i id="you-intensity"></i></span>
          </span>
          <span class="pill note" id="you-note">—</span>
          <span class="pill" id="you-notes"></span>
          <button type="button" class="morph-key" id="mic-mute" aria-label="Mute the mic from the listener">MIC<span class="morph-led"></span></button>
        </div>
        <div class="foot">
          <button type="button" class="btn big power-on" id="power-key">Power</button>
          <button type="button" class="btn big power-off" id="power-off-key" hidden>Power Off</button>
        </div>
      </div>
    </div>
  `;
}

function wireControls(screen: HTMLElement, store: Store): void {
  // ?debug=1: how many times this element had listeners attached. Anything but
  // "1" means a re-render re-wired it and every click fires N handlers.
  if (DEBUG) screen.dataset.wired = String(Number(screen.dataset.wired ?? 0) + 1);
  const actions = (): LiveActions => actionsRef.get(screen)!;
  const genreSelect = screen.querySelector<HTMLSelectElement>('#genre')!;
  genreSelect.addEventListener('change', e => {
    actions().setGenre((e.target as HTMLSelectElement).value as Genre);
  });
  // The chips are the visible control; the <select> stays the source of truth.
  screen.querySelectorAll<HTMLButtonElement>('#genre-chips .chip').forEach(chip => {
    chip.addEventListener('click', () => {
      genreSelect.value = chip.dataset.genre!;
      genreSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
  const creativity = screen.querySelector<HTMLInputElement>('#creativity')!;
  creativity.addEventListener('input', () => {
    actions().setCreativity(Number(creativity.value));
  });
  wireKnob(screen, creativity, '#creativity-knob');
  const intensity = screen.querySelector<HTMLInputElement>('#intensity')!;
  intensity.addEventListener('input', () => {
    actions().setIntensity?.(Number(intensity.value));
  });
  wireKnob(screen, intensity, '#intensity-knob');
  screen.querySelectorAll<HTMLButtonElement>('#inst-tiles button[data-inst]').forEach(btn => {
    btn.addEventListener('click', () => actions().toggle(btn.dataset.inst as Instrument));
  });
  screen.querySelectorAll<HTMLButtonElement>('button[data-morph]').forEach(btn => {
    btn.addEventListener('click', () => actions().cycleMorph?.(btn.dataset.morph as RouteTarget));
  });
  const morphOut = screen.querySelector<HTMLSelectElement>('#morph-out')!;
  morphOut.addEventListener('change', () => actions().setMorphOutput?.(morphOut.value || null));
  const micIn = screen.querySelector<HTMLSelectElement>('#mic-in')!;
  micIn.addEventListener('change', () => actions().setMicInput?.(micIn.value || null));
  const micMute = screen.querySelector<HTMLButtonElement>('#mic-mute')!;
  micMute.addEventListener('click', () => {
    if (micMute.disabled) return;
    actions().setMicMuted?.(!store.state.micMuted);
  });
  const midiIn = screen.querySelector<HTMLSelectElement>('#midi-in')!;
  midiIn.addEventListener('change', () => actions().setMidiInput?.(midiIn.value || null));
  const powerBtn = screen.querySelector<HTMLButtonElement>('#power-key')!;
  powerBtn.addEventListener('click', () => {
    if (screen.classList.contains('powering')) return;
    screen.classList.add('powering');
    actions().power();
  });
  const powerOffBtn = screen.querySelector<HTMLButtonElement>('#power-off-key')!;
  powerOffBtn.addEventListener('click', () => {
    if (screen.classList.contains('stopping')) return;
    // let the pads fade and the digits fall before the panel goes dark
    screen.classList.add('stopping');
    window.setTimeout(() => {
      screen.classList.remove('stopping', 'powering');
      actions().powerOff();
    }, 200);
  });

  screen.querySelectorAll<HTMLButtonElement>('#engine-choice button').forEach(btn => {
    btn.addEventListener('click', () => actions().setEngine(btn.dataset.engine as 'lyria' | 'patterns' | 'acestep' | 'amt'));
  });

  const bpmInput = screen.querySelector<HTMLInputElement>('#bpm')!;
  bpmInput.addEventListener('change', () => {
    const raw = bpmInput.value.trim();
    if (!raw) {
      actions().setBpmOverride?.(undefined);
      return;
    }
    const bpm = Math.min(240, Math.max(40, Number(raw)));
    bpmInput.value = String(bpm);
    actions().setBpmOverride?.(bpm);
  });

  const soundSelect = screen.querySelector<HTMLSelectElement>('#sound')!;
  soundSelect.value = store.state.sound;
  soundSelect.addEventListener('change', () => actions().setSound?.(soundSelect.value as MonitorSound));
  const keySelect = screen.querySelector<HTMLSelectElement>('#key')!;
  keySelect.addEventListener('change', () => {
    if (keySelect.value === 'auto') {
      actions().setKeyOverride?.(undefined);
      return;
    }
    const [root, mode] = keySelect.value.split('-');
    actions().setKeyOverride?.({ root: Number(root), mode: mode as 'major' | 'minor' });
  });

  screen.querySelectorAll<HTMLButtonElement>('#tempoMode button').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      actions().setTempoMode?.(btn.dataset.mode as 'locked' | 'follow');
    });
  });

  void store;
}

/** Rotary knob that drives the hidden range input (drag up/down, arrow keys). */
function wireKnob(screen: HTMLElement, input: HTMLInputElement, knobSel: string): void {
  const knob = screen.querySelector<HTMLElement>(knobSel)!;
  const step = Number(input.step) || 0.05;
  const commit = (raw: number): void => {
    const snapped = Math.min(1, Math.max(0, Math.round(raw / step) * step));
    const next = Number(snapped.toFixed(3));
    if (Number(input.value) === next) return;
    input.value = String(next);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  let drag: { y: number; from: number } | undefined;
  knob.addEventListener('pointerdown', e => {
    drag = { y: e.clientY, from: Number(input.value) };
    knob.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  knob.addEventListener('pointermove', e => {
    if (drag) commit(drag.from + (drag.y - e.clientY) / 160);
  });
  const release = (): void => {
    drag = undefined;
  };
  knob.addEventListener('pointerup', release);
  knob.addEventListener('pointercancel', release);

  knob.addEventListener('keydown', e => {
    const delta =
      e.key === 'ArrowUp' || e.key === 'ArrowRight'
        ? step
        : e.key === 'ArrowDown' || e.key === 'ArrowLeft'
          ? -step
          : e.key === 'End'
            ? 1
            : e.key === 'Home'
              ? -1
              : 0;
    if (!delta) return;
    e.preventDefault();
    commit(Number(input.value) + delta);
  });
}

function update(screen: HTMLElement, s: AppState, changeLatencyMs: number): void {
  updatePower(screen, s);
  updateHeader(screen, s);
  updateEngine(screen, s);
  updateReadouts(screen, s);
  updateYouStrip(screen, s);
  updateTiles(screen, s, changeLatencyMs);
  updateMorph(screen, s);
  updateFooter(screen, s);
}

function mark(state: SourceState): string {
  return state === 'on' ? '✓' : '✗';
}

const ENGINE_NAMES: Record<AppState['engine'], string> = {
  patterns: 'PATTERNS',
  lyria: 'LYRIA',
  acestep: 'ACE',
  amt: 'AMT',
};

/** The MIDI keyboards actually being listened to, for the LISTENING line. */
export function midiLabel(s: AppState): string {
  const listening = s.midiInputs.filter(d => s.midiIn === null || d.id === s.midiIn);
  const names = listening.map(d => shortDeviceName(d.label)).join(' + ');
  return `MIDI ${mark(s.sources.midi)}${names ? ` ${names}` : ''}`;
}

function lcdText(s: AppState): string {
  if (s.power === 'off') return 'OFF · PRESS POWER';
  // any part sent to the morph box is worth one flag: it is the difference between
  // hearing the band and hearing it through LYDIA
  const morph = anyMorph(s.routing, !!s.morphOut) ? ' · MORPH' : '';
  if (s.locked) {
    const d = s.input.dynamics;
    // What the band is doing with the gap the player left, in the two words that matter.
    const flags = `${d.space && s.enabled.lead ? ' · ANSWER' : ''}${d.fillDue ? ' · FILL' : ''}`;
    return `LIVE · BAR ${s.bar}${s.input.chord ? ` · ${chordName(s.input.chord)}` : ''}${flags}${morph}`;
  }
  // once there is enough to guess with, show the running estimate — it is the
  // only feedback that the mic is hearing a tempo and not just noise
  const guess = s.input.pendingBpm ? ` · ~${Math.round(s.input.pendingBpm)} BPM` : '';
  return `LISTENING · MIC ${mark(s.sources.mic)} ${midiLabel(s)} · ${s.input.onsets}/12${guess}${morph}`;
}

function updatePower(screen: HTMLElement, s: AppState): void {
  const on = s.power === 'on';
  screen.classList.toggle('powered', on);
  screen.querySelector<HTMLElement>('#power-key')!.hidden = on;
  screen.querySelector<HTMLElement>('#power-off-key')!.hidden = !on;
  screen.querySelectorAll<HTMLElement>('#inst-tiles, .row2 .zone').forEach(el => el.classList.toggle('dimmed', !on));
  // Pads, the creativity knob, and manual tempo/key overrides need a running
  // band; ENGINE and GENRE only set state, so they stay clickable while off.
  screen
    .querySelectorAll<HTMLElement>('#inst-tiles, .row2 .knob-zone, .row2 .manual')
    .forEach(el => el.classList.toggle('inert', !on));
}

function updateEngine(screen: HTMLElement, s: AppState): void {
  screen.querySelectorAll<HTMLButtonElement>('#engine-choice .engine-key').forEach(btn => {
    const e = btn.dataset.engine as AppState['engine'];
    const selected = e === s.engine;
    btn.classList.toggle('on', selected);
    const offline = s.offlineEngines.includes(e);
    btn.title = offline ? 'OFFLINE' : '';
    const led = btn.querySelector<HTMLElement>('.engine-led')!;
    const live = selected && s.power === 'on';
    const connecting = live && s.engineConnecting;
    // While this engine is the one actually running, its socket/session state wins over the
    // boot-time /health probe: connected -> solid green, connecting -> blinking green.
    const connected = live && !s.engineConnecting;
    const online = connected || (!offline && !live);
    led.classList.toggle('offline', !online && !connecting);
    led.classList.toggle('online', online);
    led.classList.toggle('connecting', connecting);
  });
}

function updateHeader(screen: HTMLElement, s: AppState): void {
  screen.querySelector<HTMLElement>('#lcd')!.textContent = lcdText(s);
  const pill = screen.querySelector<HTMLElement>('#live-pill')!;
  if (s.error) {
    pill.textContent = s.error;
    pill.className = 'pill error';
  } else if (s.locked) {
    pill.textContent = `● ${ENGINE_NAMES[s.engine]}`;
    pill.className = 'pill live';
  } else if (s.power === 'on') {
    pill.textContent = `listening… onsets ${s.input.onsets}/12`;
    pill.className = 'pill';
  } else {
    pill.textContent = '';
    pill.className = 'pill';
  }
}

const prevLocked = new WeakMap<HTMLElement, boolean>();
const prevGenre = new WeakMap<HTMLElement, Genre>();

/** Re-renders the tempo digits, optionally rolling them up odometer-style. */
function setTempo(el: HTMLElement, text: string, roll: boolean): void {
  if (el.dataset.text !== text) {
    el.dataset.text = text;
    el.innerHTML = [...text]
      .map((ch, i) => `<b style="--d:${i * 40}ms">${ch === ' ' ? '&nbsp;' : escapeHtml(ch)}</b>`)
      .join('');
  }
  if (!roll) return;
  el.classList.remove('roll');
  void el.offsetWidth;
  el.classList.add('roll');
}

/** One-shot class that drives a CSS animation, cleared when it finishes. */
function pulse(el: HTMLElement, cls: string, ms: number): void {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  window.setTimeout(() => el.classList.remove(cls), ms);
}

function updateReadouts(screen: HTMLElement, s: AppState): void {
  const justLocked = s.locked && prevLocked.get(screen) === false;
  prevLocked.set(screen, s.locked);
  screen.classList.toggle('locked', s.locked);
  if (justLocked) {
    screen.style.setProperty('--flash', GENRE_COLOR[s.genre]);
    pulse(screen, 'flash', 200);
  }

  const genreChanged = prevGenre.has(screen) && prevGenre.get(screen) !== s.genre;
  prevGenre.set(screen, s.genre);
  if (genreChanged) {
    screen.style.setProperty('--flash', GENRE_COLOR[s.genre]);
    pulse(screen.querySelector<HTMLElement>('.readout')!, 'sweep', 320);
    pulse(screen.querySelector<HTMLElement>('#inst-tiles')!, 'retint', 220);
  }

  screen.querySelector<HTMLElement>('#ro-key')!.textContent = s.input.key ? keyName(s.input.key) : '—';
  screen.querySelector<HTMLElement>('#chord')!.textContent = s.input.chord ? chordName(s.input.chord) : '—';
  screen.querySelector<HTMLElement>('#ro-bar')!.textContent = String(s.bar);
  updateBeats(screen, s);

  const genreSelect = screen.querySelector<HTMLSelectElement>('#genre')!;
  if (genreSelect.value !== s.genre) genreSelect.value = s.genre;
  screen.querySelectorAll<HTMLButtonElement>('#genre-chips .chip').forEach(chip => {
    chip.classList.toggle('on', chip.dataset.genre === s.genre);
  });

  const creativity = screen.querySelector<HTMLInputElement>('#creativity')!;
  if (document.activeElement !== creativity) creativity.value = String(s.creativity);
  screen.querySelector<HTMLElement>('#creativity-val')!.textContent = s.creativity.toFixed(2);
  const knob = screen.querySelector<HTMLElement>('#creativity-knob')!;
  knob.style.setProperty('--k', String(s.creativity));
  knob.setAttribute('aria-valuenow', s.creativity.toFixed(2));

  const intensity = screen.querySelector<HTMLInputElement>('#intensity')!;
  if (document.activeElement !== intensity) intensity.value = String(s.intensity);
  screen.querySelector<HTMLElement>('#intensity-val')!.textContent = s.intensity.toFixed(2);
  const iKnob = screen.querySelector<HTMLElement>('#intensity-knob')!;
  iKnob.style.setProperty('--k', String(s.intensity));
  iKnob.setAttribute('aria-valuenow', s.intensity.toFixed(2));

  const lyriaFollow = s.engine === 'lyria' || s.engine === 'acestep' || s.engine === 'amt';
  screen.querySelectorAll<HTMLButtonElement>('#tempoMode button').forEach(btn => {
    btn.classList.toggle('on', btn.dataset.mode === s.tempoMode);
    if (btn.dataset.mode === 'follow') btn.disabled = lyriaFollow;
  });
  const note = screen.querySelector<HTMLElement>('#tempoMode-note')!;
  note.hidden = !lyriaFollow;

  let tempoText = s.input.bpm ? String(Math.round(s.input.bpm)) : '—';
  if (s.engine === 'lyria' && s.input.bpm) {
    const clamped = Math.min(200, Math.max(60, Math.round(s.input.bpm)));
    if (clamped !== Math.round(s.input.bpm)) tempoText = `${clamped} (clamped)`;
  }
  setTempo(screen.querySelector<HTMLElement>('#ro-tempo')!, tempoText, justLocked);
}

const lastBar = new WeakMap<HTMLElement, number>();

/** Beat LEDs and the pad "breath": one bar-long CSS cycle, restarted on every bar callback. */
function updateBeats(screen: HTMLElement, s: AppState): void {
  const beats = screen.querySelector<HTMLElement>('#beats')!;
  const tiles = screen.querySelector<HTMLElement>('#inst-tiles')!;
  if (!s.locked || !s.input.bpm) {
    beats.classList.remove('run');
    tiles.classList.remove('run');
    lastBar.delete(screen);
    return;
  }
  screen.style.setProperty('--beat', `${60 / s.input.bpm}s`);
  if (lastBar.get(screen) === s.bar && beats.classList.contains('run')) return;
  lastBar.set(screen, s.bar);
  for (const el of [beats, tiles]) {
    el.classList.remove('run');
    void el.offsetWidth; // reflow so the animation restarts on the downbeat
    el.classList.add('run');
  }
}

const peakHold = new WeakMap<HTMLElement, { v: number; t: number }>();

function updateYouStrip(screen: HTMLElement, s: AppState): void {
  const level = Math.max(0, Math.min(1, s.input.inputLevel));
  screen.querySelector<HTMLElement>('#you-level')!.style.width = `${Math.round(level * 100)}%`;

  // peak-hold marker, decaying ~60% of full scale per second
  const now = Date.now();
  const held = peakHold.get(screen);
  const decayed = held ? Math.max(0, held.v - ((now - held.t) / 1000) * 0.6) : 0;
  const peak = Math.max(level, decayed);
  peakHold.set(screen, { v: peak, t: now });
  screen.querySelector<HTMLElement>('.you .level--main')!.style.setProperty('--peak', String(Math.round(peak * 100)));

  // Second, thinner bar: not how loud the player is, but how hard the band reads them as
  // working — it lags the level bar on the way down, which is the whole point.
  // The effective intensity the band actually plays at (auto activity × the manual knob),
  // not the raw activity reading — so the bar tracks what you hear, while the knob shows your setting.
  const intensity = Math.max(0, Math.min(1, s.effectiveIntensity));
  screen.querySelector<HTMLElement>('#you-intensity')!.style.width = `${Math.round(intensity * 100)}%`;

  screen.querySelector<HTMLElement>('#you-notes')!.textContent = s.input.notesNow.length
    ? s.input.notesNow.map(noteName).join(' · ')
    : '—';

  const noteEl = screen.querySelector<HTMLElement>('#you-note')!;
  const p = s.input.pitch;
  if (p) {
    const sign = p.cents >= 0 ? '+' : '';
    noteEl.textContent = `${noteName(p.midi)}${octave(p.midi)} ${sign}${p.cents}¢`;
  } else {
    noteEl.textContent = '—';
  }
  noteEl.classList.toggle('stable', !!p?.stable);
  noteEl.classList.toggle('unstable', !p?.stable);

  const micMute = screen.querySelector<HTMLButtonElement>('#mic-mute')!;
  const midiOnly = s.sources.mic === 'denied' || s.sources.mic === 'none';
  micMute.hidden = midiOnly;
  micMute.disabled = midiOnly;
  micMute.classList.toggle('on', s.micMuted);
  micMute.firstChild!.textContent = s.micMuted ? 'MIC MUTED' : 'MIC';
}

const enabledAtBar = new WeakMap<HTMLElement, Partial<Record<Instrument, number>>>();
// engines with changeLatencyMs > 0 (e.g. Lyria) settle on a wall-clock timer instead of a bar
const pendingUntil = new WeakMap<HTMLElement, Partial<Record<Instrument, number>>>();
const lastOn = new WeakMap<HTMLElement, Partial<Record<Instrument, boolean>>>();
// newest state per screen, so a settle timer can re-derive its label instead of
// writing one straight to the DOM behind update()'s back
const lastState = new WeakMap<HTMLElement, AppState>();

/**
 * The label under an instrument tile.
 *
 * A tile is that instrument's mute button, so the label must always follow
 * `on`. Whether the band has locked a tempo yet is a separate axis and must
 * never be reported as "off": doing so made every tile read "off" while the
 * band was still listening, so toggling an instrument looked like it did
 * nothing, and the label contradicted the tile's own lit/unlit state.
 */
export function tileLabel(on: boolean, locked: boolean, pending: boolean, justJoined: boolean): string {
  if (!on) return locked && pending ? 'leaving…' : 'off';
  if (!locked) return 'ready';
  if (pending) return 'joining…';
  return justJoined ? 'joins next bar' : 'playing';
}

function updateTiles(screen: HTMLElement, s: AppState, changeLatencyMs: number): void {
  if (!enabledAtBar.has(screen)) enabledAtBar.set(screen, {});
  if (!pendingUntil.has(screen)) pendingUntil.set(screen, {});
  if (!lastOn.has(screen)) lastOn.set(screen, {});
  const since = enabledAtBar.get(screen)!;
  const until = pendingUntil.get(screen)!;
  const last = lastOn.get(screen)!;
  lastState.set(screen, s);

  for (const i of INSTRUMENTS) {
    const btn = screen.querySelector<HTMLButtonElement>(`#inst-tiles button[data-inst="${i}"]`)!;
    const on = s.enabled[i];
    btn.classList.toggle('on', on);

    let pending = false;
    let justJoined = false;
    if (changeLatencyMs > 0) {
      if (last[i] !== on) {
        until[i] = Date.now() + changeLatencyMs;
        last[i] = on;
        // Re-render once the settle window closes. By then last[i] === on, so
        // this schedules no further timer.
        window.setTimeout(() => {
          const fresh = lastState.get(screen);
          if (fresh) updateTiles(screen, fresh, changeLatencyMs);
        }, changeLatencyMs);
      }
      pending = until[i] !== undefined && Date.now() < (until[i] as number);
    } else {
      if (on && since[i] === undefined) since[i] = s.bar;
      if (!on) since[i] = undefined;
      justJoined = on && since[i] !== undefined && s.bar <= (since[i] as number);
    }

    const text = tileLabel(on, s.locked, pending, justJoined);
    btn.querySelector<HTMLElement>('.st-text')!.textContent = text;
    // blinking LED while the engine settles the change
    btn.classList.toggle('pending', text === 'joining…' || text === 'leaving…');
    const meter = btn.querySelector<HTMLElement>('.meter i')!;
    meter.style.width = text === 'playing' ? '60%' : '0';
  }
}

/**
 * Fills a device <select> without clobbering what the user has open or chosen.
 * The first option is the "none" one baked into the skeleton (off / default / all).
 */
export function fillDeviceSelect(sel: HTMLSelectElement, options: DeviceOption[], chosen: string | null): void {
  const signature = options.map(o => `${o.id}:${o.label}`).join('|');
  if (sel.dataset.devices !== signature) {
    sel.dataset.devices = signature;
    const keep = sel.options[0];
    sel.replaceChildren(keep);
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.id;
      opt.textContent = shortDeviceName(o.label);
      sel.appendChild(opt);
    }
  }
  const want = chosen ?? '';
  if (sel.value !== want) sel.value = want;
}

const ROUTE_TITLE: Record<MorphRoute, string> = {
  main: 'main output',
  morph: 'morph output',
  both: 'main + morph',
};

function updateMorph(screen: HTMLElement, s: AppState): void {
  fillDeviceSelect(screen.querySelector<HTMLSelectElement>('#morph-out')!, s.audioOutputs, s.morphOut);
  fillDeviceSelect(screen.querySelector<HTMLSelectElement>('#mic-in')!, s.audioInputs, s.micIn);
  fillDeviceSelect(screen.querySelector<HTMLSelectElement>('#midi-in')!, s.midiInputs, s.midiIn);
  screen.querySelector<HTMLSelectElement>('#morph-out')!.disabled = !s.morphSupported;
  screen.querySelector<HTMLElement>('#morph-note')!.hidden = s.morphSupported;

  for (const t of ROUTE_TARGETS) {
    const key = screen.querySelector<HTMLButtonElement>(`#morph-${t}`);
    if (!key) continue;
    const route = s.routing[t];
    // With no output chosen a "morph" pad is still only reaching the main output,
    // so the LED stays grey rather than claiming a destination that isn't there.
    const live = !!s.morphOut && route !== 'main';
    key.dataset.route = route;
    key.classList.toggle('on', live);
    key.classList.toggle('both', live && route === 'both');
    key.title = `${displayLabel(t)} → ${s.morphOut ? ROUTE_TITLE[route] : 'main output (no morph device)'}`;
    key.setAttribute('aria-pressed', String(live));
  }
}

function updateFooter(_screen: HTMLElement, _s: AppState): void {
  // nothing to update here currently
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Display-only label overrides: the internal instrument id stays `lead`
// everywhere (state, routing, tests); only the on-screen text changes.
const DISPLAY_LABEL: Record<string, string> = { lead: 'Guitar' };
function displayLabel(i: string): string {
  return DISPLAY_LABEL[i] ?? cap(i);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function noteName(n: number): string {
  return NOTE_NAMES[((n % 12) + 12) % 12];
}

function octave(n: number): number {
  return Math.floor(n / 12) - 1;
}
