import { describe, expect, it } from 'vitest';
import { normalizeField, planAdoption, validateEdit } from '../../src/cards/adoption.ts';
import { CARD_ID_PATTERN, generateCardId } from '../../src/cards/card-id.ts';
import { extractCandidates } from '../../src/cards/parser.ts';

/** Deterministic bytes: each call returns the next fixed sequence. */
function bytes(...sequences) {
  let call = 0;
  return (length) => {
    const source = sequences[Math.min(call, sequences.length - 1)];
    call += 1;
    return Uint8Array.from({ length }, (_, index) => source[index % source.length]);
  };
}
const ID_A = bytes([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
const record = (candidate) => ({ start: candidate.start, sourceText: candidate.sourceText });
const same = (candidate) => ({ question: candidate.question, answer: candidate.answer });

describe('card IDs', () => {
  it('are random-source based, prefixed, URL/block-ID safe and avoid IDs already in the note', () => {
    expect(generateCardId(new Set(), ID_A)).toBe('kioku-0123456789');
    const collision = bytes([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(generateCardId(new Set(['kioku-0123456789']), collision)).toBe('kioku-abcdefghij');
    expect(generateCardId(new Set())).toMatch(CARD_ID_PATTERN);
  });
  it('rejects biased bytes instead of skewing the alphabet', () => {
    const biased = bytes([255, 252, 0]);
    expect(generateCardId(new Set(), biased)).toBe('kioku-0000000000');
    expect(() => generateCardId(new Set(), bytes([255]))).toThrow();
  });
  it('produce distinct IDs from the platform random source', () => {
    const ids = new Set(Array.from({ length: 200 }, () => generateCardId(new Set())));
    expect(ids.size).toBe(200);
  });
});

describe('planAdoption: verify then insert once, never rewriting the original', () => {
  it('appends only a block ID to the last line of an unedited card (Japanese, CRLF, at EOF)', () => {
    for (const eol of ['\n', '\r\n']) {
      const note = ['# 見出し', 'Q: 光合成とは？', 'A: 光で糖を作る反応', '', '本文'].join(eol);
      const [candidate] = extractCandidates(note);
      const plan = planAdoption(note, record(candidate), same(candidate), ID_A);
      expect(plan).toMatchObject({ ok: true, cardId: 'kioku-0123456789', insert: ' ^kioku-0123456789' });
      expect(plan.next).toBe(['# 見出し', 'Q: 光合成とは？', 'A: 光で糖を作る反応 ^kioku-0123456789', '', '本文'].join(eol));
      expect(plan.next.replace(' ^kioku-0123456789', '')).toBe(note);
      expect(extractCandidates(plan.next)[0]).toMatchObject({ status: 'adopted', cardId: 'kioku-0123456789' });
    }
    const atEnd = 'Q: q\nA: a';
    expect(planAdoption(atEnd, record(extractCandidates(atEnd)[0]), { question: 'q', answer: 'a' }, ID_A).next)
      .toBe('Q: q\nA: a ^kioku-0123456789');
  });

  it('keeps the original and stores an edited card in a hidden edit record with the note line ending', () => {
    const heading = 'Q: 原文の問い\r\nA: 原文の答え\r\n# 次の見出し\r\n';
    const blocks = 'Q: 原文の問い\r\nA: 原文の答え\r\n\r\n次の段落';
    for (const [text, tail] of [[heading, '%%\r\n\r\n# 次の見出し\r\n'], [blocks, '%%\r\n\r\n次の段落']]) {
      const [candidate] = extractCandidates(text);
      const plan = planAdoption(text, record(candidate), { question: ' 編集した問い ', answer: '編集した答え\n二行目  ' }, ID_A);
      expect(plan.ok).toBe(true);
      expect(plan.next.startsWith(candidate.sourceText)).toBe(true);
      expect(plan.next).toContain('\r\n\r\n%%kioku-edit:kioku-0123456789\r\nQ: 編集した問い\r\nA: 編集した答え\r\n二行目\r\n%%');
      expect(plan.next.endsWith(tail)).toBe(true);
      expect(plan.next).not.toMatch(/[^\r]\n/);
      const [adopted, ...rest] = extractCandidates(plan.next);
      expect(adopted).toMatchObject({ status: 'adopted', question: '原文の問い', edit: { question: '編集した問い', answer: '編集した答え\n二行目' } });
      expect(rest).toEqual([]);
    }
  });

  it('adds a blank line after an edit record when the following line is text', () => {
    const note = 'Q: a\nA: b\nQ: c\nA: d';
    const plan = planAdoption(note, record(extractCandidates(note)[0]), { question: 'a2', answer: 'b' }, ID_A);
    expect(plan.next).toBe('Q: a\nA: b ^kioku-0123456789\n\n%%kioku-edit:kioku-0123456789\nQ: a2\nA: b\n%%\n\nQ: c\nA: d');
    expect(extractCandidates(plan.next).map((item) => [item.question, item.status])).toEqual([['a', 'adopted'], ['c', 'new']]);
  });

  it('inserts exactly one blank line when non-blank text follows, so the ID ends a paragraph (edited or not)', () => {
    const cases = [
      ['Q: a\nA: b\nQ: c\nA: d', 'Q: a\nA: b ^kioku-0123456789\n\nQ: c\nA: d'],
      ['Q: a\nA: b\nA: 2つ目\n', 'Q: a\nA: b ^kioku-0123456789\n\nA: 2つ目\n'],
      ['Q: a\nA: b\n---\n本文', 'Q: a\nA: b ^kioku-0123456789\n\n---\n本文'],
      ['Q: a\r\nA: b\r\n```\r\ncode\r\n```', 'Q: a\r\nA: b ^kioku-0123456789\r\n\r\n```\r\ncode\r\n```'],
      ['Q: a\nA: b\n## 見出し', 'Q: a\nA: b ^kioku-0123456789\n\n## 見出し'],
      ['Q: a\nA: b\n\n本文', 'Q: a\nA: b ^kioku-0123456789\n\n本文'],
      ['Q: a\nA: b\n', 'Q: a\nA: b ^kioku-0123456789\n'],
      ['Q: a\nA: b', 'Q: a\nA: b ^kioku-0123456789'],
    ];
    for (const [note, expected] of cases) {
      const candidate = extractCandidates(note)[0];
      const plan = planAdoption(note, record(candidate), same(candidate), ID_A);
      expect(plan.next).toBe(expected);
      // Original characters are untouched: removing the inserted text gives the note back.
      expect(plan.next.slice(0, plan.offset) + plan.next.slice(plan.offset + plan.insert.length)).toBe(note);
      expect(extractCandidates(plan.next)[0]).toMatchObject({ status: 'adopted', needsBlankLine: false });
    }
    const list = '- Q: a\n- A: b\n- Q: c\n- A: d';
    const listPlan = planAdoption(list, record(extractCandidates(list)[0]), { question: 'a', answer: 'b' }, ID_A);
    expect(listPlan.next).toBe('- Q: a\n- A: b ^kioku-0123456789\n- Q: c\n- A: d');
    const listThenText = '- Q: a\n- A: b\nQ: c\nA: d';
    expect(planAdoption(listThenText, record(extractCandidates(listThenText)[0]), { question: 'a', answer: 'b' }, ID_A).next)
      .toBe('- Q: a\n- A: b ^kioku-0123456789\n\nQ: c\nA: d');
    const mixed = 'x\nQ: a\r\nA: b\r\nQ: c\nA: d';
    const mixedPlan = planAdoption(mixed, record(extractCandidates(mixed)[0]), { question: 'a2', answer: 'b' }, ID_A);
    expect(mixedPlan.next).toBe('x\nQ: a\r\nA: b ^kioku-0123456789\r\n\r\n%%kioku-edit:kioku-0123456789\r\nQ: a2\r\nA: b\r\n%%\r\n\r\nQ: c\nA: d');
    const mixedUnedited = 'x\nQ: a\r\nA: b\r\nQ: c';
    expect(planAdoption(mixedUnedited, record(extractCandidates(mixedUnedited)[0]), { question: 'a', answer: 'b' }, ID_A).next)
      .toBe('x\nQ: a\r\nA: b ^kioku-0123456789\r\n\r\nQ: c');
    const crlf = 'Q: a\r\nA: b\r\nQ: c\r\nA: d';
    const edited = planAdoption(crlf, record(extractCandidates(crlf)[0]), { question: 'a2', answer: 'b' }, ID_A);
    expect(edited.next).toBe('Q: a\r\nA: b ^kioku-0123456789\r\n\r\n%%kioku-edit:kioku-0123456789\r\nQ: a2\r\nA: b\r\n%%\r\n\r\nQ: c\r\nA: d');
  });

  it('relocates a uniquely matching original after an external edit above it', () => {
    const note = 'intro\nQ: 問い\nA: 答え';
    const recorded = record(extractCandidates(note)[0]);
    const changed = `追加された行\n${note}`;
    const plan = planAdoption(changed, recorded, { question: '問い', answer: '答え' }, ID_A);
    expect(plan.ok && plan.next).toBe('追加された行\nintro\nQ: 問い\nA: 答え ^kioku-0123456789');
  });

  it('chooses the recorded position among identical blocks under same-name headings', () => {
    const note = '## 復習\nQ: 同じ\nA: 同じ\n\n## 復習\nQ: 同じ\nA: 同じ';
    const second = extractCandidates(note)[1];
    const plan = planAdoption(note, record(second), same(second), ID_A);
    expect(plan.next).toBe('## 復習\nQ: 同じ\nA: 同じ\n\n## 復習\nQ: 同じ\nA: 同じ ^kioku-0123456789');
  });

  it('aborts without guessing when identical blocks moved (ambiguous)', () => {
    const note = '## 復習\nQ: 同じ\nA: 同じ\n\n## 復習\nQ: 同じ\nA: 同じ';
    const plan = planAdoption(`x\n${note}`, record(extractCandidates(note)[1]), { question: '同じ', answer: '同じ' }, ID_A);
    expect(plan).toEqual({ ok: false, reason: expect.stringContaining('位置を特定できません') });
  });

  it('aborts when the original text was changed externally', () => {
    const note = 'Q: 問い\nA: 答え';
    const recorded = record(extractCandidates(note)[0]);
    for (const changed of ['Q: 問い\nA: 外部で変更', 'Q: 問い\n', '', '```\nQ: 問い\nA: 答え\n```']) {
      expect(planAdoption(changed, recorded, { question: '問い', answer: '答え' }, ID_A))
        .toEqual({ ok: false, reason: expect.stringContaining('原文が抽出後に変更') });
    }
  });

  it('refuses double adoption (e.g. adopted in another view) and foreign block IDs', () => {
    const note = 'Q: 問い\nA: 答え';
    const recorded = record(extractCandidates(note)[0]);
    expect(planAdoption('Q: 問い\nA: 答え ^kioku-zzzzzzzzzz', recorded, { question: '問い', answer: '答え' }, ID_A))
      .toEqual({ ok: false, reason: expect.stringContaining('既に採用済み') });
    expect(planAdoption('Q: 問い\nA: 答え ^mine', recorded, { question: '問い', answer: '答え' }, ID_A))
      .toEqual({ ok: false, reason: expect.stringContaining('block ID') });
  });

  it('rejects edits that cannot round-trip through an edit record', () => {
    const note = 'Q: 問い\nA: 答え';
    const recorded = record(extractCandidates(note)[0]);
    for (const [edit, reason] of [
      [{ question: '', answer: 'x' }, '問いが空'],
      [{ question: 'x', answer: '  ' }, '答えが空'],
      [{ question: 'x %% y', answer: 'z' }, '%%'],
      [{ question: 'x', answer: 'see ^kioku-0123456789' }, '^kioku-'],
      [{ question: 'x', answer: '一行目\n\n三行目' }, '空行'],
      [{ question: 'x', answer: '一行目\nQ: 次の問い' }, '空行'],
      [{ question: 'x', answer: '一行目\n# 見出し' }, '空行'],
      [{ question: 'x', answer: 'y\n```' }, 'コードブロック'],
      [{ question: 'x', answer: 'y\n  ~~~js' }, 'コードブロック'],
      [{ question: 'x', answer: '$$a^2$$' }, '$$'],
      [{ question: 'x <!-- memo', answer: 'y' }, 'HTML'],
      [{ question: 'x', answer: 'y -->' }, 'HTML'],
    ]) {
      const plan = planAdoption(note, recorded, edit, ID_A);
      expect(plan.ok).toBe(false);
      expect(plan.reason).toContain(reason);
    }
    expect(validateEdit({ question: '- 箇条書き', answer: '答え\n- 続き' })).toBeNull();
    expect(validateEdit({ question: 'x', answer: 'y\n```' })).not.toBeNull();
    expect(validateEdit({ question: 'inline `code` と $x$', answer: 'y' })).toBeNull();
    expect(normalizeField('  a  \r\n b \n')).toBe('a\n b');
  });

  it('never reuses an ID already present in the note', () => {
    const note = 'Q: a\nA: b ^kioku-0123456789\n\nQ: c\nA: d';
    const second = extractCandidates(note)[1];
    const plan = planAdoption(note, record(second), same(second), bytes([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [35]));
    expect(plan.cardId).toBe('kioku-zzzzzzzzzz');
  });
});
