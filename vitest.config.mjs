import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/**/*.test.mjs'], exclude: [...configDefaults.exclude, '.claude/**'], environment: 'node', testTimeout: 15000 },
});
