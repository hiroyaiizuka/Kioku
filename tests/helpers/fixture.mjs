import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDirectory, safePath } from '../../scripts/lib/paths.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));
const fixtureBase = join(project, 'artifacts', 'unit-fixtures');
const copies = ['.nvmrc', 'AGENTS.md', 'LICENSE', 'README.md', 'manifest.json', 'package.json', 'package-lock.json',
  'styles.css', 'tsconfig.json', 'versions.json', 'src', 'docs', 'scripts/build.mjs', 'scripts/lib/build.mjs',
  'scripts/validate.mjs', 'scripts/harness-cli.mjs', 'scripts/lib/harness.mjs',
  'scripts/e2e/smoke.mjs', 'scripts/e2e/assert-smoke.mjs',
  'scripts/lib/bundled-obsidian.mjs', 'scripts/lib/note-baseline.mjs', 'scripts/lib/cdp.mjs', 'scripts/lib/obsidian-instance.mjs',
  'scripts/lib/dedicated-cdp.mjs', 'scripts/obsidian-instance-cli.mjs', 'scripts/lib/heavy-queue.mjs', 'scripts/heavy-queue/heavy-queue.mjs',
  'scripts/lib/paths.mjs', '.claude/skills/review-check/SKILL.md',
  // The bundled runtime dependency: build inputs and the module esbuild resolves inside the fixture.
  'node_modules/ts-fsrs/package.json', 'node_modules/ts-fsrs/dist/index.mjs', 'node_modules/ts-fsrs/LICENSE'];
let serial = 0;
const generated = new Set();

export function createFixture() {
  ensureDirectory(project, fixtureBase);
  const root = join(fixtureBase, `case-${process.pid}-${serial += 1}`);
  safePath(project, root, 'directory', true);
  mkdirSync(root);
  generated.add(root);
  safePath(project, root, 'directory');
  try {
    for (const path of copies) {
      const source = join(project, path);
      safePath(project, source, ['src', 'docs'].includes(path) ? 'directory' : 'file');
      const destination = join(root, path);
      safePath(project, destination, ['src', 'docs'].includes(path) ? 'directory' : 'file', true);
      cpSync(source, destination, { recursive: true });
    }
    // Build only inside this fixture: parallel test workers must not copy another worker's dist temp files.
    const result = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Fixture build failed: ${result.stderr || result.stdout}`);
    return root;
  } catch (error) {
    cleanup(root);
    throw error;
  }
}
export function cleanup(root) {
  if (!generated.has(root)) throw new Error('Refusing cleanup of an unregistered fixture.');
  safePath(project, fixtureBase, 'directory');
  safePath(fixtureBase, root, 'directory');
  rmSync(root, { recursive: true });
  generated.delete(root);
}
