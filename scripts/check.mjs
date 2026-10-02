// `npm run check`: runs the unchanged steps (`npm run check:steps`). Only with KIOKU_HEAVY_QUEUE=1 they run inside the
// Mac-wide heavy-job slot (scripts/lib/heavy-queue.mjs); otherwise the queue is never touched.
import { spawnSync } from 'node:child_process';
import { heavyQueueEnabled, runQueuedCheck } from './lib/heavy-queue.mjs';
import { projectRoot } from './lib/paths.mjs';

/** The npm that started us (npm_execpath), else `npm` from PATH. */
function stepsCommand(env = process.env) {
  return env.npm_execpath ? [process.execPath, [env.npm_execpath, 'run', 'check:steps']] : ['npm', ['run', 'check:steps']];
}

try {
  if (process.argv.length !== 2) throw new Error('Usage: npm run check');
  const [command, args] = stepsCommand();
  if (!heavyQueueEnabled(process.env)) {
    const result = spawnSync(command, args, { stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } else process.exitCode = await runQueuedCheck(projectRoot(), process.env, command, args);
} catch (error) { console.error(error.message); process.exitCode = 1; }
