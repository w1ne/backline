/** Real-browser release gate. See services/VOICE_SMOKE.md. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {mkdtemp, mkdir, readFile, writeFile, rm, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, join, extname, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {WebSocket, WebSocketServer} from 'ws';
import {heldVoiceWav, attachAmtFixture} from './fixtures/voice-smoke.mjs';
import {fetchAmtSamples} from './fetch-amt-samples.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fault = process.env.VOICE_SMOKE_FAULT;
assert(!fault || ['samples', 'held'].includes(fault), 'Unknown VOICE_SMOKE_FAULT');
const work = await mkdtemp(join(tmpdir(), 'duet-voice-smoke-'));
const site = join(work, 'site');
const artifacts = resolve(process.env.VOICE_SMOKE_ARTIFACTS || join(root, 'test-results/voice-smoke'));
const evidence = {starts: [], notes: [], playablePlans: 0, sampleRequests: [], browserErrors: [], externalRequests: []};
const children = [];
const clients = new Set();
let cdp;
let page;
let browserLog = '';
let failed = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mime = {'.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.wav': 'audio/wav'};
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://fixture').pathname;
  if (pathname === '/health') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({amt: {ok: true}, lyria: {ok: false}, acestep: {ok: false}}));
    return;
  }
  if (pathname.startsWith('/samples/amt/')) {
    evidence.sampleRequests.push(pathname);
    if (fault === 'samples') { res.writeHead(503); res.end('Intentional missing-sample regression'); return; }
  }
  const file = resolve(site, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname)));
  if (!file.startsWith(site + sep)) { res.writeHead(403); res.end(); return; }
  try {
    const data = await readFile(file);
    res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream');
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
const wss = new WebSocketServer({server, path: '/amt'});
wss.on('connection', socket => {
  clients.add(socket); socket.on('close', () => clients.delete(socket));
  attachAmtFixture(socket, evidence, fault);
});

async function run(cmd, args, env = process.env) {
  const child = spawn(cmd, args, {cwd: root, env, stdio: 'inherit'});
  children.push(child);
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, `${cmd} ${args.join(' ')} failed`);
}

async function chromePath() {
  const candidates = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/usr/bin/chromium-browser', '/opt/google/chrome/chrome'].filter(Boolean);
  for (const path of candidates) { try { await access(path); return path; } catch {} }
  throw new Error('Chrome not found. Set CHROME_BIN to a Chrome/Chromium executable.');
}

async function connectCDP(url) {
  const ws = new WebSocket(url);
  await once(ws, 'open');
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.on('message', data => {
    const msg = JSON.parse(data.toString());
    if (msg.id) {
      const task = pending.get(msg.id);
      if (!task) return;
      pending.delete(msg.id); clearTimeout(task.timer);
      if (msg.error) task.reject(new Error(JSON.stringify(msg.error))); else task.resolve(msg.result);
    } else for (const listener of listeners) listener(msg);
  });
  return {close: () => ws.close(), on: listener => listeners.push(listener),
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const request = ++id;
        const timer = setTimeout(() => { pending.delete(request); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
        pending.set(request, {resolve, reject, timer});
        ws.send(JSON.stringify({id: request, method, params}));
      });
    }};
}

const instrumentation = `(() => {
  window.voiceSmoke = {peaks: []};
  navigator.requestMIDIAccess = async () => ({inputs: new Map(), outputs: new Map(), addEventListener(){}, removeEventListener(){}});
  const original = AudioNode.prototype.connect;
  const tapped = new WeakSet();
  AudioNode.prototype.connect = function(target, ...args) {
    const result = original.call(this, target, ...args);
    if (target instanceof AudioDestinationNode && !tapped.has(this.context)) {
      tapped.add(this.context);
      const analyser = this.context.createAnalyser(); analyser.fftSize = 2048;
      original.call(this, analyser);
      const data = new Float32Array(analyser.fftSize);
      setInterval(() => {
        analyser.getFloatTimeDomainData(data);
        let peak = 0; for (const n of data) peak = Math.max(peak, Math.abs(n));
        const state = window.__backline?.store.state;
        // Count-in clicks must never satisfy sampled-accompaniment success.
        voiceSmoke.peaks.push({peak, time: this.context.currentTime,
          eligible: !!state && state.countInBeat == null && state.bar >= 2});
      }, 50);
    }
    return result;
  };
})();`;

try {
  await mkdir(artifacts, {recursive: true});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const manifest = JSON.parse(await readFile(new URL('./amt-samples-manifest.json', import.meta.url), 'utf8'));
  // The fixture plays violin only. Reuse production's integrity-checked preparation
  // without making this bounded gate download ten instruments it never exercises.
  await fetchAmtSamples({manifest: {...manifest, files: {'violin-ogg.js': manifest.files['violin-ogg.js']}}});
  await run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--base=/', '--emptyOutDir', '--outDir', site],
    {...process.env, VITE_RELAY_URL: origin});
  const wav = join(work, 'held-voice.wav'); await writeFile(wav, heldVoiceWav());
  const profile = join(work, 'chrome'); await mkdir(profile);
  const chrome = spawn(await chromePath(), ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`,
    '--disable-background-networking', 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
  children.push(chrome); chrome.stderr.on('data', data => { browserLog += data; });
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch {}
    if (chrome.exitCode !== null) throw new Error(`Chrome exited: ${browserLog}`);
    await sleep(100);
  }
  assert(port, 'Chrome did not expose its debugging port');
  page = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {method: 'PUT'})).json();
  cdp = await connectCDP(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  // Never contact a production relay, paid inference service, or sample CDN.
  await cdp.send('Fetch.enable', {patterns: [{urlPattern: '*', requestStage: 'Request'}]});
  cdp.on(msg => {
    if (msg.method === 'Runtime.exceptionThrown') evidence.browserErrors.push(msg.params.exceptionDetails.text);
    if (msg.method === 'Fetch.requestPaused') {
      const {requestId, request} = msg.params;
      const local = request.url.startsWith(origin + '/') || /^(data:|blob:)/.test(request.url);
      // Cosmetic web fonts use fallback system fonts in this offline fixture.
      if (!local && !/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(request.url)) evidence.externalRequests.push(request.url);
      void cdp.send(local ? 'Fetch.continueRequest' : 'Fetch.failRequest',
        local ? {requestId} : {requestId, errorReason: 'BlockedByClient'}).catch(() => {});
    }
  });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {source: instrumentation});
  await cdp.send('Page.navigate', {url: `${origin}/?debug=1`});
  const evaluate = async expression => {
    const result = await cdp.send('Runtime.evaluate', {expression, returnByValue: true, userGesture: true});
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  for (let i = 0; i < 100; i++) {
    if (await evaluate('!!window.__backline && !!document.querySelector("#enable-audio")')) break;
    await sleep(100);
  }
  const click = async selector => {
    const point = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      element.scrollIntoView({block:'center'});
      const rect = element.getBoundingClientRect();
      return {x:rect.x + rect.width/2,y:rect.y + rect.height/2};
    })()`);
    await cdp.send('Input.dispatchMouseEvent', {type:'mousePressed', ...point, button:'left', clickCount:1});
    await cdp.send('Input.dispatchMouseEvent', {type:'mouseReleased', ...point, button:'left', clickCount:1});
  };
  if (await evaluate('__backline.store.state.enabled.drums')) await click('[data-inst="drums"]');
  await click('#enable-audio');
  // Twenty real seconds covers two-bar count-in, AMT listening and the old false ending.
  const started = Date.now();
  while (Date.now() - started < 20000) await sleep(500);
  evidence.result = await evaluate(`(() => {
    const s = __backline.store.state;
    return {locked:s.locked, engine:s.engine, countIn:s.countIn, manualBpm:s.bpmOverride,
      bpm:s.input.bpm, silenceBeats:s.input.dynamics.silenceBeats, bar:s.bar,
      enabled:s.enabled, voiceMonitor:s.voiceMonitor, droneVolume:s.droneVolume, noiseVolume:s.noiseVolume,
      scheduled:__backline.scheduled, peaks:voiceSmoke.peaks, error:s.error};
  })()`);
  const result = evidence.result;
  assert.equal(result.engine, 'amt', 'App silently fell back from AMT');
  assert.equal(result.countIn, true, 'Smoke must exercise the default count-in');
  assert(result.locked && result.bar >= 4, 'Voice alone did not start and maintain the transport');
  assert.equal(result.silenceBeats, 0, 'Sustained voice was incorrectly treated as silence');
  assert(evidence.starts.length === 1 && evidence.starts[0].bpm === 100, 'Expected one automatic 100 BPM session');
  assert(evidence.notes.some(n => n.held && n.beat < .5), 'The note held through startup was lost');
  assert(new Set(evidence.notes.map(n => n.id)).size <= 3, 'Fixture must remain one sustained phrase, not repeated new onsets');
  assert(evidence.playablePlans >= 2, 'No AMT plans were produced from held microphone input');
  assert(!result.enabled.drums && !result.voiceMonitor && !result.droneVolume && !result.noiseVolume, 'Backing audio was not isolated');
  assert(evidence.sampleRequests.length, 'No shipped AMT samples were requested');
  assert(result.scheduled.some(n => n.inst === 'keys'), 'No real sampled notes reached scheduling');
  assert(result.peaks.filter(n => n.eligible && n.peak > .001).length >= 3,
    'No audible sampled accompaniment after count-in (master audio stayed silent)');
  assert.equal(evidence.browserErrors.length, 0, 'Unhandled browser errors');
  assert(!evidence.externalRequests.some(url => /\/violin-ogg\.js(?:\?|$)/.test(url)),
    'AMT attempted to load its instrument from an external CDN');
  console.log(`Voice smoke passed: ${evidence.notes.length} captured notes, ${evidence.playablePlans} plans, audible GM output.`);
} catch (error) {
  failed = true;
  evidence.failure = error.stack || String(error);
  console.error(evidence.failure);
} finally {
  if (cdp) {
    try { const shot = await cdp.send('Page.captureScreenshot'); await writeFile(join(artifacts, 'page.png'), Buffer.from(shot.data, 'base64')); } catch {}
    try { await cdp.send('Page.close'); } catch {}
    cdp.close();
  }
  await writeFile(join(artifacts, 'evidence.json'), JSON.stringify(evidence, null, 2));
  await writeFile(join(artifacts, 'chrome.log'), browserLog);
  for (const socket of clients) socket.terminate();
  wss.close(); server.close();
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  await rm(work, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
  if (failed) process.exitCode = 1;
}
