// Mac-wide FIFO queue for heavy jobs (tooling only; dependency-free and project-agnostic: imports node:* only).
// ONE slot for every heavy job (`check` and `native`) across projects: at most one runs at a time on this Mac.
// It never signals any process. An owner is released by itself, or recovered only when its PID has exited or the PID
// now runs a different command line / start time (PID reuse). Processes are looked up by exact PID (`ps -p <pid>`),
// never by a name or pattern search that could match the waiter itself. Overdue owners are reported, never touched.
// Command lines can carry credentials: only a SHA-256 digest of the full command line and a sanitized executable
// basename are ever persisted, returned, logged or put into errors. The raw command line stays in memory only.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, appendFileSync, constants, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync,
  writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, normalize } from 'node:path';

export const jobs = ['check', 'native'];
export const overdueMs = 30 * 60 * 1000;
export const tokenVariable = 'ORCA_HEAVY_QUEUE_TOKEN';
export const dirVariable = 'ORCA_HEAVY_QUEUE_DIR';
const historyLimit = 1024 * 1024;
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const uuidPattern = new RegExp(`^${uuid}$`, 'u');
const ticketPattern = new RegExp(`^(\\d{12})-(${uuid})\\.json$`, 'u');

export class HeavyQueueError extends Error {
  constructor(message) { super(message); this.name = 'HeavyQueueError'; }
}
const refuse = (message) => { throw new HeavyQueueError(message); };

/** User-level queue directory: ORCA_HEAVY_QUEUE_DIR (normalized absolute) or the per-user cache directory. */
export function defaultQueueDir(env = process.env, platform = process.platform, home = homedir()) {
  const configured = env[dirVariable];
  if (configured !== undefined && configured !== '') {
    if (!isAbsolute(configured) || normalize(configured) !== configured) refuse(`${dirVariable} must be a normalized absolute path.`);
    return configured;
  }
  if (!home) refuse(`Cannot resolve the home directory for the heavy-job queue; set ${dirVariable}.`);
  return platform === 'darwin' ? join(home, 'Library', 'Caches', 'orca-heavy-queue') : join(home, '.cache', 'orca-heavy-queue');
}

function runPs(args) {
  const result = spawnSync('/bin/ps', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' } });
  if (result.error) refuse(`Cannot run /bin/ps (${result.error.message}); cannot verify queue owners.`);
  return result;
}

/**
 * `{ started, command }` of exactly this PID, or null when it does not exist (ps exit 1). Throws when ps cannot tell.
 * The raw command is for `identify` only and must never be stored, returned to callers or printed.
 */
export function processInfo(pid) {
  const query = (field) => {
    const result = runPs(['-ww', '-o', `${field}=`, '-p', String(pid)]);
    if (result.status === 1) return null;
    if (result.status !== 0) refuse(`ps failed (${result.status}); cannot verify pid ${pid}. Refusing to judge the queue.`);
    return result.stdout.trim();
  };
  const started = query('lstart');
  const command = started === null ? null : query('command');
  return started === null || command === null ? null : { started, command };
}

/** Safe identity of a process: start time, digest of the full command line, executable basename (argv[0] only). */
export function identify(info) {
  const first = info.command.split(/\s/u, 1)[0] ?? '';
  const name = first.slice(first.lastIndexOf('/') + 1);
  return { started: info.started, commandDigest: createHash('sha256').update(info.command).digest('hex'),
    executable: /^[A-Za-z0-9._+-]{1,64}$/u.test(name) && !name.includes('=') ? name : 'unknown' };
}

export const defaultSystem = {
  pid: process.pid,
  uid: process.getuid?.(),
  now: () => Date.now(),
  monotonic: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  processInfo,
  log: (line) => console.error(line),
};

function checkDirectory(path, system, recursive = false) {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if (error.code !== 'ENOENT') refuse(`Cannot inspect ${path} (${error.code}); refusing to use the heavy-job queue.`);
    try { mkdirSync(path, { recursive, mode: 0o700 }); }
    catch (inner) { if (inner.code !== 'EEXIST') refuse(`Cannot create ${path} (${inner.code}); refusing to use the heavy-job queue.`); }
    stat = lstatSync(path);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) refuse(`${path} is not a real directory; refusing to use the heavy-job queue.`);
  if (system.uid !== undefined && stat.uid !== system.uid) refuse(`${path} is owned by uid ${stat.uid}, not ${system.uid}; refusing.`);
  if (stat.mode & 0o022) refuse(`${path} is writable by group or others (mode ${(stat.mode & 0o777).toString(8)}); refusing.`);
  try { accessSync(path, constants.W_OK | constants.X_OK); }
  catch (error) { refuse(`${path} is not writable (${error.code}); refusing to use the heavy-job queue.`); }
}

/** Validate (or create, mode 0700) the queue layout. Anything unexpected refuses with the reason. */
export function openQueue(dir, system = defaultSystem) {
  if (!isAbsolute(dir) || normalize(dir) !== dir) refuse(`Heavy-job queue directory must be a normalized absolute path: ${dir}`);
  const paths = { dir, tickets: join(dir, 'tickets'), tmp: join(dir, 'tmp'), stale: join(dir, 'stale'), owner: join(dir, 'owner.json'),
    history: join(dir, 'history.jsonl'), enqueueLock: join(dir, 'enqueue.lock'), seq: join(dir, 'seq.json') };
  checkDirectory(dir, system, true);
  for (const sub of [paths.tickets, paths.tmp, paths.stale]) checkDirectory(sub, system);
  return { dir, paths, system };
}

const isText = (value) => typeof value === 'string' && value.length > 0;
const isTime = (value) => isText(value) && Number.isFinite(Date.parse(value));
const isIdentity = (record) => typeof record.commandDigest === 'string' && /^[0-9a-f]{64}$/u.test(record.commandDigest)
  && typeof record.executable === 'string' && /^[A-Za-z0-9._+-]{1,64}$/u.test(record.executable) && typeof record.started === 'string';
function validRecord(record, kind) {
  const base = record !== null && typeof record === 'object' && record.schema === 2 && uuidPattern.test(record.ticketId ?? '')
    && isText(record.project) && isText(record.worktree) && isAbsolute(record.worktree) && Number.isSafeInteger(record.pid) && record.pid > 1
    && isIdentity(record) && !('cmdline' in record) && jobs.includes(record.job) && isTime(record.enqueuedAt)
    && (record.launcher === undefined || (Number.isSafeInteger(record.launcher?.pid) && isIdentity(record.launcher)));
  if (!base) return false;
  if (kind === 'lock') return true;
  if (!Number.isSafeInteger(record.seq) || record.seq <= 0) return false;
  return kind === 'ticket' || (isText(record.token) && isTime(record.startedAt) && Number.isFinite(record.waitedMs));
}

/** Parsed record, or null when absent. A record that cannot be judged refuses (never guessed at or deleted). */
function readRecord(file, kind) {
  let stat;
  try { stat = lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile()) refuse(`${file} is not a regular file; refusing. Inspect and remove it manually.`);
  let record;
  try { record = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null; // Removed meanwhile.
    if (error.code) refuse(`Cannot read ${file} (${error.code}); refusing to use the heavy-job queue.`);
    record = null;
  }
  if (!validRecord(record, kind)) refuse(`Unrecognized heavy-job queue ${kind} record ${file}; refusing. Inspect and remove it manually.`);
  return record;
}

const temporary = (queue) => join(queue.paths.tmp, `${randomUUID()}.json`);
const serialize = (record) => `${JSON.stringify(record, null, 2)}\n`;
function removeQuietly(file) { try { unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } }

/** Create `target` with its full contents atomically, only if absent (hard link of a private temp file). */
function createExclusive(queue, target, record) {
  const file = temporary(queue);
  writeFileSync(file, serialize(record), { flag: 'wx', mode: 0o600 });
  try { linkSync(file, target); return true; }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  finally { removeQuietly(file); }
}

function replaceAtomic(queue, target, record) {
  const file = temporary(queue);
  writeFileSync(file, serialize(record), { flag: 'wx', mode: 0o600 });
  try { renameSync(file, target); } catch (error) { removeQuietly(file); throw error; }
}

function history(queue, event) {
  const line = `${JSON.stringify({ at: new Date(queue.system.now()).toISOString(), ...event })}\n`;
  try {
    try { if (lstatSync(queue.paths.history).size > historyLimit) renameSync(queue.paths.history, `${queue.paths.history}.1`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    appendFileSync(queue.paths.history, line, { mode: 0o600 });
  } catch (error) { queue.system.log(`[heavy-queue] could not append ${queue.paths.history} (${error.code ?? error.message}).`); }
}

export const readOwner = (queue) => readRecord(queue.paths.owner, 'owner');

export function listTickets(queue) {
  const tickets = [];
  for (const name of readdirSync(queue.paths.tickets)) {
    const file = join(queue.paths.tickets, name);
    const match = ticketPattern.exec(name);
    if (!match) refuse(`Unexpected entry ${file} in the heavy-job queue; refusing. Inspect and remove it manually.`);
    const record = readRecord(file, 'ticket');
    if (!record) continue; // Removed meanwhile.
    if (record.ticketId !== match[2] || record.seq !== Number(match[1])) refuse(`Ticket ${file} does not match its name; refusing.`);
    tickets.push({ ...record, file });
  }
  // Sequence numbers are unique (allocated under the enqueue lock), so this is strictly the enqueue order.
  return tickets.sort((a, b) => a.seq - b.seq);
}

/** Live only while the PID exists with the recorded command-line digest and start time; nothing is ever signalled. */
export function verify(record, system) {
  const info = system.processInfo(record.pid);
  if (!info) return { live: false, reason: `pid ${record.pid} has exited` };
  const now = identify(info);
  if (now.commandDigest !== record.commandDigest) {
    return { live: false, reason: `pid ${record.pid} was reused by another command (executable ${now.executable})` };
  }
  if (now.started !== record.started) return { live: false, reason: `pid ${record.pid} was reused (start time differs)` };
  return { live: true };
}

export const summary = (record) => ({ ticketId: record.ticketId, project: record.project, worktree: record.worktree, pid: record.pid,
  executable: record.executable, commandDigest: record.commandDigest, started: record.started, job: record.job, seq: record.seq, enqueuedAt: record.enqueuedAt, ...(record.startedAt ? { startedAt: record.startedAt } : {}),
  ...(record.waitedMs !== undefined ? { waitedMs: record.waitedMs } : {}), ...(record.launcher ? { launcher: record.launcher } : {}) });

/**
 * Remove `file` only if it still holds the record judged: rename it to a unique name first, then compare. If a newer
 * record took the name meanwhile, it is restored; if even that fails (a third writer), both are kept and we refuse.
 */
function removeIfSame(queue, file, record, event) {
  const moved = join(queue.paths.stale, `${basename(file)}.${randomUUID()}`);
  try { renameSync(file, moved); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  let after;
  try { after = JSON.parse(readFileSync(moved, 'utf8')); } catch { after = null; }
  if (after?.ticketId !== record.ticketId || after?.pid !== record.pid) {
    try { linkSync(moved, file); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      refuse(`Heavy-job queue race: kept ${moved} because ${file} was recreated meanwhile; inspect both manually.`);
    }
    removeQuietly(moved);
    return false;
  }
  removeQuietly(moved);
  if (event) history(queue, { ...event, record: summary(record) });
  return true;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown (clock moved back)';
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600); const minutes = Math.floor((seconds % 3600) / 60); const rest = seconds % 60;
  const pad = (value) => String(value).padStart(2, '0');
  if (hours) return `${hours}h${pad(minutes)}m${pad(rest)}s`;
  return minutes ? `${minutes}m${pad(rest)}s` : `${rest}s`;
}

/** Wall-clock hold time; negative (clock moved back) is shown as unknown and never counts as overdue. */
export const heldMs = (owner, system) => system.now() - Date.parse(owner.startedAt);
const describe = (owner, system) => `project=${owner.project} job=${owner.job} pid=${owner.pid} worktree=${owner.worktree} `
  + `held ${formatDuration(heldMs(owner, system))} (since ${owner.startedAt})`;

function sameWorktreeRefusal(owner) {
  if (owner.job === 'native') {
    return `This worktree already holds the native slot (dedicated instance pid ${owner.pid}, since ${owner.startedAt}). `
      + 'Use it, or quit it first (harness:quit).';
  }
  return `This worktree already holds the heavy-job slot (${owner.job}, pid ${owner.pid} [${owner.executable}], since ${owner.startedAt}); `
    + 'refusing a second request instead of waiting on itself. Wait for it to finish (it is never stopped automatically).';
}

/**
 * Wait (FIFO) for the single slot. Returns `{ mode, owner, waitedMs }`:
 * - `reentrant`: env carries the live owner's token (a child of the holder, e.g. commit → pre-commit → check): no wait.
 * - `nested`: a `check` from the worktree that holds `native` (its own dedicated-instance session): no wait.
 * - `acquired`: this process now owns the slot; call `release` (or `handOff` to a long-lived native process).
 * Any other second request from the same worktree is refused (it would otherwise wait on itself).
 */
export async function acquire(queue, request, options = {}) {
  const { system } = queue;
  const { project, worktree, job, env = {} } = request;
  if (!jobs.includes(job)) refuse(`Unknown heavy job "${job}" (expected ${jobs.join(' or ')}).`);
  if (!isText(project) || !isText(worktree) || !isAbsolute(worktree)) refuse('A heavy-job request needs a project name and an absolute worktree.');
  const pollMs = options.pollMs ?? 1000; const reportEveryMs = options.reportEveryMs ?? 60000;

  const current = readOwner(queue);
  if (current && verify(current, system).live) {
    if (isText(env[tokenVariable]) && env[tokenVariable] === current.token) return { mode: 'reentrant', owner: current, waitedMs: 0 };
    if (current.worktree === worktree) {
      if (current.job === 'native' && job === 'check') return { mode: 'nested', owner: current, waitedMs: 0 };
      refuse(sameWorktreeRefusal(current));
    }
  }
  for (const ticket of listTickets(queue)) {
    if (ticket.worktree === worktree && verify(ticket, system).live) {
      refuse(`This worktree already waits in the heavy-job queue (ticket ${ticket.seq}, pid ${ticket.pid} [${ticket.executable}]); `
        + 'refusing a second request. Wait for it, or stop that command yourself.');
    }
  }
  const me = system.processInfo(system.pid);
  if (!me) refuse(`Cannot read this process (pid ${system.pid}) with ps; refusing to enqueue.`);
  const ticketId = randomUUID();
  const base = { schema: 2, ticketId, project, worktree, pid: system.pid, ...identify(me), job,
    enqueuedAt: new Date(system.now()).toISOString() };
  const { seq, file } = await enqueue(queue, base);
  base.seq = seq;
  const begin = system.monotonic();
  let acquired = false;
  let lastShown = null; let lastReport = -Infinity; const overdue = new Set();
  try {
    for (;;) {
      const tickets = listTickets(queue);
      if (!tickets.some((ticket) => ticket.ticketId === ticketId)) refuse(`Our queue ticket ${file} vanished; refusing to continue.`);
      const ahead = [];
      for (const ticket of tickets) {
        if (ticket.ticketId === ticketId) break;
        const state = verify(ticket, system);
        if (state.live) ahead.push(ticket);
        else removeIfSame(queue, ticket.file, ticket, { event: 'recovered-ticket', reason: state.reason });
      }
      const owner = readOwner(queue);
      const ownerState = owner ? verify(owner, system) : null;
      if (owner && !ownerState.live) {
        // Only the head of the queue recovers a dead / reused owner, so recovery and acquisition do not race.
        if (!ahead.length) { removeIfSame(queue, queue.paths.owner, owner, { event: 'recovered-owner', reason: ownerState.reason }); continue; }
      } else if (!owner && !ahead.length) {
        const waitedMs = Math.max(0, Math.round(system.monotonic() - begin));
        const record = { ...base, token: randomUUID(), startedAt: new Date(system.now()).toISOString(), waitedMs };
        if (createExclusive(queue, queue.paths.owner, record)) {
          acquired = true;
          removeQuietly(file);
          history(queue, { event: 'acquired', record: summary(record) });
          if (lastShown) system.log(`[heavy-queue] ${job} slot acquired after waiting ${formatDuration(waitedMs)}.`);
          return { mode: 'acquired', owner: record, waitedMs };
        }
        continue;
      }
      const elapsed = system.monotonic() - begin;
      const key = owner ? owner.ticketId : `ticket:${ahead[0].ticketId}`;
      if (key !== lastShown || elapsed - lastReport >= reportEveryMs) {
        lastShown = key; lastReport = elapsed;
        const next = ahead[0];
        system.log(`[heavy-queue] waiting for the ${job} slot (#${ahead.length + 1} in line, waited ${formatDuration(elapsed)}); `
          + (owner ? `owner: ${describe(owner, system)}` : `next: project=${next.project} job=${next.job} pid=${next.pid} worktree=${next.worktree}`));
      }
      if (owner && ownerState.live && heldMs(owner, system) > overdueMs && !overdue.has(owner.ticketId)) {
        overdue.add(owner.ticketId);
        system.log(`[heavy-queue] REPORT: the owner has held the slot over ${formatDuration(overdueMs)} (${describe(owner, system)}). `
          + 'Report only: nothing is signalled or released while that pid is alive with the same command-line digest.');
        history(queue, { event: 'overdue', heldMs: heldMs(owner, system), record: summary(owner) });
      }
      await system.sleep(pollMs);
    }
  } finally {
    if (!acquired) removeQuietly(file);
  }
}

function readLastSeq(queue) {
  let raw;
  try { raw = readFileSync(queue.paths.seq, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  let value;
  try { value = JSON.parse(raw); } catch { value = null; }
  if (value?.schema !== 1 || !Number.isSafeInteger(value.seq) || value.seq < 0) {
    refuse(`Unrecognized heavy-job queue counter ${queue.paths.seq}; refusing. Inspect and remove it manually.`);
  }
  return value.seq;
}

/**
 * Append a ticket under a short exclusive enqueue lock (holding our pid / command-line digest), so sequence numbers are
 * unique and strictly increasing in enqueue order. The high-water mark in seq.json keeps numbers from being reused
 * after tickets leave. A lock left by a dead (or reused) PID is recovered like a stale owner; a live one is waited for.
 */
async function enqueue(queue, base) {
  const { system } = queue;
  for (let attempt = 0; !createExclusive(queue, queue.paths.enqueueLock, base); attempt += 1) {
    const holder = readRecord(queue.paths.enqueueLock, 'lock');
    const state = holder ? verify(holder, system) : { live: true };
    if (!state.live) removeIfSame(queue, queue.paths.enqueueLock, holder, { event: 'recovered-enqueue-lock', reason: state.reason });
    else if (attempt >= 6000) refuse(`The enqueue lock ${queue.paths.enqueueLock} stays held by live pid ${holder?.pid}; refusing.`);
    else await system.sleep(10);
  }
  try {
    const seq = Math.max(readLastSeq(queue), listTickets(queue).at(-1)?.seq ?? 0) + 1;
    replaceAtomic(queue, queue.paths.seq, { schema: 1, seq });
    const file = join(queue.paths.tickets, `${String(seq).padStart(12, '0')}-${base.ticketId}.json`);
    if (!createExclusive(queue, file, { ...base, seq })) refuse(`Ticket ${file} already exists; refusing.`);
    return { seq, file };
  } finally {
    removeIfSame(queue, queue.paths.enqueueLock, base, null);
  }
}

/** Release the slot held under `ticketId` (no-op when someone else holds it). */
export function release(queue, ticketId, reason = 'released') {
  const owner = readOwner(queue);
  if (!owner || owner.ticketId !== ticketId) return false;
  return removeIfSame(queue, queue.paths.owner, owner, { event: reason, heldMs: heldMs(owner, queue.system) });
}

/** Tie the held slot to a long-lived process (e.g. a dedicated Obsidian) that outlives the acquiring CLI. */
export function handOff(queue, ticketId, pid) {
  const owner = readOwner(queue);
  if (!owner || owner.ticketId !== ticketId) refuse(`The slot ${ticketId} is no longer held; cannot hand it to pid ${pid}.`);
  const info = queue.system.processInfo(pid);
  if (!info) refuse(`Cannot hand the slot to pid ${pid}: it does not exist.`);
  const record = { ...owner, pid, ...identify(info),
    launcher: { pid: owner.pid, executable: owner.executable, commandDigest: owner.commandDigest, started: owner.started } };
  replaceAtomic(queue, queue.paths.owner, record);
  history(queue, { event: 'handed-off', record: summary(record) });
  return record;
}

/** Read-only snapshot (never recovers anything): owner liveness, hold time, overdue flag, waiters in order. */
export function status(queue) {
  const { system } = queue;
  const owner = readOwner(queue);
  const state = owner ? verify(owner, system) : null;
  const held = owner ? heldMs(owner, system) : null;
  return {
    dir: queue.dir,
    owner: owner ? { ...summary(owner), ...state, held: formatDuration(held), overdue: state.live && held > overdueMs } : null,
    waiting: listTickets(queue).map((ticket) => ({ seq: ticket.seq, ...summary(ticket), ...verify(ticket, system) })),
  };
}

/**
 * Hold the slot while `command` runs (stdio inherited; the child gets the owner token for re-entrance). Termination
 * signals delivered to us are ignored while the child runs (a terminal delivers them to the child too), so the slot is
 * released only after the child has exited. Resolves to the child's exit code.
 */
export async function run(queue, request, command, args, options = {}) {
  const held = await acquire(queue, request, options);
  const ignore = () => {};
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.on(signal, ignore);
  try {
    const child = (options.spawn ?? spawn)(command, args, { stdio: 'inherit', env: { ...request.env, [tokenVariable]: held.owner.token } });
    return await new Promise((resolve) => {
      child.once('error', (error) => {
        queue.system.log(`[heavy-queue] could not start the command (${error.code ?? 'error'}); arguments are not shown.`); resolve(1);
      });
      child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
  } finally {
    for (const signal of signals) process.off(signal, ignore);
    if (held.mode === 'acquired') release(queue, held.owner.ticketId);
  }
}
