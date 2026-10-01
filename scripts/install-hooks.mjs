import { spawnSync } from 'node:child_process';
import { chmodSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot, safePath, runCLI } from './lib/paths.mjs';

runCLI(() => {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/install-hooks.mjs');
  const root = projectRoot();
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' });
  if (top.status !== 0 || realpathSync(top.stdout.trim()) !== root) {
    throw new Error('Kioku has no Git worktree yet; hook installation refused. Do not initialize Git without approval.');
  }
  const hook = join(root, '.githooks', 'pre-commit');
  safePath(root, hook, 'file');
  chmodSync(hook, 0o755);
  const result = spawnSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Failed to install hooks.');
  console.info('Optional pre-commit hook installed; it always runs npm run check.');
});
