import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installedFiles, sha256, verifyDistribution } from './build.mjs';
import { atomicWrite, ensureDirectory, safePath, safeRead } from './paths.mjs';

export const markerContents = 'Kioku dedicated test vault v1\n';
export function harnessPaths(root) {
  const vault = join(root, 'test-vault');
  return {
    root, vault,
    marker: join(vault, '.kioku-generated'),
    installed: join(vault, '.obsidian', 'plugins', 'kioku'),
    enabled: join(vault, '.obsidian', 'community-plugins.json'),
  };
}

export function assertGeneratedVault(paths) {
  safePath(paths.root, paths.vault, 'directory');
  if (safeRead(paths.root, paths.marker).toString('utf8') !== markerContents) {
    throw new Error('Refusing unrecognized test-vault marker.');
  }
}

export function enabledPlugins(paths) {
  const value = JSON.parse(safeRead(paths.root, paths.enabled).toString('utf8'));
  if (!Array.isArray(value) || value.length !== 1 || value[0] !== 'kioku') {
    throw new Error('community-plugins.json must enable exactly kioku (no duplicates / other plugins).');
  }
  return value;
}

export function prepareVault(root) {
  const paths = harnessPaths(root);
  if (safePath(root, paths.vault, 'directory', true)) {
    throw new Error('test-vault already exists; prepare never overwrites it. Use harness:update.');
  }
  const build = verifyDistribution(root);
  mkdirSync(paths.vault); // Not recursive: a concurrently created vault must cause failure.
  writeFileSync(paths.marker, markerContents, { flag: 'wx', mode: 0o600 });
  ensureDirectory(root, paths.installed);
  for (const [file, bytes] of build.files) atomicWrite(root, join(paths.installed, file), bytes);
  atomicWrite(root, paths.enabled, '["kioku"]\n');
  atomicWrite(root, join(paths.vault, 'Welcome.md'), '# Kioku M0 起動確認\n\nカード作成・保存・復習は未実装です。\n左 ribbon の「フラッシュカード」を開き、起動確認ポップアップを閉じてください。\nこのノートの変更は harness:update で上書きされません。\n');
  return preflight(root);
}

export function updateVault(root) {
  const paths = harnessPaths(root);
  assertGeneratedVault(paths);
  enabledPlugins(paths); // Never repair or rewrite existing settings.
  const build = verifyDistribution(root);
  safePath(root, paths.installed, 'directory');
  // Validate every destination before the first write, so a later linked file cannot cause partial update.
  for (const file of installedFiles) safePath(root, join(paths.installed, file), 'file', true);
  for (const [file, bytes] of build.files) atomicWrite(root, join(paths.installed, file), bytes);
  return preflight(root);
}

export function preflight(root) {
  const paths = harnessPaths(root);
  assertGeneratedVault(paths);
  const enabled = enabledPlugins(paths);
  const build = verifyDistribution(root);
  const hashes = {};
  for (const file of installedFiles) {
    const actual = safeRead(root, join(paths.installed, file));
    const expected = sha256(build.files.get(file));
    if (sha256(actual) !== expected) throw new Error(`Installed hash mismatch: ${file}; run harness:update with Obsidian closed.`);
    hashes[file] = expected;
  }
  return { id: 'kioku', version: build.manifest.version, buildId: build.info.buildId, vault: paths.vault, enabled, hashes };
}
