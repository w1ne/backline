/**
 * CI regression gate over the bench suite. Imports the synthetic voice, harmony and patterns
 * benches (and, when the MIR-1K dataset is available, the real-voice subset bench) and checks
 * their metrics against the floors/ceilings recorded in bench/thresholds.json. Prints a table
 * of every check and exits 1 if any metric regressed past its threshold.
 *
 * Run with: npm run bench:gate
 */
import THRESHOLDS from './thresholds.json';

// Each bench run.ts guards its own CLI `main()` (which prints/writes RESULTS.md, and for
// realvoice exits the process when the dataset is missing) behind `process.env.BENCH_GATE`.
// Static imports are hoisted and evaluated before this module's body runs, so the env var has
// to be set first and the bench modules loaded with a dynamic import.
process.env.BENCH_GATE = '1';
const { run: runVoice } = await import('./voice/run');
const { run: runHarmony } = await import('./harmony/run');
const { run: runPatterns } = await import('./patterns/run');
const { runGate: runRealvoice } = await import('./realvoice/run');

interface Check {
  group: string;
  name: string;
  value: number;
  op: '>=' | '<=';
  threshold: number;
  pass: boolean;
  detail?: string;
}

function check(group: string, name: string, value: number, op: '>=' | '<=', threshold: number, detail?: string): Check {
  const pass = Number.isNaN(value) ? false : (op === '>=' ? value >= threshold : value <= threshold);
  return { group, name, value, op, threshold, pass, detail };
}

function gateVoice(checks: Check[]) {
  const { rows } = runVoice();
  const floors: Record<string, number> = THRESHOLDS.voice.melodyF1Floor;
  for (const [clip, floor] of Object.entries(floors)) {
    const row = rows.find(r => r.clip === clip && r.profile === 'VOICE');
    checks.push(check('voice', `${clip} VOICE note F1`, row ? row.f1 : NaN, '>=', floor));
  }
}

function gateHarmony(checks: Check[]) {
  const { rows } = runHarmony();
  const maxLeap = Math.max(...rows.map(r => r.maxLeap));
  checks.push(check('harmony', 'max single-voice leap (semitones)', maxLeap, '<=', THRESHOLDS.harmony.maxSingleVoiceLeap));
}

function gatePatterns(checks: Check[]) {
  const { rows } = runPatterns();
  const minSigs: Record<string, number> = THRESHOLDS.patterns.minSignaturesAtCreativity;
  for (const [creativityStr, floor] of Object.entries(minSigs)) {
    const creativity = Number(creativityStr);
    for (const r of rows.filter(r => r.creativity === creativity)) {
      checks.push(check('patterns', `${r.genre}/${r.instrument} @ creativity ${creativity}: distinct signatures`, r.signatures, '>=', floor));
    }
  }
}

function gateRealvoice(checks: Check[]): string[] {
  const warnings: string[] = [];
  const { subsetClips, songs, meanPitchAccFloor, noteF1Floor, keyLockedMinCount, keysDissonantCeiling } = THRESHOLDS.realvoice;
  const result = runRealvoice(subsetClips, songs);
  if (!result) {
    warnings.push('MIR-1K dataset not found under bench/realvoice/data/MIR-1K/ — skipping real-voice gate (see bench/realvoice/fetch.sh).');
    return warnings;
  }
  const { rows, fits } = result;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  checks.push(check('realvoice', 'mean pitch accuracy % (subset)', mean(rows.map(r => r.pitchAcc)), '>=', meanPitchAccFloor));
  checks.push(check('realvoice', 'mean note F1 (subset)', mean(rows.map(r => r.f1)), '>=', noteF1Floor));
  const keyLocked = rows.filter(r => r.keyLockS !== null).length;
  checks.push(check('realvoice', 'clips with a key lock (subset)', keyLocked, '>=', keyLockedMinCount));
  const ceilings: Record<string, number> = keysDissonantCeiling;
  for (const f of fits) {
    const ceiling = ceilings[f.song];
    if (ceiling === undefined) continue;
    checks.push(check('realvoice', `${f.song}: dissonant half bars, keys % (following)`, 100 * f.follow.dissonantKeys, '<=', ceiling));
  }
  return warnings;
}

function main() {
  const checks: Check[] = [];
  const warnings: string[] = [];

  gateVoice(checks);
  gateHarmony(checks);
  gatePatterns(checks);
  warnings.push(...gateRealvoice(checks));

  const failed = checks.filter(c => !c.pass);

  console.log('# Bench gate\n');
  console.log('| group | metric | value | op | threshold | result |');
  console.log('|---|---|---|---|---|---|');
  for (const c of checks) {
    console.log(`| ${c.group} | ${c.name} | ${c.value.toFixed(3)} | ${c.op} | ${c.threshold} | ${c.pass ? 'pass' : 'FAIL'} |`);
  }
  for (const w of warnings) console.warn(`\nWARNING: ${w}`);

  if (failed.length) {
    console.error(`\n${failed.length}/${checks.length} bench gate checks failed:\n`);
    for (const c of failed) {
      const gap = c.op === '>=' ? c.threshold - c.value : c.value - c.threshold;
      console.error(`  - [${c.group}] ${c.name}: got ${c.value.toFixed(3)}, needed ${c.op} ${c.threshold} (off by ${gap.toFixed(3)})`);
    }
    process.exit(1);
  }

  console.log(`\nAll ${checks.length} bench gate checks passed.`);
}

main();
