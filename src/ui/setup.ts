import { GENRES } from '../types';
import type { Genre } from '../types';
import { login } from '../auth';
import type { Store } from './state';

export function renderSetup(root: HTMLElement, store: Store, onStart: () => void): void {
  const { source, genre, engine, user, error } = store.state;

  root.innerHTML = `
    <div class="screen">
      <div class="bar">
        <span class="logo"><i></i>Backline</span>
        <span class="pill">ready</span>
      </div>
      <div class="grid2">
        <div class="panel">
          <h4>Your input</h4>
          <div class="choice" id="source-choice">
            <button type="button" id="source-mic" class="${source === 'mic' ? 'on' : ''}">Microphone</button>
            <button type="button" id="source-midi" class="${source === 'midi' ? 'on' : ''}">MIDI keyboard</button>
          </div>
        </div>
        <div class="panel">
          <h4>Genre</h4>
          <div class="choice" id="genre-choice">
            ${GENRES.map(
              g =>
                `<button type="button" class="genre-btn ${g === genre ? 'on' : ''}" data-genre="${g}">${cap(g)}</button>`,
            ).join('')}
          </div>
        </div>
      </div>
      <div class="panel">
        <h4>Engine</h4>
        <div class="choice" id="engine-choice">
          <button type="button" id="engine-lyria" class="${engine === 'lyria' ? 'on' : ''}">Lyria (API)</button>
          <button type="button" id="engine-patterns" class="${engine === 'patterns' ? 'on' : ''}">Patterns (offline)</button>
        </div>
        <div id="auth-row" style="${engine === 'lyria' ? '' : 'display:none'}">
          ${
            user
              ? `<span class="hint">Signed in as ${escapeHtml(user.login)}</span>`
              : `<button type="button" class="btn" id="github-login">Sign in with GitHub</button>`
          }
        </div>
      </div>
      ${error ? `<div class="hint" id="setup-error" style="color:#f66">${escapeHtml(error)}</div>` : ''}
      <div class="foot">
        <span class="hint">Play four bars and the band will lock onto you. Use headphones.</span>
        <button type="button" class="btn" id="start-jam">Start jam</button>
      </div>
    </div>
  `;

  root.querySelector<HTMLButtonElement>('#source-mic')!.addEventListener('click', () => store.update({ source: 'mic' }));
  root.querySelector<HTMLButtonElement>('#source-midi')!.addEventListener('click', () => store.update({ source: 'midi' }));

  root.querySelectorAll<HTMLButtonElement>('.genre-btn').forEach(btn => {
    btn.addEventListener('click', () => store.update({ genre: btn.dataset.genre as Genre }));
  });

  root.querySelector<HTMLButtonElement>('#github-login')?.addEventListener('click', () => login());

  const authRow = root.querySelector<HTMLElement>('#auth-row')!;
  root.querySelector<HTMLButtonElement>('#engine-lyria')!.addEventListener('click', () => {
    store.update({ engine: 'lyria' });
    authRow.style.display = '';
  });
  root.querySelector<HTMLButtonElement>('#engine-patterns')!.addEventListener('click', () => {
    store.update({ engine: 'patterns' });
    authRow.style.display = 'none';
  });

  root.querySelector<HTMLButtonElement>('#start-jam')!.addEventListener('click', () => {
    if (store.state.engine === 'lyria' && !store.state.user) {
      store.update({ error: 'Sign in with GitHub to use Lyria' });
      return;
    }
    onStart();
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
