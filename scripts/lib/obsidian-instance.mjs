// Dedicated, concurrent Obsidian instance for test-vault only (tooling; never part of the plugin runtime).
// The user's own Obsidian keeps running: Electron's single-instance lock is per --user-data-dir, so this
// instance uses a profile inside the project and is identified/terminated only by its recorded PID.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, closeSync, constants, linkSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, statSync,
  unlinkSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { userInfo } from 'node:os';
import { basename, isAbsolute, join, normalize } from 'node:path';
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
  ensureDirectory(root, paths.tooling); ensureDirectory(root, paths.profile);
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

/**
 * Environment for the dedicated child: inherited unchanged (HOME included) except ELECTRON_* (e.g.
 * ELECTRON_RUN_AS_NODE) and NODE_OPTIONS. A private HOME is NOT used: natively it hid the login keychain, Electron
 * safeStorage then raised a blocking SecurityAgent dialog (artifacts/lev-279/e5f67e6-partial/RECORD.md, Step 3; gitignored local evidence).
 */
export function childEnvironment(env) {
  const result = { ...env };
  for (const key of Object.keys(result)) if (key.startsWith('ELECTRON_') || key === 'NODE_OPTIONS') delete result[key];
  return result;
}

/** Read a lock's owner text; null when it vanished meanwhile (another launcher won a race). */
function warn(system, message) { (system.warn ?? ((text) => console.warn(text)))(message); }
function removeIfPresent(file) {
  try { unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/** Remove leftover `<lock>.stale-*` files whose recorded owner PID is dead; keep anything else. */
function cleanStaleLockFiles(root, paths, system) {
  const prefix = `${basename(paths.lock)}.stale-`;
  const removed = [];
  for (const name of readdirSync(paths.tooling).filter((entry) => entry.startsWith(prefix)).sort()) {
    const file = join(paths.tooling, name);
    let owner;
    try { owner = lockOwner(root, file); } catch (error) { warn(system, `Kept ${file}: ${error.message}`); continue; }
    if (owner !== null && /^\d+$/u.test(owner) && !isAlive(Number(owner), system)) { removeIfPresent(file); removed.push(name); }
  }
  return removed;
}

function lockOwner(root, file) {
  try { return safeRead(root, file).toString('utf8').trim(); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/**
 * Exclusive launch lock holding the launcher PID. A lock whose owner PID is dead (e.g. Ctrl-C) is stale and is
 * recovered by renaming it to a unique name first, then checking the renamed bytes are still the dead owner's: if a
 * concurrent launcher replaced it in between, its fresh lock is restored. If a third launcher already created a new
 * lock, the moved file is kept (never deleted), a warning names it, and the state is re-evaluated. Races retry a
 * bounded number of times. `system.lockRace(stage)` is a test-only hook to interleave competing launchers.
 */
function acquireLaunchLock(root, paths, system) {
  const me = String(system.pid ?? process.pid);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    safePath(root, paths.lock, 'file', true);
    try {
      const fd = openSync(paths.lock, 'wx', 0o600);
      try { writeFileSync(fd, `${me}\n`); } finally { closeSync(fd); }
      return me;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    system.lockRace?.('exists');
    const owner = lockOwner(root, paths.lock);
    if (owner === null) continue; // Released meanwhile: try again.
    if (!/^\d+$/u.test(owner) || isAlive(Number(owner), system)) {
      throw new Error(`Another harness:launch (pid ${owner || 'unknown'}) holds ${paths.lock}. If none is running, delete that file and retry.`);
    }
    system.lockRace?.('stale');
    const moved = `${paths.lock}.stale-${me}-${randomUUID()}`;
    safePath(root, moved, 'file', true);
    try { renameSync(paths.lock, moved); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const movedOwner = lockOwner(root, moved);
    if (movedOwner !== null && movedOwner !== owner) {
      // We moved a competitor's fresh lock: put it back, then re-evaluate.
      system.lockRace?.('restore');
      try { linkSync(moved, paths.lock); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // A third launcher created a newer lock meanwhile: keep the competitor's lock file for inspection.
        warn(system, `Launch lock race: kept the lock of pid ${movedOwner} as ${moved} because ${paths.lock} was recreated.`);
        continue;
      }
    }
    removeIfPresent(moved);
  }
  throw new Error(`Could not acquire ${paths.lock} (concurrent launches); retry.`);
}

/**
 * Launch the dedicated instance. `system.waitForDedicatedPage` / `system.enableCommunityPlugins` perform the CDP part
 * (see dedicated-cdp.mjs); unit tests inject fakes and never start Obsidian.
 */
export async function launchDedicated(root, env = process.env, system = defaultSystem) {
  assertSupported(system.platform);
  const paths = instancePaths(root);
  ensureDirectory(root, paths.tooling);
  // Exclusive launch lock: overlapping launches must not overwrite / clear each other's record.
  const me = acquireLaunchLock(root, paths, system);
  try {
    cleanStaleLockFiles(root, paths, system);
    return await launchLocked(root, env, system, paths);
  } finally {
    // Never remove another launcher's lock, and never let a release problem mask the launch result.
    try { if (lockOwner(root, paths.lock) === me) unlinkSync(paths.lock); }
    catch (error) { warn(system, `Could not release ${paths.lock} (${error.message}); a later launch recovers it once pid ${me} exits.`); }
  }
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
  // Obsidian on macOS unlinks and re-listens on this socket at startup and unlinks it on quit (see docs/harness.md).
  // Early gate (so a refusal creates nothing), lstat only; taking over an existing socket is opt-in.
  const socket = system.cliSocketPath ?? resolveCliSocketPath(env);
  assertSocketTakeoverAllowed(socket, env);

  const profile = prepareProfile(root, { vault: expected.vault, sourceDir: system.asarSourceDir ?? defaultAsarSourceDir(system.platform),
    minAppVersion, now: system.now().getTime() });
  // Re-check right before spawn: a socket may have appeared meanwhile (e.g. the user started Obsidian). A sub-second
  // window between spawn and Obsidian's own unlink/listen remains and cannot be closed from outside (docs/harness.md).
  const socketExisted = assertSocketTakeoverAllowed(socket, env);
  safePath(root, paths.log, 'file', true);
  const log = openSync(paths.log, 'a', 0o600);
  let child;
  try {
    safePath(root, paths.log, 'file');
    child = system.spawn(executable, [profileFlag(paths.profile), `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'],
      { detached: true, stdio: ['ignore', log, log], env: childEnvironment(env), cwd: paths.profile });
  } finally { closeSync(log); }
  // Register before the pid check: a failed spawn emits 'error' asynchronously and must not crash the CLI.
  let spawnError = null;
  child?.on?.('error', (error) => { spawnError = error; });
  if (!Number.isSafeInteger(child?.pid)) {
    throw new Error(`Failed to start ${executable}${spawnError ? ` (${spawnError.message})` : ''}; see ${paths.log}.`);
  }
  child.unref?.();
  const startedAt = system.now().toISOString();
  writeState(root, { pid: child.pid, profile: paths.profile, port, startedAt, executable, version: profile.version,
    vault: expected.vault, log: paths.log });

  let page;
  try {
    page = await system.waitForDedicatedPage({ port, vault: expected.vault, version: profile.version,
      alive: () => isAlive(child.pid, system) });
  } catch (error) {
    let ours = false;
    try { ours = readState(root)?.pid === child.pid; } catch { ours = false; } // Never mask the original error.
    if (ours && !isAlive(child.pid, system)) clearState(root);
    throw new Error(`${error.message} Log: ${paths.log}. If it is still running, use npm run harness:quit.`);
  }
  const restrictedMode = await system.enableCommunityPlugins({ port, target: page.target });
  return { status: 'LAUNCHED', pid: child.pid, version: page.version, port, startedAt, profile: paths.profile,
    vault: expected.vault, asar: { version: profile.version, reused: profile.reused, removed: profile.removed },
    restrictedMode, log: paths.log,
    cliSocket: { path: socket, existedBeforeLaunch: socketExisted, takenOver: socketExisted,
      note: 'Owned by the dedicated instance while it runs (CLI commands reach test-vault) and removed on harness:quit.' } };
}

/** Terminate only the recorded PID, after proving its command line carries the dedicated profile flag. */
export const defaultQuitTimeoutMs = 60000;
export function resolveQuitTimeout(env = process.env) {
  const raw = env.KIOKU_QUIT_TIMEOUT_MS ?? String(defaultQuitTimeoutMs);
  if (!/^\d+$/u.test(raw) || Number(raw) < 1000 || Number(raw) > 600000) {
    throw new Error('KIOKU_QUIT_TIMEOUT_MS must be an integer between 1000 and 600000.');
  }
  return Number(raw);
}

/** Where macOS Obsidian 1.14.3 puts its CLI socket: join(os.homedir(), '.obsidian-cli.sock') (XDG is ignored on darwin). */
export const cliSocketPath = (home = userInfo().homedir) => join(home, '.obsidian-cli.sock');
/** os.homedir() semantics: HOME when non-empty, otherwise the passwd home directory. */
export const resolveCliSocketPath = (env = process.env) => cliSocketPath(env.HOME || userInfo().homedir);

/** lstat only. ENOENT is the only "absent"; any other error (EACCES, ENOTDIR, ELOOP, ...) refuses (fail closed). */
export function cliSocketExists(socket) {
  try { lstatSync(socket); return true; }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw new Error(`Cannot determine whether ${socket} exists (${error.code ?? error.message}); refusing to launch. Nothing was started.`);
  }
}

function assertSocketTakeoverAllowed(socket, env) {
  const exists = cliSocketExists(socket);
  if (exists && env.KIOKU_ALLOW_CLI_SOCKET_TAKEOVER !== '1') {
    throw new Error(`${socket} exists (another Obsidian's CLI socket). Launching would take it over: while the dedicated `
      + 'instance runs, `obsidian` CLI commands from you or agents would reach the dedicated test-vault instance, and on quit '
      + 'the socket is removed, so your CLI stays broken until you restart your Obsidian (the GUI is unaffected). Nothing was '
      + 'started. Only with the user\'s explicit consent: KIOKU_ALLOW_CLI_SOCKET_TAKEOVER=1 npm run harness:launch.');
  }
  return exists;
}

function socketState(socket) {
  try { lstatSync(socket); return true; } catch (error) { return error.code === 'ENOENT' ? false : `unknown (${error.code})`; }
}

export async function quitDedicated(root, system = defaultSystem, timeoutMs = defaultQuitTimeoutMs) {
  const paths = instancePaths(root);
  const recorded = recordedInstance(root, system);
  if (!recorded.running) {
    // E.g. Obsidian's own app.relaunch(): the recorded PID is gone but a new process uses the dedicated profile.
    // Never signal an unrecorded PID automatically; list verified command lines for the manual procedure.
    const strays = profileProcesses(paths.profile, system);
    if (recorded.state) clearState(root);
    if (strays.length) {
      const lines = strays.map((stray) => `  ${stray} ${commandOf(stray, system)}`).join('\n');
      throw new Error(`No running recorded instance, but unrecorded processes use the dedicated profile; nothing was signalled.\n${lines}\n`
        + 'Manual stop (see docs/harness.md): kill only a PID whose command line contains exactly '
        + `${profileFlag(paths.profile)}.`);
    }
    if (!recorded.state) return { status: 'NOT_RUNNING', message: 'No recorded dedicated instance; nothing was signalled.' };
    return { status: 'NOT_RUNNING', pid: recorded.state.pid, message: `${recorded.reason}; nothing was signalled. State cleared.` };
  }
  const { pid } = recorded.state;
  // lstat only (never touched): a socket right before quit is likely another Obsidian's if it was started meanwhile,
  // and the dedicated instance's will-quit unlink may remove it (inferred from the 1.14.3 asar).
  const socket = system.cliSocketPath ?? resolveCliSocketPath();
  const existedBeforeQuit = socketState(socket);
  system.kill(pid, 'SIGTERM');
  const end = Date.now() + timeoutMs;
  while (isAlive(pid, system)) {
    if (Date.now() > end) {
      throw new Error(`Dedicated Obsidian (pid ${pid}) did not exit within ${timeoutMs} ms after SIGTERM; state kept, nothing else was signalled. `
        + 'Its main thread may be blocked by a system dialog (e.g. a keychain prompt): check the screen, then rerun npm run harness:quit '
        + '(KIOKU_QUIT_TIMEOUT_MS to wait longer). A manual SIGKILL of this verified PID is an operator decision; see docs/harness.md.');
    }
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
  const cliSocket = { path: socket, existedBeforeQuit, existsAfterQuit: socketState(socket) };
  if (existedBeforeQuit === true) {
    cliSocket.warning = 'A CLI socket existed right before quit. If you started your own Obsidian while the dedicated instance ran, '
      + 'its socket may have been removed by the dedicated instance on quit: restart your Obsidian to restore its CLI.';
    warn(system, cliSocket.warning);
  }
  return { status: 'STOPPED', pid, port: recorded.state.port, cliSocket,
    message: 'SIGTERM sent to the recorded dedicated PID only; it exited.' };
}
