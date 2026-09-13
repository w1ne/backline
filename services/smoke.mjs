// One-command live smoke test for the AMT service and relay: run after every pod deploy, or as
// a watchdog check. Checks relay /health, then runs the arpeggio and hummed-melody clips through
// the relay's AMT websocket (reusing bench/streammuse/tools/tick_latency.mjs's runClip) and
// asserts on latency/quality thresholds, then a mid-session tempo change via `set {bpm}` that
// has to keep the socket open. Prints a compact table; exits non-zero on any failure,
// with the failing line printed first.
//
//   npm run smoke:live
//   node services/smoke.mjs [relayBase]
//
// relayBase defaults to https://backline-relay.shylenkoa.workers.dev (health at /health, AMT ws
// at /amt). Total runtime target: well under 90 s (two 8-bar clips at 90 bpm ~= 21s each, the
// tempo-change run ~= 20s).
import WebSocket from 'ws';
import { runClip } from '../bench/streammuse/tools/tick_latency.mjs';

const RELAY_BASE = process.argv[2] ?? 'https://backline-relay.shylenkoa.workers.dev';
const HEALTH_URL = `${RELAY_BASE}/health`;
const WS_URL = RELAY_BASE.replace(/^http/, 'ws') + '/amt';
const BARS = 8;
const LOOKAHEAD = 2;

const CUE_MEAN_MAX_MS = 400;
const CUE_P95_MAX_MS = 600;
const CHORD_ACCURACY_MIN = 0.4;

const failures = [];
const rows = [];
/** Set when the AMT pod answers but its model is still loading; exits 2 rather than 1. */
let notReady = false;

function check(label, ok, detail) {
  rows.push({ label, ok, detail });
  if (!ok) failures.push(`${label}: ${detail}`);
}

async function checkHealth() {
  let body;
  try {
    const res = await fetch(HEALTH_URL);
    body = await res.json();
  } catch (err) {
    check('relay health', false, `fetch failed: ${err.message}`);
    return;
  }
  check('relay health', body.relay === 'ok', `relay=${body.relay}`);
  check('amt health', body.amt === true, `amt=${body.amt}${body.amtState ? ` (${body.amtState})` : ''}`);
  check('acestep health', body.acestep === true, `acestep=${body.acestep}${body.acestepState ? ` (${body.acestepState})` : ''}`);
  // A 503 from the pod (relayed as amtState "loading") is the model still loading after a
  // restart: not ready, but not broken. Reported separately so a caller can wait instead of alarm.
  if (body.amt !== true && body.amtState === 'loading') notReady = true;
}

async function checkClip(clip) {
  const r = await runClip({ url: WS_URL, bars: BARS, clip, lookaheadBeats: LOOKAHEAD });

  // Policy (architecture review, decision 1): a single empty window is a rest; two in a row
  // are filled by the service. So the smoke fails on consecutive empties, not on one.
  let consecutiveEmpty = 0, maxConsecutiveEmpty = 0;
  for (const p of r.modelPlans) {
    consecutiveEmpty = p.notes?.length ? 0 : consecutiveEmpty + 1;
    maxConsecutiveEmpty = Math.max(maxConsecutiveEmpty, consecutiveEmpty);
  }
  check(`${clip}: no two consecutive empty plans past listen window`, maxConsecutiveEmpty < 2,
    `${r.emptyModel.length} empty of ${r.modelPlans.length} model plans, longest run ${maxConsecutiveEmpty}`);

  const mean = r.cueToPlanModel.mean;
  const p95 = r.cueToPlanModel.p95;
  check(`${clip}: cue->plan mean <= ${CUE_MEAN_MAX_MS}ms`, Number.isFinite(mean) && mean <= CUE_MEAN_MAX_MS,
    `mean=${mean}ms`);
  check(`${clip}: cue->plan p95 <= ${CUE_P95_MAX_MS}ms`, Number.isFinite(p95) && p95 <= CUE_P95_MAX_MS,
    `p95=${p95}ms`);

  if (clip === 'arpeggio') {
    check(`${clip}: chord-at-bar-start accuracy >= ${CHORD_ACCURACY_MIN * 100}%`,
      r.accuracy !== undefined && r.accuracy >= CHORD_ACCURACY_MIN,
      `accuracy=${((r.accuracy ?? 0) * 100).toFixed(0)}%`);
  }

  check(`${clip}: sections include groove`, r.sections.includes('groove'),
    `sections=${r.sections.join(',')}`);

  return r;
}

// A mid-session tempo change through `set {bpm}` (90 -> 100 at bar 4 of 8): the socket has to
// stay open and plans have to keep coming on the new beat grid. This used to be a reconnect,
// an empty session and the eight-beat listen gate again, every time the singer drifted.
async function checkTempoChange() {
  const BPM_A = 90, BPM_B = 100, BARS = 8, CHANGE_BEAT = 16, LISTEN = 8;
  const ws = new WebSocket(WS_URL, { headers: { Origin: 'https://www.duetai.art' } });
  const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));
  let ready = null;
  const plans = [];
  const errors = [];
  let closed = null;
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'ready') ready = m;
    else if (m.type === 'plan') plans.push({ ...m, at: Date.now() });
    else if (m.type === 'error') errors.push(m.message);
  });
  ws.on('close', (code, reason) => { closed = { code, reason: reason.toString() }; });
  try {
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  } catch (err) {
    check('tempo-change: socket opens', false, err.message);
    return;
  }
  ws.send(JSON.stringify({ type: 'start', bpm: BPM_A, key: 'A minor', genre: 'lofi',
    lookaheadBeats: LOOKAHEAD, commitBeats: 2, listenBeats: LISTEN }));
  ws.send(JSON.stringify({ type: 'set', bpm: BPM_A, key: 'A minor', creativity: 0.3, amount: 1,
    enabledRoles: { keys: true, bass: true, lead: false } }));
  await sleep(500);
  check('tempo-change: server takes set {bpm}', ready?.setBpm === true, `ready=${JSON.stringify(ready)}`);

  // One A-minor scale note per beat, absolute beats; wall-clock per beat follows the tempo.
  const scale = [57, 59, 60, 62, 64, 65, 67, 69];
  let bpm = BPM_A;
  let changedAt = null;
  let t = Date.now();
  for (let beat = 0; beat < BARS * 4; beat += 2) {
    if (beat === CHANGE_BEAT) {
      bpm = BPM_B;
      ws.send(JSON.stringify({ type: 'set', bpm, key: 'A minor', creativity: 0.3, amount: 1,
        enabledRoles: { keys: true, bass: true, lead: false } }));
      changedAt = Date.now();
    }
    ws.send(JSON.stringify({ type: 'notes', notes: [
      { beat, pitch: scale[beat % scale.length], dur: 1, vel: 0.7 },
      { beat: beat + 1, pitch: scale[(beat + 1) % scale.length], dur: 1, vel: 0.7 }] }));
    ws.send(JSON.stringify({ type: 'tick', beat }));
    t += 2 * 60000 / bpm;
    await sleep(t - Date.now());
  }
  await sleep(2000);
  const after = plans.filter(p => changedAt !== null && p.at > changedAt);
  const afterWithNotes = after.filter(p => p.notes?.length);
  check('tempo-change: socket stays open across set {bpm}', closed === null && errors.length === 0,
    closed ? `closed ${closed.code} ${closed.reason}` : errors.length ? `error: ${errors[0]}` : 'open');
  check('tempo-change: plans keep coming after the change', after.length >= 6 && afterWithNotes.length >= 4,
    `${after.length} plans after the change, ${afterWithNotes.length} with notes`);
  ws.close();
}

async function main() {
  const t0 = Date.now();
  await checkHealth();
  // Only bother running the clips if the pod is actually up -- an unreachable service would
  // otherwise hang each clip until its own timeouts, blowing the 90s budget.
  const healthOk = rows.filter(r => r.label.endsWith('health')).every(r => r.ok);
  if (healthOk) {
    await checkClip('arpeggio');
    await checkClip('melody');
    await checkTempoChange();
  } else {
    check('clips skipped', false, 'relay/amt/acestep health failed, skipping clip runs');
  }
  const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);

  console.log('');
  console.log(`backline live smoke (${elapsedS}s)`);
  console.log('-'.repeat(60));
  for (const row of rows) {
    console.log(`[${row.ok ? 'PASS' : 'FAIL'}] ${row.label.padEnd(48)} ${row.detail}`);
  }
  console.log('-'.repeat(60));

  if (failures.length) {
    console.error('');
    if (notReady) {
      console.error('SMOKE NOT READY: amt is still loading its model (503); wait and re-run');
      process.exit(2);
    }
    console.error(`SMOKE FAILED (${failures.length} failure${failures.length > 1 ? 's' : ''}):`);
    console.error(`  ${failures[0]}`);
    for (const f of failures.slice(1)) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`\nSMOKE OK (${elapsedS}s)`);
}

main().catch(err => { console.error('smoke crashed:', err); process.exit(1); });
