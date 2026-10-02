// Protocol simulation only: never native Obsidian evidence, and never starts a browser.
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, createFixture } from '../helpers/fixture.mjs';
import { prepareVault } from '../../scripts/lib/harness.mjs';
import { sha256 } from '../../scripts/lib/build.mjs';

const roots = [];
afterEach(() => { while (roots.length) cleanup(roots.pop()); });
function frame(text) {
  const data = Buffer.from(text);
  const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >>> 8, data.length & 255]);
  return Buffer.concat([head, data]);
}
async function simulatedSmoke(root, expected, baselineId, mutateAt, baselineMode = false) {
  let modalCount = 0; let closes = 0;
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
          if (expression.includes("require?.('obsidian')")) {
            result = { exceptionDetails: { text: "Cannot find module 'obsidian'" } };
          } else if (expression.includes('versions?.electron')) value = { vault: expected.vault,
            url: popout ? 'about:blank' : 'app://obsidian.md/index.html', processType: 'renderer', electron: '43.3.0' };
          else if (expression.includes('getBoundingClientRect')) {
            value = { count: 1, buildId: expected.buildId, version: expected.version, loaded: true,
              text: expression.includes('kioku-deck-picker-modal') ? 'Kioku — デッキを選んで復習 全デッキ' : 'Kioku デッキ AI は未実装',
              x: 300, y: 200, width: 400, height: 300, viewportWidth: 1000, viewportHeight: 700 };
          } else if (expression.includes('executeCommandById')) { modalCount = 1; value = true; }
          else if (expression.includes('?.click()')) {
            if (expression.includes('-close')) {
              modalCount = 0; closes += 1;
              if (mutateAt === 'close' && closes === 1) writeFileSync(join(expected.vault, 'Welcome.md'), 'MUTATED ON CLOSE\n');
              if (mutateAt === 'kioku-folder' && closes === 1) mkdirSync(join(expected.vault, 'Kioku'));
            } else modalCount = 1;
            value = true;
          } else if (expression.includes('kioku-ribbon')) value = 1;
          else value = modalCount;
          if (!result.exceptionDetails) result = { result: { type: 'string', value: JSON.stringify(value) } };
        }
        if (message.method === 'Page.captureScreenshot') result = { data: '' }; // Synthetic, never actual evidence.
        if (message.method === 'Input.dispatchKeyEvent') modalCount = 0;
        socket.write(frame(JSON.stringify({ id: message.id, result })));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let processHandle;
  try {
    processHandle = spawn(process.execPath, ['scripts/e2e/smoke.mjs', ...(baselineMode ? ['baseline'] : [])], { cwd: root, env: { ...process.env,
      KIOKU_CONFIRM_VAULT_CLOSED: '1',
      KIOKU_BASELINE_ID: baselineId, KIOKU_CDP_URL: `http://127.0.0.1:${server.address().port}` } });
    let stdout = ''; let stderr = '';
    processHandle.stdout.on('data', (chunk) => stdout += chunk); processHandle.stderr.on('data', (chunk) => stderr += chunk);
    const status = await new Promise((resolve, reject) => { processHandle.on('exit', resolve); processHandle.on('error', reject); });
    return { status, stdout, stderr };
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
    vaultClosed: 'operator-confirmed-before-launch', vault: expected.vault, buildId: expected.buildId, version: expected.version,
    files: { 'Welcome.md': sha256(readFileSync(join(expected.vault, 'Welcome.md'))) } };
  writeFileSync(join(directory, `${id}.json`), JSON.stringify(baseline));
  return { root, expected, id };
}
describe('real smoke CLI note preservation using non-UI CDP simulation', () => {
  it('accepts unchanged files (protocol test only)', async () => {
    const { root, expected, id } = setup(); const result = await simulatedSmoke(root, expected, id);
    expect(result.status, result.stderr).toBe(0);
  });
  it('refuses a new baseline after CDP targets exist', async () => {
    const { root, expected, id } = setup(); const result = await simulatedSmoke(root, expected, id, undefined, true);
    expect(result.status).toBe(1); expect(result.stderr).toMatch(/Close Obsidian before baseline capture/);
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
