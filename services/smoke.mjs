// One-command live smoke test for the AMT service and relay: run after every pod deploy, or as
// a watchdog check. Checks relay /health, then runs the arpeggio and hummed-melody clips through
// the relay's AMT websocket (reusing bench/streammuse/tools/tick_latency.mjs's runClip) and
// asserts on latency/quality thresholds. Prints a compact table; exits non-zero on any failure,
// with the failing line printed first.
//
//   npm run smoke:live
//   node services/smoke.mjs [relayBase]
//
// relayBase defaults to https://backline-relay.shylenkoa.workers.dev (health at /health, AMT ws
// at /amt). Total runtime target: well under 90 s (two 8-bar clips at 90 bpm ~= 21s each).
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

  check(`${clip}: no empty plans past listen window`, r.emptyModel.length === 0,
    `${r.emptyModel.length} empty of ${r.modelPlans.length} model plans`);

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

async function main() {
  const t0 = Date.now();
  await checkHealth();
  // Only bother running the clips if the pod is actually up -- an unreachable service would
  // otherwise hang each clip until its own timeouts, blowing the 90s budget.
  const healthOk = rows.filter(r => r.label.endsWith('health')).every(r => r.ok);
  if (healthOk) {
    await checkClip('arpeggio');
    await checkClip('melody');
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
