// Protocol simulation only: never native Obsidian evidence, and never starts a browser.
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, createFixture } from '../helpers/fixture.mjs';
import { heavyQueueVariables, withoutHeavyQueue } from '../helpers/hermetic-env.mjs';
import { prepareVault } from '../../scripts/lib/harness.mjs';
import { sha256 } from '../../scripts/lib/build.mjs';

const roots = [];
afterEach(() => { while (roots.length) cleanup(roots.pop()); });
function frame(text) {
  const data = Buffer.from(text);
  const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >>> 8, data.length & 255]);
  return Buffer.concat([head, data]);
}
/**
 * `foreignModal`: false, true (open from the start), 'after-first-close' (stacked over the second deck picker) or
 * 'after-status' (appears once the status modal is closed). `uiOperations` counts clicks, commands and key events.
 */
async function simulatedSmoke(root, expected, baselineId, mutateAt, baselineMode = false, foreignModal = false) {
  let modalCount = 0; let closes = 0; let kiokuModal = ''; let statusClosed = false; let uiOperations = 0;
  const sockets = new Set();
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify([
      { type: 'page', title: 'test-vault - Obsidian 1.13.7',
        webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/probe` },
      { type: 'page', title: 'Popout - test-vault - Obsidian 1.13.7',
        webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/popout` },
    ]));
  });
  server.on('upgrade', (req, socket) => {
    const popout = req.url === '/popout';
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffered = Buffer.alloc(0);
    socket.on('data', (part) => {
      buffered = Buffer.concat([buffered, part]);
      while (buffered.length >= 6) {
        const opcode = buffered[0] & 15; let length = buffered[1] & 127; let position = 2;
        if (length === 126) { if (buffered.length < 8) return; length = buffered.readUInt16BE(2); position = 4; }
        if (buffered.length < position + 4 + length) return;
        const mask = buffered.subarray(position, position + 4); position += 4;
        const data = Buffer.from(buffered.subarray(position, position + length)); buffered = buffered.subarray(position + length);
        for (let i = 0; i < data.length; i += 1) data[i] ^= mask[i % 4];
        if (opcode === 8) { socket.end(); continue; }
        const message = JSON.parse(data.toString()); let result = {};
        if (message.method === 'Runtime.evaluate') {
          const expression = message.params.expression; let value;
          if (expression.includes("'.modal-container'")) {
            const foreign = foreignModal === true || (foreignModal === 'after-first-close' && closes >= 1)
              || (foreignModal === 'after-status' && statusClosed);
            value = [...(modalCount ? [{ kioku: true, classes: `modal ${kiokuModal}` }] : []),
              ...(foreign ? [{ kioku: false, classes: 'modal mod-lg mod-trust-folder' }] : [])];
          } else if (expression.includes("require?.('obsidian')")) {
            result = { exceptionDetails: { text: "Cannot find module 'obsidian'" } };
          } else if (expression.includes('versions?.electron')) value = { vault: expected.vault,
            url: popout ? 'about:blank' : 'app://obsidian.md/index.html', processType: 'renderer', electron: '43.3.0' };
          else if (expression.includes('getBoundingClientRect')) {
            value = { count: 1, buildId: expected.buildId, version: expected.version, loaded: true,
              text: expression.includes('kioku-deck-picker-modal') ? 'Kioku — デッキを選んで復習 全デッキ' : 'Kioku デッキ AI は未実装',
              x: 300, y: 200, width: 400, height: 300, viewportWidth: 1000, viewportHeight: 700 };
          } else if (expression.includes('executeCommandById')) {
            uiOperations += 1; modalCount = 1; kiokuModal = 'kioku-startup-modal'; value = true;
          } else if (expression.includes('?.click()')) {
            uiOperations += 1;
            if (expression.includes('-close')) {
              if (kiokuModal === 'kioku-startup-modal') statusClosed = true;
              modalCount = 0; closes += 1;
              if (mutateAt === 'close' && closes === 1) writeFileSync(join(expected.vault, 'Welcome.md'), 'MUTATED ON CLOSE\n');
              if (mutateAt === 'kioku-folder' && closes === 1) mkdirSync(join(expected.vault, 'Kioku'));
            } else { modalCount = 1; kiokuModal = 'kioku-deck-picker-modal'; }
            value = true;
          } else if (expression.includes('kioku-ribbon')) value = 1;
          else value = modalCount;
          if (!result.exceptionDetails) result = { result: { type: 'string', value: JSON.stringify(value) } };
        }
        if (message.method === 'Page.captureScreenshot') result = { data: '' }; // Synthetic, never actual evidence.
        if (message.method === 'Input.dispatchKeyEvent') { uiOperations += 1; modalCount = 0; }
        socket.write(frame(JSON.stringify({ id: message.id, result })));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let processHandle;
  try {
    processHandle = spawn(process.execPath, ['scripts/e2e/smoke.mjs', ...(baselineMode ? ['baseline'] : [])], { cwd: root, env: { ...withoutHeavyQueue(),
      KIOKU_BASELINE_ID: baselineId, KIOKU_CDP_URL: `http://127.0.0.1:${server.address().port}` } });
    let stdout = ''; let stderr = '';
    processHandle.stdout.on('data', (chunk) => stdout += chunk); processHandle.stderr.on('data', (chunk) => stderr += chunk);
    const status = await new Promise((resolve, reject) => { processHandle.on('exit', resolve); processHandle.on('error', reject); });
    return { status, stdout, stderr, uiOperations };
  } finally {
    if (processHandle?.exitCode === null) processHandle.kill();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}
function setup() {
  const root = createFixture(); roots.push(root); const expected = prepareVault(root);
  const id = randomUUID(); const directory = join(root, 'artifacts/e2e-smoke/baselines'); mkdirSync(directory, { recursive: true });
  const baseline = { schema: 1, id, capturedAt: new Date().toISOString(), stage: 'before-startup',
    vaultClosed: 'dedicated-instance-verified-not-running', vault: expected.vault, buildId: expected.buildId, version: expected.version,
    files: { 'Welcome.md': sha256(readFileSync(join(expected.vault, 'Welcome.md'))) } };
  writeFileSync(join(directory, `${id}.json`), JSON.stringify(baseline));
  return { root, expected, id };
}
describe('real smoke CLI note preservation using non-UI CDP simulation', () => {
  it('accepts unchanged files (protocol test only)', async () => {
    const { root, expected, id } = setup(); const result = await simulatedSmoke(root, expected, id);
    expect(result.status, result.stderr).toBe(0);
  });
  it('refuses a new baseline while a CDP port answers (dedicated instance already up)', async () => {
    const { root, expected, id } = setup(); const result = await simulatedSmoke(root, expected, id, undefined, true);
    expect(result.status).toBe(1); expect(result.stderr).toMatch(/CDP port \d+ already answers/);
    expect(readdirSync(join(root, 'artifacts/e2e-smoke/baselines'))).toEqual([`${id}.json`]);
  });
  it('fails before any UI operation when a foreign modal (trust / restricted-mode dialog) is open', async () => {
    const { root, expected, id } = setup(); const result = await simulatedSmoke(root, expected, id, undefined, false, true);
    expect(result.status).toBe(1); expect(result.stderr).toMatch(/Unexpected foreign modal open.*mod-trust-folder/);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe('FAIL'); expect(report.steps).toEqual([]);
    expect(result.uiOperations).toBe(0);
  });
  it('fails instead of PASS when a foreign modal appears after the status modal is closed', async () => {
    const { root, expected, id } = setup();
    const result = await simulatedSmoke(root, expected, id, undefined, false, 'after-status');
    expect(result.status).toBe(1); expect(result.stderr).toMatch(/Unexpected foreign modal open.*mod-trust-folder/);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe('FAIL'); expect(report.steps.at(-1).operation).toBe('command → status modal → close');
  });
  it('fails when a foreign modal is stacked over the open deck picker', async () => {
    const { root, expected, id } = setup();
    const result = await simulatedSmoke(root, expected, id, undefined, false, 'after-first-close');
    expect(result.status).toBe(1); expect(result.stderr).toMatch(/Unexpected foreign modal open.*mod-trust-folder/);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe('FAIL'); expect(report.steps.map((step) => step.operation)).toEqual(['ribbon → deck picker → close (1)']);
  });
  it('fails before any UI operation when the CDP port is not the recorded dedicated instance port', async () => {
    const { root, expected, id } = setup();
    mkdirSync(join(root, '.tooling'));
    writeFileSync(join(root, '.tooling', 'obsidian-instance.json'), JSON.stringify({ schema: 1, pid: 4242,
      profile: join(root, '.tooling', 'obsidian-profile'), port: 1, startedAt: new Date().toISOString() }));
    const result = await simulatedSmoke(root, expected, id);
    expect(result.status).toBe(1); expect(result.stderr).toMatch(/not the recorded dedicated instance port 1/);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe('FAIL'); expect(report.steps).toEqual([]);
  });
  it('refuses UI PASS without a pre-startup baseline ID', async () => {
    const { root, expected } = setup(); const result = await simulatedSmoke(root, expected, '');
    expect(result.status).toBe(1); expect(result.stderr).toMatch(/KIOKU_BASELINE_ID/);
  });
  it('fails instead of PASS when opening the deck picker creates the (even empty) review data folder', async () => {
    const { root, expected, id } = setup();
    const result = await simulatedSmoke(root, expected, id, 'kioku-folder');
    expect(result.status, result.stdout).toBe(1);
    expect(result.stderr).toMatch(/Review data folder was created without a rating: Kioku/);
  });
  for (const stage of ['startup', 'close', 'restart']) {
    it(`fails instead of PASS when a note changes at ${stage}`, async () => {
      const { root, expected, id } = setup();
      if (stage === 'restart') expect((await simulatedSmoke(root, expected, id)).status).toBe(0);
      if (stage !== 'close') writeFileSync(join(expected.vault, 'Welcome.md'), 'MUTATED BY M0 STARTUP\n');
      const result = await simulatedSmoke(root, expected, id, stage);
      expect(result.status, result.stdout).toBe(1);
      expect(result.stderr).toMatch(/Vault content changed/);
      expect(JSON.parse(result.stdout).status).toBe('FAIL');
    });
  }
});

// Regression (LEV-305 native gate on 6b3bbb8): inside an opted-in `npm run check` the test process carries
// KIOKU_HEAVY_QUEUE=1 and the slot holder's token; the simulated smoke children must not see them.
describe('the same protocol inside an opted-in check (KIOKU_HEAVY_QUEUE=1 exported to the test process)', () => {
  const saved = {}; let scratch; let queueDir;
  beforeAll(() => {
    for (const key of heavyQueueVariables) saved[key] = process.env[key];
    scratch = mkdtempSync(join(tmpdir(), 'kioku-note-queue-')); queueDir = join(scratch, 'queue');
    Object.assign(process.env, { KIOKU_HEAVY_QUEUE: '1', ORCA_HEAVY_QUEUE_DIR: queueDir, ORCA_HEAVY_QUEUE_TOKEN: randomUUID() });
  });
  afterAll(() => {
    for (const key of heavyQueueVariables) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    rmSync(scratch, { recursive: true, force: true });
  });
  it('accepts unchanged files and still fails on a changed note, without touching any queue', async () => {
    const { root, expected, id } = setup();
    const unchanged = await simulatedSmoke(root, expected, id);
    expect(unchanged.status, unchanged.stderr).toBe(0);
    writeFileSync(join(expected.vault, 'Welcome.md'), 'MUTATED BY M0 STARTUP\n');
    const changed = await simulatedSmoke(root, expected, id, 'startup');
    expect(changed.status, changed.stdout).toBe(1);
    expect(changed.stderr).toMatch(/Vault content changed/u);
    expect(existsSync(queueDir)).toBe(false);
  });
});
