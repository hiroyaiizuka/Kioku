// Kioku wiring of the Mac-wide heavy-job queue (scripts/heavy-queue/). Opt-in: active only when KIOKU_HEAVY_QUEUE=1;
// unset (or empty / 0) keeps every command exactly on its previous path and never touches the queue directory.
import { acquire, defaultQueueDir, defaultSystem, formatDuration, handOff, HeavyQueueError, openQueue, readOwner, release, run,
  summary, verify } from '../heavy-queue/heavy-queue.mjs';

export const project = 'kioku';

export function heavyQueueEnabled(env = process.env) {
  const value = env.KIOKU_HEAVY_QUEUE;
  if (value === undefined || value === '' || value === '0') return false;
  if (value === '1') return true;
  throw new HeavyQueueError('KIOKU_HEAVY_QUEUE must be 1 (use the Mac-wide heavy-job queue) or unset.');
}

export const kiokuQueue = (env = process.env, system = defaultSystem) => openQueue(defaultQueueDir(env), system);

/** npm run check: the steps run as a child holding the slot (pre-commit → check inside it re-enters via the token). */
export function runQueuedCheck(root, env, command, args, system = defaultSystem, options = {}) {
  return run(kiokuQueue(env, system), { project, worktree: root, job: 'check', env }, command, args, options);
}

/**
 * harness:launch: wait for the slot, launch, and hand the slot to the dedicated Obsidian PID as soon as it is spawned
 * (`launch(onSpawned)` calls back right after the PID is recorded), so the slot stays held after this CLI exits, and also
 * when the launch fails later while that Obsidian (detached, unref'd) keeps running. The slot is released only when
 * nothing was spawned, or the spawned / recorded instance is confirmed gone.
 *
 * Guard: when a dedicated instance runs (or cannot be ruled out) but the slot cannot be handed to it (handOff refused,
 * e.g. ps failed for that PID or the owner record could not be rewritten), this CLI does NOT exit. The owner record still
 * names this launcher, so exiting would let the next waiter recover the slot while that Obsidian runs (Mappy's native and
 * check jobs do not see Kioku's CDP port). It stays the live owner and retries every `guardMs`: it returns once the slot
 * is handed over, or releases it once no dedicated instance runs (e.g. after npm run harness:quit from another terminal).
 * SIGINT / SIGTERM / SIGHUP are ignored from the first failed handOff (the launch may still wait for the page) or the
 * start of the guard, whichever comes first, until this function returns: with no listener a signal would kill this
 * owner during any await (inspect, ps, the rest of the launch). Chosen over a persistent "pinned" marker because it keeps the
 * on-disk queue format unchanged: every queue reader (any project, any copy of the queue code) already treats a live owner
 * PID as held, whereas a new marker kind would be an unknown entry to them.
 * Remaining windows (documented in docs/harness.md): if this CLI is killed after acquiring but before the spawn callback
 * (normally microseconds after spawn), or SIGKILLed while signals are ignored, its own PID dies and the next waiter recovers the slot
 * while Obsidian may run.
 */
export async function launchWithQueue(root, env, launch, system = defaultSystem, options = {}) {
  const queue = kiokuQueue(env, system);
  const held = await acquire(queue, { project, worktree: root, job: 'native', env }, options);
  if (held.mode !== 'acquired') {
    throw new HeavyQueueError(`harness:launch must own the native slot, but runs inside a held ${held.owner.job} slot `
      + `(pid ${held.owner.pid}); run it on its own. Nothing was started.`);
  }
  const ticketId = held.owner.ticketId;
  let handed = null; let handOffError = null;
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP']; const ignore = () => {}; let ignoring = false;
  // Registered synchronously, before any further await, so no signal can end this owner while the slot is unhanded.
  const ignoreSignals = () => {
    if (ignoring) return;
    ignoring = true;
    for (const signal of signals) process.on(signal, ignore);
  };
  const onSpawned = (pid) => {
    try { handed = handOff(queue, ticketId, pid); handOffError = null; } catch (error) { handOffError = error; ignoreSignals(); }
  };
  // Loaded only here, so the opt-out paths (e.g. scripts/check.mjs) never import the harness / esbuild modules.
  const inspect = options.instance ?? (async () => (await import('./obsidian-instance.mjs')).recordedInstance(root));
  const guardMs = options.guardMs ?? 5000; const reportEveryMs = options.reportEveryMs ?? 60000;
  // One attempt to settle an unhanded slot: a message once settled, null while it must stay guarded (reason in `note`).
  const attempt = async (retried, note) => {
    let instance;
    try { instance = await inspect(); }
    catch (error) { note(`cannot tell whether a dedicated instance runs (${error.message})`); return null; }
    if (!instance.running) {
      let released;
      try { released = release(queue, ticketId, 'released-after-failed-launch'); }
      catch (error) {
        return `native slot not released (${error.message}); no dedicated instance runs, so the next waiter recovers it once `
          + 'this command exits.';
      }
      if (!released) return `native slot ${ticketId} is no longer held by this launch; nothing to release.`;
      return `native slot released (no dedicated instance runs${retried ? ' now' : ''}).`;
    }
    onSpawned(instance.state.pid);
    if (handed) return `native slot handed to the still-running dedicated pid ${handed.pid}${retried ? ' after retrying' : ''}; run npm run harness:quit.`;
    let mine;
    try { mine = readOwner(queue)?.ticketId === ticketId; } catch { mine = true; } // Cannot tell: keep guarding.
    if (!mine) return `native slot ${ticketId} is no longer held by this launch; nothing left to guard.`;
    note(`a dedicated instance (pid ${instance.state.pid}) still runs but the slot could not be handed to it (${handOffError?.message})`);
    return null;
  };
  // Until the slot is handed over or no dedicated instance runs, this live process stays the owner (see above).
  const guard = async () => {
    let lastNote = null; let lastReport = -Infinity;
    const note = (reason) => {
      const now = system.monotonic();
      if (reason === lastNote && now - lastReport < reportEveryMs) return;
      lastNote = reason; lastReport = now;
      system.log(`[heavy-queue] GUARD: ${reason}. This command (pid ${system.pid}) keeps the native slot and retries every `
        + `${formatDuration(guardMs)} until the slot is handed to the dedicated instance or no dedicated instance runs. To stop, `
        + 'run npm run harness:quit in another terminal (this command then releases the slot and exits). Signals are ignored '
        + 'meanwhile; SIGKILL would let another heavy job start while Obsidian may still run.');
    };
    ignoreSignals(); // Before the first await (inspect): the owner record still names this process.
    const first = await attempt(false, note);
    if (first) return first;
    for (;;) {
      await system.sleep(guardMs);
      const settled = await attempt(true, note);
      if (settled) return settled;
    }
  };
  // Decide the slot after a failure: keep it with a live dedicated instance, release it only when none runs.
  const settle = async () => {
    if (!handed) return guard();
    // The owner record already names the dedicated PID, so the slot stays held even when this cannot be judged.
    try {
      if (verify(handed, system).live) return `native slot kept by the still-running dedicated pid ${handed.pid}; run npm run harness:quit.`;
      release(queue, ticketId, 'released-after-failed-launch');
      return `native slot released (spawned pid ${handed.pid} is gone).`;
    } catch (error) { return `native slot state unknown (${error.message}); check the queue status, then npm run harness:quit.`; }
  };
  try {
    let result;
    try { result = await launch(onSpawned); }
    catch (error) { error.message = `${error.message}\nheavyQueue: ${await settle()}`; throw error; }
    if (!handed) onSpawned(result.pid); // A launcher that did not report the spawn.
    if (!handed) {
      const firstError = handOffError?.message;
      const outcome = await settle();
      if (!handed) {
        throw new HeavyQueueError(`Dedicated Obsidian pid ${result.pid} started, but the native slot could not be handed to it `
          + `(${firstError}). ${outcome}`);
      }
    }
    return { ...result, heavyQueue: { dir: queue.dir, slot: 'native', waitedMs: held.waitedMs, owner: summary(handed),
      note: 'Held by the dedicated instance PID until harness:quit (or until that PID is gone).' } };
  } finally { if (ignoring) for (const signal of signals) process.off(signal, ignore); }
}

/**
 * harness:quit: quitting always runs first (a broken queue never blocks stopping Obsidian). Afterwards this worktree's
 * native slot is released once its PID is gone; a still-running owner (e.g. quit timed out, or a guarding harness:launch
 * that releases it itself once the stopped instance is seen gone) keeps it.
 */
export async function quitWithQueue(root, env, quit, system = defaultSystem) {
  let result; let failure = null;
  try { result = await quit(); } catch (error) { failure = error; }
  let heavyQueue;
  try {
    const queue = kiokuQueue(env, system);
    const owner = readOwner(queue);
    if (!owner || owner.job !== 'native' || owner.worktree !== root) heavyQueue = { dir: queue.dir, released: false, note: 'This worktree held no native slot.' };
    else if (verify(owner, system).live) {
      // An owner without `launcher` was never handed off: a guarding harness:launch, which releases it on its own once the
      // dedicated instance is gone.
      heavyQueue = { dir: queue.dir, released: false, note: `Owner pid ${owner.pid} is still running; slot kept.${owner.launcher ? ''
        : ' It is a guarding harness:launch: it releases the slot by itself once no dedicated instance runs.'}` };
    }
    else heavyQueue = { dir: queue.dir, released: release(queue, owner.ticketId, 'released-by-quit'), owner: summary(owner) };
  } catch (error) {
    heavyQueue = { released: false, error: error.message };
    system.log(`[heavy-queue] quit could not update the queue (${error.message}); a dead owner is recovered by the next waiter.`);
  }
  if (failure) { failure.message = `${failure.message}\nheavyQueue: ${JSON.stringify(heavyQueue)}`; throw failure; }
  return { ...result, heavyQueue };
}

/** harness:e2e:smoke: runs only inside this worktree's live native slot. Returns the owner for the report. */
export function assertNativeHeld(root, env, system = defaultSystem) {
  const queue = kiokuQueue(env, system);
  const owner = readOwner(queue);
  const live = owner ? verify(owner, system).live : false;
  if (!owner || !live || owner.job !== 'native' || owner.worktree !== root) {
    throw new HeavyQueueError('KIOKU_HEAVY_QUEUE=1: the smoke runs only inside this worktree\'s native slot; run '
      + 'KIOKU_HEAVY_QUEUE=1 npm run harness:launch first. '
      + `Current owner: ${owner ? `${owner.project} ${owner.job} pid ${owner.pid} (${owner.worktree}${live ? '' : ', not running'})` : 'none'}.`);
  }
  return { dir: queue.dir, owner: summary(owner) };
}
