// Long-session AMT probe: drive one session for BEATS beats and report, per 16-beat segment,
// how many plans came back and how many carried notes. Catches the ~100 s cliff (model time
// vocabulary) that the 8-bar smoke never reaches.
//   node services/probe-long-session.mjs [ws-url] [beats] [bpm]
import WebSocket from 'ws';
const WS_URL = process.argv[2] ?? 'wss://backline-relay.shylenkoa.workers.dev/amt';
const BEATS = Number(process.argv[3] ?? 320);
const BPM = Number(process.argv[4] ?? 120);
const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));
const ws = new WebSocket(WS_URL, { headers: { Origin: 'https://www.duetai.art' } });
const plans = []; const errors = []; let closed = null; const tickAt = new Map(); const lat = [];
ws.on('message', raw => { const m = JSON.parse(raw.toString());
  if (m.type === 'plan') { plans.push(m); const t0 = tickAt.get(m.fromBeat - 2); if (t0) lat.push(Date.now() - t0); } else if (m.type === 'error') errors.push(m.message); });
ws.on('close', (c, r) => { closed = `${c} ${r}`; });
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
const set = { type: 'set', bpm: BPM, key: 'A minor', creativity: 0.3, amount: 1, enabledRoles: { keys: true, bass: true, lead: false } };
ws.send(JSON.stringify({ type: 'start', bpm: BPM, key: 'A minor', genre: 'lofi', lookaheadBeats: 2, commitBeats: 2, listenBeats: 8 }));
ws.send(JSON.stringify(set));
const scale = [57, 59, 60, 62, 64, 65, 67, 69];
let t = Date.now();
for (let beat = 0; beat < BEATS && closed === null; beat += 2) {
  ws.send(JSON.stringify({ type: 'notes', notes: [
    { beat, pitch: scale[beat % 8], dur: 1, vel: 0.7 }, { beat: beat + 1, pitch: scale[(beat + 1) % 8], dur: 1, vel: 0.7 }] }));
  tickAt.set(beat, Date.now()); ws.send(JSON.stringify({ type: 'tick', beat }));
  t += 2 * 60000 / BPM; await sleep(t - Date.now());
}
await sleep(1500);
const seg = 16; const rows = [];
for (let b = 8; b < BEATS; b += seg) {
  const ps = plans.filter(p => p.fromBeat >= b && p.fromBeat < b + seg);
  const n = ps.reduce((a, p) => a + (p.notes?.length ?? 0), 0);
  rows.push(`${String(b).padStart(4)}-${String(b + seg).padStart(4)} beats: ${ps.length} plans, ${ps.filter(p => (p.notes?.length ?? 0) >= 3).length} model-sized (>=3 notes), ${n} notes`);
}
console.log(rows.join('\n'));
const tail = plans.filter(p => p.fromBeat >= BEATS - 64);
const ok = closed === null && errors.length === 0 && tail.length >= 8 && tail.filter(p => (p.notes?.length ?? 0) >= 3).length >= tail.length * 0.5;
const q = f => lat.length ? lat.slice().sort((a, b) => a - b)[Math.min(lat.length - 1, Math.floor(f * lat.length))] : -1;
console.log(`${ok ? 'PASS' : 'FAIL'} long-session: cue->plan p50=${q(0.5)}ms p95=${q(0.95)}ms, ${plans.length} plans, ${errors.length} errors${errors[0] ? ' (' + errors[0].slice(0, 80) + ')' : ''}, closed=${closed}, last 64 beats: ${tail.filter(p => (p.notes?.length ?? 0) >= 3).length}/${tail.length} model-sized (server fills empty windows with 1-2 key notes)`);
ws.close(); process.exit(ok ? 0 : 1);
