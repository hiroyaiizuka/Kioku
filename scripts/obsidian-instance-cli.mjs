import { enableCommunityPlugins, waitForDedicatedPage } from './lib/dedicated-cdp.mjs';
import { defaultSystem, launchDedicated, quitDedicated } from './lib/obsidian-instance.mjs';
import { projectRoot } from './lib/paths.mjs';

// Starts/stops ONLY the dedicated test-vault instance (own --user-data-dir under .tooling/). It never signals,
// quits or reconfigures the user's own Obsidian, and never looks processes up by name.
try {
  const command = process.argv[2];
  if (process.argv.length !== 3 || !['launch', 'quit'].includes(command)) {
    throw new Error('Usage: node scripts/obsidian-instance-cli.mjs launch|quit (no path arguments).');
  }
  const root = projectRoot();
  const result = command === 'launch'
    ? await launchDedicated(root, process.env, { ...defaultSystem, waitForDedicatedPage, enableCommunityPlugins })
    : await quitDedicated(root);
  console.info(JSON.stringify(result, null, 2));
  if (command === 'launch') {
    console.info('Dedicated instance started for test-vault only. This is not a UI PASS; run the smoke with a pre-launch baseline.');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
