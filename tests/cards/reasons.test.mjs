import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PENDING_CLOSED_NOTICE, REASONS, canvasEmbeds, canvasUnreadable, lostInline, lostNotice,
  refusalInline, refusalNotice, writeFailed } from '../../src/cards/reasons.ts';

const PREFIXES = ['保存しませんでした', '採用を確認できませんでした'];
const count = (text, phrase) => text.split(phrase).length - 1;
const allReasons = [
  ...Object.values(REASONS),
  writeFailed('disk full'),
  canvasEmbeds('board.canvas'),
  canvasUnreadable('board.canvas', 'Unexpected token'),
];

describe('user-facing reasons never duplicate the composed prefix', () => {
  it('no reason contains a prefix phrase itself', () => {
    for (const reason of allReasons) {
      for (const phrase of PREFIXES) expect(reason, reason).not.toContain(phrase);
    }
  });

  it('every composed Notice and inline text has each prefix phrase at most once', () => {
    for (const reason of allReasons) {
      for (const text of [refusalNotice(reason), refusalInline(reason), lostNotice(reason), lostInline(reason)]) {
        for (const phrase of PREFIXES) expect(count(text, phrase), text).toBeLessThanOrEqual(1);
      }
    }
    for (const phrase of PREFIXES) expect(count(PENDING_CLOSED_NOTICE, phrase)).toBeLessThanOrEqual(1);
  });

  it('keeps the prefix phrases only in the central reasons module', () => {
    const files = [];
    const walk = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path); else if (path.endsWith('.ts')) files.push(path);
      }
    };
    walk('src');
    const offenders = files.filter((file) => !file.endsWith(join('cards', 'reasons.ts'))
      && PREFIXES.some((phrase) => readFileSync(file, 'utf8').includes(phrase)));
    expect(offenders).toEqual([]);
  });
});
