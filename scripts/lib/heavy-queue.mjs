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
 * harness:launch: wait for the slot, launch, then hand the slot to the dedicated Obsidian PID so it stays held after
 * this CLI exits (until harness:quit, or until that PID is gone). A failed launch releases it.
 */
export async function launchWithQueue(root, env, launch, system = defaultSystem, options = {}) {
  const queue = kiokuQueue(env, system);
  const held = await acquire(queue, { project, worktree: root, job: 'native', env }, options);
  if (held.mode !== 'acquired') {
    throw new HeavyQueueError(`harness:launch must own the native slot, but runs inside a held ${held.owner.job} slot `
      + `(pid ${held.owner.pid}); run it on its own. Nothing was started.`);
  }
  let result;
  try { result = await launch(); }
  catch (error) { release(queue, held.owner.ticketId, 'released-after-failed-launch'); throw error; }
  let owner;
  try { owner = handOff(queue, held.owner.ticketId, result.pid); }
  catch (error) {
    release(queue, held.owner.ticketId, 'released-after-failed-handoff');
    throw new HeavyQueueError(`Dedicated Obsidian pid ${result.pid} started, but the native slot could not be handed to it `
      + `(${error.message}); the slot was released. Run npm run harness:quit now.`);
  }
  return { ...result, heavyQueue: { dir: queue.dir, slot: 'native', waitedMs: held.waitedMs, owner: summary(owner),
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
