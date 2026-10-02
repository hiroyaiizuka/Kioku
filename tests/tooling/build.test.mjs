import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFixture, cleanup } from '../helpers/fixture.mjs';
import { sha256, validateMetadata, verifyDistribution } from '../../scripts/lib/build.mjs';
import { harnessPaths, prepareVault, preflight } from '../../scripts/lib/harness.mjs';

const roots = [];
const setup = () => { const root = createFixture(); roots.push(root); return root; };
afterEach(() => { while (roots.length) cleanup(roots.pop()); });

describe('source-to-distribution provenance', () => {
  it('accepts the current production bytes without rebuilding on disk', () => {
    const root = setup(); const before = readFileSync(join(root, 'dist/kioku/main.js'));
    expect(verifyDistribution(root).files.get('main.js')).toEqual(before);
    expect(readFileSync(join(root, 'dist/kioku/main.js'))).toEqual(before);
  });
  it('rejects a fake bundle even with rehashed dist and identical installed files', () => {
    const root = setup(); prepareVault(root);
    const info = JSON.parse(readFileSync(join(root, 'dist/kioku/build-info.json'), 'utf8'));
    const fake = `module.exports={default:class NotKioku{}}; // ${info.buildId} ${info.version}\n`;
    info.files['main.js'] = sha256(fake);
    for (const directory of [join(root, 'dist/kioku'), harnessPaths(root).installed]) {
      writeFileSync(join(directory, 'main.js'), fake);
      writeFileSync(join(directory, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`);
    }
    expect(() => verifyDistribution(root)).toThrow(/production bundle/);
    expect(() => preflight(root)).toThrow(/production bundle/);
    for (const args of [['scripts/validate.mjs', '--artifacts'], ['scripts/harness-cli.mjs', 'preflight']]) {
      const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toMatch(/production bundle/);
    }
  });
  it('bundles exactly the pinned MIT ts-fsrs with its notice, keeping obsidian the only external import', () => {
    const root = setup();
    const bundle = readFileSync(join(root, 'dist/kioku/main.js'), 'utf8');
    expect(bundle.startsWith('/*!\n * Bundled: ts-fsrs 5.4.2\n * MIT License\n * \n * Copyright (c) 2026 Open Spaced Repetition')).toBe(true);
    const info = JSON.parse(readFileSync(join(root, 'dist/kioku/build-info.json'), 'utf8'));
    expect(info.bundledDependencies).toEqual({ 'ts-fsrs': '5.4.2' });
    expect(info.externalImports).toEqual(['obsidian']);
    expect(Object.keys(info.inputs)).toEqual(expect.arrayContaining(['node_modules/ts-fsrs/dist/index.mjs', 'node_modules/ts-fsrs/LICENSE']));
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ ...pkg, dependencies: { 'ts-fsrs': '^5.4.2' } }));
    expect(() => validateMetadata(root)).toThrow(/Runtime dependencies must be exactly/);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ ...pkg, dependencies: { 'ts-fsrs': '5.4.2', other: '1.0.0' } }));
    expect(() => validateMetadata(root)).toThrow(/Runtime dependencies must be exactly/);
  });
  it('the production bundle does not leave ts-fsrs Date.prototype helpers in the host window', () => {
    const root = setup();
    const bundle = readFileSync(join(root, 'dist/kioku/main.js'), 'utf8');
    const Dummy = class {};
    const obsidian = new Proxy({}, { get: () => Dummy });
    const context = { module: { exports: {} }, require: (id) => { if (id === 'obsidian') return obsidian; throw new Error(id); } };
    context.exports = context.module.exports;
    vm.runInNewContext(`${bundle}\n;globalThis.leaked = ['scheduler', 'diff', 'format', 'dueFormat'].filter((name) => name in Date.prototype);`, context);
    expect(context.leaked).toEqual([]);
    expect(typeof context.module.exports.default).toBe('function');
  });
});
