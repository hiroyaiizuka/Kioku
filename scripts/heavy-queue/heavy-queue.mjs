// Mac-wide FIFO queue for heavy jobs (tooling only; dependency-free and project-agnostic: imports node:* only).
// ONE slot for every heavy job (`check` and `native`) across projects: at most one runs at a time on this Mac.
// It never signals any process. An owner is released by itself, or recovered only when its PID has exited or the PID
// now runs a different command line / start time (PID reuse). Processes are looked up by exact PID (`ps -p <pid>`),
// never by a name or pattern search that could match the waiter itself. Overdue owners are reported, never touched.
// Command lines can carry credentials: only a SHA-256 digest of the full command line and a sanitized executable
// basename are ever persisted, returned, logged or put into errors. The raw command line stays in memory only.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, appendFileSync, closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync,
  renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';

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
  const paths = { dir, tickets: join(dir, 'tickets'), tmp: join(dir, 'tmp'), owner: join(dir, 'owner'), enqueue: join(dir, 'enqueue'),
    history: join(dir, 'history.jsonl'), seq: join(dir, 'seq.json') };
  checkDirectory(dir, system, true);
  for (const legacy of ['owner.json', 'enqueue.lock', 'stale']) {
    let present = true;
    try { lstatSync(join(dir, legacy)); } catch (error) { if (error.code !== 'ENOENT') throw error; present = false; }
    if (present) refuse(`${join(dir, legacy)} is from an earlier queue layout; refusing. Remove it once nothing uses the queue.`);
  }
  for (const sub of [paths.tickets, paths.tmp, paths.owner, paths.enqueue]) checkDirectory(sub, system);
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

/**
 * Bytes of a file inside the (already validated, 0700) queue directory, or null when absent. Fail closed: it never
 * follows a symlink (O_NOFOLLOW, so nothing outside the directory is ever read), never blocks on a FIFO (O_NONBLOCK), and
 * accepts only a regular file owned by the current user (checked on the opened descriptor, so it cannot be swapped).
 */
function readQueueFile(file, system) {
  let fd;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'ELOOP') refuse(`${file} is a symbolic link; refusing (not followed). Inspect and remove it manually.`);
    refuse(`Cannot open ${file} (${error.code}); refusing to use the heavy-job queue. Inspect it manually.`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) refuse(`${file} is not a regular file; refusing. Inspect and remove it manually.`);
    if (system.uid !== undefined && stat.uid !== system.uid) refuse(`${file} is owned by uid ${stat.uid}, not ${system.uid}; refusing.`);
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

/** Parse + shape-check a record; anything that cannot be judged refuses with the reason (never treated as free). */
function parseRecord(bytes, file, kind) {
  let record;
  try { record = JSON.parse(bytes.toString('utf8')); } catch { record = null; }
  if (!validRecord(record, kind)) refuse(`Unrecognized heavy-job queue ${kind} record ${file}; refusing. Inspect and remove it manually.`);
  return record;
}

/** Parsed record, or null when absent. */
function readRecord(file, kind, system) {
  const bytes = readQueueFile(file, system);
  return bytes === null ? null : parseRecord(bytes, file, kind);
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

const genPattern = /^(\d{12})\.(json|released)$/u;
const genName = (gen, suffix) => `${String(gen).padStart(12, '0')}.${suffix}`;

/**
 * Generation leases (the slot owner in `owner/`, the enqueue lock in `enqueue/`).
 *
 * Why: renaming or unlinking a shared fixed name (owner.json) after judging it stale can hide a NEW live holder that
 * replaced it between the check and the act, letting a third contender in. Here no live holder's file is ever renamed,
 * replaced by anyone else, or removed:
 * - Each holder has its own immutable-name file `<gen>.json`, created only by exclusive create at `gen = highest + 1`.
 * - The current holder is the highest generation, unless it carries a `<gen>.released` marker or its PID is dead / reused.
 * - A takeover first proves the inspected generation is unchanged (re-read the bytes after judging the holder dead: only
 *   a live holder ever rewrites its own file, e.g. handOff, and it does so before it can die), then exclusively creates the
 *   next generation; a competitor that got there first makes the create fail, so at most one takeover per generation wins.
 * - Generation files are NEVER deleted (neither records nor markers). So every generation name that has ever existed
 *   still exists, and the exclusive create (link) of any used name fails with EEXIST: by construction, an actor with a
 *   stale view (an empty directory, or generation K long since superseded) can never re-create a generation number that
 *   has existed, and a takeover of K succeeds only while K is still the highest (nobody has created K+1). Pruning old
 *   generations behind a floor marker was rejected: "check the floor, then create" is two steps, the same check-then-act
 *   window again. Cost: two small files (< 1 KiB each) per acquisition and per enqueue; reset by deleting the whole queue
 *   directory while nothing uses it (docs/harness.md).
 * - Release = create our own `<gen>.released` marker (exact generation; never touches another holder's file).
 */
function leaseState(queue, dir, kind) {
  // One pass with a running maximum: files accumulate forever, so no spread into Math.max (argument limit) and no per-file
  // map; only the highest generation and whether its record exists matter.
  let gen = 0; let hasRecord = false;
  for (const name of readdirSync(dir)) {
    const match = genPattern.exec(name);
    if (!match || Number(match[1]) === 0) {
      refuse(`Unexpected entry ${join(dir, name)} in the heavy-job queue; refusing. Inspect and remove it manually.`);
    }
    const number = Number(match[1]);
    if (number > gen) { gen = number; hasRecord = false; }
    if (number === gen && match[2] === 'json') hasRecord = true;
  }
  if (!gen) return null;
  const file = join(dir, genName(gen, 'json'));
  if (!hasRecord) refuse(`${join(dir, genName(gen, 'released'))} has no generation record; refusing. Inspect it manually.`);
  const bytes = readQueueFile(file, queue.system);
  if (bytes === null) return { retry: true }; // Defensive only: generation files are never deleted.
  const record = parseRecord(bytes, file, kind);
  return { gen, file, bytes, record: { ...record, gen }, released: releasedBy(queue, dir, gen, record) };
}

/**
 * True only for a valid release marker of exactly this generation and holder: a regular file (not a symlink, FIFO or
 * directory) owned by us, naming the same generation and ticketId. Anything else is an anomaly: reported, and the
 * generation stays held (fail closed: a forged marker can never make a live holder look free).
 */
function releasedBy(queue, dir, gen, record) {
  const marker = join(dir, genName(gen, 'released'));
  let bytes;
  try { bytes = readQueueFile(marker, queue.system); }
  catch (error) {
    if (!(error instanceof HeavyQueueError)) throw error;
    reportAnomaly(queue, `${error.message} Treated as NOT released.`);
    return false;
  }
  if (bytes === null) return false;
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { value = null; }
  if (value?.schema === 2 && value.gen === gen && value.ticketId === record.ticketId) return true;
  reportAnomaly(queue, `${marker} does not name generation ${gen} and its holder; treated as NOT released. Inspect it manually.`);
  return false;
}

function reportAnomaly(queue, message) {
  queue.anomalies ??= new Set();
  if (queue.anomalies.has(message)) return;
  queue.anomalies.add(message);
  queue.system.log(`[heavy-queue] ANOMALY: ${message}`);
  history(queue, { event: 'anomaly', message });
}

/** `{ free, reason }` of an inspected generation: released, or holder PID dead / reused. */
function leaseFree(state, system) {
  if (!state) return { free: true };
  if (state.released) return { free: true, released: true };
  const live = verify(state.record, system);
  return live.live ? { free: false } : { free: true, reason: live.reason };
}

/**
 * Take the generation after `state` (null = none seen). Returns the new generation, or 0 when it must judge again (the
 * inspected generation changed, or the next name already exists: someone else won, or our view was stale).
 */
function takeLease(queue, dir, state, record) {
  if (state) {
    const now = readQueueFile(state.file, queue.system);
    if (now === null || !now.equals(state.bytes)) return 0; // Rewritten by its (then live) holder after we read it: judge again.
  }
  const gen = (state?.gen ?? 0) + 1;
  const stored = { ...record }; delete stored.gen;
  return createExclusive(queue, join(dir, genName(gen, 'json')), stored) ? gen : 0; // Never reusable: names are never deleted.
}

function releaseLease(queue, dir, gen, ticketId) {
  return createExclusive(queue, join(dir, genName(gen, 'released')),
    { schema: 2, gen, ticketId, releasedAt: new Date(queue.system.now()).toISOString() });
}

/** Highest unreleased owner generation (live or not), or null. */
export function readOwner(queue) {
  for (;;) {
    const state = leaseState(queue, queue.paths.owner, 'owner');
    if (state?.retry) continue;
    return state && !state.released ? state.record : null;
  }
}

export function listTickets(queue) {
  const tickets = [];
  for (const name of readdirSync(queue.paths.tickets)) {
    const file = join(queue.paths.tickets, name);
    const match = ticketPattern.exec(name);
    if (!match) refuse(`Unexpected entry ${file} in the heavy-job queue; refusing. Inspect and remove it manually.`);
    const record = readRecord(file, 'ticket', queue.system);
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
        else {
          // Ticket names are unique and their contents never change, so this name can only ever hold the judged ticket.
          removeQuietly(ticket.file);
          history(queue, { event: 'recovered-ticket', reason: state.reason, record: summary(ticket) });
        }
      }
      const lease = leaseState(queue, queue.paths.owner, 'owner');
      if (lease?.retry) continue;
      const judged = leaseFree(lease, system);
      const owner = lease && !lease.released ? lease.record : null;
      if (judged.free) {
        // Only the head of the queue takes the slot (also over a dead / reused owner), which keeps FIFO.
        if (!ahead.length) {
          await system.race?.('owner-inspected', { gen: lease?.gen ?? 0 });
          const waitedMs = Math.max(0, Math.round(system.monotonic() - begin));
          const record = { ...base, token: randomUUID(), startedAt: new Date(system.now()).toISOString(), waitedMs };
          const gen = takeLease(queue, queue.paths.owner, lease, record);
          if (gen) {
            acquired = true;
            removeQuietly(file);
            if (judged.reason) history(queue, { event: 'recovered-owner', reason: judged.reason, record: summary(lease.record) });
            history(queue, { event: 'acquired', record: summary(record) });
            if (lastShown) system.log(`[heavy-queue] ${job} slot acquired after waiting ${formatDuration(waitedMs)}.`);
            return { mode: 'acquired', owner: { ...record, gen }, waitedMs };
          }
          continue;
        }
      }
      const ownerState = { live: !judged.free };
      const elapsed = system.monotonic() - begin;
      const shownOwner = ownerState.live ? owner : null;
      const key = shownOwner ? shownOwner.ticketId : `ticket:${ahead[0].ticketId}`;
      if (key !== lastShown || elapsed - lastReport >= reportEveryMs) {
        lastShown = key; lastReport = elapsed;
        const next = ahead[0];
        system.log(`[heavy-queue] waiting for the ${job} slot (#${ahead.length + 1} in line, waited ${formatDuration(elapsed)}); `
          + (shownOwner ? `owner: ${describe(shownOwner, system)}` : `next: project=${next.project} job=${next.job} pid=${next.pid} worktree=${next.worktree}`));
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
  const raw = readQueueFile(queue.paths.seq, queue.system);
  if (raw === null) return 0;
  let value;
  try { value = JSON.parse(raw.toString('utf8')); } catch { value = null; }
  if (value?.schema !== 1 || !Number.isSafeInteger(value.seq) || value.seq < 0) {
    refuse(`Unrecognized heavy-job queue counter ${queue.paths.seq}; refusing. Inspect and remove it manually.`);
  }
  return value.seq;
}

/**
 * Append a ticket under the enqueue lease (a generation lease holding our pid / command-line digest), so sequence
 * numbers are unique and strictly increasing in enqueue order. The high-water mark in seq.json keeps numbers from being
 * reused after tickets leave. A lease left by a dead (or reused) PID is taken over; a live one is waited for.
 */
async function enqueue(queue, base) {
  const { system } = queue;
  let gen = 0;
  for (let attempt = 0; !gen; attempt += 1) {
    const lease = leaseState(queue, queue.paths.enqueue, 'lock');
    if (lease?.retry) continue;
    const judged = leaseFree(lease, system);
    if (judged.free) {
      await system.race?.('enqueue-inspected', { gen: lease?.gen ?? 0 });
      gen = takeLease(queue, queue.paths.enqueue, lease, base);
      if (gen && judged.reason) history(queue, { event: 'recovered-enqueue-lock', reason: judged.reason, record: summary(lease.record) });
    } else if (attempt >= 6000) refuse(`The enqueue lease in ${queue.paths.enqueue} stays held by live pid ${lease.record.pid}; refusing.`);
    else await system.sleep(10);
  }
  try {
    await system.race?.('enqueue-held', { gen });
    const seq = Math.max(readLastSeq(queue), listTickets(queue).at(-1)?.seq ?? 0) + 1;
    replaceAtomic(queue, queue.paths.seq, { schema: 1, seq });
    const file = join(queue.paths.tickets, `${String(seq).padStart(12, '0')}-${base.ticketId}.json`);
    if (!createExclusive(queue, file, { ...base, seq })) refuse(`Ticket ${file} already exists; refusing.`);
    return { seq, file };
  } finally {
    releaseLease(queue, queue.paths.enqueue, gen, base.ticketId);
  }
}

/** Release the slot held under `ticketId` (no-op when someone else holds it). */
export function release(queue, ticketId, reason = 'released') {
  const owner = readOwner(queue);
  if (!owner || owner.ticketId !== ticketId) return false;
  if (!releaseLease(queue, queue.paths.owner, owner.gen, ticketId)) return false;
  history(queue, { event: reason, heldMs: heldMs(owner, queue.system), record: summary(owner) });
  return true;
}

/** Tie the held slot to a long-lived process (e.g. a dedicated Obsidian) that outlives the acquiring CLI. */
export function handOff(queue, ticketId, pid) {
  const owner = readOwner(queue);
  if (!owner || owner.ticketId !== ticketId) refuse(`The slot ${ticketId} is no longer held; cannot hand it to pid ${pid}.`);
  const info = queue.system.processInfo(pid);
  if (!info) refuse(`Cannot hand the slot to pid ${pid}: it does not exist.`);
  const { gen, ...stored } = owner;
  const record = { ...stored, pid, ...identify(info),
    launcher: { pid: owner.pid, executable: owner.executable, commandDigest: owner.commandDigest, started: owner.started } };
  // Only the live holder rewrites its own generation file (atomic rename). Takeovers re-read these bytes after judging the
  // holder dead, so a stale view of the launcher record can never take the slot from the handed-off process.
  replaceAtomic(queue, join(queue.paths.owner, genName(gen, 'json')), record);
  history(queue, { event: 'handed-off', record: summary(record) });
  return { ...record, gen };
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
