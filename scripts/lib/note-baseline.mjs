import { randomUUID } from 'node:crypto';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from './build.mjs';
import { assertGeneratedVault, harnessPaths } from './harness.mjs';
import { ensureDirectory, safePath, safeRead } from './paths.mjs';

/** Hash every content file, including attachments; only Obsidian settings and our marker are excluded. */
export function snapshotNotes(root) {
  const paths = harnessPaths(root); assertGeneratedVault(paths);
  const files = Object.create(null);
  function visit(relative) {
    const directory = join(paths.vault, relative); safePath(root, directory, 'directory');
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!relative && ['.obsidian', '.kioku-generated'].includes(entry.name)) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(name);
      else files[name] = sha256(safeRead(root, join(paths.vault, name)));
    }
  }
  visit('');
  return files;
}

function baselinePath(root, id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id)) {
    throw new Error('KIOKU_BASELINE_ID must identify the baseline captured before Obsidian startup.');
  }
  return join(root, 'artifacts', 'e2e-smoke', 'baselines', `${id}.json`);
}

export function captureNoteBaseline(root, expected, vaultClosed) {
  if (vaultClosed !== true) throw new Error('Confirm Obsidian is closed before capturing the startup baseline.');
  const baseline = { schema: 1, id: randomUUID(), capturedAt: new Date().toISOString(), stage: 'before-startup',
    vaultClosed: 'operator-confirmed-before-launch', vault: expected.vault, buildId: expected.buildId, version: expected.version,
    files: snapshotNotes(root) };
  const directory = join(root, 'artifacts', 'e2e-smoke', 'baselines'); ensureDirectory(root, directory);
  const file = baselinePath(root, baseline.id); safePath(root, file, 'file', true);
  writeFileSync(file, `${JSON.stringify(baseline, null, 2)}\n`, { flag: 'wx', mode: 0o400 });
  return baseline;
}

export function loadNoteBaseline(root, expected, id) {
  const baseline = JSON.parse(safeRead(root, baselinePath(root, id)).toString('utf8'));
  if (baseline.schema !== 1 || baseline.id !== id || baseline.stage !== 'before-startup'
      || baseline.vaultClosed !== 'operator-confirmed-before-launch' || typeof baseline.capturedAt !== 'string'
      || !Number.isFinite(Date.parse(baseline.capturedAt)) || baseline.vault !== expected.vault
      || baseline.buildId !== expected.buildId || baseline.version !== expected.version
      || !baseline.files || Array.isArray(baseline.files) || typeof baseline.files !== 'object'
      || Object.values(baseline.files).some((hash) => typeof hash !== 'string' || !/^[0-9a-f]{64}$/u.test(hash))) {
    throw new Error('Invalid or stale pre-startup note baseline. Do not rebaseline after startup or before restart.');
  }
  return baseline;
}

/**
 * The deck picker must not create the review data folder (not even an empty one, which a file
 * snapshot cannot see). The folder is `dataFolder` from the plugin's data.json, `Kioku` by default.
 */
export function assertNoReviewDataFolder(root) {
  const paths = harnessPaths(root); assertGeneratedVault(paths);
  const settingsFile = join(paths.installed, 'data.json');
  let folder = 'Kioku';
  if (safePath(root, settingsFile, 'file', true)) {
    const configured = JSON.parse(safeRead(root, settingsFile).toString('utf8')).dataFolder;
    if (typeof configured === 'string' && /^[^./][^:*?"<>|]*$/u.test(configured)
        && !configured.split('/').includes('..')) folder = configured;
  }
  if (safePath(root, join(paths.vault, ...folder.split('/')), 'directory', true)) {
    throw new Error(`Review data folder was created without a rating: ${folder}`);
  }
  return { folder, status: 'ABSENT' };
}

export function assertNotesUnchanged(root, baseline) {
  const actual = snapshotNotes(root);
  const changes = [...new Set([...Object.keys(baseline.files), ...Object.keys(actual)])].sort()
    .filter((file) => baseline.files[file] !== actual[file]);
  if (changes.length) throw new Error(`Vault content changed since before startup: ${changes.join(', ')}`);
  return { baselineId: baseline.id, capturedAt: baseline.capturedAt, fileCount: Object.keys(actual).length, status: 'PASS' };
}
