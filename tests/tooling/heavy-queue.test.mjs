// Mac-wide heavy-job queue with an injected clock and process table. Never starts Obsidian and never signals a process;
// only the FIFO and check-entry cases start short real child processes against a private temporary queue directory.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { acquire, defaultQueueDir, defaultSystem, formatDuration, HeavyQueueError, listTickets, openQueue, overdueMs, readOwner, release,
  run, status, tokenVariable } from '../../scripts/heavy-queue/heavy-queue.mjs';
import { assertNativeHeld, heavyQueueEnabled, launchWithQueue, quitWithQueue } from '../../scripts/lib/heavy-queue.mjs';
import { prepareVault } from '../../scripts/lib/harness.mjs';
import { cleanup, createFixture } from '../helpers/fixture.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));
const library = join(project, 'scripts', 'heavy-queue', 'heavy-queue.mjs');
const cli = join(project, 'scripts', 'heavy-queue', 'cli.mjs');
const temporary = []; const fixtures = [];
afterEach(() => {
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
/** Poll real processes; never falls through silently (a slow machine fails here with the reason, not later). */
async function waitUntil(predicate, what, limitMs = 45000) {
  const end = Date.now() + limitMs;
  while (!predicate()) { if (Date.now() > end) throw new Error(`Timed out after ${limitMs} ms waiting for ${what}.`); await pause(10); }
}
// Tests that start real Node processes: generous limits so CPU load from other jobs slows them but does not fail them.
const realProcessTimeout = 120000;
const request = (worktree, job = 'check', env = {}) => ({ project: 'kioku', worktree, job, env });
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
    const start = (name, worktree) => {
      mkdirSync(worktree, { recursive: true });
      const child = spawn(process.execPath, [cli, 'run', '--project', 'pilot', '--job', 'check', '--', process.execPath, '-e', job(name)],
        { cwd: worktree, env: { ...process.env, ORCA_HEAVY_QUEUE_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
      return new Promise((resolve) => { child.on('exit', (code) => resolve({ code, stderr })); });
    };
    const first = start('A', join(scratch(), 'a'));
    await waitUntil(() => existsSync(log), 'A to start its job');
    const second = start('B', join(scratch(), 'b'));
    await waitUntil(() => readdirSync(join(dir, 'tickets')).length === 1, 'B to queue behind A');
    writeFileSync(finish, '');
    const [a, b] = await Promise.all([first, second]);
    expect(a.code, a.stderr).toBe(0); expect(b.code, b.stderr).toBe(0);
    expect(readFileSync(log, 'utf8')).toBe('start A\nend A\nstart B\nend B\n');
    expect(b.stderr).toMatch(/waiting for the check slot .*owner: project=pilot job=check pid=\d+/u);
    expect(readdirSync(join(dir, 'tickets'))).toEqual([]); expect(existsSync(join(dir, 'owner.json'))).toBe(false);
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
        return new Promise((resolve) => { child.on('exit', (code) => resolve({ code, stderr })); });
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
    expect(readdirSync(join(dir, 'stale'))).toEqual([]);
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
    const lockRecord = (pid) => JSON.stringify({ schema: 1, ticketId: '00000000-0000-4000-8000-000000000000', project: 'kioku',
      worktree: '/w/crashed', pid, cmdline: `node requester-${pid}`, started: 'Sat Oct  3 00:00:00 2026', job: 'check',
      enqueuedAt: '2026-10-03T00:00:00.000Z' });
    openQueue(dir, host.proc(251));
    writeFileSync(join(dir, 'enqueue.lock'), lockRecord(250)); // pid 250 is not in the table: dead.
    const first = await acquire(openQueue(dir, host.proc(251)), request('/w/a'));
    expect(first.mode).toBe('acquired');
    expect(historyEvents(dir)).toContain('recovered-enqueue-lock');
    host.proc(252); writeFileSync(join(dir, 'enqueue.lock'), lockRecord(252)); // Live holder.
    const observer = openQueue(dir, host.proc(254));
    const waiting = acquire(openQueue(dir, host.proc(253)), request('/w/b'));
    await settle(() => host.queried.filter((pid) => pid === 252).length > 5);
    expect(listTickets(observer)).toEqual([]); expect(existsSync(join(dir, 'enqueue.lock'))).toBe(true);
    rmSync(join(dir, 'enqueue.lock'));
    await settle(() => listTickets(observer).length === 1);
    release(observer, first.owner.ticketId);
    expect((await waiting).owner.pid).toBe(253);
  });

  it('never touches a live owner: owner.json bytes stay identical while waiting, and no process is signalled', async () => {
    const host = fakeHost(); const dir = scratch();
    const owner = openQueue(dir, host.proc(401));
    const held = await acquire(owner, request('/w/owner'));
    const before = readFileSync(join(dir, 'owner.json'));
    let done = false;
    const waiting = acquire(openQueue(dir, host.proc(402)), request('/w/waiter')).then((result) => { done = true; return result; });
    host.clock.wall += 5000;
    await settle(() => host.queried.filter((pid) => pid === 401).length > 20);
    expect(done).toBe(false);
    expect(readFileSync(join(dir, 'owner.json'))).toEqual(before);
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
});

describe('over 30 minutes and clock changes: report only', () => {
  it('reports an overdue live owner once and keeps waiting without touching it', async () => {
    const host = fakeHost(); const dir = scratch();
    const owner = openQueue(dir, host.proc(1001)); const held = await acquire(owner, request('/w/owner'));
    const before = readFileSync(join(dir, 'owner.json'));
    const waiting = acquire(openQueue(dir, host.proc(1002)), request('/w/waiter'));
    await settle(() => host.logs.length === 1);
    host.clock.wall += overdueMs + 60000;
    await settle(() => host.logs.some((line) => line.includes('REPORT')));
    const seen = host.queried.length;
    await settle(() => host.queried.length > seen + 40);
    expect(host.logs.filter((line) => line.includes('REPORT'))).toHaveLength(1);
    expect(host.logs.find((line) => line.includes('REPORT'))).toMatch(/held the slot over 30m00s .*Report only: nothing is signalled/u);
    expect(readFileSync(join(dir, 'owner.json'))).toEqual(before);
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
    const corrupt = scratch(); openQueue(corrupt, me()); writeFileSync(join(corrupt, 'owner.json'), '{not json');
    await expect(acquire(openQueue(corrupt, me()), request('/w/a'))).rejects.toThrow(/Unrecognized heavy-job queue owner record/u);
    expect(readFileSync(join(corrupt, 'owner.json'), 'utf8')).toBe('{not json'); // Never deleted on a guess.

    const counter = scratch(); openQueue(counter, me()); writeFileSync(join(counter, 'seq.json'), '{"schema":1,"seq":-4}');
    await expect(acquire(openQueue(counter, me()), request('/w/a'))).rejects.toThrow(/Unrecognized heavy-job queue counter/u);
    expect(existsSync(join(counter, 'enqueue.lock'))).toBe(false);

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
    expect(existsSync(join(queueDir, 'owner.json'))).toBe(false);
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
            expect(existsSync(join(queueDir, 'owner.json'))).toBe(false);
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
      const missing = spawnSync(process.execPath, [cli, 'run', '--project', 'p', '--job', 'check', '--', join(scratch(), 'no-such-command')],
        { cwd: scratch(), encoding: 'utf8', env });
      expect(missing.status).toBe(1); expect(missing.stderr).toMatch(/could not start/u);
      const usage = spawnSync(process.execPath, [cli, 'run', '--job', 'check'], { cwd: scratch(), encoding: 'utf8', env });
      expect(usage.status).toBe(1); expect(usage.stderr).toMatch(/Heavy-job queue refused: Usage/u);
      expect(existsSync(join(dir, 'owner.json'))).toBe(false);
    }, realProcessTimeout);

    it('git commit → .githooks/pre-commit → npm run check → check:steps: a failing step blocks the commit', () => {
      for (const [steps, blocked] of [['node -e "process.exit(5)"', true], ['node -e "process.exit(0)"', false]]) {
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
      launcher: { pid: 1401, cmdline: 'node scripts/obsidian-instance-cli.mjs launch' } } });
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
    await expect(launchWithQueue('/w/kioku', env, async () => { throw new Error('CDP never answered'); }, host.proc(1506)))
      .rejects.toThrow(/CDP never answered/u);
    expect(readOwner(openQueue(dir, host.proc(1507)))).toBeNull();
    expect(historyEvents(dir)).toEqual(['acquired', 'handed-off', 'released-by-quit', 'acquired', 'released-after-failed-launch']);
  });
});
