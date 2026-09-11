import * as Tone from 'tone';
import { Bandleader } from './band/bandleader';
import { ToneClock } from './band/clock';
import { Players } from './players/players';
import { PATTERNS } from './patterns';
import { INSTRUMENTS, GENRES } from './types';
import type { Genre } from './types';

const app = document.getElementById('app')!;
app.innerHTML = `
  <h1>Backline</h1>
  <button id="start">Start</button>
  <button id="stop" disabled>Stop</button>
  <label>Genre <select id="genre"></select></label>
  <label>Creativity <input id="creativity" type="range" min="0" max="1" step="0.05" value="0.3" /></label>
`;

const genreSelect = document.getElementById('genre') as HTMLSelectElement;
for (const g of GENRES) {
  const opt = document.createElement('option');
  opt.value = g;
  opt.textContent = g;
  genreSelect.appendChild(opt);
}

const players = new Players();
const band = new Bandleader(new ToneClock(), players, PATTERNS);
for (const i of INSTRUMENTS) band.setEnabled(i, true);

const startBtn = document.getElementById('start') as HTMLButtonElement;
const stopBtn = document.getElementById('stop') as HTMLButtonElement;
const creativityInput = document.getElementById('creativity') as HTMLInputElement;

startBtn.addEventListener('click', async () => {
  await players.init();
  band.start(100, Tone.now() + 0.2);
  startBtn.disabled = true;
  stopBtn.disabled = false;
});

stopBtn.addEventListener('click', () => {
  band.stop();
  startBtn.disabled = false;
  stopBtn.disabled = true;
});

genreSelect.addEventListener('change', () => {
  const g = genreSelect.value as Genre;
  players.setGenre(g);
  band.set({ genre: g });
});

creativityInput.addEventListener('input', () => {
  band.set({ creativity: Number(creativityInput.value) });
});
