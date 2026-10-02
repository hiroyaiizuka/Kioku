import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildSync } from 'esbuild';
import { safePath, safeRead } from './paths.mjs';

export const pluginFiles = ['main.js', 'manifest.json', 'styles.css'];
export const installedFiles = [...pluginFiles, 'build-info.json'];
export const requiredDocs = ['AGENTS.md', 'README.md', 'docs/product-plan.md', 'docs/architecture.md',
  'docs/harness.md', 'docs/linear-workflow.md', 'docs/development.md', '.claude/skills/review-check/SKILL.md'];
/** The only runtime dependency (bundled, never external), pinned exactly. See docs/m2-design.md §4.1. */
export const runtimeDependencies = { 'ts-fsrs': '5.4.2' };
/** Bundled dependency files that are build inputs (their bytes change the build ID). */
export const dependencyInputs = ['node_modules/ts-fsrs/package.json', 'node_modules/ts-fsrs/dist/index.mjs',
  'node_modules/ts-fsrs/LICENSE'];
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const readJSON = (root, file) => JSON.parse(safeRead(root, join(root, file)).toString('utf8'));

export function validateMetadata(root) {
  const manifest = readJSON(root, 'manifest.json');
  const pkg = readJSON(root, 'package.json');
  const lock = readJSON(root, 'package-lock.json');
  const versions = readJSON(root, 'versions.json');
  if (manifest.id !== 'kioku' || manifest.name !== 'Kioku' || manifest.isDesktopOnly !== true) {
    throw new Error('Manifest must declare kioku / Kioku / desktop only.');
  }
  if (!/^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(manifest.version)) throw new Error('Expected beta version 0.x.y.');
  for (const field of ['minAppVersion', 'description', 'author']) {
    if (typeof manifest[field] !== 'string' || !manifest[field].trim()) throw new Error(`Missing manifest ${field}.`);
  }
  if (pkg.name !== 'kioku' || pkg.private !== true || pkg.license !== 'MIT'
      || pkg.version !== manifest.version || versions[manifest.version] !== manifest.minAppVersion) {
    throw new Error('package / manifest / versions mismatch.');
  }
  if (JSON.stringify(pkg.dependencies ?? {}) !== JSON.stringify(runtimeDependencies)
      || JSON.stringify(lock.packages?.['']?.dependencies ?? {}) !== JSON.stringify(runtimeDependencies)) {
    throw new Error(`Runtime dependencies must be exactly ${JSON.stringify(runtimeDependencies)}.`);
  }
  for (const [name, version] of Object.entries(runtimeDependencies)) {
    const locked = lock.packages[`node_modules/${name}`];
    if (locked?.version !== version || locked.license !== 'MIT' || locked.dev) throw new Error(`Lock resolution mismatch: ${name}`);
    if (locked.dependencies && Object.keys(locked.dependencies).length) throw new Error(`${name} must not pull runtime dependencies.`);
    const installed = readJSON(root, `node_modules/${name}/package.json`);
    if (installed.name !== name || installed.version !== version || installed.license !== 'MIT') {
      throw new Error(`Installed ${name} is not the pinned MIT ${version}; run npm ci.`);
    }
  }
  if (pkg.devDependencies.obsidian !== manifest.minAppVersion) throw new Error('API types must match minAppVersion.');
  const nodeVersion = safeRead(root, join(root, '.nvmrc')).toString('utf8').trim();
  if (nodeVersion !== '22.22.3' || pkg.engines.node !== nodeVersion) throw new Error('Node version mismatch.');
  if (lock.lockfileVersion !== 3 || lock.name !== pkg.name || lock.version !== pkg.version
      || lock.packages?.['']?.version !== pkg.version) throw new Error('Lockfile metadata mismatch.');
  const lockedDeps = lock.packages[''].devDependencies;
  if (JSON.stringify(lockedDeps) !== JSON.stringify(pkg.devDependencies)) throw new Error('Lockfile dependencies mismatch.');
  for (const [name, version] of Object.entries(pkg.devDependencies)) {
    if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error(`Pin stable tooling: ${name}`);
    if (lock.packages[`node_modules/${name}`]?.version !== version) throw new Error(`Lock resolution mismatch: ${name}`);
  }
  for (const doc of requiredDocs) safeRead(root, join(root, doc));
  if (!safeRead(root, join(root, 'LICENSE')).toString('utf8').startsWith('MIT License')) throw new Error('Expected MIT LICENSE.');
  return manifest;
}

export function buildInputs(root) {
  const files = ['manifest.json', 'versions.json', 'styles.css', 'package.json', 'package-lock.json', '.nvmrc',
    'tsconfig.json', 'scripts/build.mjs', 'scripts/lib/build.mjs', 'scripts/lib/paths.mjs', ...dependencyInputs];
  // Dirent classification is checked again by safePath: symlinks must never be treated as input.
  function sourceFiles(directory) {
    safePath(root, join(root, directory), 'directory');
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) sourceFiles(file);
      else { safePath(root, join(root, file), 'file'); files.push(file); }
    }
  }
  sourceFiles('src');
  const inputs = Object.fromEntries(files.sort().map((file) => [file, sha256(safeRead(root, join(root, file)))]));
  return { inputs, buildId: sha256(JSON.stringify(inputs)) };
}

/** MIT notices of bundled dependencies, kept verbatim at the top of main.js. */
export function licenseBanner(root) {
  return Object.entries(runtimeDependencies).map(([name, version]) => {
    const text = safeRead(root, join(root, 'node_modules', name, 'LICENSE')).toString('utf8').trim();
    if (!text.startsWith('MIT License') || text.includes('*/')) throw new Error(`Unexpected ${name} license text.`);
    return `/*!\n * Bundled: ${name} ${version}\n * ${text.split('\n').join('\n * ')}\n */`;
  }).join('\n');
}

/** One production recipe for emission and independent, in-memory verification. */
export function productionBundle(root, manifest, identity) {
  const result = buildSync({
    banner: { js: licenseBanner(root) },
    absWorkingDir: root,
    entryPoints: ['src/main.ts'],
    outfile: 'dist/kioku/main.js',
    bundle: true,
    platform: 'browser',
    format: 'cjs',
    target: 'es2021',
    external: ['obsidian'],
    define: { __KIOKU_VERSION__: JSON.stringify(manifest.version), __KIOKU_BUILD_ID__: JSON.stringify(identity.buildId) },
    sourcemap: false,
    minify: true,
    treeShaking: true,
    metafile: true,
    write: false,
  });
  const externalImports = [...new Set(Object.values(result.metafile.outputs)
    .flatMap((item) => item.imports.filter((entry) => entry.external).map((entry) => entry.path)))].sort();
  if (JSON.stringify(externalImports) !== JSON.stringify(['obsidian'])) {
    throw new Error('Only public Obsidian runtime imports allowed.');
  }
  return { bundle: Buffer.from(result.outputFiles[0].contents), externalImports };
}

export function verifyDistribution(root, { metadata = true } = {}) {
  if (metadata) validateMetadata(root);
  const directory = join(root, 'dist', 'kioku');
  safePath(root, directory, 'directory');
  if (JSON.stringify(readdirSync(directory).sort()) !== JSON.stringify([...installedFiles].sort())) {
    throw new Error('dist/kioku must contain exactly the four distribution files.');
  }
  const info = readJSON(root, 'dist/kioku/build-info.json');
  const current = buildInputs(root);
  const manifest = readJSON(root, 'manifest.json');
  if (info.schema !== 1 || info.id !== 'kioku' || info.version !== manifest.version || info.mode !== 'production'
      || info.buildId !== current.buildId || JSON.stringify(info.inputs) !== JSON.stringify(current.inputs)) {
    throw new Error('Stale build identity or inputs; run npm run check.');
  }
  if (JSON.stringify(Object.keys(info.files ?? {}).sort()) !== JSON.stringify([...pluginFiles].sort())) {
    throw new Error('Invalid distribution hash table.');
  }
  const files = new Map();
  for (const file of pluginFiles) {
    const bytes = safeRead(root, join(directory, file));
    if (sha256(bytes) !== info.files[file]) throw new Error(`Distribution hash mismatch: ${file}`);
    files.set(file, bytes);
  }
  for (const file of ['manifest.json', 'styles.css']) {
    if (sha256(safeRead(root, join(root, file))) !== info.files[file]) throw new Error(`Source / dist mismatch: ${file}`);
  }
  const expected = productionBundle(root, manifest, current);
  if (!files.get('main.js').equals(expected.bundle)) {
    throw new Error('Distribution differs from the current source production bundle; run npm run check.');
  }
  if (JSON.stringify(info.externalImports) !== JSON.stringify(expected.externalImports)) {
    throw new Error('Unexpected runtime imports.');
  }
  if (JSON.stringify(info.bundledDependencies) !== JSON.stringify(runtimeDependencies)) {
    throw new Error('build-info must record exactly the pinned bundled dependencies.');
  }
  files.set('build-info.json', safeRead(root, join(directory, 'build-info.json')));
  return { info, manifest, files };
}
