import { describe, expect, it } from 'vitest';
import { findAnchors, planInsertion, validateQuoteRecord } from '../../src/cards/insertion.ts';
import { existingCardIds, extractCandidates } from '../../src/cards/parser.ts';

const fixed = (length) => Uint8Array.from({ length }, (_, index) => index % 36);
const ID = 'kioku-0123456789';
const CARD = { question: '光合成が行われる細胞小器官は？', answer: '葉緑体' };
const anchorOf = (text, quote) => {
  const at = text.indexOf(quote);
  const anchor = findAnchors(text).find((item) => item.start <= at && at < item.end);
  return { start: anchor.start, text: anchor.text, quote };
};

describe('generated card insertion (§9, Q2)', () => {
  it('inserts the card and the quote record after the paragraph, changing no existing character', () => {
    const note = '# 生物\n光合成は糖を作る反応である。葉緑体で行われる。\n\n## 次\n';
    const plan = planInsertion(note, anchorOf(note, '葉緑体で行われる。'), CARD, fixed);
    expect(plan.ok).toBe(true);
    expect(plan.cardId).toBe(ID);
    expect(plan.next).toBe('# 生物\n光合成は糖を作る反応である。葉緑体で行われる。\n\nQ: 光合成が行われる細胞小器官は？\nA: 葉緑体 ^kioku-0123456789\n\n%%kioku-src:kioku-0123456789\n葉緑体で行われる。\n%%\n\n## 次\n');
    // The original text is intact around the insertion.
    expect(plan.next.slice(0, plan.offset) + plan.next.slice(plan.offset + plan.insert.length)).toBe(note);
    // The card is an adopted Q/A for M1/M2; the quote record is not a candidate.
    const candidates = extractCandidates(plan.next);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ status: 'adopted', cardId: ID, question: CARD.question, answer: CARD.answer });
    expect(existingCardIds(plan.next)).toEqual(new Set([ID]));
  });

  it('adds a blank line when non-blank text follows directly, and nothing extra at EOF', () => {
    const fenced = '本文の文。\n```\ncode\n```\n';
    expect(planInsertion(fenced, anchorOf(fenced, '本文の文。'), CARD, fixed).next).toMatch(/\n%%\n\n```\ncode/);
    const eof = '最後の文。';
    expect(planInsertion(eof, anchorOf(eof, '最後の文。'), CARD, fixed).next).toMatch(/^最後の文。\n\nQ: .*\n%%$/s);
  });

  it('inserts after the whole list, table, quote or callout (never inside the structure)', () => {
    const list = '- 一つ目の項目\n\n- 二つ目の項目\n  続きの行\n\n本文\n';
    const listPlan = planInsertion(list, anchorOf(list, '一つ目の項目'), CARD, fixed);
    expect(listPlan.offset).toBe(list.indexOf('続きの行') + '続きの行'.length);
    // A line right after a table continues it (GFM), so the card goes after that line too.
    const table = '| 語 | 意味 |\n| --- | --- |\n| ATP | エネルギー通貨 |\n後続\n\n次\n';
    const tablePlan = planInsertion(table, anchorOf(table, 'エネルギー通貨'), CARD, fixed);
    expect(tablePlan.offset).toBe(table.indexOf('\n\n次'));
    const callout = '> [!note] 要点\n> 葉緑体で行われる。\n\n本文\n';
    expect(planInsertion(callout, anchorOf(callout, '葉緑体で行われる。'), CARD, fixed).offset).toBe(callout.indexOf('\n\n本文'));
  });

  it('keeps CRLF line breaks', () => {
    const note = '葉緑体で行われる。\r\n\r\n次\r\n';
    expect(planInsertion(note, anchorOf(note, '葉緑体で行われる。'), CARD, fixed).insert)
      .toBe('\r\n\r\nQ: 光合成が行われる細胞小器官は？\r\nA: 葉緑体 ^kioku-0123456789\r\n\r\n%%kioku-src:kioku-0123456789\r\n葉緑体で行われる。\r\n%%');
  });

  it('refuses when the block changed, is ambiguous, or the card / quote cannot be stored', () => {
    const note = '甲は乙である。\n\n丙は丁である。\n';
    const recorded = anchorOf(note, '甲は乙である。');
    expect(planInsertion('甲は乙でない。\n\n丙は丁である。\n', recorded, CARD, fixed)).toMatchObject({ ok: false, reason: expect.stringContaining('変更') });
    const duplicated = '前置き\n\n甲は乙である。\n\n甲は乙である。\n';
    expect(planInsertion(duplicated, { ...recorded, start: 999 }, CARD, fixed)).toMatchObject({ ok: false, reason: expect.stringContaining('複数') });
    // Moved but unique: found again by its text.
    expect(planInsertion(`前置き\n\n${note}`, recorded, CARD, fixed).ok).toBe(true);
    expect(planInsertion(note, recorded, { question: '', answer: 'x' }, fixed)).toMatchObject({ ok: false });
    expect(planInsertion(note, recorded, { question: 'a\n\nb', answer: 'x' }, fixed)).toMatchObject({ ok: false });
    expect(planInsertion(note, { ...recorded, quote: '50%%' }, CARD, fixed)).toMatchObject({ ok: false, reason: expect.stringContaining('引用を記録できない') });
  });

  it('validates quote records like edit records', () => {
    expect(validateQuoteRecord('普通の文。')).toBeNull();
    for (const bad of ['a\n\nb', 'x %% y', '$$x$$', '<!-- c -->', '^kioku-abc', '# 見出し', 'Q: 問い', '```']) {
      expect(validateQuoteRecord(bad), bad).not.toBeNull();
    }
  });

  it('never reuses an ID left in a quote record', () => {
    expect(existingCardIds('%%kioku-src:kioku-aaaaaaaaaa\n引用\n%%')).toEqual(new Set(['kioku-aaaaaaaaaa']));
  });
});
