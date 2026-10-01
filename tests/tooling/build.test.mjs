import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFixture, cleanup } from '../helpers/fixture.mjs';
import { sha256, verifyDistribution } from '../../scripts/lib/build.mjs';
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
});
