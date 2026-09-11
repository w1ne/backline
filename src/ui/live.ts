import { GENRES, INSTRUMENTS } from '../types';
import type { Genre, Instrument } from '../types';
import { keyName } from '../music/scales';
import { DEBUG } from '../debug';
import type { AppState, Store } from './state';

const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const ALL_KEYS: { root: number; mode: 'major' | 'minor' }[] = [
  ...KEY_NAMES.map((_, root) => ({ root, mode: 'major' as const })),
  ...KEY_NAMES.map((_, root) => ({ root, mode: 'minor' as const })),
];

export interface LiveActions {
  toggle(i: Instrument): void;
  setGenre(g: Genre): void;
  setCreativity(c: number): void;
  stop(): void;
  setBpmOverride?(bpm: number | undefined): void;
  setKeyOverride?(key: { root: number; mode: 'major' | 'minor' } | undefined): void;
  setTempoMode?(m: 'locked' | 'follow'): void;
  /** ms a toggled instrument spends showing "joining…"/"leaving…" before it settles */
  changeLatencyMs?: number;
}

const actionsRef = new WeakMap<HTMLElement, LiveActions>();

export function renderLive(root: HTMLElement, store: Store, actions: LiveActions): void {
  let screen = root.querySelector<HTMLElement>('.screen[data-live]');
  if (!screen) {
    root.innerHTML = skeleton();
    screen = root.querySelector<HTMLElement>('.screen[data-live]')!;
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
        <span class="logo"><i></i>Backline</span>
        <span class="pill" id="live-pill"></span>
      </div>
      <div class="readout">
        <div><small>Tempo</small><strong id="ro-tempo">&mdash;</strong>
          <span class="toggle" id="tempoMode">
            <button type="button" data-mode="locked">Locked</button>
            <button type="button" data-mode="follow">Follow</button>
          </span>
          <small class="hint" id="tempoMode-note" hidden>Follow needs the Patterns engine</small>
        </div>
        <div><small>Key</small><strong id="ro-key">&mdash;</strong></div>
        <div><small>Genre</small>
          <select id="genre">
            ${GENRES.map(g => `<option value="${g}">${cap(g)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="creativity-panel panel">
        <label for="creativity">CREATIVITY</label>
        <input type="range" id="creativity" min="0" max="1" step="0.05" />
        <span class="val" id="creativity-val"></span>
      </div>
      <div class="creativity-panel panel">
        <label for="bpm">BPM OVERRIDE</label>
        <input type="number" id="bpm" min="40" max="240" placeholder="auto" />
        <label for="key">KEY OVERRIDE</label>
        <select id="key">
          <option value="auto">auto</option>
          ${ALL_KEYS.map(
            k => `<option value="${k.root}-${k.mode}">${KEY_NAMES[k.root]} ${k.mode === 'major' ? 'maj' : 'min'}</option>`,
          ).join('')}
        </select>
      </div>
      <div class="you">
        <span class="label">YOU</span>
        <span class="level"><i id="you-level"></i></span>
        <span class="pill" id="you-notes"></span>
      </div>
      <div class="inst" id="inst-tiles">
        ${INSTRUMENTS.map(
          i =>
            `<button type="button" class="${i}" data-inst="${i}">
              <span class="dot"></span>
              <span class="name">${cap(i)}</span>
              <span class="st"><span class="st-text"></span><span class="meter"><i style="width:0"></i></span></span>
            </button>`,
        ).join('')}
      </div>
      <div class="foot">
        <button type="button" class="btn ghost" id="stop-jam">Stop</button>
        <span class="hint" id="latency"></span>
      </div>
    </div>
  `;
}

function wireControls(screen: HTMLElement, store: Store): void {
  // ?debug=1: how many times this element had listeners attached. Anything but
  // "1" means a re-render re-wired it and every click fires N handlers.
  if (DEBUG) screen.dataset.wired = String(Number(screen.dataset.wired ?? 0) + 1);
  const actions = (): LiveActions => actionsRef.get(screen)!;
  screen.querySelector<HTMLSelectElement>('#genre')!.addEventListener('change', e => {
    actions().setGenre((e.target as HTMLSelectElement).value as Genre);
  });
  const creativity = screen.querySelector<HTMLInputElement>('#creativity')!;
  creativity.addEventListener('input', () => {
    actions().setCreativity(Number(creativity.value));
  });
  screen.querySelectorAll<HTMLButtonElement>('#inst-tiles button').forEach(btn => {
    btn.addEventListener('click', () => actions().toggle(btn.dataset.inst as Instrument));
  });
  screen.querySelector<HTMLButtonElement>('#stop-jam')!.addEventListener('click', () => actions().stop());

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

function update(screen: HTMLElement, s: AppState, changeLatencyMs: number): void {
  updateHeader(screen, s);
  updateReadouts(screen, s);
  updateYouStrip(screen, s);
  updateTiles(screen, s, changeLatencyMs);
  updateFooter(screen, s);
}

function updateHeader(screen: HTMLElement, s: AppState): void {
  const pill = screen.querySelector<HTMLElement>('#live-pill')!;
  if (s.error) {
    pill.textContent = s.error;
    pill.className = 'pill error';
  } else if (s.locked) {
    const looping = s.loopsUpdatedAt !== undefined && Date.now() - s.loopsUpdatedAt < 3000 ? ' · looping' : '';
    pill.textContent = `live · bar ${s.bar}${looping}`;
    pill.className = 'pill live';
  } else {
    pill.textContent = `listening… onsets ${s.input.onsets}/12`;
    pill.className = 'pill';
  }
}

function updateReadouts(screen: HTMLElement, s: AppState): void {
  screen.querySelector<HTMLElement>('#ro-tempo')!.textContent = s.input.bpm ? String(Math.round(s.input.bpm)) : '—';
  screen.querySelector<HTMLElement>('#ro-key')!.textContent = s.input.key ? keyName(s.input.key) : '—';

  const genreSelect = screen.querySelector<HTMLSelectElement>('#genre')!;
  if (genreSelect.value !== s.genre) genreSelect.value = s.genre;

  const creativity = screen.querySelector<HTMLInputElement>('#creativity')!;
  if (document.activeElement !== creativity) creativity.value = String(s.creativity);
  screen.querySelector<HTMLElement>('#creativity-val')!.textContent = s.creativity.toFixed(2);

  const lyriaFollow = s.engine === 'lyria';
  screen.querySelectorAll<HTMLButtonElement>('#tempoMode button').forEach(btn => {
    btn.classList.toggle('on', btn.dataset.mode === s.tempoMode);
    if (btn.dataset.mode === 'follow') btn.disabled = lyriaFollow;
  });
  const note = screen.querySelector<HTMLElement>('#tempoMode-note')!;
  note.hidden = !lyriaFollow;

  const tempoEl = screen.querySelector<HTMLElement>('#ro-tempo')!;
  if (s.engine === 'lyria' && s.input.bpm) {
    const clamped = Math.min(200, Math.max(60, Math.round(s.input.bpm)));
    if (clamped !== Math.round(s.input.bpm)) tempoEl.textContent = `${clamped} (clamped)`;
  }
}

function updateYouStrip(screen: HTMLElement, s: AppState): void {
  screen.querySelector<HTMLElement>('#you-level')!.style.width = `${Math.round(s.input.inputLevel * 100)}%`;
  screen.querySelector<HTMLElement>('#you-notes')!.textContent = s.input.notesNow.length
    ? s.input.notesNow.map(noteName).join(' · ')
    : '—';
}

const enabledAtBar = new WeakMap<HTMLElement, Partial<Record<Instrument, number>>>();
// engines with changeLatencyMs > 0 (e.g. Lyria) settle on a wall-clock timer instead of a bar
const pendingUntil = new WeakMap<HTMLElement, Partial<Record<Instrument, number>>>();
const lastOn = new WeakMap<HTMLElement, Partial<Record<Instrument, boolean>>>();

function updateTiles(screen: HTMLElement, s: AppState, changeLatencyMs: number): void {
  if (!enabledAtBar.has(screen)) enabledAtBar.set(screen, {});
  if (!pendingUntil.has(screen)) pendingUntil.set(screen, {});
  if (!lastOn.has(screen)) lastOn.set(screen, {});
  const since = enabledAtBar.get(screen)!;
  const until = pendingUntil.get(screen)!;
  const last = lastOn.get(screen)!;

  for (const i of INSTRUMENTS) {
    const btn = screen.querySelector<HTMLButtonElement>(`#inst-tiles button[data-inst="${i}"]`)!;
    const on = s.enabled[i];
    btn.classList.toggle('on', on);

    let text: string;
    if (changeLatencyMs > 0) {
      if (last[i] !== on) {
        until[i] = Date.now() + changeLatencyMs;
        last[i] = on;
        window.setTimeout(() => {
          const textEl = btn.querySelector<HTMLElement>('.st-text')!;
          const meterEl = btn.querySelector<HTMLElement>('.meter i')!;
          const stillOn = last[i];
          const settledText = stillOn ? 'playing' : 'off';
          textEl.textContent = settledText;
          meterEl.style.width = settledText === 'playing' ? '60%' : '0';
        }, changeLatencyMs);
      }
      const pending = until[i] !== undefined && Date.now() < (until[i] as number);
      text = !s.locked ? 'off' : pending ? (on ? 'joining…' : 'leaving…') : on ? 'playing' : 'off';
    } else {
      if (on && since[i] === undefined) since[i] = s.bar;
      if (!on) since[i] = undefined;
      const justJoined = on && since[i] !== undefined && s.bar <= (since[i] as number);
      text = !on ? 'off' : !s.locked ? 'off' : justJoined ? 'joins next bar' : 'playing';
    }
    btn.querySelector<HTMLElement>('.st-text')!.textContent = text;
    const meter = btn.querySelector<HTMLElement>('.meter i')!;
    meter.style.width = text === 'playing' ? '60%' : '0';
  }
}

function updateFooter(_screen: HTMLElement, _s: AppState): void {
  // latency text is set independently via setLatency(), refreshed per bar
}

export function setLatency(root: HTMLElement, ms: number): void {
  const el = root.querySelector<HTMLElement>('#latency');
  if (el) el.textContent = `latency ${Math.round(ms)} ms`;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function noteName(n: number): string {
  return NOTE_NAMES[((n % 12) + 12) % 12];
}
