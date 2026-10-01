import { preflight, prepareVault, updateVault } from './lib/harness.mjs';
import { projectRoot, runCLI } from './lib/paths.mjs';

runCLI(() => {
  const actions = { prepare: prepareVault, update: updateVault, preflight };
  const action = actions[process.argv[2]];
  if (process.argv.length !== 3 || !Object.hasOwn(actions, process.argv[2]) || typeof action !== 'function') {
    throw new Error('Usage: node scripts/harness-cli.mjs prepare|update|preflight (no path arguments).');
  }
  const result = action(projectRoot());
  console.info(JSON.stringify(result, null, 2));
  console.info('Filesystem verification only. Obsidian was not started; this is not an actual UI PASS.');
});
