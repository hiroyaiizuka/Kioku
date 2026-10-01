import { describe, expect, it } from 'vitest';
import { assertNativeTarget, assertStartup } from '../../scripts/e2e/assert-smoke.mjs';

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
    expect(() => assertNativeTarget({ version: '1.8.7', vault: '/kioku/test-vault' }, '/kioku/test-vault')).not.toThrow();
    expect(() => assertNativeTarget({ version: '', vault: '/kioku/test-vault' }, '/kioku/test-vault')).toThrow();
    expect(() => assertNativeTarget({ version: '1.8.7', vault: '/personal' }, '/kioku/test-vault')).toThrow();
  });
});
