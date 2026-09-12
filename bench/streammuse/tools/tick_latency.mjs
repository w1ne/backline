// Plays the hummed A-minor melody from bench/voice/synth.ts into the AMT service the way the
// browser does (start -> notes at their wall-clock onsets -> a cue every half bar) and reports
// the cue-to-plan latency per commit through the relay. Node 20, `ws` from node_modules.
//
//   node bench/streammuse/tools/tick_latency.mjs wss://backline-relay.shylenkoa.workers.dev/amt [bars] [out.json] [melody|arpeggio]
//
// `arpeggio` plays the Am F C G Am Dm Em Am progression (root-third-fifth-third per bar, from
// bench/voice/synth.ts) and scores the plan's `chord` in force at each bar start against it.
import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';

const URL = process.argv[2] ?? 'wss://backline-relay.shylenkoa.workers.dev/amt';
const BARS = Number(process.argv[3] ?? 16);
const OUT = process.argv[4];
const CLIP = process.argv[5] ?? 'melody';
const BPM = 90;
const BEAT_MS = 60000 / BPM;
const COMMIT_BEATS = 2;
const LISTEN_BEATS = 8;

// A_MINOR_MELODY_DEGREES from bench/voice/synth.ts, root A3, one note per beat, 8 bars.
const DEGREES = [0, 2, 3, 5, 7, 5, 3, 2, 0, 3, 7, 5, 3, 2, 0, 0, 2, 3, 5, 7, 9, 7, 5, 3, 2, 0, 3, 2, 0, -2, 0, 0];
// ARPEGGIO_CHORDS from bench/voice/synth.ts: Am F C G Am Dm Em Am, one bar each.
const ARPEGGIO = [[9, 'min'], [5, 'maj'], [0, 'maj'], [7, 'maj'], [9, 'min'], [2, 'min'], [4, 'min'], [9, 'min']];
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const chordName = ([root, q]) => NAMES[root] + (q === 'min' ? 'm' : '');
const melody = [];
const truth = []; // chord name per bar
for (let beat = 0; beat < BARS * 4; beat++) {
  if (CLIP === 'arpeggio') {
    const c = ARPEGGIO[Math.floor(beat / 4) % ARPEGGIO.length];
    const third = c[1] === 'maj' ? 4 : 3;
    const root = 55 + ((((c[0] - 55) % 12) + 12) % 12);
    melody.push({ beat, pitch: root + [0, third, 7, third][beat % 4], dur: 1, vel: 0.7 });
    if (beat % 4 === 0) truth.push(chordName(c));
  } else {
    melody.push({ beat, pitch: 57 + DEGREES[beat % DEGREES.length], dur: 1, vel: 0.7 });
  }
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
console.log(`server ${ready ? 'plans per half bar (tick)' : 'plans per bar (no ready)'}; ${BARS} bars at ${BPM} bpm, clip ${CLIP}`);

const t0 = performance.now();
let i = 0;
const cueBeats = [];
for (let beat = 0; beat < BARS * 4; beat += COMMIT_BEATS) cueBeats.push(beat);
// A note reaches the service DETECT_MS after its onset, as the browser's pitch detector
// reports it (bench_harmony.py replays with the same 125 ms).
const DETECT_MS = 125;
const arrival = n => t0 + n.beat * BEAT_MS + DETECT_MS;
for (const beat of cueBeats) {
  await sleepUntil(t0 + beat * BEAT_MS);
  // Everything detected up to this cue goes out first, as the browser flushes before cueing.
  while (i < melody.length && arrival(melody[i]) <= performance.now()) {
    ws.send(JSON.stringify({ type: 'notes', notes: [melody[i]] })); i++;
  }
  if (mode === 'tick') {
    pending = { beat, sentAt: performance.now() };
    ws.send(JSON.stringify({ type: 'tick', beat }));
  } else if (beat % 4 === 0) {
    pending = { beat, sentAt: performance.now() };
    ws.send(JSON.stringify({ type: 'bar', bar: beat / 4 }));
  }
  // Notes detected inside this half bar, at their arrival times.
  while (i < melody.length && arrival(melody[i]) < t0 + (beat + COMMIT_BEATS) * BEAT_MS) {
    await sleepUntil(arrival(melody[i]));
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
console.log(`chord per plan:  ${plans.map(p => p.chord ?? '-').join(' ')}`);
const sections = [...new Set(plans.map(p => p.section ?? '-'))];
console.log(`sections seen:   ${sections.join(' -> ')}`);
// Chord in force at each bar start: the latest plan whose chordFrom <= bar start (as
// bench/voice/output.ts); before the first plan the client plays the chord it `set` (Am).
const chordAt = t => {
  let c = 'Am';
  for (const p of plans) if (typeof p.chord === 'string' && p.chordFrom <= t + 0.01) c = p.chord;
  return c;
};
const atStart = [];
for (let bar = 0; bar < BARS; bar++) atStart.push(chordAt(bar * 4));
console.log(`chord at bar start: ${atStart.join(' ')}`);
if (truth.length) {
  const hits = atStart.filter((c, i) => c === truth[i]).length;
  console.log(`truth:              ${truth.join(' ')}`);
  console.log(`bar-start accuracy: ${hits}/${BARS} = ${(100 * hits / BARS).toFixed(0)}%`);
}
if (others.length) console.log('other messages:', JSON.stringify(others.slice(0, 5)));
if (OUT) writeFileSync(OUT, JSON.stringify({ mode, plans, statuses, others }, null, 1));
