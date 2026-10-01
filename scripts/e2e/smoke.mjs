import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { preflight } from '../lib/harness.mjs';
import { assertNotesUnchanged, captureNoteBaseline, loadNoteBaseline } from '../lib/note-baseline.mjs';
import { atomicWrite, ensureDirectory, projectRoot } from '../lib/paths.mjs';
import { assertNativeTarget, assertStartup } from './assert-smoke.mjs';

class CDP {
  constructor(url) { this.url = url; this.nextId = 0; this.pending = new Map(); this.errors = []; }
  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') this.errors.push(message.params.exceptionDetails.text);
      if (!message.id) return;
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
    });
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', () => reject(new Error('CDP WebSocket connection failed.')), { once: true });
    });
    await this.send('Runtime.enable'); await this.send('Page.enable');
  }
  send(method, params = {}) {
    const id = this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async value(expression) {
    const response = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    return JSON.parse(response.result.value);
  }
  close() { this.socket.close(); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(client, expression, wanted) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (await client.value(expression) === wanted) return; await sleep(50); }
  throw new Error(`Timed out waiting for native UI state: ${wanted}.`);
}

function cdpEndpoint() {
  const endpoint = new URL(process.env.KIOKU_CDP_URL ?? 'http://127.0.0.1:9222');
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
      || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new Error('CDP must be a loopback HTTP endpoint with no credentials / path / query.');
  }
  return endpoint;
}

async function captureBeforeStartup() {
  const root = projectRoot(); const expected = preflight(root); const endpoint = cdpEndpoint();
  if (process.env.KIOKU_CONFIRM_VAULT_CLOSED !== '1') {
    throw new Error('Close Obsidian first, then set KIOKU_CONFIRM_VAULT_CLOSED=1 for baseline capture.');
  }
  // A listening desktop CDP page would make a newly captured baseline too late for onload.
  let response;
  try { response = await fetch(new URL('/json/list', endpoint), { signal: AbortSignal.timeout(2000) }); }
  catch (error) { if (error.cause?.code !== 'ECONNREFUSED') throw error; }
  if (response) {
    if (!response.ok) throw new Error(`CDP target list returned ${response.status}.`);
    const targets = await response.json();
    if (!Array.isArray(targets) || targets.length) throw new Error('Close Obsidian before baseline capture; CDP targets already exist.');
  }
  const baseline = captureNoteBaseline(root, expected, true);
  console.info(JSON.stringify({ status: 'CAPTURED', kind: 'filesystem-baseline-not-ui-test', baseline,
    next: `Start Obsidian, then KIOKU_BASELINE_ID=${baseline.id} npm run harness:e2e:smoke. Reuse this ID after restart.` }, null, 2));
}

async function runSmoke() {
let client;
let output;
let root;
const report = { status: 'FAIL', kind: 'native-obsidian-cdp', startedAt: new Date().toISOString(), steps: [],
  restart: 'NOT TESTED: run again after an independently performed Obsidian desktop restart.' };
try {
  if (process.argv.length !== 2) throw new Error('Usage: npm run harness:e2e:smoke (configure KIOKU_CDP_URL).');
  root = projectRoot();
  output = join(root, 'artifacts', 'e2e-smoke', `${Date.now()}-${randomUUID()}`);
  ensureDirectory(root, output);
  const expected = preflight(root); report.preflight = expected;
  const baseline = loadNoteBaseline(root, expected, process.env.KIOKU_BASELINE_ID);
  report.noteBaseline = { id: baseline.id, capturedAt: baseline.capturedAt, stage: baseline.stage, vaultClosed: baseline.vaultClosed };
  report.noteChecks = [{ phase: 'after startup, before UI operations (also after manual restart)',
    ...assertNotesUnchanged(root, baseline) }];
  const endpoint = cdpEndpoint();
  report.endpoint = endpoint.href;
  const targets = await fetch(new URL('/json/list', endpoint)).then((response) => {
    if (!response.ok) throw new Error(`CDP target list returned ${response.status}.`); return response.json();
  });
  const candidates = [];
  for (const target of targets.filter((item) => item.type === 'page' && typeof item.webSocketDebuggerUrl === 'string')) {
    const probe = new CDP(target.webSocketDebuggerUrl); await probe.connect();
    const state = await probe.value(`JSON.stringify({version:window.require?.('obsidian')?.apiVersion??'',vault:window.app?.vault?.adapter?.getBasePath?.()??''})`)
      .catch(() => null);
    probe.close();
    if (state?.vault === expected.vault) { assertNativeTarget(state, expected.vault); candidates.push({ target, state }); }
  }
  if (candidates.length !== 1) throw new Error(`Expected one native dedicated-vault page; found ${candidates.length}.`);
  report.obsidian = candidates[0].state;
  client = new CDP(candidates[0].target.webSocketDebuggerUrl); await client.connect();
  const ribbonSelector = '.side-dock-ribbon .kioku-ribbon[aria-label="フラッシュカード"]';
  const ribbonCount = await client.value(`JSON.stringify(document.querySelectorAll(${JSON.stringify(ribbonSelector)}).length)`);
  if (ribbonCount !== 1) throw new Error('Enabled native Kioku ribbon absent or duplicated.');
  await waitFor(client, `JSON.stringify(document.querySelectorAll('.kioku-startup-modal').length)`, 0);
  for (let run = 1; run <= 2; run += 1) {
    await client.value(`JSON.stringify((document.querySelector(${JSON.stringify(ribbonSelector)})?.click(),true))`);
    await waitFor(client, `JSON.stringify(document.querySelectorAll('.kioku-startup-modal').length)`, 1);
    const observed = await client.value(`JSON.stringify((()=>{const e=document.querySelector('.kioku-startup-modal');const b=e?.querySelector('.kioku-build-identity');const r=e?.getBoundingClientRect();return {count:document.querySelectorAll('.kioku-startup-modal').length,text:e?.textContent??'',buildId:b?.dataset.kiokuBuildId,version:b?.dataset.kiokuVersion,x:r?.x??0,y:r?.y??0,width:r?.width??0,height:r?.height??0,viewportWidth:innerWidth,viewportHeight:innerHeight}})())`);
    assertStartup(observed, expected);
    const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    atomicWrite(root, join(output, `modal-${run}.png`), Buffer.from(shot.data, 'base64'));
    await client.value(`JSON.stringify((document.querySelector('.kioku-startup-close')?.click(),true))`);
    await waitFor(client, `JSON.stringify(document.querySelectorAll('.kioku-startup-modal').length)`, 0);
    report.steps.push({ operation: `ribbon → modal → close (${run})`, status: 'PASS', observed });
    report.noteChecks.push({ phase: `after open/close ${run}`, ...assertNotesUnchanged(root, baseline) });
  }
  await client.value(`JSON.stringify((document.querySelector(${JSON.stringify(ribbonSelector)})?.click(),true))`);
  await waitFor(client, `JSON.stringify(document.querySelectorAll('.kioku-startup-modal').length)`, 1);
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitFor(client, `JSON.stringify(document.querySelectorAll('.kioku-startup-modal').length)`, 0);
  report.steps.push({ operation: 'ribbon → modal → Escape', status: 'PASS' });
  if (client.errors.length) throw new Error(`Obsidian page errors: ${client.errors.join('; ')}`);
  report.noteChecks.push({ phase: 'after Escape, before PASS', ...assertNotesUnchanged(root, baseline) });
  report.status = 'PASS';
} catch (error) {
  report.error = error.message; console.error(`Native smoke failed: ${error.message}`); process.exitCode = 1;
} finally {
  // Disconnect only this CDP WebSocket. Never close or restart the user's Obsidian process.
  if (client) client.close();
  report.finishedAt = new Date().toISOString();
  if (output) atomicWrite(root, join(output, 'record.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.info(JSON.stringify(report, null, 2));
}
}

// Separate pre-launch entry. It never enables, starts, closes or restarts Obsidian.
if (process.argv[2] === 'baseline') {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: npm run harness:e2e:smoke -- baseline');
    await captureBeforeStartup();
  } catch (error) { console.error(error.message); process.exitCode = 1; }
} else await runSmoke();
