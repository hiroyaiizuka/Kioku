import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createFixture, cleanup } from '../helpers/fixture.mjs';

const roots = [];
async function isolatedHelper() {
  const root = createFixture(); roots.push(root);
  const directory = join(root, 'tests', 'helpers'); mkdirSync(directory, { recursive: true });
  const helper = join(directory, 'fixture.mjs');
  copyFileSync(new URL('../helpers/fixture.mjs', import.meta.url), helper);
  return { root, helper: await import(pathToFileURL(helper).href) };
}
afterEach(() => { while (roots.length) cleanup(roots.pop()); });

describe('fixture helper safety in an isolated project', () => {
  for (const parent of ['artifacts', 'artifacts/unit-fixtures']) {
    it(`refuses creation through a linked ${parent} without writing to its target`, async () => {
      const { root, helper } = await isolatedHelper();
      const sentinel = join(root, 'sentinel'); mkdirSync(sentinel); writeFileSync(join(sentinel, 'keep'), 'keep');
      if (parent.includes('/')) mkdirSync(join(root, 'artifacts'));
      symlinkSync(sentinel, join(root, parent));
      expect(() => helper.createFixture()).toThrow(/symlink/);
      expect(readdirSync(sentinel)).toEqual(['keep']);
    });
  }
  for (const component of ['artifacts', 'artifacts/unit-fixtures', 'generated']) {
    it(`refuses cleanup through linked ${component} without deleting its target`, async () => {
      const { root, helper } = await isolatedHelper();
      const generated = helper.createFixture();
      const target = component === 'generated' ? generated : join(root, component);
      renameSync(target, `${target}.saved`); symlinkSync(`${target}.saved`, target);
      try {
        expect(() => helper.cleanup(generated)).toThrow(/symlink/);
        const preserved = generated.replace(target, `${target}.saved`);
        expect(existsSync(join(preserved, 'manifest.json'))).toBe(true);
      } finally {
        if (existsSync(target)) unlinkSync(target); renameSync(`${target}.saved`, target); helper.cleanup(generated);
      }
    });
  }
  it('never deletes an unregistered path', async () => {
    const { root, helper } = await isolatedHelper();
    const sentinel = join(root, 'sentinel'); mkdirSync(sentinel);
    expect(() => helper.cleanup(sentinel)).toThrow(/registered/);
    expect(existsSync(sentinel)).toBe(true);
  });
});
