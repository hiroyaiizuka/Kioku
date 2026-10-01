// Dedicated-instance tooling with fake process/ps/spawn/CDP. Never starts Obsidian and never signals a real process.
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, createFixture } from '../helpers/fixture.mjs';
import { prepareVault } from '../../scripts/lib/harness.mjs';
import { restrictedModeAction } from '../../scripts/lib/dedicated-cdp.mjs';
import { assertDedicatedStopped, childEnvironment, compareVersions, defaultAsarSourceDir, instancePaths, launchDedicated, ownsProfile,
  portInUse, prepareProfile, quitDedicated, readState, resolveExecutable, resolvePort, selectAsar, vaultId,
  writeState } from '../../scripts/lib/obsidian-instance.mjs';

const roots = [];
afterEach(() => { while (roots.length) cleanup(roots.pop()); });
function setup() {
  const root = createFixture(); roots.push(root); const expected = prepareVault(root);
  const source = join(root, 'fake-app-support'); mkdirSync(source);
  return { root, expected, source, paths: instancePaths(root) };
}
const esrch = () => Object.assign(new Error('no such process'), { code: 'ESRCH' });

/** Fake OS: `alive` PIDs, `commands` per PID for `ps -o command= -p`, `list` for `ps -axo`. */
function fakeSystem({ alive = [], commands = {}, list = '', busyPorts = [], source } = {}) {
  const live = new Set(alive); const signals = []; const spawned = []; const psCalls = [];
  return {
    platform: 'darwin', signals, spawned, psCalls, executable: '/fake/Obsidian.app/Contents/MacOS/Obsidian', asarSourceDir: source,
    kill(pid, signal) {
      if (!live.has(pid)) throw esrch();
      if (signal !== 0) { signals.push([pid, signal]); live.delete(pid); }
    },
    ps(args) {
      psCalls.push(args);
      if (args.includes('-p')) {
        const pid = Number(args.at(-1));
        return pid in commands ? { status: 0, stdout: `${commands[pid]}\n` } : { status: 1, stdout: '' };
      }
      return { status: 0, stdout: list };
    },
    portInUse: async (port) => busyPorts.includes(port),
    sleep: async () => {},
    now: () => new Date('2026-10-02T00:00:00.000Z'),
    spawn(executable, args, options) {
      spawned.push({ executable, args, options }); live.add(4242);
      return { pid: 4242, unref() {}, on() {} };
    },
    waitForDedicatedPage: async ({ version }) => ({ target: { webSocketDebuggerUrl: 'ws://127.0.0.1/fake' }, version }),
    enableCommunityPlugins: async () => 'turned-off-by-harness via app.plugins.setEnable(true) (dedicated profile only)',
  };
}

describe('dedicated Obsidian profile (fake app-support dir, real file bytes)', () => {
  it('registers only test-vault, copies the newest asar, then reuses it when hash-identical', () => {
    const { root, expected, source, paths } = setup();
    writeFileSync(join(source, 'obsidian-1.9.9.asar'), 'old');
    writeFileSync(join(source, 'obsidian-1.14.3.asar'), Buffer.from([1, 2, 3, 255]));
    writeFileSync(join(source, 'obsidian-1.10.0.asar'), 'middle');
    writeFileSync(join(source, 'obsidian-2.0.0-beta.asar'), 'ignored');
    writeFileSync(join(source, 'obsidian.json'), '{"vaults":{"personal":{"path":"/Users/me/Notes","open":true}}}');
    const first = prepareProfile(root, { vault: expected.vault, sourceDir: source, minAppVersion: '1.8.7', now: 1 });
    expect(first).toMatchObject({ version: '1.14.3', reused: false, removed: [] });
    const asar = join(paths.profile, 'obsidian-1.14.3.asar');
    expect(readFileSync(asar)).toEqual(Buffer.from([1, 2, 3, 255]));
    const config = JSON.parse(readFileSync(join(paths.profile, 'obsidian.json'), 'utf8'));
    expect(config).toEqual({ vaults: { [vaultId(expected.vault)]: { path: expected.vault, ts: 1, open: true } }, updateDisabled: true });
    expect(vaultId(expected.vault)).toMatch(/^[0-9a-f]{16}$/u);
    expect(readFileSync(join(source, 'obsidian.json'), 'utf8')).toContain('personal'); // Source never written.

    const inode = statSync(asar).ino;
    expect(prepareProfile(root, { vault: expected.vault, sourceDir: source, minAppVersion: '1.8.7' }).reused).toBe(true);
    expect(statSync(asar).ino).toBe(inode);
    writeFileSync(join(source, 'obsidian-1.14.3.asar'), 'patched same version');
    writeFileSync(join(paths.profile, 'obsidian-1.15.0.asar'), 'stale auto-update must not win');
    const third = prepareProfile(root, { vault: expected.vault, sourceDir: source, minAppVersion: '1.8.7' });
    expect(third).toMatchObject({ reused: false, removed: ['obsidian-1.15.0.asar'] });
    expect(readFileSync(asar, 'utf8')).toBe('patched same version');
    expect(readdirSync(paths.profile).filter((name) => name.endsWith('.asar'))).toEqual(['obsidian-1.14.3.asar']);
  });
  it('selects by numeric semver and refuses below minAppVersion, missing, linked or unsupported sources', () => {
    const { root, source } = setup();
    expect(() => selectAsar(source, '1.8.7')).toThrow(/No installed/);
    writeFileSync(join(source, 'obsidian-1.8.6.asar'), 'too old');
    expect(() => selectAsar(source, '1.8.7')).toThrow(/below manifest.minAppVersion 1.8.7/);
    writeFileSync(join(source, 'obsidian-1.9.10.asar'), 'newest');
    writeFileSync(join(source, 'obsidian-1.9.9.asar'), 'older');
    expect(selectAsar(source, '1.8.7')).toMatchObject({ version: '1.9.10', name: 'obsidian-1.9.10.asar' });
    symlinkSync(join(source, 'obsidian-1.9.9.asar'), join(source, 'obsidian-1.20.0.asar'));
    expect(() => selectAsar(source, '1.8.7')).toThrow(/regular asar/);
    expect(() => selectAsar(join(root, 'missing'), '1.8.7')).toThrow(/not found/);
    expect(compareVersions('1.10.0', '1.9.99')).toBeGreaterThan(0);
    expect(() => defaultAsarSourceDir('linux', '/home/u')).toThrow(/Unsupported platform/);
    expect(defaultAsarSourceDir('darwin', '/Users/u')).toBe('/Users/u/Library/Application Support/obsidian');
  });
  it('keeps the state file contained: linked .tooling / hard links / foreign profiles are refused', () => {
    const { root, paths } = setup();
    const sentinel = join(root, 'sentinel'); mkdirSync(sentinel);
    symlinkSync(sentinel, paths.tooling);
    expect(() => writeState(root, { pid: 10, profile: paths.profile, port: 9222, startedAt: new Date().toISOString() }))
      .toThrow(/symlink/);
    expect(readdirSync(sentinel)).toEqual([]);

    const other = setup();
    writeState(other.root, { pid: 10, profile: other.paths.profile, port: 9222, startedAt: '2026-10-02T00:00:00.000Z' });
    expect(readState(other.root)).toMatchObject({ schema: 1, pid: 10, port: 9222 });
    linkSync(other.paths.state, join(other.root, 'linked-state'));
    expect(() => readState(other.root)).toThrow(/hard link/);
    const third = setup();
    writeState(third.root, { pid: 10, profile: '/Users/me/Library/Application Support/obsidian', port: 9222, startedAt: '2026-10-02T00:00:00.000Z' });
    expect(() => readState(third.root)).toThrow(/Unrecognized/);
  });
});

describe('dedicated Obsidian process control (fake process table)', () => {
  it('matches only the exact dedicated --user-data-dir argument', () => {
    const profile = '/p/.tooling/obsidian-profile';
    expect(ownsProfile(`/A/Obsidian --user-data-dir=${profile} --remote-debugging-port=9222`, profile)).toBe(true);
    expect(ownsProfile(`/A/Obsidian --user-data-dir=${profile}`, profile)).toBe(true);
    expect(ownsProfile(`/A/Obsidian --user-data-dir=${profile}-2`, profile)).toBe(false);
    expect(ownsProfile(`/A/Obsidian --x--user-data-dir=${profile}`, profile)).toBe(false);
    expect(ownsProfile('/Applications/Obsidian.app/Contents/MacOS/Obsidian', profile)).toBe(false);
  });
  it('quit is a no-op without a record and for an exited PID, never signalling anything', async () => {
    const { root, paths } = setup(); const system = fakeSystem();
    expect(await quitDedicated(root, system)).toMatchObject({ status: 'NOT_RUNNING' });
    writeState(root, { pid: 777, profile: paths.profile, port: 9222, startedAt: '2026-10-02T00:00:00.000Z' });
    expect(await quitDedicated(root, system)).toMatchObject({ status: 'NOT_RUNNING', pid: 777 });
    expect(system.signals).toEqual([]); expect(existsSync(paths.state)).toBe(false);
  });
  it('quit refuses to signal a live PID whose command line lacks the dedicated profile (e.g. the user Obsidian)', async () => {
    const { root, paths } = setup();
    const system = fakeSystem({ alive: [555], commands: { 555: '/Applications/Obsidian.app/Contents/MacOS/Obsidian' } });
    writeState(root, { pid: 555, profile: paths.profile, port: 9222, startedAt: '2026-10-02T00:00:00.000Z' });
    const result = await quitDedicated(root, system);
    expect(result.status).toBe('NOT_RUNNING'); expect(result.message).toMatch(/without the dedicated --user-data-dir.*nothing was signalled/);
    expect(system.signals).toEqual([]);
    expect(system.psCalls).toContainEqual(['-ww', '-o', 'command=', '-p', '555']);
  });
  it('quit sends SIGTERM only to the verified recorded PID and clears the state', async () => {
    const { root, paths } = setup();
    const system = fakeSystem({ alive: [555, 4242], commands: { 4242: `/A/Obsidian --user-data-dir=${paths.profile} --remote-debugging-port=9222`,
      555: '/Applications/Obsidian.app/Contents/MacOS/Obsidian' } });
    writeState(root, { pid: 4242, profile: paths.profile, port: 9222, startedAt: '2026-10-02T00:00:00.000Z' });
    expect(await quitDedicated(root, system)).toMatchObject({ status: 'STOPPED', pid: 4242 });
    expect(system.signals).toEqual([[4242, 'SIGTERM']]); expect(existsSync(paths.state)).toBe(false);
  });
  it('quit waits (without signalling) for helper processes that still use the profile', async () => {
    const { root, paths } = setup();
    const system = fakeSystem({ alive: [4242], commands: { 4242: `/A/Obsidian --user-data-dir=${paths.profile}` } });
    let polls = 0; const ps = system.ps;
    system.ps = (args) => (args.includes('-A') && (polls += 1) < 3
      ? { status: 0, stdout: `  91 /A/Obsidian Helper (GPU) --user-data-dir=${paths.profile}\n` } : ps(args));
    writeState(root, { pid: 4242, profile: paths.profile, port: 9222, startedAt: '2026-10-02T00:00:00.000Z' });
    expect(await quitDedicated(root, system)).toMatchObject({ status: 'STOPPED' });
    expect(polls).toBe(3); expect(system.signals).toEqual([[4242, 'SIGTERM']]);
    const stuck = setup(); const always = fakeSystem({ alive: [4242], commands: { 4242: `/A/Obsidian --user-data-dir=${stuck.paths.profile}` },
      list: `  91 /A/Obsidian Helper --user-data-dir=${stuck.paths.profile}\n` });
    writeState(stuck.root, { pid: 4242, profile: stuck.paths.profile, port: 9222, startedAt: '2026-10-02T00:00:00.000Z' });
    await expect(quitDedicated(stuck.root, always, 0)).rejects.toThrow(/helpers still use the dedicated profile \(pid 91\)/);
    expect(always.signals).toEqual([[4242, 'SIGTERM']]);
  });
  it('treats an unexpected ps failure as unverifiable instead of guessing', async () => {
    const { root, paths } = setup();
    const system = fakeSystem({ alive: [4242] }); system.ps = () => ({ status: 2, stdout: '' });
    writeState(root, { pid: 4242, profile: paths.profile, port: 9222, startedAt: '2026-10-02T00:00:00.000Z' });
    await expect(quitDedicated(root, system)).rejects.toThrow(/ps failed \(2\)/);
    await expect(assertDedicatedStopped(root, [9222], system)).rejects.toThrow(/ps failed/);
    expect(system.signals).toEqual([]); expect(readState(root).pid).toBe(4242);
  });
  it('quit keeps the record and fails when the process ignores SIGTERM', async () => {
    const { root, paths } = setup();
    const system = fakeSystem({ commands: { 4242: `/A/Obsidian --user-data-dir=${paths.profile}` } });
    system.kill = (pid, signal) => { if (signal) system.signals.push([pid, signal]); };
    writeState(root, { pid: 4242, profile: paths.profile, port: 9222, startedAt: '2026-10-02T00:00:00.000Z' });
    await expect(quitDedicated(root, system, 0)).rejects.toThrow(/did not exit/);
    expect(readState(root).pid).toBe(4242);
  });
  it('launch refuses when the recorded instance is alive, a profile process exists, or the CDP port is in use', async () => {
    const { root, paths, source } = setup(); writeFileSync(join(source, 'obsidian-1.14.3.asar'), 'asar');
    writeState(root, { pid: 4242, profile: paths.profile, port: 9222, startedAt: '2026-10-02T00:00:00.000Z' });
    const running = fakeSystem({ source, alive: [4242], commands: { 4242: `/A/Obsidian --user-data-dir=${paths.profile}` } });
    await expect(launchDedicated(root, {}, running)).rejects.toThrow(/already running \(pid 4242\)/);
    const stray = fakeSystem({ source, list: `  91 /A/Obsidian Helper --type=gpu --user-data-dir=${paths.profile}\n 92 /bin/zsh\n` });
    await expect(launchDedicated(root, {}, stray)).rejects.toThrow(/pid 91/);
    const busy = fakeSystem({ source, busyPorts: [9333] });
    await expect(launchDedicated(root, { KIOKU_CDP_PORT: '9333' }, busy)).rejects.toThrow(/9333 is already in use/);
    await expect(launchDedicated(root, {}, { ...fakeSystem({ source }), platform: 'linux' })).rejects.toThrow(/Unsupported platform/);
    for (const system of [running, stray, busy]) expect(system.spawned).toEqual([]);
    expect(existsSync(paths.profile)).toBe(false);
  });
  it('launch executes the binary with the dedicated profile, loopback CDP and private HOME, and records the PID', async () => {
    const { root, expected, paths, source } = setup(); writeFileSync(join(source, 'obsidian-1.14.3.asar'), 'asar');
    const system = fakeSystem({ source });
    const env = { KIOKU_CDP_PORT: '9333', ELECTRON_RUN_AS_NODE: '1', ELECTRON_ENABLE_LOGGING: '1', NODE_OPTIONS: '--inspect',
      HOME: '/Users/me', PATH: '/usr/bin' };
    const result = await launchDedicated(root, env, system);
    expect(result).toMatchObject({ status: 'LAUNCHED', pid: 4242, version: '1.14.3', port: 9333, vault: expected.vault });
    const [{ executable, args, options }] = system.spawned;
    expect(executable).toBe(system.executable);
    expect(args).toEqual([`--user-data-dir=${paths.profile}`, '--remote-debugging-port=9333', '--remote-debugging-address=127.0.0.1']);
    expect(options).toMatchObject({ detached: true, cwd: paths.home });
    expect(options.env).toEqual({ KIOKU_CDP_PORT: '9333', HOME: paths.home, PATH: '/usr/bin' }); // From the passed env only.
    expect(childEnvironment({ ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: 'x', ELECTRONX: 'kept', HOME: '/h' }, '/d'))
      .toEqual({ ELECTRONX: 'kept', HOME: '/d' });
    expect(readState(root)).toMatchObject({ pid: 4242, profile: paths.profile, port: 9333, startedAt: '2026-10-02T00:00:00.000Z' });
    expect(existsSync(paths.log)).toBe(true);
  });
  it('launch refuses while another launch holds the lock, and keeps the record when the page wait fails but the process lives', async () => {
    const { root, paths, source } = setup(); writeFileSync(join(source, 'obsidian-1.14.3.asar'), 'asar');
    mkdirSync(paths.tooling); writeFileSync(paths.lock, '');
    const locked = fakeSystem({ source });
    await expect(launchDedicated(root, {}, locked)).rejects.toThrow(/Another harness:launch/);
    expect(locked.spawned).toEqual([]); expect(existsSync(paths.lock)).toBe(true);
    const other = setup(); writeFileSync(join(other.source, 'obsidian-1.14.3.asar'), 'asar');
    const system = fakeSystem({ source: other.source });
    system.waitForDedicatedPage = async () => { throw new Error('Timed out.'); };
    await expect(launchDedicated(other.root, {}, system)).rejects.toThrow(/Timed out.*harness:quit/);
    expect(readState(other.root).pid).toBe(4242); expect(existsSync(other.paths.lock)).toBe(false);
  });
  it('launch recovers a stale lock whose owner PID is dead, but not one held by a live PID', async () => {
    const { root, paths, source } = setup(); writeFileSync(join(source, 'obsidian-1.14.3.asar'), 'asar');
    mkdirSync(paths.tooling); writeFileSync(paths.lock, '999999\n');
    const live = fakeSystem({ source, alive: [999999] });
    await expect(launchDedicated(root, {}, live)).rejects.toThrow(/pid 999999\) holds/);
    expect(live.spawned).toEqual([]);
    const system = fakeSystem({ source });
    expect(await launchDedicated(root, {}, system)).toMatchObject({ status: 'LAUNCHED' });
    expect(existsSync(paths.lock)).toBe(false);
  });
  it('stale-lock recovery never deletes a competitor\'s fresh lock (rename + verify + restore)', async () => {
    const { root, paths, source } = setup(); writeFileSync(join(source, 'obsidian-1.14.3.asar'), 'asar');
    mkdirSync(paths.tooling); writeFileSync(paths.lock, '999999\n');
    // Competitor B recovers the same dead owner first and writes its own live lock just before we rename.
    const system = fakeSystem({ source, alive: [777] });
    system.lockRace = (stage) => { if (stage === 'stale') writeFileSync(paths.lock, '777\n'); };
    await expect(launchDedicated(root, {}, system)).rejects.toThrow(/pid 777\) holds/);
    expect(readFileSync(paths.lock, 'utf8')).toBe('777\n');
    expect(readdirSync(paths.tooling).filter((name) => name.includes('.stale-'))).toEqual([]);
    expect(system.spawned).toEqual([]);
  });
  for (const stage of ['exists', 'stale']) {
    it(`retries when the lock vanishes at the ${stage} stage (competitor released it)`, async () => {
      const { root, paths, source } = setup(); writeFileSync(join(source, 'obsidian-1.14.3.asar'), 'asar');
      mkdirSync(paths.tooling); writeFileSync(paths.lock, '999999\n');
      const system = fakeSystem({ source }); let fired = false;
      system.lockRace = (current) => { if (current === stage && !fired) { fired = true; unlinkSync(paths.lock); } };
      expect(await launchDedicated(root, {}, system)).toMatchObject({ status: 'LAUNCHED' });
      expect(fired).toBe(true); expect(existsSync(paths.lock)).toBe(false);
      expect(readdirSync(paths.tooling).filter((name) => name.includes('.stale-'))).toEqual([]);
    });
  }
  it('three launchers: keeps the second launcher\'s moved lock, warns with its name, and re-evaluates', async () => {
    const { root, paths, source } = setup(); writeFileSync(join(source, 'obsidian-1.14.3.asar'), 'asar');
    mkdirSync(paths.tooling); writeFileSync(paths.lock, '999999\n');
    const system = fakeSystem({ source, alive: [777, 888] }); const warnings = [];
    system.warn = (message) => warnings.push(message);
    system.lockRace = (stage) => {
      if (stage === 'stale') writeFileSync(paths.lock, '777\n'); // B recovered the dead lock first.
      if (stage === 'restore') writeFileSync(paths.lock, '888\n'); // C created a newer lock before our restore.
    };
    await expect(launchDedicated(root, {}, system)).rejects.toThrow(/pid 888\) holds/);
    const kept = readdirSync(paths.tooling).filter((name) => name.includes('.stale-'));
    expect(kept).toHaveLength(1); expect(readFileSync(join(paths.tooling, kept[0]), 'utf8')).toBe('777\n');
    expect(warnings.join()).toContain(kept[0]); expect(readFileSync(paths.lock, 'utf8')).toBe('888\n');
  });
  it('cleans leftover stale-lock files only when their owner pid is dead', async () => {
    const { root, paths, source } = setup(); writeFileSync(join(source, 'obsidian-1.14.3.asar'), 'asar');
    mkdirSync(paths.tooling);
    writeFileSync(join(paths.tooling, 'obsidian-launch.lock.stale-1-dead'), '999999\n');
    writeFileSync(join(paths.tooling, 'obsidian-launch.lock.stale-2-live'), '777\n');
    writeFileSync(join(paths.tooling, 'obsidian-launch.lock.stale-3-garbage'), 'not a pid\n');
    const system = fakeSystem({ source, alive: [777] });
    expect(await launchDedicated(root, {}, system)).toMatchObject({ status: 'LAUNCHED' });
    expect(readdirSync(paths.tooling).filter((name) => name.includes('.stale-')).sort())
      .toEqual(['obsidian-launch.lock.stale-2-live', 'obsidian-launch.lock.stale-3-garbage']);
  });
  it('a lock release failure only warns and never masks a successful launch', async () => {
    const { root, paths, source } = setup(); writeFileSync(join(source, 'obsidian-1.14.3.asar'), 'asar');
    const system = fakeSystem({ source }); const warnings = [];
    system.warn = (message) => warnings.push(message);
    system.waitForDedicatedPage = async ({ version }) => {
      linkSync(paths.lock, join(paths.tooling, 'transient-link')); // Like the restore window: nlink 2.
      return { target: { webSocketDebuggerUrl: 'ws://x' }, version };
    };
    expect(await launchDedicated(root, {}, system)).toMatchObject({ status: 'LAUNCHED', pid: 4242 });
    expect(warnings.join()).toMatch(/Could not release .*hard link/); expect(existsSync(paths.lock)).toBe(true);
  });
  it('releases only its own lock when another launcher replaced it meanwhile', async () => {
    const { root, paths, source } = setup(); writeFileSync(join(source, 'obsidian-1.14.3.asar'), 'asar');
    const system = fakeSystem({ source });
    system.waitForDedicatedPage = async ({ version }) => {
      writeFileSync(paths.lock, '777\n'); return { target: { webSocketDebuggerUrl: 'ws://x' }, version };
    };
    await launchDedicated(root, {}, system);
    expect(readFileSync(paths.lock, 'utf8')).toBe('777\n');
  });
  it('launch reports an asynchronous spawn failure without an unhandled error event', async () => {
    const { root, paths, source } = setup(); writeFileSync(join(source, 'obsidian-1.14.3.asar'), 'asar');
    const system = fakeSystem({ source });
    system.spawn = () => {
      const child = new EventEmitter();
      process.nextTick(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
      return child;
    };
    await expect(launchDedicated(root, {}, system)).rejects.toThrow(/Failed to start/);
    await new Promise((resolve) => setImmediate(resolve)); // The async 'error' fires here and must be handled.
    expect(existsSync(paths.state)).toBe(false); expect(existsSync(paths.lock)).toBe(false);
  });
  it('quit fails, listing verified command lines, when an unrecorded process uses the profile (e.g. app.relaunch)', async () => {
    const { root, paths } = setup();
    const command = `/A/Obsidian --user-data-dir=${paths.profile} --remote-debugging-port=9222`;
    const system = fakeSystem({ alive: [5151], commands: { 5151: command }, list: `  5151 ${command}\n  300 /Applications/Obsidian.app/Contents/MacOS/Obsidian\n` });
    writeState(root, { pid: 4242, profile: paths.profile, port: 9222, startedAt: '2026-10-02T00:00:00.000Z' });
    await expect(quitDedicated(root, system)).rejects.toThrow(new RegExp(`nothing was signalled[\\s\\S]*5151 ${command.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`));
    expect(system.signals).toEqual([]); expect(existsSync(paths.state)).toBe(false);
    await expect(quitDedicated(root, system)).rejects.toThrow(/5151/); // Also without any record.
  });
  it('launch keeps no record when the new process exits before its page appears', async () => {
    const { root, paths, source } = setup(); writeFileSync(join(source, 'obsidian-1.14.3.asar'), 'asar');
    const system = fakeSystem({ source });
    system.waitForDedicatedPage = async () => { system.kill = () => { throw esrch(); }; throw new Error('exited early.'); };
    await expect(launchDedicated(root, {}, system)).rejects.toThrow(/exited early/);
    expect(existsSync(paths.state)).toBe(false);
  });
});

describe('baseline precondition is about the dedicated instance only', () => {
  it('refuses while the dedicated instance is alive or a CDP port answers, and ignores other Obsidian processes', async () => {
    const { root, paths } = setup();
    const userObsidian = '  300 /Applications/Obsidian.app/Contents/MacOS/Obsidian\n';
    expect(await assertDedicatedStopped(root, [9222], fakeSystem({ list: userObsidian, alive: [300] })))
      .toEqual({ dedicatedInstance: 'not-running', checkedPorts: [9222], staleRecord: null });
    writeState(root, { pid: 4242, profile: paths.profile, port: 9444, startedAt: '2026-10-02T00:00:00.000Z' });
    const alive = fakeSystem({ alive: [4242], commands: { 4242: `/A/Obsidian --user-data-dir=${paths.profile}` } });
    await expect(assertDedicatedStopped(root, [9222], alive)).rejects.toThrow(/pid 4242\) is running/);
    await expect(assertDedicatedStopped(root, [9222], fakeSystem({ busyPorts: [9444] }))).rejects.toThrow(/9444 already answers/);
    await expect(assertDedicatedStopped(root, [9222], fakeSystem({ busyPorts: [9222] }))).rejects.toThrow(/9222 already answers/);
    expect(await assertDedicatedStopped(root, [9222], fakeSystem())).toMatchObject({ staleRecord: 'recorded PID has exited' });
    const stray = fakeSystem({ list: `  91 /A/Obsidian Helper --user-data-dir=${paths.profile}\n` });
    await expect(assertDedicatedStopped(root, [9222], stray)).rejects.toThrow(/pid 91/);
  });
  it('detects a real listening loopback port', async () => {
    const server = createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try { expect(await portInUse(port)).toBe(true); } finally { await new Promise((resolve) => server.close(resolve)); }
    expect(await portInUse(port)).toBe(false);
  });
});

describe('configuration and restricted-mode decisions', () => {
  it('accepts only an absolute executable and a valid port', () => {
    expect(resolveExecutable({ KIOKU_OBSIDIAN_BINARY: process.execPath })).toBe(process.execPath);
    for (const value of ['Obsidian', './Obsidian', '/nonexistent/Obsidian', '/usr/../usr/bin/env', '/etc/hosts']) {
      expect(() => resolveExecutable({ KIOKU_OBSIDIAN_BINARY: value })).toThrow(/KIOKU_OBSIDIAN_BINARY/);
    }
    expect(resolvePort({})).toBe(9222); expect(resolvePort({ KIOKU_CDP_PORT: '9333' })).toBe(9333);
    for (const value of ['80', '70000', '9222x', '']) expect(() => resolvePort({ KIOKU_CDP_PORT: value })).toThrow(/KIOKU_CDP_PORT/);
  });
  it('turns restricted mode off only for the known trust dialog or a stored restricted choice', () => {
    expect(restrictedModeAction({ enabled: true, choice: 'true', trustModals: 0, modals: 0 }, false)).toBe('none');
    expect(restrictedModeAction({ enabled: false, choice: null, trustModals: 1, modals: 1 }, false)).toBe('enable-and-close-trust');
    expect(restrictedModeAction({ enabled: false, choice: 'false', trustModals: 0, modals: 0 }, false)).toBe('enable');
    expect(restrictedModeAction({ enabled: false, choice: null, trustModals: 0, modals: 0 }, false)).toBe('wait');
    expect(() => restrictedModeAction({ enabled: false, choice: null, trustModals: 0, modals: 0 }, true)).toThrow(/refusing to guess/);
    expect(() => restrictedModeAction({ enabled: false, choice: null, trustModals: 1, modals: 2 }, false)).toThrow(/Unexpected modal/);
    expect(() => restrictedModeAction({ enabled: false, choice: null, trustModals: 0, modals: 1 }, false)).toThrow(/Unexpected modal/);
    expect(restrictedModeAction({ enabled: true, choice: 'true', trustModals: 1, modals: 1 }, false)).toBe('close-trust');
    expect(() => restrictedModeAction({ enabled: true, choice: 'true', trustModals: 1, modals: 2 }, false)).toThrow(/Unexpected modal/);
    expect(() => restrictedModeAction({ enabled: true, choice: 'true', trustModals: 0, modals: 1 }, false)).toThrow(/Unexpected modal/);
  });
});
