import { join } from 'node:path';
import { buildInputs, productionBundle, sha256, validateMetadata } from './lib/build.mjs';
import { atomicWrite, ensureDirectory, projectRoot, safePath, safeRead } from './lib/paths.mjs';

const root = projectRoot();
if (process.argv.length !== 2) throw new Error('Usage: node scripts/build.mjs');
const manifest = validateMetadata(root);
const identity = buildInputs(root);
const output = join(root, 'dist', 'kioku');
ensureDirectory(root, output);
for (const file of ['main.js', 'manifest.json', 'styles.css', 'build-info.json']) {
  safePath(root, join(output, file), 'file', true);
}
const { bundle, externalImports } = productionBundle(root, manifest, identity);
const files = new Map([
  ['main.js', bundle],
  ['manifest.json', safeRead(root, join(root, 'manifest.json'))],
  ['styles.css', safeRead(root, join(root, 'styles.css'))],
]);
const info = {
  schema: 1, id: 'kioku', version: manifest.version, mode: 'production', ...identity,
  files: Object.fromEntries([...files].map(([name, bytes]) => [name, sha256(bytes)])), externalImports,
};
for (const [name, bytes] of files) atomicWrite(root, join(output, name), bytes);
atomicWrite(root, join(output, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`);
console.info(`Built Kioku ${manifest.version} (${identity.buildId}), ${bundle.length} bytes.`);
