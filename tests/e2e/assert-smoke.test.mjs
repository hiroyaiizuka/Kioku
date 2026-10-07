import { describe, expect, it } from 'vitest';
import { evaluateInPage, fakeDocument, fakePage } from '../helpers/cdp-server.mjs';
import { assertDeckPicker, assertNativeTarget, assertNoForeignModal, assertStartup, modalInventoryArrayExpression,
  modalInventoryExpression, modalObservation, nativeTargetExpression,
  obsidianVersionFromTitle } from '../../scripts/e2e/assert-smoke.mjs';

const expected = { buildId: 'abc', version: '0.0.1' };
const visible = { count: 1, text: 'Kioku デッキ AI は未実装', buildId: 'abc', version: '0.0.1',
  x: 300, y: 200, width: 400, height: 300, viewportWidth: 1000, viewportHeight: 700 };
const picker = { ...visible, text: 'デッキ新規学習中復習', header: 'デッキ', loaded: true };
describe('native smoke assertions', () => {
  it('rejects a missing, stale, duplicated, dishonest, invisible or off-center modal', () => {
    for (const state of [null, { ...visible, count: 0 }, { ...visible, count: 2 }, { ...visible, buildId: 'stale' },
      { ...visible, text: 'Kioku ready' }, { ...visible, text: 'Kioku M0 未実装' }, { ...visible, width: 0 }, { ...visible, x: 10 }]) {
      expect(() => assertStartup(state, expected)).toThrow();
    }
    expect(() => assertStartup(visible, expected)).not.toThrow();
  });
  it('rejects a missing, stale, duplicated, unloaded or off-center deck picker (the ribbon target)', () => {
    for (const state of [null, { ...picker, count: 0 }, { ...picker, count: 2 }, { ...picker, buildId: 'stale' },
      { ...picker, version: '0.0.2' }, { ...picker, loaded: false }, { ...picker, header: 'Kioku 状態' }, { ...picker, header: undefined }, { ...picker, y: 5 }]) {
      expect(() => assertDeckPicker(state, expected)).toThrow();
    }
    expect(() => assertDeckPicker(picker, expected)).not.toThrow();
    expect(modalObservation('.kioku-deck-picker-modal', null)).toContain('const b=e;');
    expect(modalObservation('.kioku-startup-modal', '.kioku-build-identity')).toContain('querySelector(".kioku-build-identity")');
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
    expect(() => assertNoForeignModal([{ kioku: true, classes: 'modal kioku-deck-picker-modal' }])).not.toThrow();
    for (const modals of [[{ kioku: false, classes: 'modal mod-lg mod-trust-folder' }],
      [{ kioku: true, classes: 'modal' }, { kioku: false, classes: 'modal mod-settings' }], [null], [{}], null, 0]) {
      expect(() => assertNoForeignModal(modals)).toThrow();
    }
    expect(() => assertNoForeignModal([{ kioku: false, classes: 'modal mod-trust-folder' }])).toThrow(/mod-trust-folder/);
    expect(modalInventoryExpression).toContain("'.modal-container'");
    for (const name of ['kioku-startup-modal', 'kioku-deck-picker-modal', 'kioku-candidate-modal']) {
      expect(modalInventoryExpression).toContain(name);
    }
  });
  it('expressions evaluate to the shapes CDP callers expect (string for CDP.value, array for embedding)', async () => {
    const page = fakePage({ document: fakeDocument([['modal', 'kioku-startup-modal'], ['modal', 'kioku-deck-picker-modal'],
      ['modal', 'kioku-candidate-modal'], ['modal', 'mod-trust-folder'], ['modal', 'kioku-deck-picker-modal-lookalike']]),
      app: { vault: { adapter: { getBasePath: () => '/kioku/test-vault' } } }, location: { href: 'app://obsidian.md/index.html' },
      process: { type: 'renderer', versions: { electron: '39.2.1' } } });
    const inventory = await evaluateInPage(page, modalInventoryExpression);
    expect(inventory.result.type).toBe('string');
    expect(JSON.parse(inventory.result.value)).toEqual([{ kioku: true, classes: 'modal kioku-startup-modal' },
      { kioku: true, classes: 'modal kioku-deck-picker-modal' }, { kioku: true, classes: 'modal kioku-candidate-modal' },
      { kioku: false, classes: 'modal mod-trust-folder' }, { kioku: false, classes: 'modal kioku-deck-picker-modal-lookalike' }]);
    const embedded = await evaluateInPage(page, `JSON.stringify({ modals: ${modalInventoryArrayExpression} })`);
    expect(Array.isArray(JSON.parse(embedded.result.value).modals)).toBe(true);
    const target = await evaluateInPage(page, nativeTargetExpression);
    expect(target.result.type).toBe('string');
    expect(JSON.parse(target.result.value)).toEqual({ vault: '/kioku/test-vault', url: 'app://obsidian.md/index.html',
      processType: 'renderer', electron: '39.2.1' });
  });
});
