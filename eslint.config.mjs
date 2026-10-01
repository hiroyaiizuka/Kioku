import { defineConfig, globalIgnores } from 'eslint/config';
import js from '@eslint/js';
import json from '@eslint/json';
import globals from 'globals';
import obsidianmd from 'eslint-plugin-obsidianmd';
// The rule's own default list, extended (not replaced) with the Q/A card markers used in Kioku UI text.
import { DEFAULT_ACRONYMS } from 'eslint-plugin-obsidianmd/dist/lib/rules/ui/acronyms.js';

const nodeOnlyOff = Object.fromEntries(
  [...Object.keys(globals.node).filter((key) => !(key in globals.browser)), 'NodeJS']
    .map((key) => [key, 'off']),
);

export default defineConfig(
  globalIgnores(['.claude/worktrees/**', 'node_modules/**', 'dist/**', 'test-vault/**', 'artifacts/**', '.tooling/**', 'coverage/**', 'package-lock.json']),
  { files: ['src/**/*.ts'], extends: [...obsidianmd.configs.recommended] },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser, ...nodeOnlyOff, __KIOKU_VERSION__: 'readonly', __KIOKU_BUILD_ID__: 'readonly' },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      'obsidianmd/no-nodejs-modules': 'error',
      'obsidianmd/ui/sentence-case': ['warn', { acronyms: [...DEFAULT_ACRONYMS, 'Q', 'A'] }],
      'obsidianmd/regex-lookbehind': ['error', { isDesktopOnly: false }],
      'no-restricted-imports': ['error', { patterns: ['node:*', 'electron'] }],
    },
  },
  { files: ['**/*.mjs'], extends: [js.configs.recommended], languageOptions: { globals: globals.node } },
  { files: ['scripts/e2e/smoke.mjs', 'tests/ui/*.test.mjs', 'tests/helpers/obsidian-mock.mjs'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  { files: ['*.json'], plugins: { json }, language: 'json/json', extends: ['json/recommended'] },
);
