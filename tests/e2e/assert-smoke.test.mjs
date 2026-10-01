import { describe, expect, it } from 'vitest';
import { assertNativeTarget, assertNoForeignModal, assertStartup, modalInventoryExpression, nativeTargetExpression,
  obsidianVersionFromTitle } from '../../scripts/e2e/assert-smoke.mjs';

const expected = { buildId: 'abc', version: '0.0.1' };
const visible = { count: 1, text: 'Kioku M0 未実装', buildId: 'abc', version: '0.0.1',
  x: 300, y: 200, width: 400, height: 300, viewportWidth: 1000, viewportHeight: 700 };
describe('native smoke assertions', () => {
  it('rejects a missing, stale, duplicated, dishonest, invisible or off-center modal', () => {
    for (const state of [null, { ...visible, count: 0 }, { ...visible, count: 2 }, { ...visible, buildId: 'stale' },
      { ...visible, text: 'Kioku ready' }, { ...visible, width: 0 }, { ...visible, x: 10 }]) {
      expect(() => assertStartup(state, expected)).toThrow();
    }
    expect(() => assertStartup(visible, expected)).not.toThrow();
  });
  it('accepts only native Obsidian target information for the exact dedicated Vault', () => {
    const native = { version: '1.13.7', vault: '/kioku/test-vault', url: 'app://obsidian.md/index.html',
      processType: 'renderer', electron: '43.3.0' };
    expect(() => assertNativeTarget(native, '/kioku/test-vault')).not.toThrow();
    for (const state of [{ ...native, version: '' }, { ...native, vault: '/personal' }, { ...native, url: 'https://example.com' },
      { ...native, processType: '' }, { ...native, electron: '' }]) {
      expect(() => assertNativeTarget(state, '/kioku/test-vault')).toThrow();
    }
    expect(nativeTargetExpression).toContain('versions?.electron');
    expect(nativeTargetExpression).not.toContain("require?.('obsidian')");
    expect(obsidianVersionFromTitle('New tab - test-vault - Obsidian 1.13.7')).toBe('1.13.7');
    expect(obsidianVersionFromTitle('New tab - test-vault - Obsidian v1.13.7')).toBe('');
    expect(obsidianVersionFromTitle('test-vault - Obsidian')).toBe('');
  });
  it('fails on any open modal that is not Kioku, including the trust / restricted-mode dialog', () => {
    expect(() => assertNoForeignModal([])).not.toThrow();
    expect(() => assertNoForeignModal([{ kioku: true, classes: 'modal kioku-startup-modal' }])).not.toThrow();
    for (const modals of [[{ kioku: false, classes: 'modal mod-lg mod-trust-folder' }],
      [{ kioku: true, classes: 'modal' }, { kioku: false, classes: 'modal mod-settings' }], [null], [{}], null, 0]) {
      expect(() => assertNoForeignModal(modals)).toThrow();
    }
    expect(() => assertNoForeignModal([{ kioku: false, classes: 'modal mod-trust-folder' }])).toThrow(/mod-trust-folder/);
    expect(modalInventoryExpression).toContain("'.modal-container'");
    expect(modalInventoryExpression).toContain('.kioku-startup-modal');
  });
});
