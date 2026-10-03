// Generic entry for any project (tooling only):
//   node <path>/cli.mjs status
//   node <path>/cli.mjs run --project <name> --job check|native -- <command> [args...]
// `run` waits FIFO for the Mac-wide slot, runs the command with inherited stdio, then releases. The worktree is the
// real path of the current directory. Nothing is ever signalled; `status` never recovers or releases anything (it may
// create the queue directories on first use and record anomalies in history.jsonl).
import { realpathSync } from 'node:fs';
import { defaultQueueDir, defaultSystem, openQueue, run, status } from './heavy-queue.mjs';

const usage = 'Usage: cli.mjs status | cli.mjs run --project <name> --job check|native -- <command> [args...]';
try {
  const [command, ...rest] = process.argv.slice(2);
  const queue = () => openQueue(defaultQueueDir(process.env), defaultSystem);
  if (command === 'status' && rest.length === 0) {
    console.info(JSON.stringify(status(queue()), null, 2));
  } else if (command === 'run') {
    const separator = rest.indexOf('--');
    const options = separator < 0 ? [] : rest.slice(0, separator);
    const child = separator < 0 ? [] : rest.slice(separator + 1);
    const value = (flag) => { const index = options.indexOf(flag); return index >= 0 ? options[index + 1] : undefined; };
    const project = value('--project'); const job = value('--job');
    if (!project || !job || options.length !== 4 || !child.length) throw new Error(usage);
    process.exitCode = await run(queue(), { project, job, worktree: realpathSync(process.cwd()), env: process.env }, child[0], child.slice(1));
  } else throw new Error(usage);
} catch (error) { console.error(`Heavy-job queue refused: ${error.message}`); process.exitCode = 1; }
