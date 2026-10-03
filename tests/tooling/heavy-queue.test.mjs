// Mac-wide heavy-job queue with an injected clock and process table. Never starts Obsidian and never signals a process;
// only the FIFO and check-entry cases start short real child processes against a private temporary queue directory.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquire, defaultQueueDir, defaultSystem, formatDuration, handOff, HeavyQueueError, identify, listTickets, processInfo, verify, openQueue, overdueMs, readOwner, release,
  run, status, tokenVariable } from '../../scripts/heavy-queue/heavy-queue.mjs';
import { assertNativeHeld, heavyQueueEnabled, launchWithQueue, quitWithQueue } from '../../scripts/lib/heavy-queue.mjs';
import { prepareVault } from '../../scripts/lib/harness.mjs';
import { cleanup, createFixture } from '../helpers/fixture.mjs';

// Observes every rename / link / unlink made through node:fs (passthrough otherwise), so a concurrency test can check an
// invariant at the exact instant between two filesystem steps of the code under test, without relying on timing.
const fsObserver = { after: null };
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal();
  const watched = (name) => (...args) => { const result = real[name](...args); fsObserver.after?.(name, args); return result; };
  return { ...real, default: real, renameSync: watched('renameSync'), linkSync: watched('linkSync'), unlinkSync: watched('unlinkSync') };
});

const project = fileURLToPath(new URL('../../', import.meta.url));
const library = join(project, 'scripts', 'heavy-queue', 'heavy-queue.mjs');
const cli = join(project, 'scripts', 'heavy-queue', 'cli.mjs');
const temporary = []; const fixtures = [];
afterEach(() => {
  fsObserver.after = null;
  while (fixtures.length) cleanup(fixtures.pop());
  while (temporary.length) { const dir = temporary.pop(); chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); }
});
function scratch() { const dir = mkdtempSync(join(tmpdir(), 'kioku-heavy-queue-')); temporary.push(dir); return dir; }

/** One shared fake host: `table` maps pid → { command, started }; every requester gets its own pid on the same clock. */
function fakeHost() {
  const table = new Map(); const clock = { wall: Date.parse('2026-10-03T00:00:00.000Z'), mono: 0 }; const logs = []; const queried = [];
  const proc = (pid, command = `node requester-${pid}`) => {
    table.set(pid, { command, started: 'Sat Oct  3 00:00:00 2026' });
    return {
      pid, uid: process.getuid(), logs,
      now: () => clock.wall,
      monotonic: () => clock.mono,
      sleep: (ms) => new Promise((resolve) => { clock.wall += ms; clock.mono += ms; setImmediate(resolve); }),
      processInfo: (target) => { queried.push(target); return table.get(target) ?? null; },
      log: (line) => logs.push(line),
    };
  };
  return { table, clock, logs, queried, proc };
}
const settle = async (predicate, rounds = 500) => {
  for (let round = 0; round < rounds; round += 1) { if (predicate()) return; await new Promise((resolve) => { setImmediate(resolve); }); }
  throw new Error('condition not reached');
};
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
// Child results resolve on 'close' (after stdio is fully read), not 'exit' (which can fire first), so output assertions
// (including the no-secret checks) always see every byte.
/** Poll real processes; never falls through silently (a slow machine fails here with the reason, not later). */
async function waitUntil(predicate, what, limitMs = 45000) {
  const end = Date.now() + limitMs;
  while (!predicate()) { if (Date.now() > end) throw new Error(`Timed out after ${limitMs} ms waiting for ${what}.`); await pause(10); }
}
// Tests that start real Node processes: generous limits so CPU load from other jobs slows them but does not fail them.
const realProcessTimeout = 120000;
const request = (worktree, job = 'check', env = {}) => ({ project: 'kioku', worktree, job, env });
/** Highest generation file of a lease directory (`owner` or `enqueue`) and whether it is still held (no release marker). */
function leaseTop(dir, lease = 'owner') {
  const names = existsSync(join(dir, lease)) ? readdirSync(join(dir, lease)) : [];
  const top = names.filter((name) => name.endsWith('.json')).sort().at(-1);
  return top ? { name: top, file: join(dir, lease, top), held: !names.includes(top.replace(/\.json$/u, '.released')) } : null;
}
const ownerHeld = (dir) => Boolean(leaseTop(dir)?.held);
/** A lease / ticket-shaped record for `pid` (identity of the fake command `node requester-<pid>`). */
const leaseRecord = (pid) => JSON.stringify({ schema: 2, ticketId: '00000000-0000-4000-8000-000000000000', project: 'kioku',
  worktree: `/w/holder-${pid}`, pid, ...identify({ command: `node requester-${pid}`, started: 'Sat Oct  3 00:00:00 2026' }), job: 'check',
  enqueuedAt: '2026-10-03T00:00:00.000Z' });
const markerFor = (gen, ticketId) => JSON.stringify({ schema: 2, gen, ticketId, releasedAt: '2026-10-03T00:00:00.000Z' });
/** A valid release marker of generation `gen` for the holder written by `leaseRecord`. */
const releaseMarker = (gen) => markerFor(gen, '00000000-0000-4000-8000-000000000000');
/** Pause `proc` once at race stage `wanted` (the code under test awaits `system.race(stage)` between inspect and act). */
function pauseAt(proc, wanted) {
  let resume = null; let reached = false;
  proc.race = (stage) => {
    if (stage !== wanted || resume) return undefined;
    reached = true;
    return new Promise((go) => { resume = go; });
  };
  return { reached: () => reached, resume: () => resume() };
}
const historyEvents = (dir) => readFileSync(join(dir, 'history.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).event);

describe('FIFO order', () => {
  it('serves concurrent requesters in arrival order and the waiter shows the owner and its waited time', async () => {
    const host = fakeHost(); const dir = scratch();
    const a = openQueue(dir, host.proc(101)); const b = openQueue(dir, host.proc(102)); const c = openQueue(dir, host.proc(103));
    const first = await acquire(a, request('/w/a'));
    expect(first.mode).toBe('acquired');
    const order = [];
    const second = acquire(b, request('/w/b')).then((held) => { order.push('b'); return held; });
    await settle(() => listTickets(a).length === 1);
    const third = acquire(c, request('/w/c')).then((held) => { order.push('c'); return held; });
    await settle(() => listTickets(a).length === 2 && host.logs.length >= 2);
    expect(listTickets(a).map((ticket) => [ticket.seq, ticket.pid])).toEqual([[2, 102], [3, 103]]);
    expect(host.logs[0]).toMatch(/waiting for the check slot \(#1 in line, waited 0s\); owner: project=kioku job=check pid=101 worktree=\/w\/a held/u);
    expect(host.logs[1]).toMatch(/#2 in line/u);
    host.clock.mono += 65000; host.clock.wall += 65000;
    await settle(() => host.logs.some((line) => /waited 1m0\ds/u.test(line)));
    expect(release(a, first.owner.ticketId)).toBe(true);
    const heldB = await second;
    expect(order).toEqual(['b']);
    expect(heldB.waitedMs).toBeGreaterThanOrEqual(65000);
    expect(readOwner(a)).toMatchObject({ pid: 102, worktree: '/w/b', seq: 2, waitedMs: heldB.waitedMs });
    release(b, heldB.owner.ticketId);
    const heldC = await third;
    expect(order).toEqual(['b', 'c']);
    release(c, heldC.owner.ticketId);
    expect(readOwner(a)).toBeNull(); expect(listTickets(a)).toEqual([]);
    // Sequence numbers are never reused after tickets leave (high-water mark).
    const fourth = await acquire(a, request('/w/a'));
    expect(fourth.owner.seq).toBe(4);
    expect(historyEvents(dir)).toEqual(['acquired', 'released', 'acquired', 'released', 'acquired', 'released', 'acquired']);
  });

  it('runs two real concurrent CLI requesters one after the other (real ps on exact PIDs)', async () => {
    const dir = join(scratch(), 'queue'); const log = join(scratch(), 'order.log'); const finish = join(scratch(), 'finish');
    // Each job ends only once `finish` exists, which the test creates after B is queued behind A.
    const job = (name) => `const fs=process.getBuiltinModule('node:fs');fs.appendFileSync(${JSON.stringify(log)},'start ${name}\\n');`
      + `const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(finish)})){clearInterval(t);`
      + `fs.appendFileSync(${JSON.stringify(log)},'end ${name}\\n');}},10)`;
    const live = {};
    const start = (name, worktree) => {
      mkdirSync(worktree, { recursive: true });
      const child = spawn(process.execPath, [cli, 'run', '--project', 'pilot', '--job', 'check', '--', process.execPath, '-e', job(name)],
        { cwd: worktree, env: { ...process.env, ORCA_HEAVY_QUEUE_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
      live[name] = ''; child.stderr.on('data', (chunk) => { live[name] += chunk; });
      return new Promise((resolve) => { child.on('close', (code) => resolve({ code, stderr: live[name] })); });
    };
    const first = start('A', join(scratch(), 'a'));
    await waitUntil(() => existsSync(log), 'A to start its job');
    const second = start('B', join(scratch(), 'b'));
    // A ends only after B has reported waiting: a queued ticket alone does not mean B has looked at the owner yet
    // (under load B's ps checks can outlast A, and B would then rightly take the free slot without waiting).
    await waitUntil(() => live.B.includes('waiting for the check slot'), 'B to report waiting behind A');
    writeFileSync(finish, '');
    const [a, b] = await Promise.all([first, second]);
    expect(a.code, a.stderr).toBe(0); expect(b.code, b.stderr).toBe(0);
    expect(readFileSync(log, 'utf8')).toBe('start A\nend A\nstart B\nend B\n');
    expect(b.stderr).toMatch(/waiting for the check slot .*owner: project=pilot job=check pid=\d+/u);
    expect(readdirSync(join(dir, 'tickets'))).toEqual([]); expect(ownerHeld(dir)).toBe(false);
  }, realProcessTimeout);

  it('simultaneous enqueues behind a barrier get distinct sequence numbers and are served in that order (many rounds)', async () => {
    const dir = join(scratch(), 'queue'); const work = scratch();
    const script = join(work, 'enqueue.mjs');
    writeFileSync(script, [
      "import { appendFileSync, existsSync, writeFileSync } from 'node:fs';",
      `const { acquire, defaultSystem, openQueue, release } = await import(${JSON.stringify(pathToFileURL(library).href)});`,
      'const [dir, name, go, log] = process.argv.slice(2);',
      'const queue = openQueue(dir, { ...defaultSystem, log: () => {} });',
      "writeFileSync(`${go}.ready-${name}`, '');",
      'while (!existsSync(go)) { /* tight barrier so both enqueue at the same moment */ }',
      "const held = await acquire(queue, { project: 'race', worktree: `/race/${name}`, job: 'check' }, { pollMs: 5 });",
      "appendFileSync(log, `${name}\\n`);",
      'release(queue, held.owner.ticketId);',
      ''].join('\n'));
    const holderQueue = openQueue(dir, { ...defaultSystem, log: () => {} });
    for (let round = 0; round < 25; round += 1) {
      const go = join(work, `go-${round}`); const log = join(work, `served-${round}.log`);
      const holder = await acquire(holderQueue, { project: 'race', worktree: '/race/holder', job: 'check' });
      const children = ['x', 'y'].map((name) => {
        const child = spawn(process.execPath, [script, dir, name, go, log], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
        return new Promise((resolve) => { child.on('close', (code) => resolve({ code, stderr })); });
      });
      await waitUntil(() => existsSync(`${go}.ready-x`) && existsSync(`${go}.ready-y`), `round ${round}: both children at the barrier`);
      writeFileSync(go, '');
      await waitUntil(() => listTickets(holderQueue).length === 2, `round ${round}: both tickets`);
      const tickets = listTickets(holderQueue);
      expect(tickets).toHaveLength(2);
      expect(tickets[0].seq, `round ${round}: equal sequence numbers`).toBeLessThan(tickets[1].seq);
      release(holderQueue, holder.owner.ticketId);
      for (const result of await Promise.all(children)) expect(result.code, result.stderr).toBe(0);
      expect(readFileSync(log, 'utf8')).toBe(`${tickets.map((ticket) => ticket.worktree.slice('/race/'.length)).join('\n')}\n`);
    }
  }, 600000);
});

describe('command lines may carry credentials: only digest + executable basename leave memory', () => {
  const secret = 'FAKE-SECRET';
  /** Every byte under the queue directory (owner, tickets, history, counter, stale, tmp). */
  const queueBytes = (dir) => {
    const out = [];
    const walk = (path) => {
      for (const name of readdirSync(path)) {
        const file = join(path, name);
        if (statSync(file).isDirectory()) walk(file); else out.push(`${file}\n${readFileSync(file, 'utf8')}`);
      }
    };
    walk(dir);
    return out.join('\n');
  };

  it('a real owner, waiter, status call and refusals never persist or print a secret-looking argument', async () => {
    const dir = join(scratch(), 'queue'); const finish = join(scratch(), 'finish'); const started = join(scratch(), 'started');
    const wa = scratch(); const wb = scratch();
    const env = { ...process.env, ORCA_HEAVY_QUEUE_DIR: dir }; delete env[tokenVariable];
    const hold = `const fs=process.getBuiltinModule('node:fs');fs.writeFileSync(${JSON.stringify(started)},'');`
      + `const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(finish)}))clearInterval(t);},10)`;
    const start = (cwd, script, flag) => {
      const child = spawn(process.execPath, [cli, 'run', '--project', 'pilot', '--job', 'check', '--', process.execPath, '-e', script, '--', flag],
        { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
      return new Promise((resolve) => { child.on('close', (code) => resolve({ code, output })); });
    };
    const once = (cwd, args) => { const result = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8' });
      return { code: result.status, output: result.stdout + result.stderr }; };
    const a = start(wa, hold, `--api-key=${secret}-123`);
    await waitUntil(() => existsSync(started), 'the owner to start');
    const b = start(wb, '0', `--api-key=${secret}-456`);
    await waitUntil(() => readdirSync(join(dir, 'tickets')).length === 1, 'the waiter to queue');
    const shown = once(wa, ['status']);
    const sameWorktree = once(wa, ['run', '--project', 'pilot', '--job', 'check', '--', process.execPath, '-e', '0', '--', `--api-key=${secret}-789`]);
    const doubleWait = once(wb, ['run', '--project', 'pilot', '--job', 'check', '--', process.execPath, '-e', '0', '--', `--token=${secret}-000`]);
    const whileHeld = queueBytes(dir);
    writeFileSync(finish, '');
    const results = await Promise.all([a, b]);

    expect(shown.code).toBe(0);
    const snapshot = JSON.parse(shown.output);
    expect(snapshot.owner).toMatchObject({ executable: 'node', commandDigest: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    expect(snapshot.waiting).toHaveLength(1);
    expect(sameWorktree.code).toBe(1); expect(sameWorktree.output).toMatch(/already holds the heavy-job slot \(check, pid \d+ \[node\]/u);
    expect(doubleWait.code).toBe(1); expect(doubleWait.output).toMatch(/already waits in the heavy-job queue \(ticket \d+, pid \d+ \[node\]\)/u);
    for (const text of [whileHeld, queueBytes(dir), shown.output, sameWorktree.output, doubleWait.output, ...results.map((result) => result.output)]) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain('--api-key');
    }
    expect(results.map((result) => result.code)).toEqual([0, 0]);
  }, realProcessTimeout);

  it('reuse reasons, Kioku launch/quit/smoke results and the identity never echo arguments', async () => {
    const host = fakeHost(); const dir = scratch(); const env = { ORCA_HEAVY_QUEUE_DIR: dir };
    expect(identify({ command: `/usr/local/bin/node tool.mjs --api-key=${secret}`, started: 's' }))
      .toEqual({ started: 's', executable: 'node', commandDigest: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    expect(identify({ command: `API_KEY=${secret} run`, started: 's' }).executable).toBe('unknown');
    const launched = await launchWithQueue('/w/kioku', env, async () => {
      host.table.set(4244, { command: `Obsidian --user-data-dir=/p --api-key=${secret}`, started: 'x' }); return { pid: 4244 };
    }, host.proc(1601, `node launch --password=${secret}`));
    host.table.set(4244, { command: `/bin/sh -c sleep --api-key=${secret}`, started: 'x' }); // PID reuse.
    const shown = status(openQueue(dir, host.proc(1602)));
    const quit = await quitWithQueue('/w/kioku', env, async () => ({ status: 'STOPPED', pid: 4244 }), host.proc(1603));
    let refused = '';
    try { assertNativeHeld('/w/kioku', env, host.proc(1604)); } catch (error) { refused = error.message; }
    expect(shown.owner.reason).toBe('pid 4244 was reused by another command (executable sh)');
    for (const text of [JSON.stringify(launched), JSON.stringify(shown), JSON.stringify(quit), refused, host.logs.join('\n'),
      readFileSync(join(dir, 'history.jsonl'), 'utf8')]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('stale owners and tickets', () => {
  it('recovers the slot of a crashed owner (PID gone) and records why', async () => {
    const host = fakeHost(); const dir = scratch();
    await acquire(openQueue(dir, host.proc(201)), request('/w/crashed'));
    host.table.delete(201);
    const next = openQueue(dir, host.proc(202));
    const held = await acquire(next, request('/w/next'));
    expect(held.mode).toBe('acquired'); expect(readOwner(next).pid).toBe(202);
    const recovered = readFileSync(join(dir, 'history.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      .find((event) => event.event === 'recovered-owner');
    expect(recovered).toMatchObject({ reason: 'pid 201 has exited', record: { pid: 201, worktree: '/w/crashed' } });
    // Generation files are never deleted (a used generation number can never be re-created).
    expect(readdirSync(join(dir, 'owner')).filter((name) => name.endsWith('.json')).sort()).toEqual(['000000000001.json', '000000000002.json']);
  });

  it('detects PID reuse by a different command line or start time and recovers', async () => {
    for (const reuse of [{ command: '/usr/bin/vim notes.md', started: 'Sat Oct  3 00:00:00 2026' },
      { command: 'node requester-301', started: 'Sat Oct  3 05:00:00 2026' }]) {
      const host = fakeHost(); const dir = scratch();
      await acquire(openQueue(dir, host.proc(301)), request('/w/old'));
      host.table.set(301, reuse);
      const held = await acquire(openQueue(dir, host.proc(302)), request('/w/new'));
      expect(held.mode).toBe('acquired');
      expect(historyEvents(dir)).toContain('recovered-owner');
    }
  });

  it('recovers an enqueue lock left by a dead PID but waits for a live one', async () => {
    const host = fakeHost(); const dir = scratch();
    openQueue(dir, host.proc(251));
    writeFileSync(join(dir, 'enqueue', '000000000001.json'), leaseRecord(250)); // pid 250 is not in the table: dead.
    const first = await acquire(openQueue(dir, host.proc(251)), request('/w/a'));
    expect(first.mode).toBe('acquired');
    expect(historyEvents(dir)).toContain('recovered-enqueue-lock');
    expect(leaseTop(dir, 'enqueue')).toMatchObject({ name: '000000000002.json', held: false });
    host.proc(252); writeFileSync(join(dir, 'enqueue', '000000000003.json'), leaseRecord(252)); // Live holder of the next generation.
    const observer = openQueue(dir, host.proc(254));
    const waiting = acquire(openQueue(dir, host.proc(253)), request('/w/b'));
    await settle(() => host.queried.filter((pid) => pid === 252).length > 5);
    expect(listTickets(observer)).toEqual([]); expect(leaseTop(dir, 'enqueue')).toMatchObject({ name: '000000000003.json', held: true });
    writeFileSync(join(dir, 'enqueue', '000000000003.released'), releaseMarker(3)); // That holder releases.
    await settle(() => listTickets(observer).length === 1);
    release(observer, first.owner.ticketId);
    expect((await waiting).owner.pid).toBe(253);
  });

  it('never touches a live owner: its generation file bytes stay identical while waiting, and no process is signalled', async () => {
    const host = fakeHost(); const dir = scratch();
    const owner = openQueue(dir, host.proc(401));
    const held = await acquire(owner, request('/w/owner'));
    const before = readFileSync(leaseTop(dir).file);
    let done = false;
    const waiting = acquire(openQueue(dir, host.proc(402)), request('/w/waiter')).then((result) => { done = true; return result; });
    host.clock.wall += 5000;
    await settle(() => host.queried.filter((pid) => pid === 401).length > 20);
    expect(done).toBe(false);
    expect(readFileSync(leaseTop(dir).file)).toEqual(before);
    release(owner, held.owner.ticketId);
    await waiting;
    // Only exact-PID lookups were ever made (the fake has no kill, list-all or pattern API at all).
    expect(new Set(host.queried)).toEqual(new Set([401, 402]));
  });

  it('prunes a dead waiter ahead in line instead of waiting behind it', async () => {
    const host = fakeHost(); const dir = scratch();
    const owner = openQueue(dir, host.proc(501)); const held = await acquire(owner, request('/w/owner'));
    const deadWait = acquire(openQueue(dir, host.proc(502)), request('/w/dead')).catch((error) => error);
    await settle(() => listTickets(owner).length === 1);
    host.table.delete(502);
    const nextWait = acquire(openQueue(dir, host.proc(503)), request('/w/next'));
    await settle(() => historyEvents(dir).includes('recovered-ticket'));
    release(owner, held.owner.ticketId);
    expect((await nextWait).owner.pid).toBe(503);
    expect(await deadWait).toBeInstanceOf(HeavyQueueError); // Its ticket vanished: it refuses instead of running unqueued.
  });
});

describe('stale views never hide a live holder (deterministic interleavings, no timing)', () => {
  it('owner: a head waiter that judged the launcher dead after it handed the slot off never hides or replaces the new holder', async () => {
    const host = fakeHost(); const dir = scratch();
    const launcher = openQueue(dir, host.proc(1701, 'node scripts/obsidian-instance-cli.mjs launch'));
    const held = await acquire(launcher, request('/w/kioku', 'native'));
    const watcher = openQueue(dir, host.proc(1799));
    const waiterSystem = host.proc(1702);
    let waiterDone = false;
    const waiter = acquire(openQueue(dir, waiterSystem), request('/w/a')).then((result) => { waiterDone = true; return result; });
    await settle(() => host.logs.length >= 1); // The waiter is the head of the queue and has seen the live launcher.
    const violations = [];
    let triggered = false;
    const realInfo = waiterSystem.processInfo;
    // Between the waiter reading the owner record and acting on it: the launcher hands the slot to the dedicated instance
    // (pid 4250) and exits. The waiter's view is now stale. From here on, after EVERY rename / link / unlink, the owner record
    // must still exist and belong to pid 4250.
    waiterSystem.processInfo = (pid) => {
      if (pid === 1701 && !triggered) {
        triggered = true;
        host.table.set(4250, { command: 'Obsidian --user-data-dir=/w/kioku/.tooling/obsidian-profile', started: 'o' });
        handOff(launcher, held.owner.ticketId, 4250);
        host.table.delete(1701);
        fsObserver.after = (operation, args) => {
          const owner = readOwner(watcher);
          if (owner?.pid !== 4250) violations.push(`${operation} ${args.map(String).join(' -> ')}: owner ${owner ? `pid ${owner.pid}` : 'absent'}`);
        };
      }
      return realInfo(pid);
    };
    await settle(() => triggered);
    let thirdDone = false;
    const third = acquire(openQueue(dir, host.proc(1703)), request('/w/third')).then((result) => { thirdDone = true; return result; });
    await settle(() => host.queried.filter((pid) => pid === 4250).length > 20);
    expect(violations).toEqual([]);
    expect(readOwner(watcher)).toMatchObject({ pid: 4250, ticketId: held.owner.ticketId, job: 'native' });
    expect(waiterDone).toBe(false); expect(thirdDone).toBe(false);
    expect(historyEvents(dir)).not.toContain('recovered-owner');
    fsObserver.after = null;
    host.table.delete(4250); // The dedicated instance exits: now (and only now) the head waiter takes the slot, FIFO.
    const next = await waiter;
    expect(thirdDone).toBe(false);
    release(watcher, next.owner.ticketId);
    expect((await third).owner.pid).toBe(1703);
  });

  it('owner: a head that saw an empty owner/ and stalled can never re-create generation 1 after it was used', async () => {
    // FIFO alone already keeps others behind a live head. To test the lease by itself, the later requesters are made to
    // misjudge the stalled head's ticket as dead (they prune it) so they can take the slot while it is stalled.
    const host = fakeHost(); const dir = scratch(); const watcher = openQueue(dir, host.proc(2099));
    const stalled = host.proc(2001); const stall = pauseAt(stalled, 'owner-inspected');
    const blind = (proc) => { const real = proc.processInfo; proc.processInfo = (pid) => (pid === 2001 ? null : real(pid)); return proc; };
    const stalledWait = acquire(openQueue(dir, stalled), request('/w/stalled')).then((result) => ({ result }), (error) => ({ error }));
    await settle(() => stall.reached()); // It saw owner/ empty and stopped right before creating generation 1.
    expect(readdirSync(join(dir, 'owner'))).toEqual([]);
    const first = await acquire(openQueue(dir, blind(host.proc(2002))), request('/w/first'));
    expect(first.owner.gen).toBe(1);
    release(watcher, first.owner.ticketId);
    const second = await acquire(openQueue(dir, blind(host.proc(2003))), request('/w/second'));
    expect(second.owner.gen).toBe(2); // Live holder from here on.
    const violations = [];
    fsObserver.after = (operation) => {
      const owner = readOwner(watcher);
      if (owner?.pid !== 2003) violations.push(`${operation}: owner ${owner ? `pid ${owner.pid}` : 'absent'}`);
    };
    stall.resume();
    const outcome = await stalledWait;
    fsObserver.after = null;
    expect(outcome.result, 'the stalled head must not become a second owner').toBeUndefined();
    expect(outcome.error?.message).toMatch(/ticket .* vanished/u); // It judged again and found its (pruned) ticket gone.
    expect(violations).toEqual([]);
    expect(readOwner(watcher)).toMatchObject({ pid: 2003, gen: 2 });
    expect(readdirSync(join(dir, 'owner')).filter((name) => name.endsWith('.json')).sort()).toEqual(['000000000001.json', '000000000002.json']);
    release(watcher, second.owner.ticketId);
  });

  it('enqueue lease: an allocator that saw an empty enqueue/ and stalled never allocates beside the live holder', async () => {
    const host = fakeHost(); const dir = scratch(); const watcher = openQueue(dir, host.proc(2199));
    const stalled = host.proc(2101);
    let stallResume = null; let stallReached = false; let holderInside = false; const overlaps = [];
    stalled.race = (stage) => {
      if (stage === 'enqueue-inspected' && !stallReached) { stallReached = true; return new Promise((go) => { stallResume = go; }); }
      if (stage === 'enqueue-held' && holderInside) overlaps.push('the stalled allocator entered the enqueue section while the holder was inside');
      return undefined;
    };
    const stalledWait = acquire(openQueue(dir, stalled), request('/w/stalled'));
    await settle(() => stallReached); // It saw enqueue/ empty and stopped right before creating generation 1.
    expect(readdirSync(join(dir, 'enqueue'))).toEqual([]);
    const first = await acquire(openQueue(dir, host.proc(2102)), request('/w/first')); // Takes enqueue generation 1, releases it.
    expect(first.owner.seq).toBe(1);
    const holder = host.proc(2103); const hold = pauseAt(holder, 'enqueue-held');
    const holderWait = acquire(openQueue(dir, holder), request('/w/holder'));
    await settle(() => hold.reached()); // Holds enqueue generation 2 while allocating.
    holderInside = true;
    stallResume();
    await settle(() => host.queried.filter((pid) => pid === 2103).length > 5); // The stalled allocator now waits for the holder.
    expect(overlaps).toEqual([]);
    expect(leaseTop(dir, 'enqueue')).toMatchObject({ name: '000000000002.json', held: true });
    holderInside = false;
    hold.resume();
    release(watcher, first.owner.ticketId);
    const holderHeld = await holderWait;
    release(watcher, holderHeld.owner.ticketId);
    const stalledHeld = await stalledWait;
    expect([first.owner.seq, holderHeld.owner.seq, stalledHeld.owner.seq]).toEqual([1, 2, 3]);
    expect(overlaps).toEqual([]);
    release(watcher, stalledHeld.owner.ticketId);
  });

  it('enqueue lease: two allocators taking over a dead lease never allocate side by side or hide the winner', async () => {
    const host = fakeHost(); const dir = scratch();
    openQueue(dir, host.proc(1801));
    writeFileSync(join(dir, 'enqueue', '000000000001.json'), leaseRecord(1800)); // Left by a dead allocator (pid 1800).
    const watcher = openQueue(dir, host.proc(1899));
    const first = host.proc(1802); const firstPause = pauseAt(first, 'enqueue-inspected');
    const firstWait = acquire(openQueue(dir, first), request('/w/first'));
    await settle(() => firstPause.reached()); // First judged generation 1 dead and stopped right before acting.
    const second = host.proc(1803); const secondPause = pauseAt(second, 'enqueue-held');
    const secondWait = acquire(openQueue(dir, second), request('/w/second'));
    await settle(() => secondPause.reached()); // Second took generation 2 and holds it while allocating.
    const violations = [];
    fsObserver.after = (operation) => {
      const top = leaseTop(dir, 'enqueue');
      if (top?.name !== '000000000002.json' || !top.held) violations.push(`${operation}: enqueue lease ${top ? `${top.name} held=${top.held}` : 'absent'}`);
    };
    firstPause.resume(); // First now acts on its stale view of generation 1.
    await settle(() => host.queried.filter((pid) => pid === 1803).length > 5); // It found generation 2 live and waits.
    expect(violations).toEqual([]);
    expect(listTickets(watcher)).toEqual([]);
    fsObserver.after = null;
    secondPause.resume();
    const secondHeld = await secondWait;
    expect(secondHeld.owner).toMatchObject({ pid: 1803, seq: 1 });
    await settle(() => listTickets(watcher).length === 1);
    expect(listTickets(watcher)[0]).toMatchObject({ pid: 1802, seq: 2 });
    release(watcher, secondHeld.owner.ticketId);
    expect((await firstWait).owner).toMatchObject({ pid: 1802, seq: 2 });
    expect(historyEvents(dir).filter((event) => event === 'recovered-enqueue-lock')).toHaveLength(1);
  });
});

describe('fail closed on queue files that are not what they claim', () => {
  it('a symlinked generation record pointing outside the directory is refused, never followed', async () => {
    const host = fakeHost(); const dir = scratch(); const outside = scratch();
    // Outside the queue: a well-formed record of a LIVE pid. If it were followed, the waiter would treat it as the owner.
    host.proc(1901); writeFileSync(join(outside, 'owner.json'), leaseRecord(1901).replace('"schema":2', '"schema":2,"seq":1,"token":"t",'
      + '"startedAt":"2026-10-03T00:00:00.000Z","waitedMs":0'));
    openQueue(dir, host.proc(1902));
    symlinkSync(join(outside, 'owner.json'), join(dir, 'owner', '000000000001.json'));
    await expect(acquire(openQueue(dir, host.proc(1902)), request('/w/a'))).rejects.toThrow(/is a symbolic link; refusing \(not followed\)/u);
    expect(() => readOwner(openQueue(dir, host.proc(1903)))).toThrow(/symbolic link/u);
    expect(() => status(openQueue(dir, host.proc(1903)))).toThrow(/symbolic link/u);
    expect(host.queried).not.toContain(1901); // The outside record was never used to judge anything.
    symlinkSync(join(outside, 'owner.json'), join(dir, 'enqueue', '000000000001.json'));
    rmSync(join(dir, 'owner', '000000000001.json'));
    await expect(acquire(openQueue(dir, host.proc(1904)), request('/w/b'))).rejects.toThrow(/symbolic link/u);
  });

  it('non-regular files (directory, FIFO) as records, tickets or the counter are refused', async () => {
    const host = fakeHost();
    const asDirectory = scratch(); openQueue(asDirectory, host.proc(1911)); mkdirSync(join(asDirectory, 'owner', '000000000001.json'));
    await expect(acquire(openQueue(asDirectory, host.proc(1911)), request('/w/a'))).rejects.toThrow(/is not a regular file/u);
    const asFifo = scratch(); openQueue(asFifo, host.proc(1912));
    expect(spawnSync('/usr/bin/mkfifo', [join(asFifo, 'owner', '000000000001.json')]).status).toBe(0);
    await expect(acquire(openQueue(asFifo, host.proc(1912)), request('/w/a'))).rejects.toThrow(/is not a regular file/u); // Never blocks.
    const ticket = scratch(); openQueue(ticket, host.proc(1913));
    symlinkSync(join(scratch(), 'x.json'), join(ticket, 'tickets', `000000000001-${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}.json`));
    await expect(acquire(openQueue(ticket, host.proc(1913)), request('/w/a'))).rejects.toThrow(/symbolic link/u);
    const counter = scratch(); openQueue(counter, host.proc(1914));
    expect(spawnSync('/usr/bin/mkfifo', [join(counter, 'seq.json')]).status).toBe(0);
    await expect(acquire(openQueue(counter, host.proc(1914)), request('/w/a'))).rejects.toThrow(/is not a regular file/u);
  });

  it('a symlinked, wrong-content or non-regular release marker never makes a live owner look free', async () => {
    const host = fakeHost(); const dir = scratch(); const outside = scratch();
    const owner = openQueue(dir, host.proc(1921));
    const forgeries = [
      ['symlink to a valid-looking marker', (marker, gen, ticketId) => {
        writeFileSync(join(outside, `marker-${gen}`), markerFor(gen, ticketId)); symlinkSync(join(outside, `marker-${gen}`), marker);
      }],
      ['marker naming another holder', (marker, gen) => writeFileSync(marker, markerFor(gen, '11111111-1111-4111-8111-111111111111'))],
      ['marker naming another generation', (marker, gen, ticketId) => writeFileSync(marker, markerFor(gen + 1, ticketId))],
      ['empty marker', (marker) => writeFileSync(marker, '')],
      ['directory as a marker', (marker) => mkdirSync(marker)],
    ];
    for (const [label, forge] of forgeries) {
      const held = await acquire(owner, request('/w/owner'));
      const marker = join(dir, 'owner', `${String(held.owner.gen).padStart(12, '0')}.released`);
      forge(marker, held.owner.gen, held.owner.ticketId);
      host.queried.length = 0; host.logs.length = 0;
      const viewer = openQueue(dir, host.proc(1922));
      expect(readOwner(viewer), label).toMatchObject({ pid: 1921, ticketId: held.owner.ticketId });
      expect(status(viewer).owner, label).toMatchObject({ pid: 1921, live: true });
      let done = false;
      const waiting = acquire(openQueue(dir, host.proc(1923)), request('/w/waiter')).then((result) => { done = true; return result; });
      await settle(() => host.queried.filter((pid) => pid === 1921).length > 10);
      expect(done, label).toBe(false);
      expect(host.logs.some((line) => line.includes('ANOMALY') && line.includes('NOT released')), label).toBe(true);
      // Clean up this round: remove the forgery, the owner releases properly, the waiter takes over and releases.
      rmSync(marker, { recursive: true, force: true });
      expect(release(owner, held.owner.ticketId), label).toBe(true);
      release(owner, (await waiting).owner.ticketId);
    }
  });
});

describe('re-entrance and double requests', () => {
  it('commit → pre-commit → check inside a held slot re-enters with the token instead of deadlocking', async () => {
    const host = fakeHost(); const dir = scratch();
    const held = await acquire(openQueue(dir, host.proc(601)), request('/w/a'));
    const inner = openQueue(dir, host.proc(602));
    const nested = await acquire(inner, request('/w/a', 'check', { [tokenVariable]: held.owner.token }));
    expect(nested).toMatchObject({ mode: 'reentrant', waitedMs: 0 });
    expect(listTickets(inner)).toEqual([]); expect(readOwner(inner).pid).toBe(601);
    // A wrong token from the same worktree is a second request: refused with guidance, never a self-wait.
    await expect(acquire(inner, request('/w/a', 'check', { [tokenVariable]: 'forged' }))).rejects.toThrow(/already holds the heavy-job slot/u);
  });

  it('a check from the worktree that holds native runs nested; a second native is refused', async () => {
    const host = fakeHost(); const dir = scratch();
    await acquire(openQueue(dir, host.proc(701)), request('/w/a', 'native'));
    expect((await acquire(openQueue(dir, host.proc(702)), request('/w/a', 'check'))).mode).toBe('nested');
    await expect(acquire(openQueue(dir, host.proc(703)), request('/w/a', 'native'))).rejects.toThrow(/already holds the native slot/u);
  });

  it('refuses a double enqueue from the same worktree while its first ticket waits', async () => {
    const host = fakeHost(); const dir = scratch();
    const owner = openQueue(dir, host.proc(801)); const held = await acquire(owner, request('/w/owner'));
    const firstWait = acquire(openQueue(dir, host.proc(802)), request('/w/b'));
    await settle(() => listTickets(owner).length === 1);
    await expect(acquire(openQueue(dir, host.proc(803)), request('/w/b'))).rejects.toThrow(/already waits in the heavy-job queue/u);
    expect(listTickets(owner)).toHaveLength(1);
    release(owner, held.owner.ticketId);
    expect((await firstWait).owner.pid).toBe(802);
  });

  it('run passes the owner token to the child and releases after the child exits', async () => {
    const host = fakeHost(); const queue = openQueue(scratch(), host.proc(901));
    let childEnv;
    const fakeSpawn = (command, args, options) => {
      childEnv = options.env;
      const handlers = {};
      setImmediate(() => handlers.exit(7, null));
      return { once: (event, handler) => { handlers[event] = handler; } };
    };
    const code = await run(queue, request('/w/a', 'check', { PATH: '/bin' }), 'npm', ['run', 'check:steps'], { spawn: fakeSpawn });
    expect(code).toBe(7);
    expect(childEnv).toMatchObject({ PATH: '/bin', [tokenVariable]: expect.stringMatching(/^[0-9a-f-]{36}$/u) });
    expect(readOwner(queue)).toBeNull();
  });

  it('a nested check inside this worktree\'s native session runs WITHOUT a token, so nothing under it re-enters native', async () => {
    const host = fakeHost(); const dir = scratch();
    const native = await acquire(openQueue(dir, host.proc(951)), request('/w/a', 'native'));
    let childEnv;
    const fakeSpawn = (command, args, options) => {
      childEnv = options.env;
      const handlers = {};
      setImmediate(() => handlers.exit(0, null));
      return { once: (event, handler) => { handlers[event] = handler; } };
    };
    const code = await run(openQueue(dir, host.proc(952)), request('/w/a', 'check', { [tokenVariable]: 'inherited-stale-token' }),
      'npm', ['run', 'check:steps'], { spawn: fakeSpawn });
    expect(code).toBe(0);
    expect(childEnv).not.toHaveProperty(tokenVariable);
    expect(readOwner(openQueue(dir, host.proc(953)))).toMatchObject({ ticketId: native.owner.ticketId, job: 'native' }); // Untouched.
  });
});

describe('time zones never change a process identity', () => {
  it('an owner recorded under one TZ stays live for a waiter under another (real ps on this process)', () => {
    const saved = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Tokyo';
      const recorded = { pid: process.pid, ...identify(processInfo(process.pid)) };
      process.env.TZ = 'America/Los_Angeles';
      expect(verify(recorded, { processInfo })).toEqual({ live: true });
      process.env.TZ = 'UTC';
      expect(verify(recorded, { processInfo })).toEqual({ live: true });
    } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
  });
});

describe('over 30 minutes and clock changes: report only', () => {
  it('reports an overdue live owner once and keeps waiting without touching it', async () => {
    const host = fakeHost(); const dir = scratch();
    const owner = openQueue(dir, host.proc(1001)); const held = await acquire(owner, request('/w/owner'));
    const before = readFileSync(leaseTop(dir).file);
    const waiting = acquire(openQueue(dir, host.proc(1002)), request('/w/waiter'));
    await settle(() => host.logs.length === 1);
    host.clock.wall += overdueMs + 60000;
    await settle(() => host.logs.some((line) => line.includes('REPORT')));
    const seen = host.queried.length;
    await settle(() => host.queried.length > seen + 40);
    expect(host.logs.filter((line) => line.includes('REPORT'))).toHaveLength(1);
    expect(host.logs.find((line) => line.includes('REPORT'))).toMatch(/held the slot over 30m00s .*Report only: nothing is signalled/u);
    expect(readFileSync(leaseTop(dir).file)).toEqual(before);
    expect(status(owner).owner).toMatchObject({ live: true, overdue: true });
    release(owner, held.owner.ticketId);
    expect((await waiting).mode).toBe('acquired');
    expect(historyEvents(dir)).toContain('overdue');
  });

  it('a clock that moved back shows an unknown hold time and neither reports nor recovers', async () => {
    const host = fakeHost(); const dir = scratch();
    const owner = openQueue(dir, host.proc(1101)); const held = await acquire(owner, request('/w/owner'));
    host.clock.wall -= 3 * 60 * 60 * 1000;
    const waiting = acquire(openQueue(dir, host.proc(1102)), request('/w/waiter'));
    await settle(() => host.logs.length === 1);
    expect(host.logs[0]).toMatch(/held unknown \(clock moved back\)/u);
    expect(status(owner).owner).toMatchObject({ live: true, overdue: false, held: 'unknown (clock moved back)' });
    release(owner, held.owner.ticketId);
    expect((await waiting).owner.pid).toBe(1102);
    expect(historyEvents(dir)).not.toContain('recovered-owner');
    expect(formatDuration(3725000)).toBe('1h02m05s');
  });
});

describe('unusable queue directory: refuse with the reason', () => {
  it('refuses a corrupt record, an unexpected entry, a file, a symlink, a shared or an unwritable directory', async () => {
    const host = fakeHost(); const me = () => host.proc(1201);
    const corrupt = scratch(); openQueue(corrupt, me()); writeFileSync(join(corrupt, 'owner', '000000000001.json'), '{not json');
    await expect(acquire(openQueue(corrupt, me()), request('/w/a'))).rejects.toThrow(/Unrecognized heavy-job queue owner record/u);
    expect(readFileSync(join(corrupt, 'owner', '000000000001.json'), 'utf8')).toBe('{not json'); // Never deleted on a guess.
    writeFileSync(join(corrupt, 'owner', 'note.txt'), 'x');
    expect(() => readOwner(openQueue(corrupt, me()))).toThrow(/Unexpected entry/u);
    const zero = scratch(); openQueue(zero, me()); writeFileSync(join(zero, 'enqueue', '000000000000.json'), leaseRecord(1201));
    await expect(acquire(openQueue(zero, me()), request('/w/a'))).rejects.toThrow(/Unexpected entry .*000000000000\.json/u); // Generations start at 1.

    const legacy = scratch(); writeFileSync(join(legacy, 'owner.json'), '{}');
    expect(() => openQueue(legacy, me())).toThrow(/earlier queue layout/u);

    const counter = scratch(); openQueue(counter, me()); writeFileSync(join(counter, 'seq.json'), '{"schema":1,"seq":-4}');
    await expect(acquire(openQueue(counter, me()), request('/w/a'))).rejects.toThrow(/Unrecognized heavy-job queue counter/u);
    expect(leaseTop(counter, 'enqueue')?.held).toBe(false); // The enqueue lease was released despite the refusal.

    const stray = scratch(); openQueue(stray, me()); writeFileSync(join(stray, 'tickets', 'note.txt'), 'x');
    await expect(acquire(openQueue(stray, me()), request('/w/a'))).rejects.toThrow(/Unexpected entry/u);

    const parent = scratch();
    writeFileSync(join(parent, 'file'), 'x');
    expect(() => openQueue(join(parent, 'file'), me())).toThrow(/not a real directory/u);
    symlinkSync(scratch(), join(parent, 'link'));
    expect(() => openQueue(join(parent, 'link'), me())).toThrow(/not a real directory/u);
    mkdirSync(join(parent, 'shared'), { mode: 0o700 }); chmodSync(join(parent, 'shared'), 0o777);
    expect(() => openQueue(join(parent, 'shared'), me())).toThrow(/writable by group or others/u);
    const locked = scratch(); openQueue(locked, me()); chmodSync(join(locked, 'tickets'), 0o500);
    expect(() => openQueue(locked, me())).toThrow(/is not writable \(EACCES\)/u);
    chmodSync(join(locked, 'tickets'), 0o700);
    expect(() => openQueue('relative/queue', me())).toThrow(HeavyQueueError);
    expect(() => defaultQueueDir({ ORCA_HEAVY_QUEUE_DIR: '/a/../b' })).toThrow(/normalized absolute/u);
    expect(defaultQueueDir({}, 'darwin', '/Users/me')).toBe('/Users/me/Library/Caches/orca-heavy-queue');
  });

  it('refuses when ps cannot tell whether the owner is alive', async () => {
    const host = fakeHost(); const dir = scratch();
    await acquire(openQueue(dir, host.proc(1301)), request('/w/a'));
    const blind = { ...host.proc(1302), processInfo: () => { throw new HeavyQueueError('ps failed (2); cannot verify pid 1301.'); } };
    await expect(acquire(openQueue(dir, blind), request('/w/b'))).rejects.toThrow(/cannot verify pid 1301/u);
    expect(readOwner(openQueue(dir, host.proc(1303))).pid).toBe(1301);
  });

  it('the queue source never signals, kills or searches processes by pattern', () => {
    for (const file of ['scripts/heavy-queue/heavy-queue.mjs', 'scripts/heavy-queue/cli.mjs', 'scripts/lib/heavy-queue.mjs', 'scripts/check.mjs']) {
      const source = readFileSync(join(project, file), 'utf8');
      expect(source, file).not.toMatch(/\.kill\(|pgrep|pkill|killall|'-A'|'-ax'|'-e'|osascript/u);
    }
  });
});

describe('Kioku wiring (opt-in)', () => {
  it('only KIOKU_HEAVY_QUEUE=1 enables the queue', () => {
    for (const env of [{}, { KIOKU_HEAVY_QUEUE: '' }, { KIOKU_HEAVY_QUEUE: '0' }]) expect(heavyQueueEnabled(env)).toBe(false);
    expect(heavyQueueEnabled({ KIOKU_HEAVY_QUEUE: '1' })).toBe(true);
    expect(() => heavyQueueEnabled({ KIOKU_HEAVY_QUEUE: 'yes' })).toThrow(/must be 1/u);
  });

  const checkEntry = (env) => {
    const recorder = join(scratch(), 'fake-npm.mjs'); const record = `${recorder}.json`;
    writeFileSync(recorder, `process.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({ `
      + `argv: process.argv.slice(2), token: process.env.${tokenVariable} ?? null })); process.exit(3);\n`);
    const queueDir = join(scratch(), 'queue');
    const childEnv = { ...process.env, npm_execpath: recorder, ORCA_HEAVY_QUEUE_DIR: queueDir, ...env };
    if (env.KIOKU_HEAVY_QUEUE === undefined) delete childEnv.KIOKU_HEAVY_QUEUE;
    delete childEnv[tokenVariable];
    const result = spawnSync(process.execPath, ['scripts/check.mjs'], { cwd: project, encoding: 'utf8', env: childEnv });
    return { result, queueDir, recorded: JSON.parse(readFileSync(record, 'utf8')) };
  };

  it('npm run check without the variable runs the unchanged steps and never touches the queue directory', () => {
    const { result, queueDir, recorded } = checkEntry({});
    expect(result.status).toBe(3);
    expect(recorded).toEqual({ argv: ['run', 'check:steps'], token: null });
    expect(existsSync(queueDir)).toBe(false);
  }, realProcessTimeout);

  it('opt-out: check:steps is the pre-LEV-305 check chain, and its exit code and output bytes pass through unchanged', () => {
    // Pre-change `check` (7aac9c8). The only console difference is npm's own heading pair for the extra `check:steps` hop.
    expect(JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')).scripts['check:steps'])
      .toBe('npm run validate && npm run lint && npm run typecheck && npm test && npm run build && npm run package');
    for (const code of [0, 1, 2, 3, 127]) {
      const recorder = join(scratch(), 'fake-npm.mjs'); const queueDir = join(scratch(), 'queue');
      writeFileSync(recorder, `process.stdout.write('out\\u00e9\\n'); process.stderr.write('err ${code}\\n'); process.exit(${code});\n`);
      const env = { ...process.env, npm_execpath: recorder, ORCA_HEAVY_QUEUE_DIR: queueDir };
      delete env.KIOKU_HEAVY_QUEUE; delete env[tokenVariable];
      const result = spawnSync(process.execPath, ['scripts/check.mjs'], { cwd: project, env });
      expect(result.status).toBe(code);
      expect(result.stdout.toString('utf8')).toBe('outé\n'); expect(result.stderr.toString('utf8')).toBe(`err ${code}\n`);
      expect(existsSync(queueDir)).toBe(false);
    }
  }, realProcessTimeout);

  it('opt-out: smoke records keep the pre-change schema and quit is unchanged; no queue directory is created', () => {
    const root = createFixture(); fixtures.push(root); prepareVault(root);
    const queueDir = join(scratch(), 'queue');
    const env = { ...process.env, ORCA_HEAVY_QUEUE_DIR: queueDir, KIOKU_CDP_PORT: '9', KIOKU_QUIT_TIMEOUT_MS: '1000' };
    delete env.KIOKU_HEAVY_QUEUE; delete env.KIOKU_BASELINE_ID; delete env.KIOKU_CDP_URL; delete env[tokenVariable];
    const smoke = spawnSync(process.execPath, ['scripts/e2e/smoke.mjs'], { cwd: root, encoding: 'utf8', env });
    expect(smoke.status).toBe(1);
    const runs = readdirSync(join(root, 'artifacts', 'e2e-smoke'));
    expect(runs).toHaveLength(1);
    const record = JSON.parse(readFileSync(join(root, 'artifacts', 'e2e-smoke', runs[0], 'record.json'), 'utf8'));
    expect(Object.keys(record)).toEqual(['status', 'kind', 'startedAt', 'steps', 'restart', 'preflight', 'error', 'finishedAt']);
    expect(record).toMatchObject({ status: 'FAIL', kind: 'native-obsidian-cdp', steps: [] });
    const quit = spawnSync(process.execPath, ['scripts/obsidian-instance-cli.mjs', 'quit'], { cwd: root, encoding: 'utf8', env });
    expect(quit.status, quit.stderr).toBe(0);
    expect(JSON.parse(quit.stdout)).toEqual({ status: 'NOT_RUNNING', message: 'No recorded dedicated instance; nothing was signalled.' });
    expect(existsSync(queueDir)).toBe(false);
  }, realProcessTimeout);

  it('npm run check with KIOKU_HEAVY_QUEUE=1 runs the same steps inside the slot and releases it', () => {
    const { result, queueDir, recorded } = checkEntry({ KIOKU_HEAVY_QUEUE: '1' });
    expect(result.status, result.stderr).toBe(3);
    expect(recorded.argv).toEqual(['run', 'check:steps']); expect(recorded.token).toMatch(/^[0-9a-f-]{36}$/u);
    expect(ownerHeld(queueDir)).toBe(false);
    expect(historyEvents(queueDir)).toEqual(['acquired', 'released']);
  }, realProcessTimeout);

  describe('a failing step always reaches the caller as a non-zero exit', () => {
    const cleanEnv = (extra) => {
      const env = { ...process.env };
      // Strip a surrounding hook's GIT_* (e.g. GIT_INDEX_FILE when this suite runs inside pre-commit) and any held token.
      for (const key of Object.keys(env)) if (key.startsWith('GIT_') || key === tokenVariable || key === 'KIOKU_HEAVY_QUEUE') delete env[key];
      return { ...env, ...extra };
    };
    const fakeNpm = (body) => { const file = join(scratch(), 'fake-npm.mjs'); writeFileSync(file, body); return file; };
    const failures = [['exit 1', 'process.exit(1);', 1], ['exit 3', 'process.exit(3);', 3],
      ['killed by a signal', "process.kill(process.pid, 'SIGKILL');", 1]];

    it('scripts/check.mjs, with and without the queue, exits non-zero and the queued slot is still released', () => {
      for (const queued of [false, true]) {
        for (const [label, body, expected] of failures) {
          const queueDir = join(scratch(), 'queue');
          const result = spawnSync(process.execPath, ['scripts/check.mjs'], { cwd: project, encoding: 'utf8',
            env: cleanEnv({ npm_execpath: fakeNpm(body), ORCA_HEAVY_QUEUE_DIR: queueDir, ...(queued ? { KIOKU_HEAVY_QUEUE: '1' } : {}) }) });
          expect(result.status, `${queued ? 'queued' : 'opt-out'} ${label}: ${result.stderr}`).toBe(expected);
          if (queued) {
            expect(ownerHeld(queueDir)).toBe(false);
            expect(historyEvents(queueDir)).toEqual(['acquired', 'released']);
          } else expect(existsSync(queueDir)).toBe(false);
        }
      }
    }, realProcessTimeout);

    it('the generic CLI returns the command\'s exit status and refuses with 1', () => {
      const dir = join(scratch(), 'queue'); const env = cleanEnv({ ORCA_HEAVY_QUEUE_DIR: dir });
      const run4 = spawnSync(process.execPath, [cli, 'run', '--project', 'p', '--job', 'check', '--', process.execPath, '-e', 'process.exit(4)'],
        { cwd: scratch(), encoding: 'utf8', env });
      expect(run4.status, run4.stderr).toBe(4);
      const killed = spawnSync(process.execPath, [cli, 'run', '--project', 'p', '--job', 'check', '--', process.execPath, '-e',
        "process.kill(process.pid, 'SIGKILL')"], { cwd: scratch(), encoding: 'utf8', env });
      expect(killed.status, killed.stderr).toBe(1); // Killed by a signal: non-zero, never 0.
      const missing = spawnSync(process.execPath, [cli, 'run', '--project', 'p', '--job', 'check', '--', join(scratch(), 'no-such-command')],
        { cwd: scratch(), encoding: 'utf8', env });
      expect(missing.status).toBe(1); expect(missing.stderr).toMatch(/could not start/u);
      const usage = spawnSync(process.execPath, [cli, 'run', '--job', 'check'], { cwd: scratch(), encoding: 'utf8', env });
      expect(usage.status).toBe(1); expect(usage.stderr).toMatch(/Heavy-job queue refused: Usage/u);
      expect(ownerHeld(dir)).toBe(false);
    }, realProcessTimeout);

    it('git commit → .githooks/pre-commit → npm run check → check:steps: a failing step blocks the commit', () => {
      for (const [steps, blocked] of [['node -e "process.exit(5)"', true], [`node -e "process.kill(process.pid, 'SIGKILL')"`, true],
        ['node -e "process.exit(0)"', false]]) {
        const repo = scratch(); const queueDir = join(scratch(), 'queue');
        mkdirSync(join(repo, '.githooks'));
        writeFileSync(join(repo, '.githooks', 'pre-commit'), readFileSync(join(project, '.githooks', 'pre-commit')), { mode: 0o755 });
        writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'hook-probe', private: true,
          scripts: { check: `node ${JSON.stringify(join(project, 'scripts', 'check.mjs'))}`, 'check:steps': steps } }));
        const env = cleanEnv({ ORCA_HEAVY_QUEUE_DIR: queueDir });
        const git = (...args) => spawnSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args],
          { cwd: repo, encoding: 'utf8', env });
        expect(git('init', '-q').status).toBe(0);
        expect(git('config', 'core.hooksPath', '.githooks').status).toBe(0);
        expect(git('add', '.').status).toBe(0);
        const commit = git('commit', '-q', '-m', 'probe');
        expect(commit.status !== 0, `${steps}: ${commit.stderr}`).toBe(blocked);
        expect(git('rev-parse', '--verify', '-q', 'HEAD').status !== 0).toBe(blocked);
        expect(existsSync(queueDir)).toBe(false);
      }
    }, realProcessTimeout);
  });

  it('harness:launch hands the native slot to the dedicated PID, which keeps it after the launch CLI exits', async () => {
    const host = fakeHost(); const dir = scratch(); const env = { ORCA_HEAVY_QUEUE_DIR: dir };
    const launched = await launchWithQueue('/w/kioku', env, async () => {
      host.table.set(4242, { command: 'Obsidian --user-data-dir=/w/kioku/.tooling/obsidian-profile', started: 'x' });
      return { status: 'LAUNCHED', pid: 4242 };
    }, host.proc(1401, 'node scripts/obsidian-instance-cli.mjs launch'));
    expect(launched.heavyQueue).toMatchObject({ slot: 'native', waitedMs: 0, owner: { pid: 4242, job: 'native',
      launcher: { pid: 1401, executable: 'node', ...identify({ command: 'node scripts/obsidian-instance-cli.mjs launch', started: 'x' }),
        started: 'Sat Oct  3 00:00:00 2026' } } });
    host.table.delete(1401); // The launch CLI exits; the slot stays with the dedicated instance.
    let otherDone = false;
    const otherWait = acquire(openQueue(dir, host.proc(1402)), request('/w/mappy')).then(() => { otherDone = true; });
    await settle(() => host.logs.length >= 1);
    expect(otherDone).toBe(false);
    expect(host.logs[0]).toMatch(/owner: project=kioku job=native pid=4242/u);
    expect(assertNativeHeld('/w/kioku', env, host.proc(1403))).toMatchObject({ owner: { pid: 4242 } });
    expect(() => assertNativeHeld('/w/elsewhere', env, host.proc(1404))).toThrow(/only inside this worktree's native slot/u);
    host.table.delete(4242); // Instance gone (even without quit): the waiter recovers the slot.
    await otherWait;
    expect(otherDone).toBe(true);
  });

  it('quit after the instance stopped releases the slot; a timed-out quit keeps it; a failed launch releases it', async () => {
    const host = fakeHost(); const dir = scratch(); const env = { ORCA_HEAVY_QUEUE_DIR: dir };
    await launchWithQueue('/w/kioku', env, async () => { host.table.set(4243, { command: 'Obsidian --user-data-dir=/p', started: 'x' });
      return { pid: 4243 }; }, host.proc(1501));
    await expect(quitWithQueue('/w/kioku', env, async () => { throw new Error('did not exit'); }, host.proc(1502)))
      .rejects.toThrow(/did not exit[\s\S]*still running; slot kept/u);
    expect(readOwner(openQueue(dir, host.proc(1503))).pid).toBe(4243);
    const stopped = await quitWithQueue('/w/kioku', env, async () => { host.table.delete(4243); return { status: 'STOPPED', pid: 4243 }; },
      host.proc(1504));
    expect(stopped).toMatchObject({ status: 'STOPPED', heavyQueue: { released: true, owner: { pid: 4243 } } });
    expect(readOwner(openQueue(dir, host.proc(1505)))).toBeNull();
    // Nothing was spawned and no dedicated instance runs: only then is the slot released.
    await expect(launchWithQueue('/w/kioku', env, async () => { throw new Error('preflight failed'); }, host.proc(1506),
      { instance: async () => ({ running: false }) })).rejects.toThrow(/preflight failed[\s\S]*slot released \(no dedicated instance runs\)/u);
    expect(readOwner(openQueue(dir, host.proc(1507)))).toBeNull();
    expect(historyEvents(dir)).toEqual(['acquired', 'handed-off', 'released-by-quit', 'acquired', 'released-after-failed-launch']);
  });

  it('a launch that fails AFTER spawning keeps the slot with the still-running Obsidian until it is gone', async () => {
    const host = fakeHost(); const dir = scratch(); const env = { ORCA_HEAVY_QUEUE_DIR: dir };
    const obsidian = { command: 'Obsidian --user-data-dir=/w/kioku/.tooling/obsidian-profile', started: 'o' };
    // Spawned (reported right after the PID was recorded), then the page never became ready; Obsidian keeps running.
    await expect(launchWithQueue('/w/kioku', env, async (onSpawned) => {
      host.table.set(4300, obsidian); onSpawned(4300); throw new Error('Timed out waiting for the dedicated page');
    }, host.proc(1601, 'node scripts/obsidian-instance-cli.mjs launch'), { instance: async () => { throw new Error('not consulted'); } }))
      .rejects.toThrow(/Timed out waiting[\s\S]*kept by the still-running dedicated pid 4300/u);
    host.table.delete(1601); // The launch CLI exits.
    const viewer = openQueue(dir, host.proc(1602));
    expect(readOwner(viewer)).toMatchObject({ pid: 4300, job: 'native', worktree: '/w/kioku' });
    let waiterDone = false;
    const waiter = acquire(openQueue(dir, host.proc(1603)), request('/w/other')).then((result) => { waiterDone = true; return result; });
    await settle(() => host.queried.filter((pid) => pid === 4300).length > 10);
    expect(waiterDone).toBe(false); // No second heavy job while that Obsidian runs.
    const quit = await quitWithQueue('/w/kioku', env, async () => { host.table.delete(4300); return { status: 'STOPPED', pid: 4300 }; },
      host.proc(1604));
    expect(quit.heavyQueue).toMatchObject({ released: true, owner: { pid: 4300 } });
    release(viewer, (await waiter).owner.ticketId);

    // Spawned, but it died before the failure was reported: confirmed gone, so the slot is released.
    await expect(launchWithQueue('/w/kioku', env, async (onSpawned) => {
      host.table.set(4301, obsidian); onSpawned(4301); host.table.delete(4301); throw new Error('Obsidian exited during startup');
    }, host.proc(1605))).rejects.toThrow(/exited during startup[\s\S]*slot released \(spawned pid 4301 is gone\)/u);
    expect(readOwner(viewer)).toBeNull();

    // The spawn was not reported, but the recorded dedicated instance runs: the slot is handed to it, not released.
    await expect(launchWithQueue('/w/kioku', env, async () => {
      host.table.set(4302, obsidian); throw new Error('CDP never answered');
    }, host.proc(1606), { instance: async () => ({ running: true, state: { pid: 4302 } }) }))
      .rejects.toThrow(/CDP never answered[\s\S]*handed to the still-running dedicated pid 4302/u);
    expect(readOwner(viewer)).toMatchObject({ pid: 4302, job: 'native' });
  });
});
