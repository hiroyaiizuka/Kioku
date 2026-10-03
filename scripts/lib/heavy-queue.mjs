// Kioku wiring of the Mac-wide heavy-job queue (scripts/heavy-queue/). Opt-in: active only when KIOKU_HEAVY_QUEUE=1;
// unset (or empty / 0) keeps every command exactly on its previous path and never touches the queue directory.
import { acquire, defaultQueueDir, defaultSystem, handOff, HeavyQueueError, openQueue, readOwner, release, run, summary,
  verify } from '../heavy-queue/heavy-queue.mjs';

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
 * Remaining window (documented in docs/harness.md): if this CLI is killed after acquiring but before the spawn callback
 * (normally microseconds after spawn), its own PID dies and the next waiter recovers the slot while Obsidian may run.
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
  const onSpawned = (pid) => {
    try { handed = handOff(queue, ticketId, pid); handOffError = null; } catch (error) { handOffError = error; }
  };
  // Decide the slot after a failure: keep it with a live dedicated instance, release it only when none runs.
  const settle = async () => {
    try {
      if (handed) {
        if (verify(handed, system).live) return `native slot kept by the still-running dedicated pid ${handed.pid}; run npm run harness:quit.`;
        release(queue, ticketId, 'released-after-failed-launch');
        return `native slot released (spawned pid ${handed.pid} is gone).`;
      }
      // Loaded only here, so the opt-out paths (e.g. scripts/check.mjs) never import the harness / esbuild modules.
      const inspect = options.instance ?? (async () => (await import('./obsidian-instance.mjs')).recordedInstance(root));
      const instance = await inspect();
      if (instance.running) {
        onSpawned(instance.state.pid);
        if (handed) return `native slot handed to the still-running dedicated pid ${handed.pid}; run npm run harness:quit.`;
        return `a dedicated instance (pid ${instance.state.pid}) still runs but the slot could not be handed to it `
          + `(${handOffError?.message}); run npm run harness:quit now.`;
      }
      release(queue, ticketId, 'released-after-failed-launch');
      return 'native slot released (no dedicated instance runs).';
    } catch (error) { return `native slot state unknown (${error.message}); check the queue status, then npm run harness:quit.`; }
  };
  let result;
  try { result = await launch(onSpawned); }
  catch (error) { error.message = `${error.message}\nheavyQueue: ${await settle()}`; throw error; }
  if (!handed) onSpawned(result.pid); // A launcher that did not report the spawn.
  if (!handed) {
    throw new HeavyQueueError(`Dedicated Obsidian pid ${result.pid} started, but the native slot could not be handed to it `
      + `(${handOffError?.message}). ${await settle()} Run npm run harness:quit now.`);
  }
  return { ...result, heavyQueue: { dir: queue.dir, slot: 'native', waitedMs: held.waitedMs, owner: summary(handed),
    note: 'Held by the dedicated instance PID until harness:quit (or until that PID is gone).' } };
}

/**
 * harness:quit: quitting always runs first (a broken queue never blocks stopping Obsidian). Afterwards this worktree's
 * native slot is released once its PID is gone; a still-running owner (e.g. quit timed out) keeps it.
 */
export async function quitWithQueue(root, env, quit, system = defaultSystem) {
  let result; let failure = null;
  try { result = await quit(); } catch (error) { failure = error; }
  let heavyQueue;
  try {
    const queue = kiokuQueue(env, system);
    const owner = readOwner(queue);
    if (!owner || owner.job !== 'native' || owner.worktree !== root) heavyQueue = { dir: queue.dir, released: false, note: 'This worktree held no native slot.' };
    else if (verify(owner, system).live) heavyQueue = { dir: queue.dir, released: false, note: `Owner pid ${owner.pid} is still running; slot kept.` };
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
