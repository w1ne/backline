import { GM_INSTRUMENTS } from '../players/gmInstruments';
import { GENRES, INSTRUMENTS, ACCOMP_ROW } from '../types';
import type { AccompPreset, Genre, Instrument } from '../types';
import { SOUNDS, SOUND_GROUPS, type MonitorSound } from '../players/soundCatalog';
import { keyName, mod12, NOTE_NAMES } from '../music/pitchClass';
import { chordName } from '../music/chords';
import { DEBUG } from '../debug';
import type { AppState, Store } from './state';
import type { SourceState } from '../listener/listener';
import { shortDeviceName } from '../audio/devices';
import { isPhoneUA } from '../listener/micConstraints';

const ALL_KEYS: { root: number; mode: 'major' | 'minor' }[] = [
  ...NOTE_NAMES.map((_, root) => ({ root, mode: 'major' as const })),
  ...NOTE_NAMES.map((_, root) => ({ root, mode: 'minor' as const })),
];

export interface LiveActions {
  playbackTarget?: 'Pi' | 'This browser';
  soundIds?: readonly string[];
  setPlaying?(playing: boolean): void;
  /** first user gesture: resume the AudioContext the page booted with */
  wake(): void;
  toggle(i: Instrument): void;
  setGenre(g: Genre): void;
  setEngine(e: 'lyria' | 'patterns' | 'acestep' | 'amt'): void;
  setCreativity(c: number): void;
  /** AMT: toggle one extra GM instrument preset on/off */
  toggleAccompPreset?(preset: AccompPreset, on: boolean): void;
  /** start recording you + the band; a second call stops and downloads the .mid */
  toggleRecord?(): void;
  /** hold the band in place; a second call lets it play again from the next bar */
  togglePause?(): void;
  /** manual INTENSITY knob — how much the band adds */
  setIntensity?(i: number): void;
  setBpmOverride?(bpm: number | undefined): void;
  setKeyOverride?(key: { root: number; mode: 'major' | 'minor' } | undefined): void;
  /** Registers one tap on the audio clock; once enough taps have landed to apply a tempo
   * (the 4th and later), returns the tapped bpm/downbeat that was just adopted — null otherwise. */
  tap?(): { bpm: number; downbeat: number } | null;
  /** toggle the two-bar count-in click that plays before the band's first bar */
  setCountIn?(on: boolean): void;
  /** which sound your MIDI keyboard plays through */
  setSound?(s: MonitorSound): void;
  setNoiseVolume?(volume: number): void;
  setDroneVolume?(volume: number): void;
  /** gate the mic out of the listener (onsets/pitch/level); MIDI keeps working */
  setMicMuted?(muted: boolean): void;
  /** monitor the singer's own mic back through the vocal chain — only ever actually
   *  audible where monitorAllowed() says it is safe */
  setVoiceMonitor?(enabled: boolean): void;
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
    if (actions.soundIds) screen.querySelectorAll<HTMLOptionElement>('#sound option').forEach(option => {
      if (!actions.soundIds!.includes(option.value)) option.remove();
    });
    screen.querySelectorAll('#sound optgroup').forEach(group => { if (!group.children.length) group.remove(); });
    wireControls(screen, store);
  } else {
    // Refresh the stored actions reference so listeners wired once below always
    // call into the latest closure (which may read fresher store state), instead
    // of the actions object captured on the very first render.
    actionsRef.set(screen, actions);
  }
  update(screen, store.state, actions.changeLatencyMs ?? 0);
  // Only the Pi remote has somewhere else to play; in the browser the pill says nothing useful.
  const target = screen.querySelector<HTMLElement>('#playback-target')!;
  target.hidden = actions.playbackTarget !== 'Pi';
  target.textContent = `Playback: ${actions.playbackTarget ?? 'This browser'}`;
  if (actions.setPlaying) {
    const audio = screen.querySelector<HTMLButtonElement>('#enable-audio')!;
    audio.hidden = false;
    audio.textContent = store.state.power === 'on' && !store.state.audioSuspended ? 'Pause sound' : 'Start sound';
  }
}

function skeleton(): string {
  return `
    <div class="screen" data-live>
      <div class="toast" id="toast" role="status" aria-live="polite" hidden></div>
      <div class="bar">
        <div class="mascot" id="mascot" aria-hidden="true">
          <svg viewBox="0 0 140 130" width="100%" height="100%" stroke-linejoin="round" stroke-linecap="round">
            <g class="m-body">
              <ellipse cx="72" cy="126" rx="40" ry="4" fill="#000" opacity=".4"/>
              <!-- back wing -->
              <g class="m-wing m-wing-b"><path d="M70 60 q-6 -34 -48 -30 q22 4 20 16 q-16 -4 -24 8 q18 -2 22 10 q-10 2 -12 10 q22 -8 42 -14z" fill="#f3ecd2" stroke="#2b2018" stroke-width="2.5"/></g>
              <!-- sampler -->
              <g class="m-box"><path d="M12 92 h48 l6 6 v22 h-48 l-6 -6z" fill="#e2453c" stroke="#2b2018" stroke-width="2.5"/>
                <rect class="m-pad" style="--s:0" x="20" y="96" width="9" height="7" rx="1.5" fill="#f3ecd2" stroke="#2b2018" stroke-width="1"/><rect class="m-pad" style="--s:1" x="31" y="96" width="9" height="7" rx="1.5" fill="#f3ecd2" stroke="#2b2018" stroke-width="1"/><rect class="m-pad" style="--s:2" x="42" y="96" width="9" height="7" rx="1.5" fill="#f3ecd2" stroke="#2b2018" stroke-width="1"/><rect class="m-pad" style="--s:3" x="20" y="105" width="9" height="7" rx="1.5" fill="#f3ecd2" stroke="#2b2018" stroke-width="1"/><rect class="m-pad" style="--s:4" x="31" y="105" width="9" height="7" rx="1.5" fill="#f3ecd2" stroke="#2b2018" stroke-width="1"/><rect class="m-pad" style="--s:5" x="42" y="105" width="9" height="7" rx="1.5" fill="#f3ecd2" stroke="#2b2018" stroke-width="1"/>
                <circle cx="56" cy="99" r="2.5" fill="#2aff95"/><circle cx="56" cy="107" r="2.5" fill="#f3ecd2"/>
                <text x="16" y="118" font-family="var(--display)" font-size="6" fill="#2aff95" stroke="none">HACKATHON</text></g>
              <!-- body -->
              <path d="M52 64 q28 -22 60 -6 q20 12 12 40 q-4 14 -22 14 h-30 q-8 -4 -14 -18 q-8 -18 -6 -30z" fill="#d9b06a" stroke="#2b2018" stroke-width="2.5"/>
              <path d="M78 74 q6 -2 8 4 M96 70 q6 0 6 6 M86 88 q6 -2 8 4 M108 92 q4 -2 8 2" stroke="#f3ecd2" stroke-width="2.5" stroke-dasharray="3 3" fill="none"/>
              <!-- hind + front legs -->
              <g class="m-leg m-leg-r"><path d="M108 100 q6 10 2 22 h-8 l4 -18z" fill="#d9b06a" stroke="#2b2018" stroke-width="2.5"/></g>
              <g class="m-leg m-leg-l"><path d="M84 104 q2 10 -2 18 h-8 l4 -16z" fill="#d9b06a" stroke="#2b2018" stroke-width="2.5"/></g>
              <g class="m-arm"><path d="M52 84 q-14 4 -18 14" stroke="#d9b06a" stroke-width="9" fill="none"/><path d="M52 84 q-14 4 -18 14" stroke="#2b2018" stroke-width="12" fill="none" opacity="0"/><path d="M34 98 q-2 4 2 6" stroke="#2b2018" stroke-width="2.5" fill="none"/></g>
              <!-- front wing -->
              <g class="m-wing m-wing-f"><path d="M76 56 q10 -40 62 -30 q-26 6 -22 20 q20 -6 30 8 q-22 -2 -26 12 q12 2 14 12 q-30 -10 -58 -12z" fill="#f3ecd2" stroke="#2b2018" stroke-width="2.5"/>
                <path d="M92 36 q8 6 6 14 M106 40 q6 6 4 12 M118 50 q6 4 4 10" stroke="#2b2018" stroke-width="1.5" fill="none" opacity=".6"/></g>
              <!-- head -->
              <g class="m-head">
                <path d="M40 40 l-8 -26 M50 38 l-2 -26" stroke="#2b2018" stroke-width="7" fill="none"/>
                <path d="M40 40 l-8 -26 M50 38 l-2 -26" stroke="#a67c3c" stroke-width="4" fill="none"/>
                <path d="M36 26 h6 M44 24 h6 M34 20 h6" stroke="#2b2018" stroke-width="1.5"/>
                <path d="M62 40 l14 -14 l-2 18z" fill="#d9b06a" stroke="#2b2018" stroke-width="2.5"/>
                <path d="M66 40 l8 -8 l-1 10z" fill="#e8b3b8"/>
                <path d="M30 44 q14 -16 40 -6 q10 8 6 22 q-6 12 -22 10 l-16 -4 q-10 -6 -8 -22z" fill="#d9b06a" stroke="#2b2018" stroke-width="2.5"/>
                <path d="M44 46 q6 -2 8 2 M38 54 q4 -2 6 2 M52 62 q4 0 6 2" stroke="#f3ecd2" stroke-width="2" stroke-dasharray="2 3" fill="none"/>
                <g class="m-eyes"><ellipse cx="52" cy="54" rx="6" ry="4.5" fill="#fff" stroke="#2b2018" stroke-width="2"/><circle cx="52" cy="54" r="3" fill="#2aff95"/><circle cx="52" cy="54" r="1.4" fill="#2b2018"/></g>
                <circle cx="31" cy="62" r="3" fill="#2b2018"/>
                <g class="m-flower"><circle cx="30" cy="36" r="5" fill="#f6d5dc" stroke="#2b2018" stroke-width="1.5"/><circle cx="30" cy="36" r="1.5" fill="#e2453c"/></g>
              </g>
              <g class="m-flower m-flower-2"><circle cx="128" cy="86" r="5" fill="#f6d5dc" stroke="#2b2018" stroke-width="1.5"/><circle cx="128" cy="86" r="1.5" fill="#e2453c"/></g>
              <g class="m-note"><path d="M112 26 v-13 l9 -3 v13" stroke="#ffd400" stroke-width="3" fill="none"/><circle cx="109" cy="26" r="4" fill="#ffd400"/><circle cx="118" cy="23" r="4" fill="#ffd400"/></g>
            </g>
          </svg>
        </div>
        <div class="bar-top">
          <h1 class="logo">duet<i>.ai</i></h1>
          <span class="pill" id="live-pill"></span>
          <span class="pill" id="playback-target"></span>
          <button type="button" class="morph-key" id="mic-mute" aria-label="Mute the mic from the listener">MIC<span class="morph-led"></span></button>
          <button type="button" class="morph-key" id="voice-monitor" aria-label="Monitor your own mic through the mix" title="Headphones only">VOICE<span class="morph-led"></span></button>
        </div>
        <span class="lcd" id="lcd"></span>
        <div class="bar-input">
          <p class="connection-line" id="input-status"></p>
          <button type="button" id="enable-audio" class="audio-start">Enable sound</button>
        </div>
      </div>
      <div class="section-heading band-heading"><div><h2>Your band</h2><p id="band-status" role="status"></p></div><span id="model-latency"></span></div>
      <div class="readout">
        <div class="ro-tempo"><small>Tempo</small><strong id="ro-tempo">&mdash;</strong></div>
        <div class="ro-side">
          <div><small>Key</small><strong id="ro-key">&mdash;</strong></div>
          <div><small>Chord</small><strong id="chord">&mdash;</strong></div>
          <div><small>Bar</small><strong id="ro-bar">0</strong></div>
          <div class="ro-rec"><small id="pause-label">Pause</small>
            <button type="button" class="rec-btn pause-btn" id="pause-band" aria-pressed="false" title="Hold the band">
              <span class="pause-bars"><i></i><i></i></span><span class="play-tri"></span>
            </button>
          </div>
          <div class="ro-rec"><small id="record-label">Rec</small>
            <button type="button" class="rec-btn" id="record-midi" aria-pressed="false"
                    title="Tap to record you + the band, tap again to save the MIDI">
              <span class="rec-dot"></span>
            </button>
          </div>
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
                <span class="st"><span class="st-text"></span></span>
              </button>
            </div>`,
        ).join('')}
      </div>
      <div class="inst" id="accomp-tiles">
        ${ACCOMP_ROW.map(
          p =>
            `<div class="pad">
              <button type="button" class="pad-btn ${p}" data-preset="${p}">
                <span class="dot"></span>
                <span class="name">${presetLabel(p)}</span>
                <span class="st"><span class="st-text"></span></span>
              </button>
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
          <span class="zone-label">Band amount</span>
          <div class="knob" id="intensity-knob" role="slider" tabindex="0"
               aria-label="Intensity" aria-valuemin="0" aria-valuemax="1" aria-valuenow="0.5">
            <span class="ptr"></span>
          </div>
          <span class="knob-val" id="intensity-val"></span>
          <input class="vh" type="range" id="intensity" min="0" max="1" step="0.05" aria-hidden="true" tabindex="-1" />
        </div>
        <div class="zone zone--blue">
          <span class="zone-label">Style</span>
          <div class="chips" id="genre-chips">
            ${GENRES.map(g => `<button type="button" class="chip" data-genre="${g}">${g}</button>`).join('')}
          </div>
          <select class="vh" id="genre" aria-label="Genre" tabindex="-1">
            ${GENRES.map(g => `<option value="${g}">${cap(g)}</option>`).join('')}
          </select>
        </div>
        <div class="zone zone--yellow manual">
          <span class="zone-label">Tempo &amp; key</span>
          <div class="field">
            <label for="bpm">Bpm</label>
            <input type="number" id="bpm" min="40" max="240" placeholder="auto" />
          </div>
          <div class="field tap-field">
            <button type="button" class="chip" id="tap-tempo" aria-label="Tap tempo">TAP</button>
            <button type="button" class="chip count-in-chip" id="count-in-toggle" aria-label="Toggle the count-in click">COUNT</button>
          </div>
          <div class="field">
            <label for="key">Key</label>
            <select id="key">
              <option value="auto">auto</option>
              ${ALL_KEYS.map(
                k =>
                  `<option value="${k.root}-${k.mode}">${keyName(k)}</option>`,
              ).join('')}
            </select>
          </div>

        </div>
      </div>
      <details class="model-details instrument-details"><summary>Your instrument</summary>
        <div class="zone zone--orange instrument-zone">
          <span class="zone-label">Your instrument</span>
        <p class="connection-line" id="midi-status"></p>
        <div class="instrument-controls">          <div class="field">
            <label for="sound">Keyboard sound</label>
            <select id="sound">
              ${SOUND_GROUPS.map(
                g =>
                  `<optgroup label="${g}">${SOUNDS.filter(s => s.group === g)
                    .map(s => `<option value="${s.id}">${s.label}</option>`)
                    .join('')}</optgroup>`,
              ).join('')}
            </select>
          </div>
          <div class="field"><label for="noise-volume">White noise <output id="noise-value"></output></label><input id="noise-volume" type="range" min="0" max="1" step="0.01" /></div>
          <div class="field"><label for="drone-volume">Drone <output id="drone-value"></output></label><input id="drone-volume" type="range" min="0" max="1" step="0.01" /></div>
        </div>
        </div>
      </details>
      <details class="model-details"><summary>Models &amp; connection</summary>
        <div class="zone zone--orange engine">
          <span class="zone-label">Accompaniment model</span>
          <div class="engine-keys" id="engine-choice">
            <button type="button" class="engine-key" id="engine-patterns" data-engine="patterns">
              <span class="engine-key-text">
                <span class="engine-key-name">Patterns</span>
              </span>
              <span class="engine-led" data-engine-led="patterns"></span>
            </button>
            <button type="button" class="engine-key" id="engine-acestep" data-engine="acestep">
              <span class="engine-key-text">
                <span class="engine-key-name">ACE-Step</span>
              </span>
              <span class="engine-led" data-engine-led="acestep"></span>
            </button>
            <button type="button" class="engine-key" id="engine-amt" data-engine="amt">
              <span class="engine-key-text">
                <span class="engine-key-name">AMT</span>
              </span>
              <span class="engine-led" data-engine-led="amt"></span>
            </button>
          </div>
        </div>
<p id="engine-status" role="status"></p>
<p id="output-latency" role="status"></p>
      </details>
    </div>
  `;
}

/** what the mic hears right now, so a singer sees the app react before the band does */
function hearingLabel(s: AppState): string {
  const p = s.input.pitch;
  if (!p || s.micMuted) return '';
  return ` · HEARING ${NOTE_NAMES[mod12(p.midi)]}${Math.floor(p.midi / 12) - 1}`;
}

function wireControls(screen: HTMLElement, store: Store): void {
  // ?debug=1: how many times this element had listeners attached. Anything but
  // "1" means a re-render re-wired it and every click fires N handlers.
  if (DEBUG) screen.dataset.wired = String(Number(screen.dataset.wired ?? 0) + 1);
  const actions = (): LiveActions => actionsRef.get(screen)!;
  screen.querySelector<HTMLButtonElement>('#enable-audio')!.addEventListener('click', () => {
    const a = actions();
    if (a.setPlaying) a.setPlaying(store.state.power !== 'on' || store.state.audioSuspended);
    else a.wake();
  });
  for (const [id, action] of [['noise-volume', 'setNoiseVolume'], ['drone-volume', 'setDroneVolume']] as const) {
    const input = screen.querySelector<HTMLInputElement>(`#${id}`)!;
    input.addEventListener('input', () => actions()[action]?.(Number(input.value)));
  }
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
  const micMute = screen.querySelector<HTMLButtonElement>('#mic-mute')!;
  micMute.addEventListener('click', () => {
    if (micMute.disabled) return;
    actions().setMicMuted?.(!store.state.micMuted);
  });
  const voiceMonitor = screen.querySelector<HTMLButtonElement>('#voice-monitor')!;
  voiceMonitor.addEventListener('click', () => {
    if (voiceMonitor.disabled) return;
    actions().setVoiceMonitor?.(!store.state.voiceMonitor);
  });
  // The band boots on page load; browsers keep the AudioContext suspended until
  // a gesture, so the first tap anywhere on the panel wakes it. Capture phase,
  // so a tap on any control counts.
  screen.addEventListener('pointerdown', () => actions().wake(), { capture: true });

  screen.querySelectorAll<HTMLButtonElement>('#engine-choice button').forEach(btn => {
    btn.addEventListener('click', () => actions().setEngine(btn.dataset.engine as 'lyria' | 'patterns' | 'acestep' | 'amt'));
  });

  screen.querySelectorAll<HTMLButtonElement>('#accomp-tiles button[data-preset]').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.preset as AccompPreset;
      actions().toggleAccompPreset?.(preset, !btn.classList.contains('on'));
    });
  });
  screen.querySelector<HTMLButtonElement>('#record-midi')!.addEventListener('click', () => actions().toggleRecord?.());
  screen.querySelector<HTMLButtonElement>('#pause-band')!.addEventListener('click', () => actions().togglePause?.());

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

  const tapBtn = screen.querySelector<HTMLButtonElement>('#tap-tempo')!;
  const beatsEl = screen.querySelector<HTMLElement>('#beats')!;
  tapBtn.addEventListener('click', () => {
    pulse(beatsEl, 'tap-flash', 150);
    const r = actions().tap?.();
    if (r) bpmInput.value = String(Math.round(r.bpm));
  });
  window.addEventListener('keydown', e => {
    if (e.code !== 'Space') return;
    const active = document.activeElement as HTMLElement | null;
    const tag = active?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || active?.isContentEditable) return;
    e.preventDefault();
    tapBtn.click();
  });

  const countInBtn = screen.querySelector<HTMLButtonElement>('#count-in-toggle')!;
  countInBtn.addEventListener('click', () => actions().setCountIn?.(!store.state.countIn));

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
  updateToast(screen, s);
  updateHeader(screen, s);
  updateEngine(screen, s);
  updateAccompTiles(screen, s);
  updateReadouts(screen, s);
  updateMicMute(screen, s);
  updateVoiceMonitor(screen, s);
  updateTiles(screen, s, changeLatencyMs);
  const audio = screen.querySelector<HTMLButtonElement>('#enable-audio')!;
  audio.hidden = !s.audioSuspended && s.power === 'on';
  screen.querySelector<HTMLElement>('#input-status')!.textContent = `${midiLabel(s)}${hearingLabel(s)}${s.audioSuspended ? ' · TAP TO ENABLE SOUND' : ''}`;
  screen.querySelector<HTMLElement>('#midi-status')!.textContent = midiLabel(s);
  screen.querySelector<HTMLElement>('#band-status')!.textContent = s.accompanimentStatus;
  const pause = screen.querySelector<HTMLButtonElement>('#pause-band')!;
  pause.classList.toggle('paused', s.paused);
  pause.setAttribute('aria-pressed', String(s.paused));
  pause.title = s.paused ? 'Let the band play' : 'Hold the band';
  screen.querySelector<HTMLElement>('#pause-label')!.textContent = s.paused ? 'Play' : 'Pause';
  const rec = screen.querySelector<HTMLButtonElement>('#record-midi')!;
  rec.classList.toggle('recording', s.recording);
  rec.setAttribute('aria-pressed', String(s.recording));
  screen.querySelector<HTMLElement>('#record-label')!.textContent = s.recording ? 'Save' : 'Rec';
  rec.title = s.recording ? 'Recording… tap to save the MIDI' : 'Tap to record you + the band, tap again to save the MIDI';
  screen.querySelector<HTMLElement>('#model-latency')!.textContent = [s.responseLatencyMs == null ? '' : `Response ≈${Math.round(s.responseLatencyMs)} ms`, s.modelLatencyMs == null ? '' : `Model ${Math.round(s.modelLatencyMs)} ms`,
    s.queueLatencyMs == null ? '' : `Queue ${Math.round(s.queueLatencyMs)} ms`,
    s.requestAgeMs == null ? '' : `Age ${Math.round(s.requestAgeMs)} ms`,
    s.tooLate ? `Late ${s.tooLate}` : ''].filter(Boolean).join(' · ');
  screen.querySelector<HTMLElement>('#output-latency')!.textContent = s.outputLatencyMs == null ? '' : `Output latency: ${Math.round(s.outputLatencyMs)} ms`;
  screen.querySelector<HTMLElement>('#engine-status')!.textContent = s.engineConnecting ? `${ENGINE_NAMES[s.engine]} · connecting…` : s.offlineEngines.includes(s.engine) ? `${ENGINE_NAMES[s.engine]} · offline` : '';
  for (const [id, value] of [['noise', s.noiseVolume], ['drone', s.droneVolume]] as const) {
    const input = screen.querySelector<HTMLInputElement>(`#${id}-volume`)!;
    if (document.activeElement !== input) input.value = String(value);
    screen.querySelector<HTMLElement>(`#${id}-value`)!.textContent = `${Math.round(value * 100)}%`;
  }
  const sound = screen.querySelector<HTMLSelectElement>('#sound')!;
  if (document.activeElement !== sound) sound.value = s.sound;

  const countInBtn = screen.querySelector<HTMLButtonElement>('#count-in-toggle')!;
  countInBtn.classList.toggle('on', s.countIn);
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
  if (s.power === 'off') return 'STARTING…';
  if (s.audioSuspended) return 'TAP ANYWHERE TO ENABLE SOUND';
  if (s.countInBeat != null) return `COUNT-IN · ${[1, 2, 3, 4].map(n => (n === s.countInBeat ? n : '·')).join(' ')}`;
  if (s.locked) {
    const d = s.input.dynamics;
    // What the band is doing with the gap the player left, in the two words that matter.
    const flags = `${d.space && s.enabled.lead ? ' · ANSWER' : ''}${d.fillDue ? ' · FILL' : ''}`;
    return `LIVE · BAR ${s.bar}${s.input.chord ? ` · ${chordName(s.input.chord)}` : ''}${flags}`;
  }
  const who = `LISTENING · MIC ${mark(s.sources.mic)} ${midiLabel(s)}`;
  const micOnly = s.sources.mic === 'on' && s.sources.midi !== 'on';
  if (micOnly) return `${who} · SING TO START`;
  // once there is enough to guess with, show the running estimate — it is the
  // only feedback that the mic is hearing a tempo and not just noise
  const guess = s.input.pendingBpm ? ` · ~${Math.round(s.input.pendingBpm)} BPM` : '';
  return `${who} · ${s.input.onsets}/12${guess}`;
}

function updateToast(screen: HTMLElement, s: AppState): void {
  const toast = screen.querySelector<HTMLElement>('#toast')!;
  if (s.toast) toast.textContent = s.toast; // keep the last message visible through the hide transition
  toast.hidden = !s.toast;
}

function updatePower(screen: HTMLElement, s: AppState): void {
  const on = s.power === 'on';
  screen.classList.toggle('powered', on);
  screen.querySelectorAll<HTMLElement>('#inst-tiles, #accomp-tiles, .row2 .zone').forEach(el => el.classList.toggle('dimmed', !on));
  // Pads, the creativity knob, and manual tempo/key overrides need a running
  // band; ENGINE and GENRE only set state, so they stay clickable while off.
  screen
    .querySelectorAll<HTMLElement>('#inst-tiles, #accomp-tiles, .row2 .knob-zone, .row2 .manual')
    .forEach(el => el.classList.toggle('inert', !on));
}

function updateEngine(screen: HTMLElement, s: AppState): void {
  screen.querySelectorAll<HTMLButtonElement>('#engine-choice .engine-key').forEach(btn => {
    const e = btn.dataset.engine as AppState['engine'];
    const selected = e === s.engine;
    btn.classList.toggle('on', selected);
    btn.setAttribute('aria-pressed', String(selected));
    const offline = s.offlineEngines.includes(e);
    btn.title = offline ? 'OFFLINE' : '';
    const led = btn.querySelector<HTMLElement>('.engine-led')!;
    const live = selected && s.power === 'on';
    const connecting = live && s.engineConnecting;
    // Selection alone is not evidence that a model service is available.
    const online = !offline && !connecting;
    led.classList.toggle('offline', !online && !connecting);
    led.classList.toggle('online', online);
    led.classList.toggle('connecting', connecting);
  });
}

export function accompPresetMuted(preset: AccompPreset, enabled: Record<Instrument, boolean>): boolean {
  return !Object.values(GM_INSTRUMENTS).some(gm => gm.presets.includes(preset) && enabled[gm.role]);
}

function updateAccompTiles(screen: HTMLElement, s: AppState): void {
  const row = screen.querySelector<HTMLElement>('#accomp-tiles')!;
  row.hidden = s.engine !== 'amt';

  screen.querySelectorAll<HTMLButtonElement>('#accomp-tiles button[data-preset]').forEach(btn => {
    const preset = btn.dataset.preset as AccompPreset;
    const on = s.accompPresets.includes(preset);
    const muted = accompPresetMuted(preset, s.enabled);
    const active = on && !muted && !!s.accompActive[preset];
    btn.classList.toggle('on', on);
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(on));
    btn.querySelector<HTMLElement>('.st-text')!.textContent = !on ? 'off' : muted ? 'muted' : active ? 'playing' : 'ready';
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
  const bar = screen.querySelector<HTMLElement>('.bar')!;
  if (!s.locked || !s.input.bpm) {
    beats.classList.remove('run');
    tiles.classList.remove('run');
    bar.classList.remove('run');
    lastBar.delete(screen);
    return;
  }
  screen.style.setProperty('--beat', `${60 / s.input.bpm}s`);
  if (lastBar.get(screen) === s.bar && beats.classList.contains('run')) return;
  lastBar.set(screen, s.bar);
  for (const el of [beats, tiles, bar]) {
    el.classList.remove('run');
    void el.offsetWidth; // reflow so the animation restarts on the downbeat
    el.classList.add('run');
  }
}

function updateMicMute(screen: HTMLElement, s: AppState): void {
  const micMute = screen.querySelector<HTMLButtonElement>('#mic-mute')!;
  const midiOnly = s.sources.mic === 'denied' || s.sources.mic === 'none';
  micMute.hidden = midiOnly;
  micMute.disabled = midiOnly;
  micMute.classList.toggle('on', s.micMuted);
  micMute.firstChild!.textContent = s.micMuted ? 'MIC MUTED' : 'MIC';
}

/** VOICE chip: same look and place as MIC, off by default, and disabled on a phone
 *  (headphones-only monitoring) regardless of anything else about the current state. */
function updateVoiceMonitor(screen: HTMLElement, s: AppState): void {
  const voice = screen.querySelector<HTMLButtonElement>('#voice-monitor')!;
  const midiOnly = s.sources.mic === 'denied' || s.sources.mic === 'none';
  const phone = isPhoneUA();
  voice.hidden = midiOnly;
  voice.disabled = midiOnly || phone;
  voice.title = phone ? 'Headphones only' : 'Monitor your own mic through the mix';
  voice.classList.toggle('on', s.voiceMonitor && !phone);
  voice.firstChild!.textContent = s.voiceMonitor && !phone ? 'VOICE ON' : 'VOICE';
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
export function tileLabel(on: boolean, locked: boolean, pending: boolean, justJoined: boolean, active = false): string {
  if (!on) return locked && pending ? 'leaving…' : 'off';
  if (!locked) return 'ready';
  if (pending) return 'joining…';
  return active ? 'playing' : justJoined ? 'joins next bar' : 'ready';
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

    const text = tileLabel(on, s.locked, pending, justJoined, !!s.activeParts?.[i]);
    btn.querySelector<HTMLElement>('.st-text')!.textContent = text;
    // blinking LED while the engine settles the change
    btn.classList.toggle('pending', text === 'joining…' || text === 'leaving…');
    btn.setAttribute('aria-pressed', String(on));
    btn.classList.toggle('active', text === 'playing');
  }
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

// "keys" here is the GM electric-piano preset, distinct from the main Keys instrument voice.
const PRESET_LABEL: Record<string, string> = { keys: 'Electric piano' };
function presetLabel(p: string): string {
  return PRESET_LABEL[p] ?? cap(p);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

