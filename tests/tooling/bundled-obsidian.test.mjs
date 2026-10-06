import { existsSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, createFixture } from '../helpers/fixture.mjs';
import { bundledPackageVersion, readBundledObsidian } from '../../scripts/lib/bundled-obsidian.mjs';
import { harnessPaths, prepareVault, preflight } from '../../scripts/lib/harness.mjs';
import { prepareProfile, selectAsar } from '../../scripts/lib/obsidian-instance.mjs';
const roots = [];
afterEach(() => { vi.unstubAllEnvs(); while (roots.length) cleanup(roots.pop()); });
function archive(version) {
  const data = Buffer.from(JSON.stringify({ version }));
  const json = Buffer.from(JSON.stringify({ files: { 'package.json': { offset: '0', size: data.length } } }));
  const prefix = Buffer.alloc(16); prefix.writeUInt32LE(4); prefix.writeUInt32LE(json.length + 8, 4); prefix.writeUInt32LE(json.length, 12);
  return Buffer.concat([prefix, json, data]);
}
function fixture() {
  const root = createFixture(); roots.push(root);
  const contents = join(root, 'Obsidian.app', 'Contents');
  mkdirSync(join(contents, 'MacOS'), { recursive: true }); mkdirSync(join(contents, 'Resources'));
  const executable = join(contents, 'MacOS', 'Obsidian'); writeFileSync(executable, 'fake executable');
  writeFileSync(join(contents, 'Info.plist'), 'fake plist');
  writeFileSync(join(contents, 'Resources', 'obsidian.asar'), archive('1.13.7'));
  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    return { status: 0, stdout: JSON.stringify({ CFBundleIdentifier: 'md.obsidian', CFBundleExecutable: 'Obsidian', CFBundleShortVersionString: '1.13.7' }) };
  };
  return { root, contents, executable, calls, run };
}
describe('bundled official Obsidian fallback', () => {
  it('checks signer, identity, package version and real paths before returning bytes', () => {
    const { executable, run, calls } = fixture();
    const result = readBundledObsidian(executable, run);
    expect(result).toMatchObject({ version: '1.13.7', bundled: true, name: null });
    expect(calls[0][1]).toContain('=anchor apple generic and identifier "md.obsidian" and certificate leaf[subject.OU] = "6JSW4SJWN9"');
    expect(calls[0][1]).toContain('--strict');
    expect(() => readBundledObsidian(executable, () => ({ status: 1 }))).toThrow(/signature/);
    expect(() => readBundledObsidian(executable, () => ({ status: 0, stdout: '{}' }))).toThrow(/identity\/version/);
    for (const override of [
      { CFBundleIdentifier: 'other.app' },
      { CFBundleExecutable: 'Other' },
      { CFBundleShortVersionString: '1.13.6' },
    ]) {
      const checked = (command, args) => command === '/usr/bin/codesign' ? run(command, args) : ({
        status: 0, stdout: JSON.stringify({ CFBundleIdentifier: 'md.obsidian', CFBundleExecutable: 'Obsidian', CFBundleShortVersionString: '1.13.7', ...override }),
      });
      expect(() => readBundledObsidian(executable, checked)).toThrow(/identity\/version/);
    }
  });
  it('rejects linked archive parents and malformed archive metadata', () => {
    const { root, executable, contents, run } = fixture();
    mkdirSync(join(root, 'Linked.app')); symlinkSync(contents, join(root, 'Linked.app', 'Contents'));
    expect(() => readBundledObsidian(join(root, 'Linked.app', 'Contents', 'MacOS', 'Obsidian'), run)).toThrow(/symlink/);
    expect(() => bundledPackageVersion(Buffer.alloc(10))).toThrow(/header/);
    expect(() => bundledPackageVersion(archive('bad'))).toThrow(/version/);
    expect(() => bundledPackageVersion(archive('1.13.7').subarray(0, 30))).toThrow(/bounds/);
    expect(() => readBundledObsidian(executable + '.other', run)).toThrow(/bundle executable/);
  });
  it('uses the bundle in place only when no update exists, checks minimum and refuses stale profile updates', () => {
    const { root, executable, run } = fixture();
    const sourceDir = join(root, 'updates'); mkdirSync(sourceDir);
    const bundle = () => readBundledObsidian(executable, run);
    expect(() => selectAsar(sourceDir, '1.14.0', bundle)).toThrow(/below/);
    const options = { vault: join(root, 'Kioku テスト用'), sourceDir, minAppVersion: '1.8.7', bundledSource: bundle };
    const result = prepareProfile(root, options);
    expect(result.asar).toBe(join(root, 'Obsidian.app', 'Contents', 'Resources', 'obsidian.asar'));
    expect(result.config.vaults[Object.keys(result.config.vaults)[0]].path).toBe(options.vault);
    writeFileSync(join(root, '.tooling', 'obsidian-profile', 'obsidian-9.0.0.asar'), 'stale');
    expect(() => prepareProfile(root, options)).toThrow(/nothing was deleted/);
    writeFileSync(join(sourceDir, 'obsidian-1.14.3.asar'), 'installed update');
    expect(selectAsar(sourceDir, '1.8.7', () => { throw new Error('must not use fallback'); }).version).toBe('1.14.3');
  });
  it('prepares, validates and registers the same named dedicated Vault without making a legacy Vault', () => {
    const { root, executable, run } = fixture();
    vi.stubEnv('KIOKU_TEST_VAULT_NAME', 'Kioku テスト用');
    const prepared = prepareVault(root);
    const checked = preflight(root);
    expect(checked.vault).toBe(join(root, 'Kioku テスト用'));
    expect(prepared).toEqual(checked);
    const profile = prepareProfile(root, { vault: checked.vault, sourceDir: join(root, 'absent-updates'), minAppVersion: '1.8.7', bundledSource: () => readBundledObsidian(executable, run) });
    expect(Object.values(profile.config.vaults).map(entry => entry.path)).toEqual([checked.vault]);
    expect(existsSync(join(root, 'test-vault'))).toBe(false);
  });
  it('accepts only the Kioku-specific or legacy Vault name', () => {
    expect(harnessPaths('/project', {}).vault).toBe('/project/test-vault');
    expect(harnessPaths('/project', { KIOKU_TEST_VAULT_NAME: 'Kioku テスト用' }).vault).toBe('/project/Kioku テスト用');
    for (const name of ['', '../personal', '/Users/me/Notes', 'Mappy テスト用']) {
      expect(() => harnessPaths('/project', { KIOKU_TEST_VAULT_NAME: name })).toThrow(/Unsupported/);
    }
  });
});
