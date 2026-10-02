import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { preflight } from '../lib/harness.mjs';
import { assertNoReviewDataFolder, assertNotesUnchanged, captureNoteBaseline, loadNoteBaseline } from '../lib/note-baseline.mjs';
import { atomicWrite, ensureDirectory, projectRoot } from '../lib/paths.mjs';
import { assertDeckPicker, assertNativeTarget, assertStartup, modalObservation, nativeTargetExpression,
  obsidianVersionFromTitle } from './assert-smoke.mjs';

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
    ...assertNotesUnchanged(root, baseline), reviewData: assertNoReviewDataFolder(root, baseline) }];
  const endpoint = cdpEndpoint();
  report.endpoint = endpoint.href;
  const targets = await fetch(new URL('/json/list', endpoint)).then((response) => {
    if (!response.ok) throw new Error(`CDP target list returned ${response.status}.`); return response.json();
  });
  const candidates = [];
  for (const target of targets.filter((item) => item.type === 'page' && typeof item.webSocketDebuggerUrl === 'string')) {
    const probe = new CDP(target.webSocketDebuggerUrl); await probe.connect();
    const observed = await probe.value(nativeTargetExpression)
      .catch(() => null);
    probe.close();
    const version = obsidianVersionFromTitle(target.title ?? '');
    const state = observed ? { ...observed, version } : null;
    if (state?.vault === expected.vault && state.url === 'app://obsidian.md/index.html') {
      assertNativeTarget(state, expected.vault); candidates.push({ target, state });
    }
  }
  if (candidates.length !== 1) throw new Error(`Expected one native dedicated-vault page; found ${candidates.length}.`);
  report.obsidian = candidates[0].state;
  client = new CDP(candidates[0].target.webSocketDebuggerUrl); await client.connect();
  const ribbonSelector = '.side-dock-ribbon .kioku-ribbon[aria-label="フラッシュカード"]';
  const pickerSelector = '.kioku-deck-picker-modal';
  const loadedSelector = `${pickerSelector} .kioku-deck-list, ${pickerSelector} .kioku-deck-problem`;
  const count = (selector) => `JSON.stringify(document.querySelectorAll(${JSON.stringify(selector)}).length)`;
  const click = (selector) => client.value(`JSON.stringify((document.querySelector(${JSON.stringify(selector)})?.click(),true))`);
  const unchanged = (phase) => {
    report.noteChecks.push({ phase, ...assertNotesUnchanged(root, baseline), reviewData: assertNoReviewDataFolder(root, baseline) });
  };
  const ribbonCount = await client.value(count(ribbonSelector));
  if (ribbonCount !== 1) throw new Error('Enabled native Kioku ribbon absent or duplicated.');
  await waitFor(client, count(pickerSelector), 0);
  await waitFor(client, count('.kioku-startup-modal'), 0);
  for (let run = 1; run <= 2; run += 1) {
    await click(ribbonSelector);
    await waitFor(client, count(pickerSelector), 1);
    // The picker scans notes read-only and reads the data folder before listing decks.
    await waitFor(client, count(loadedSelector), 1);
    const observed = await client.value(modalObservation(pickerSelector, null));
    assertDeckPicker(observed, expected);
    const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    atomicWrite(root, join(output, `deck-picker-${run}.png`), Buffer.from(shot.data, 'base64'));
    await click('.kioku-deck-picker-close');
    await waitFor(client, count(pickerSelector), 0);
    report.steps.push({ operation: `ribbon → deck picker → close (${run})`, status: 'PASS', observed });
    unchanged(`after deck picker open/close ${run}`);
  }
  await click(ribbonSelector);
  await waitFor(client, count(pickerSelector), 1);
  await waitFor(client, count(loadedSelector), 1);
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitFor(client, count(pickerSelector), 0);
  report.steps.push({ operation: 'ribbon → deck picker → Escape', status: 'PASS' });
  unchanged('after deck picker Escape');
  // Since M2 the status modal (version / build ID) is reached through its command.
  await client.value(`JSON.stringify((window.app.commands.executeCommandById('kioku:open-startup'),true))`);
  await waitFor(client, count('.kioku-startup-modal'), 1);
  const status = await client.value(modalObservation('.kioku-startup-modal', '.kioku-build-identity'));
  assertStartup(status, expected);
  const statusShot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  atomicWrite(root, join(output, 'status-modal.png'), Buffer.from(statusShot.data, 'base64'));
  await click('.kioku-startup-close');
  await waitFor(client, count('.kioku-startup-modal'), 0);
  report.steps.push({ operation: 'command → status modal → close', status: 'PASS', observed: status });
  unchanged('after status modal open/close');
  if (client.errors.length) throw new Error(`Obsidian page errors: ${client.errors.join('; ')}`);
  unchanged('before PASS');
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
