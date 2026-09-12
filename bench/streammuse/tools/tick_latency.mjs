// Plays the hummed A-minor melody from bench/voice/synth.ts into the AMT service the way the
// browser does (start -> notes at their wall-clock onsets -> a cue every half bar) and reports
// the cue-to-plan latency per commit through the relay. Node 20, `ws` from node_modules.
//
//   node bench/streammuse/tools/tick_latency.mjs wss://backline-relay.shylenkoa.workers.dev/amt [bars] [out.json]
import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';

const URL = process.argv[2] ?? 'wss://backline-relay.shylenkoa.workers.dev/amt';
const BARS = Number(process.argv[3] ?? 16);
const OUT = process.argv[4];
const BPM = 90;
const BEAT_MS = 60000 / BPM;
const COMMIT_BEATS = 2;
const LISTEN_BEATS = 8;

// A_MINOR_MELODY_DEGREES from bench/voice/synth.ts, root A3, one note per beat, 8 bars.
const DEGREES = [0, 2, 3, 5, 7, 5, 3, 2, 0, 3, 7, 5, 3, 2, 0, 0, 2, 3, 5, 7, 9, 7, 5, 3, 2, 0, 3, 2, 0, -2, 0, 0];
const melody = [];
for (let beat = 0; beat < BARS * 4; beat++) {
  melody.push({ beat, pitch: 57 + DEGREES[beat % DEGREES.length], dur: 1, vel: 0.7 });
}

const ws = new WebSocket(URL, { headers: { Origin: 'https://www.duetai.art' } });
const sleepUntil = t => new Promise(r => setTimeout(r, Math.max(0, t - performance.now())));
const plans = [];
const statuses = [];
const others = [];
let ready = false;
let pending; // { beat, sentAt } of the cue awaiting its plan

ws.on('message', raw => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'ready') ready = m.tick === true;
  else if (m.type === 'plan') {
    const cue = pending; pending = undefined;
    plans.push({ ...m, cueBeat: cue?.beat, rttMs: cue ? performance.now() - cue.sentAt : NaN });
  } else if (m.type === 'status') statuses.push(m);
  else others.push(m);
});

await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
ws.send(JSON.stringify({ type: 'start', bpm: BPM, key: 'A minor', genre: 'lofi',
  lookaheadBeats: 4, commitBeats: COMMIT_BEATS, listenBeats: LISTEN_BEATS }));
ws.send(JSON.stringify({ type: 'set', key: 'A minor', chord: 'Am', creativity: 0.3, amount: 1,
  instruments: { drums: true, bass: true, keys: true, lead: false } }));
await new Promise(r => setTimeout(r, 500)); // let `ready` (or nothing, on an old server) arrive
const mode = ready ? 'tick' : 'bar';
console.log(`server ${ready ? 'plans per half bar (tick)' : 'plans per bar (no ready)'}; ${BARS} bars at ${BPM} bpm`);

const t0 = performance.now();
let i = 0;
const cueBeats = [];
for (let beat = 0; beat < BARS * 4; beat += COMMIT_BEATS) cueBeats.push(beat);
for (const beat of cueBeats) {
  await sleepUntil(t0 + beat * BEAT_MS);
  // Everything sung up to this cue goes out first, as the browser flushes before cueing.
  while (i < melody.length && melody[i].beat <= beat) {
    ws.send(JSON.stringify({ type: 'notes', notes: [melody[i]] })); i++;
  }
  if (mode === 'tick') {
    pending = { beat, sentAt: performance.now() };
    ws.send(JSON.stringify({ type: 'tick', beat }));
  } else if (beat % 4 === 0) {
    pending = { beat, sentAt: performance.now() };
    ws.send(JSON.stringify({ type: 'bar', bar: beat / 4 }));
  }
  // Notes inside this half bar, at their onsets.
  while (i < melody.length && melody[i].beat < beat + COMMIT_BEATS) {
    await sleepUntil(t0 + melody[i].beat * BEAT_MS);
    ws.send(JSON.stringify({ type: 'notes', notes: [melody[i]] })); i++;
  }
}
await new Promise(r => setTimeout(r, 3000));
ws.close();

const stats = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { n: s.length, mean: +mean.toFixed(0), p50: +s[Math.floor(s.length * 0.5)].toFixed(0),
    p95: +s[Math.min(s.length - 1, Math.floor(s.length * 0.95))].toFixed(0), max: +s[s.length - 1].toFixed(0) };
};
const modelPlans = plans.filter(p => p.toBeat > LISTEN_BEATS); // past the listen window
const empty = plans.filter(p => !p.notes?.length);
const emptyModel = modelPlans.filter(p => !p.notes?.length);
const rtt = plans.map(p => p.rttMs).filter(Number.isFinite);
const server = statuses.map(s => s.latencyMs).filter(v => v > 0);
console.log(`cues sent: ${mode === 'tick' ? cueBeats.length : BARS}, plans: ${plans.length} (${modelPlans.length} past listen window)`);
console.log(`cue->plan ms (all):   ${JSON.stringify(stats(rtt))}`);
console.log(`cue->plan ms (model): ${JSON.stringify(stats(modelPlans.map(p => p.rttMs)))}`);
console.log(`server latencyMs:     ${JSON.stringify(stats(server))}`);
console.log(`empty plans: ${empty.length} (${emptyModel.length} past listen window)`);
console.log(`notes per plan: ${plans.map(p => p.notes?.length ?? 0).join(' ')}`);
if (others.length) console.log('other messages:', JSON.stringify(others.slice(0, 5)));
if (OUT) writeFileSync(OUT, JSON.stringify({ mode, plans, statuses, others }, null, 1));
