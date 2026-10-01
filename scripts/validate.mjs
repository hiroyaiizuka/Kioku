import { validateMetadata, verifyDistribution } from './lib/build.mjs';
import { projectRoot, runCLI } from './lib/paths.mjs';

runCLI(() => {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--artifacts')) {
    throw new Error('Usage: node scripts/validate.mjs [--artifacts]');
  }
  const root = projectRoot();
  const manifest = validateMetadata(root);
  if (process.argv[2]) verifyDistribution(root);
  console.info(`Validated Kioku ${manifest.version}${process.argv[2] ? ' distribution and hashes' : ' metadata'}.`);
});
