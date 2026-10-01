import { linkSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFixture, cleanup } from '../helpers/fixture.mjs';
import { harnessPaths, prepareVault, preflight, updateVault } from '../../scripts/lib/harness.mjs';

const roots = [];
const setup = () => { const root = createFixture(); roots.push(root); return root; };
afterEach(() => { while (roots.length) cleanup(roots.pop()); });

describe('dedicated vault harness', () => {
  it('prepares only a missing dedicated vault and refuses every existing vault', () => {
    const root = setup(); const result = prepareVault(root);
    expect(result).toMatchObject({ id: 'kioku', version: '0.0.1', enabled: ['kioku'] });
    expect(() => prepareVault(root)).toThrow(/already exists/);
    const other = setup(); mkdirSync(join(other, 'test-vault')); writeFileSync(join(other, 'test-vault', 'Personal.md'), 'keep');
    expect(() => prepareVault(other)).toThrow(/already exists/);
    expect(readFileSync(join(other, 'test-vault', 'Personal.md'), 'utf8')).toBe('keep');
  });
  it('updates only four plugin files and preserves Markdown, config and plugin data byte-for-byte', () => {
    const root = setup(); prepareVault(root); const paths = harnessPaths(root);
    writeFileSync(join(paths.vault, 'Welcome.md'), '# personal changes\n');
    writeFileSync(join(paths.installed, 'data.json'), '{"user":true}\n');
    writeFileSync(join(paths.vault, '.obsidian', 'app.json'), '{"user":"setting"}\n');
    const protectedFiles = ['Welcome.md', '.obsidian/app.json', '.obsidian/community-plugins.json', '.obsidian/plugins/kioku/data.json'];
    const before = Object.fromEntries(protectedFiles.map((file) => [file, readFileSync(join(paths.vault, file))]));
    writeFileSync(join(paths.installed, 'main.js'), 'stale');
    updateVault(root);
    for (const file of protectedFiles) expect(readFileSync(join(paths.vault, file))).toEqual(before[file]);
    expect(preflight(root).hashes['main.js']).toHaveLength(64);
  });
  it('detects stale distribution, installed bytes, disabled, extra and duplicate plugins', () => {
    const root = setup(); prepareVault(root); const paths = harnessPaths(root);
    writeFileSync(join(paths.installed, 'styles.css'), 'stale'); expect(() => preflight(root)).toThrow(/Installed hash/);
    updateVault(root); writeFileSync(paths.enabled, '[]\n'); expect(() => preflight(root)).toThrow(/exactly kioku/);
    writeFileSync(paths.enabled, '["kioku","other"]\n'); expect(() => preflight(root)).toThrow(/exactly kioku/);
    writeFileSync(paths.enabled, '["kioku","kioku"]\n'); expect(() => preflight(root)).toThrow(/exactly kioku/);
    writeFileSync(paths.enabled, '["kioku"]\n');
    const source = join(root, 'src', 'main.ts'); writeFileSync(source, `${readFileSync(source)}\n// stale input`);
    expect(() => preflight(root)).toThrow(/Stale build/);
  });
  it('refuses symlinked destinations and hard-linked files before an update writes anything', () => {
    const root = setup(); prepareVault(root); const paths = harnessPaths(root);
    const sentinel = join(root, 'sentinel'); mkdirSync(sentinel); writeFileSync(join(sentinel, 'keep'), 'outside');
    const style = join(paths.installed, 'styles.css'); renameSync(style, `${style}.original`);
    symlinkSync(join(sentinel, 'keep'), style); writeFileSync(join(paths.installed, 'main.js'), 'must remain stale');
    expect(() => updateVault(root)).toThrow(/symlink/);
    expect(readFileSync(join(paths.installed, 'main.js'), 'utf8')).toBe('must remain stale');
    expect(readFileSync(join(sentinel, 'keep'), 'utf8')).toBe('outside');

    const hardRoot = setup(); prepareVault(hardRoot); const hardPaths = harnessPaths(hardRoot);
    const main = join(hardPaths.installed, 'main.js'); linkSync(main, join(hardPaths.installed, 'linked-main'));
    expect(() => updateVault(hardRoot)).toThrow(/hard link/);
  });
});
