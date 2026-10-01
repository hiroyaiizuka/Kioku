// Dedicated, concurrent Obsidian instance for test-vault only (tooling; never part of the plugin runtime).
// The user's own Obsidian keeps running: Electron's single-instance lock is per --user-data-dir, so this
// instance uses a profile inside the project and is identified/terminated only by its recorded PID.
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, closeSync, constants, lstatSync, openSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { userInfo } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import { readJSON, sha256 } from './build.mjs';
import { preflight } from './harness.mjs';
import { atomicWrite, ensureDirectory, safePath, safeRead } from './paths.mjs';
import { sleep } from './cdp.mjs';

export const defaultExecutable = '/Applications/Obsidian.app/Contents/MacOS/Obsidian';
export const defaultPort = 9222;
const asarPattern = /^obsidian-(\d+)\.(\d+)\.(\d+)\.asar$/u;

export function instancePaths(root) {
  const tooling = join(root, '.tooling');
  return {
    tooling,
    profile: join(tooling, 'obsidian-profile'),
    // HOME for the dedicated process only. Obsidian (macOS) unlinks and re-listens on ~/.obsidian-cli.sock at
    // startup and unlinks it on quit; a private HOME keeps the user's instance socket untouched.
    home: join(tooling, 'obsidian-home'),
    state: join(tooling, 'obsidian-instance.json'),
    lock: join(tooling, 'obsidian-launch.lock'),
    log: join(tooling, 'obsidian-instance.log'),
  };
}

/** Deterministic 16-hex vault ID so per-vault localStorage (restricted-mode choice) survives relaunch. */
export const vaultId = (vault) => sha256(`kioku-test-vault:${vault}`).slice(0, 16);

/** Profile-level obsidian.json: registers ONLY the dedicated vault and disables self-update of the profile. */
export function obsidianConfig(vault, now = Date.now()) {
  return { vaults: { [vaultId(vault)]: { path: vault, ts: now, open: true } }, updateDisabled: true };
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version ?? '');
  if (!match) throw new Error(`Invalid version: ${version}`);
  return match.slice(1).map(Number);
}
export function compareVersions(a, b) {
  const [left, right] = [parseVersion(a), parseVersion(b)];
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
}

function assertSupported(platform) {
  if (platform !== 'darwin') {
    throw new Error(`Unsupported platform for the dedicated Obsidian harness: ${platform}. Only macOS is supported; nothing was started.`);
  }
}

/** Obsidian's own app-support dir (read-only source of installed obsidian-<ver>.asar). macOS only. */
export function defaultAsarSourceDir(platform = process.platform, home = userInfo().homedir) {
  assertSupported(platform);
  return join(home, 'Library', 'Application Support', 'obsidian');
}

/** Pick the newest installed obsidian-<semver>.asar; read-only, regular files only. */
export function selectAsar(sourceDir, minAppVersion) {
  let directory;
  try { directory = lstatSync(sourceDir); } catch { directory = null; }
  if (!directory?.isDirectory() || directory.isSymbolicLink()) {
    throw new Error(`Obsidian app-support directory not found (or not a real directory): ${sourceDir}`);
  }
  const candidates = readdirSync(sourceDir).filter((name) => asarPattern.test(name))
    .map((name) => ({ name, version: asarPattern.exec(name).slice(1).join('.') }))
    .sort((a, b) => compareVersions(b.version, a.version));
  if (!candidates.length) {
    throw new Error('No installed obsidian-<version>.asar found. Update your normal Obsidian once; the bundled installer version is not used.');
  }
  const [newest] = candidates;
  if (compareVersions(newest.version, minAppVersion) < 0) {
    throw new Error(`Installed Obsidian ${newest.version} is below manifest.minAppVersion ${minAppVersion}; refusing to launch.`);
  }
  const file = join(sourceDir, newest.name);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular asar file: ${file}`);
  const bytes = readFileSync(file);
  return { ...newest, source: file, bytes, sha256: sha256(bytes) };
}

/** Create the in-project profile, copy (or reuse) the asar, and register only test-vault. */
export function prepareProfile(root, { vault, sourceDir, minAppVersion, now = Date.now() }) {
  const paths = instancePaths(root);
  ensureDirectory(root, paths.tooling); ensureDirectory(root, paths.profile); ensureDirectory(root, paths.home);
  const asar = selectAsar(sourceDir, minAppVersion);
  const destination = join(paths.profile, asar.name);
  const reused = safePath(root, destination, 'file', true) && sha256(safeRead(root, destination)) === asar.sha256;
  if (!reused) atomicWrite(root, destination, asar.bytes);
  // Obsidian's loader runs the newest obsidian-*.asar in userData: keep exactly the chosen one.
  const removed = [];
  for (const name of readdirSync(paths.profile).sort()) {
    if (name !== asar.name && (/^obsidian-.*\.asar$/u.test(name) || name === 'obsidian.asar.tmp')) {
      const file = join(paths.profile, name); safePath(root, file, 'file'); unlinkSync(file); removed.push(name);
    }
  }
  const config = obsidianConfig(vault, now);
  atomicWrite(root, join(paths.profile, 'obsidian.json'), `${JSON.stringify(config)}\n`);
  return { version: asar.version, asar: destination, source: asar.source, sha256: asar.sha256, reused, removed, config };
}

export function resolvePort(env = process.env) {
  const raw = env.KIOKU_CDP_PORT ?? String(defaultPort);
  if (!/^\d{4,5}$/u.test(raw) || Number(raw) < 1024 || Number(raw) > 65535) {
    throw new Error('KIOKU_CDP_PORT must be an integer between 1024 and 65535.');
  }
  return Number(raw);
}

export function resolveExecutable(env = process.env) {
  const configured = env.KIOKU_OBSIDIAN_BINARY;
  const executable = configured ?? defaultExecutable;
  if (configured !== undefined && (!isAbsolute(configured) || normalize(configured) !== configured)) {
    throw new Error('KIOKU_OBSIDIAN_BINARY must be a normalized absolute path to the Obsidian executable.');
  }
  let stat;
  try { stat = statSync(executable); accessSync(executable, constants.X_OK); } catch { stat = null; }
  if (!stat?.isFile()) {
    throw new Error(`Obsidian executable not found or not executable: ${executable} (set KIOKU_OBSIDIAN_BINARY).`);
  }
  return executable;
}

export const profileFlag = (profile) => `--user-data-dir=${profile}`;
/** True only for an exact --user-data-dir=<profile> argument (not a prefix such as <profile>-2). */
export function ownsProfile(command, profile) {
  const flag = profileFlag(profile);
  for (let index = command.indexOf(flag); index >= 0; index = command.indexOf(flag, index + 1)) {
    const before = index === 0 ? ' ' : command[index - 1];
    const after = command[index + flag.length];
    if (before === ' ' && (after === undefined || after === ' ')) return true;
  }
  return false;
}

/** Run /bin/ps without a shell; returns { status, stdout }. */
function runPs(args) {
  const result = spawnSync('/bin/ps', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout };
}

export const defaultSystem = {
  platform: process.platform,
  kill: (pid, signal) => process.kill(pid, signal),
  ps: runPs,
  spawn,
  portInUse,
  sleep,
  now: () => new Date(),
};

export function isAlive(pid, system = defaultSystem) {
  try { system.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

/** `ps -o command= -p <pid>`; empty when the process does not exist (ps exit 1). */
export function commandOf(pid, system = defaultSystem) {
  const result = system.ps(['-ww', '-o', 'command=', '-p', String(pid)]);
  if (result.status === 1) return '';
  if (result.status !== 0) throw new Error(`ps failed (${result.status}); cannot verify pid ${pid}.`);
  return result.stdout.trim();
}

/** Every process (main or helper) whose command line carries the dedicated profile flag. */
export function profileProcesses(profile, system = defaultSystem) {
  const result = system.ps(['-A', '-ww', '-o', 'pid=,command=']);
  if (result.status !== 0) throw new Error(`ps failed (${result.status}); cannot verify the dedicated profile is unused.`);
  return result.stdout.split('\n').map((line) => /^\s*(\d+)\s+(.*)$/u.exec(line))
    .filter((match) => match && ownsProfile(match[2], profile)).map((match) => Number(match[1]));
}

/** Anything accepting a loopback connection (or blocking our bind) counts as "in use". */
export async function portInUse(port, host = '127.0.0.1') {
  const answered = await new Promise((resolve) => {
    const socket = connect({ port, host });
    socket.setTimeout(1000, () => { socket.destroy(); resolve(true); });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', (error) => resolve(error.code !== 'ECONNREFUSED'));
  });
  if (answered) return true;
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(true));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(false)));
  });
}

export function readState(root) {
  const paths = instancePaths(root);
  if (!safePath(root, paths.state, 'file', true)) return null;
  let state;
  try { state = JSON.parse(safeRead(root, paths.state).toString('utf8')); } catch { state = null; }
  if (!state || state.schema !== 1 || !Number.isSafeInteger(state.pid) || state.pid <= 1 || state.profile !== paths.profile
      || !Number.isSafeInteger(state.port) || typeof state.startedAt !== 'string' || !Number.isFinite(Date.parse(state.startedAt))) {
    throw new Error(`Unrecognized dedicated-instance state file: ${paths.state}. Refusing to act on it; inspect it manually.`);
  }
  return state;
}

export function writeState(root, state) {
  const paths = instancePaths(root);
  ensureDirectory(root, paths.tooling);
  atomicWrite(root, paths.state, `${JSON.stringify({ schema: 1, ...state }, null, 2)}\n`);
}

export function clearState(root) {
  const paths = instancePaths(root);
  if (safePath(root, paths.state, 'file', true)) unlinkSync(paths.state);
}

/** The recorded PID is ours only while alive AND its command line carries the dedicated profile flag. */
export function recordedInstance(root, system = defaultSystem) {
  const state = readState(root);
  if (!state) return { state: null, running: false };
  if (!isAlive(state.pid, system)) return { state, running: false, reason: 'recorded PID has exited' };
  if (!ownsProfile(commandOf(state.pid, system), state.profile)) {
    return { state, running: false, reason: 'recorded PID now belongs to a process without the dedicated --user-data-dir' };
  }
  return { state, running: true };
}

/**
 * Baseline precondition: the dedicated instance is not running and no CDP port answers.
 * It does not (and must not) inspect or require closing the user's own Obsidian.
 */
export async function assertDedicatedStopped(root, ports, system = defaultSystem, host = '127.0.0.1') {
  const paths = instancePaths(root);
  const recorded = recordedInstance(root, system);
  if (recorded.running) {
    throw new Error(`Dedicated Obsidian (pid ${recorded.state.pid}) is running; run npm run harness:quit before baseline capture.`);
  }
  const strays = profileProcesses(paths.profile, system);
  if (strays.length) throw new Error(`Processes still use the dedicated profile (pid ${strays.join(', ')}); run npm run harness:quit.`);
  const checked = [...new Set([...ports, ...(recorded.state ? [recorded.state.port] : [])])];
  for (const port of checked) {
    if (await system.portInUse(port) || (!['127.0.0.1', 'localhost'].includes(host) && await system.portInUse(port, host))) {
      throw new Error(`CDP port ${port} already answers; the dedicated instance (or something else) is up. Baseline must precede startup.`);
    }
  }
  return { dedicatedInstance: 'not-running', checkedPorts: checked, staleRecord: recorded.reason ?? null };
}

function childEnvironment(home) {
  const env = { ...process.env, HOME: home };
  // ELECTRON_RUN_AS_NODE etc. would change what the binary does; NODE_OPTIONS must not leak into Electron.
  for (const key of Object.keys(env)) if (key.startsWith('ELECTRON_') || key === 'NODE_OPTIONS') delete env[key];
  return env;
}

/**
 * Launch the dedicated instance. `system.waitForDedicatedPage` / `system.enableCommunityPlugins` perform the CDP part
 * (see dedicated-cdp.mjs); unit tests inject fakes and never start Obsidian.
 */
export async function launchDedicated(root, env = process.env, system = defaultSystem) {
  assertSupported(system.platform);
  const paths = instancePaths(root);
  ensureDirectory(root, paths.tooling);
  safePath(root, paths.lock, 'file', true);
  // Exclusive launch lock: overlapping launches must not overwrite / clear each other's record.
  try { closeSync(openSync(paths.lock, 'wx', 0o600)); }
  catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`Another harness:launch holds ${paths.lock}. If none is running, delete that file and retry.`);
    }
    throw error;
  }
  try { return await launchLocked(root, env, system, paths); }
  finally { if (safePath(root, paths.lock, 'file', true)) unlinkSync(paths.lock); }
}

async function launchLocked(root, env, system, paths) {
  const expected = preflight(root);
  const { minAppVersion } = readJSON(root, 'manifest.json');
  const port = resolvePort(env);
  const executable = system.executable ?? resolveExecutable(env);
  const recorded = recordedInstance(root, system);
  if (recorded.running) {
    throw new Error(`Dedicated Obsidian is already running (pid ${recorded.state.pid}). Use it, or npm run harness:quit first.`);
  }
  const strays = profileProcesses(paths.profile, system);
  if (strays.length) throw new Error(`Unrecorded processes use the dedicated profile (pid ${strays.join(', ')}); refusing to launch a second one.`);
  if (await system.portInUse(port)) throw new Error(`CDP port ${port} is already in use; refusing to launch (set KIOKU_CDP_PORT).`);

  const profile = prepareProfile(root, { vault: expected.vault, sourceDir: system.asarSourceDir ?? defaultAsarSourceDir(system.platform),
    minAppVersion, now: system.now().getTime() });
  safePath(root, paths.log, 'file', true);
  const log = openSync(paths.log, 'a', 0o600);
  let child;
  try {
    safePath(root, paths.log, 'file');
    child = system.spawn(executable, [profileFlag(paths.profile), `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'],
      { detached: true, stdio: ['ignore', log, log], env: childEnvironment(paths.home), cwd: paths.home });
  } finally { closeSync(log); }
  if (!Number.isSafeInteger(child?.pid)) throw new Error(`Failed to start ${executable}; see ${paths.log}.`);
  child.on?.('error', () => {});
  child.unref?.();
  const startedAt = system.now().toISOString();
  writeState(root, { pid: child.pid, profile: paths.profile, port, startedAt, executable, version: profile.version,
    vault: expected.vault, log: paths.log });

  let page;
  try {
    page = await system.waitForDedicatedPage({ port, vault: expected.vault, version: profile.version,
      alive: () => isAlive(child.pid, system) });
  } catch (error) {
    if (!isAlive(child.pid, system) && readState(root)?.pid === child.pid) clearState(root);
    throw new Error(`${error.message} Log: ${paths.log}. If it is still running, use npm run harness:quit.`);
  }
  const restrictedMode = await system.enableCommunityPlugins({ port, target: page.target });
  return { status: 'LAUNCHED', pid: child.pid, version: page.version, port, startedAt, profile: paths.profile,
    vault: expected.vault, asar: { version: profile.version, reused: profile.reused, removed: profile.removed },
    restrictedMode, log: paths.log };
}

/** Terminate only the recorded PID, after proving its command line carries the dedicated profile flag. */
export async function quitDedicated(root, system = defaultSystem, timeoutMs = 20000) {
  const paths = instancePaths(root);
  const recorded = recordedInstance(root, system);
  if (!recorded.state) return { status: 'NOT_RUNNING', message: 'No recorded dedicated instance; nothing was signalled.' };
  if (!recorded.running) {
    clearState(root);
    return { status: 'NOT_RUNNING', pid: recorded.state.pid, message: `${recorded.reason}; nothing was signalled. State cleared.` };
  }
  const { pid } = recorded.state;
  system.kill(pid, 'SIGTERM');
  const end = Date.now() + timeoutMs;
  while (isAlive(pid, system)) {
    if (Date.now() > end) throw new Error(`Dedicated Obsidian (pid ${pid}) did not exit within ${timeoutMs} ms after SIGTERM; state kept.`);
    await system.sleep(100);
  }
  // Electron helpers (GPU/renderer) can outlive the main PID briefly; wait (never signal them) so that an
  // immediate harness:launch / baseline does not see them as strays.
  let helpers = profileProcesses(paths.profile, system);
  while (helpers.length) {
    if (Date.now() > end) {
      clearState(root);
      throw new Error(`Main pid ${pid} exited, but helpers still use the dedicated profile (pid ${helpers.join(', ')}); retry later.`);
    }
    await system.sleep(100);
    helpers = profileProcesses(paths.profile, system);
  }
  clearState(root);
  return { status: 'STOPPED', pid, port: recorded.state.port, message: 'SIGTERM sent to the recorded dedicated PID only; it exited.' };
}
