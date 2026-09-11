import { GENRES } from '../types';
import type { Genre } from '../types';
import { login } from '../auth';
import type { Store } from './state';

// the drop-in only plays on the first paint, not on every state re-render
let introPlayed = false;

export function renderSetup(root: HTMLElement, store: Store, onStart: () => void | Promise<void>): void {
  const { source, genre, engine, user, error } = store.state;
  const intro = introPlayed ? '' : ' intro';
  introPlayed = true;

  root.innerHTML = `
    <div class="screen${intro}">
      <div class="bar">
        <h1 class="logo">Back<i>line</i></h1>
        <span class="swatches" aria-hidden="true">
          <span style="--c:var(--orange)"></span><span style="--c:var(--yellow)"></span><span style="--c:var(--blue)"></span><span style="--c:var(--green)"></span><span style="--c:var(--pink)"></span>
        </span>
        <span class="pill">ready</span>
      </div>
      <div class="grid2">
        <div class="zone zone--orange">
          <h4>Your input</h4>
          <div class="choice" id="source-choice">
            <button type="button" id="source-mic" class="key ${source === 'mic' ? 'on' : ''}">Mic</button>
            <button type="button" id="source-midi" class="key ${source === 'midi' ? 'on' : ''}">Midi</button>
          </div>
        </div>
        <div class="zone zone--ink">
          <h4>Genre</h4>
          <div class="choice" id="genre-choice">
            ${GENRES.map(
              g =>
                `<button type="button" class="key genre-btn ${g === genre ? 'on' : ''}" data-genre="${g}">${g}</button>`,
            ).join('')}
          </div>
        </div>
      </div>
      <div class="zone zone--yellow">
        <h4>Engine</h4>
        <div class="switch-row">
          <span class="switch" id="engine-choice">
            <button type="button" id="engine-lyria" class="${engine === 'lyria' ? 'on' : ''}">Lyria · api</button>
            <button type="button" id="engine-patterns" class="${engine === 'patterns' ? 'on' : ''}">Patterns · offline</button>
          </span>
          <p class="hint">Patterns plays offline · Lyria streams from the API</p>
          <span id="auth-row" style="${engine === 'lyria' ? '' : 'display:none'}">
            ${
              user
                ? `<span class="hint">Signed in as ${escapeHtml(user.login)}</span>`
                : `<button type="button" class="btn" id="github-login">Sign in · GitHub</button>`
            }
          </span>
        </div>
      </div>
      ${error ? `<div class="err" id="setup-error">${escapeHtml(error)}</div>` : ''}
      <div class="zone zone--green foot">
        <p class="hint">Play four bars — the band locks onto you. Use headphones.</p>
        <button type="button" class="btn big" id="start-jam">Start</button>
      </div>
    </div>
  `;

  root.querySelector<HTMLButtonElement>('#source-mic')!.addEventListener('click', () => store.update({ source: 'mic' }));
  root.querySelector<HTMLButtonElement>('#source-midi')!.addEventListener('click', () => store.update({ source: 'midi' }));

  root.querySelectorAll<HTMLButtonElement>('.genre-btn').forEach(btn => {
    btn.addEventListener('click', () => store.update({ genre: btn.dataset.genre as Genre }));
  });

  root.querySelector<HTMLButtonElement>('#github-login')?.addEventListener('click', () => {
    store.update({ error: null });
    login();
  });

  const authRow = root.querySelector<HTMLElement>('#auth-row')!;
  root.querySelector<HTMLButtonElement>('#engine-lyria')!.addEventListener('click', () => {
    store.update({ engine: 'lyria', error: null });
    authRow.style.display = '';
  });
  root.querySelector<HTMLButtonElement>('#engine-patterns')!.addEventListener('click', () => {
    store.update({ engine: 'patterns', error: null });
    authRow.style.display = 'none';
  });

  root.querySelector<HTMLButtonElement>('#start-jam')!.addEventListener('click', () => {
    if (store.state.engine === 'lyria' && !store.state.user) {
      store.update({ error: 'Sign in with GitHub to use Lyria' });
      return;
    }
    try {
      const result = onStart();
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch(err => {
          store.update({ error: readableStartError(err) });
        });
      }
    } catch (err) {
      store.update({ error: readableStartError(err) });
    }
  });
}

function readableStartError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : undefined;
  if (name === 'NotAllowedError') return 'Microphone access was denied. Allow it and try again.';
  if (name === 'NotFoundError') return 'No microphone found.';
  const msg = err instanceof Error ? err.message : String(err);
  if (/midi/i.test(msg)) return 'Web MIDI is unavailable. Try Chrome/Edge, or use the microphone instead.';
  return `Could not start: ${msg}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
