import { mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, createFixture } from '../helpers/fixture.mjs';
import { prepareVault } from '../../scripts/lib/harness.mjs';
import { assertNotesUnchanged, captureNoteBaseline, loadNoteBaseline, snapshotNotes } from '../../scripts/lib/note-baseline.mjs';

const roots = [];
const setup = () => { const root = createFixture(); roots.push(root); return { root, expected: prepareVault(root) }; };
afterEach(() => { while (roots.length) cleanup(roots.pop()); });

describe('pre-startup note baseline filesystem contract (not native UI evidence)', () => {
  it('captures content paths and hashes, preserves its original record, and reuses it for restart', () => {
    const { root, expected } = setup(); mkdirSync(join(expected.vault, 'nested'));
    writeFileSync(join(expected.vault, 'nested', '日本語.md'), '# 学習\r\n');
    writeFileSync(join(expected.vault, 'nested', 'asset.bin'), Buffer.from([0, 255, 42]));
    writeFileSync(join(expected.vault, '__proto__'), 'content, not an object prototype');
    expect(() => captureNoteBaseline(root, expected, false)).toThrow(/closed/);
    const baseline = captureNoteBaseline(root, expected, true);
    const file = join(root, 'artifacts/e2e-smoke/baselines', `${baseline.id}.json`); const before = readFileSync(file);
    expect(Object.keys(baseline.files).sort()).toEqual(['Welcome.md', '__proto__', 'nested/asset.bin', 'nested/日本語.md']);
    expect(loadNoteBaseline(root, expected, baseline.id)).toEqual(baseline);
    expect(assertNotesUnchanged(root, baseline).status).toBe('PASS');
    writeFileSync(join(expected.vault, '.obsidian', 'workspace.json'), '{}');
    expect(assertNotesUnchanged(root, loadNoteBaseline(root, expected, baseline.id)).status).toBe('PASS');
    expect(readFileSync(file)).toEqual(before);
    expect(() => loadNoteBaseline(root, expected, undefined)).toThrow(/KIOKU_BASELINE_ID/);
    expect(() => loadNoteBaseline(root, { ...expected, buildId: 'new-build' }, baseline.id)).toThrow(/stale/);
    expect(() => loadNoteBaseline(root, expected, '../../outside')).toThrow(/KIOKU_BASELINE_ID/);
  });
  for (const operation of ['modify', 'add', 'delete', 'rename']) {
    it(`rejects a content file ${operation}`, () => {
      const { root, expected } = setup(); const baseline = captureNoteBaseline(root, expected, true);
      const note = join(expected.vault, 'Welcome.md');
      if (operation === 'modify') writeFileSync(note, 'mutated\n');
      if (operation === 'add') writeFileSync(join(expected.vault, 'Extra.md'), 'new note');
      if (operation === 'delete') unlinkSync(note);
      if (operation === 'rename') renameSync(note, join(expected.vault, 'Renamed.md'));
      expect(() => assertNotesUnchanged(root, baseline)).toThrow(/Vault content changed/);
    });
  }
  it('rejects linked content and linked artifact parents', () => {
    const { root, expected } = setup();
    symlinkSync(join(root, 'manifest.json'), join(expected.vault, 'linked.md'));
    expect(() => snapshotNotes(root)).toThrow(/symlink/);
    unlinkSync(join(expected.vault, 'linked.md'));
    mkdirSync(join(root, 'sentinel')); symlinkSync(join(root, 'sentinel'), join(root, 'artifacts'));
    expect(() => captureNoteBaseline(root, expected, true)).toThrow(/symlink/);
  });
});
