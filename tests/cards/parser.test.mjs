import { describe, expect, it } from 'vitest';
import { existingCardIds, extractCandidates } from '../../src/cards/parser.ts';
import { classifyLines } from '../../src/cards/regions.ts';
import { splitLines } from '../../src/cards/lines.ts';

const pick = (items) => items.map(({ question, answer, status }) => ({ question, answer, status }));

describe('explicit Q/A syntax', () => {
  it('reads half/full width markers, Japanese markers, list markers and multi-line fields', () => {
    const note = [
      '# 生物',
      'Q: 光合成とは？',
      'A: 光で糖を作る反応',
      '',
      'Q：細胞の基本単位は？',
      'A：細胞',
      '',
      '問: 日本の首都は？',
      '答: 東京',
      '',
      'Ｑ：全角 Q',
      'Ａ：全角 A',
      '',
      '- Q: 箇条書きの問い',
      '- A: 箇条書きの答え',
      '',
      'Q: 複数行の',
      '問い',
      'A:',
      '- 答え1',
      '  - 答え2',
    ].join('\n');
    expect(pick(extractCandidates(note))).toEqual([
      { question: '光合成とは？', answer: '光で糖を作る反応', status: 'new' },
      { question: '細胞の基本単位は？', answer: '細胞', status: 'new' },
      { question: '日本の首都は？', answer: '東京', status: 'new' },
      { question: '全角 Q', answer: '全角 A', status: 'new' },
      { question: '箇条書きの問い', answer: '箇条書きの答え', status: 'new' },
      { question: '複数行の\n問い', answer: '- 答え1\n  - 答え2', status: 'new' },
    ]);
  });

  it('ends blocks at blank lines, headings, rules and the next question; ignores incomplete blocks', () => {
    const note = [
      'Q: 答えが無い問い',
      '',
      'A: 問いが無い答え',
      'Q: 一つ目',
      'A: 答え1',
      'Q: 二つ目',
      'A: 答え2',
      '## 見出し',
      'Q: 見出しで終わる',
      'A: 答え3',
      '---',
      'Q: 空の答え',
      'A:',
      '',
      'Q: 2つ目の A で終わる',
      'A: 答え4',
      'A: 無視される',
      '  Q: インデントは対象外',
      '  A: x',
      '> Q: 引用は対象外',
      '> A: x',
    ].join('\n');
    expect(pick(extractCandidates(note)).map((item) => item.question)).toEqual(['一つ目', '二つ目', '見出しで終わる', '2つ目の A で終わる']);
    expect(extractCandidates(note)[3].answer).toBe('答え4');
  });

  it('records exact offsets, 0-based lines and the untouched source text, also with CRLF and CR', () => {
    for (const eol of ['\n', '\r\n', '\r']) {
      const note = ['# 見出し', 'Q: 問い  ', 'A: 答え ', '続き', '', 'after'].join(eol);
      const [candidate] = extractCandidates(note);
      expect(candidate.line).toBe(1);
      expect(note.slice(candidate.start, candidate.end)).toBe(candidate.sourceText);
      expect(candidate.sourceText).toBe(['Q: 問い  ', 'A: 答え ', '続き'].join(eol));
      expect(candidate.answer).toBe('答え\n続き');
    }
  });

  it('distinguishes Q/A under same-name headings by position, not by heading text', () => {
    const note = ['## 復習', 'Q: 同じ問い', 'A: 同じ答え', '', '## 復習', 'Q: 同じ問い', 'A: 同じ答え'].join('\n');
    const candidates = extractCandidates(note);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((item) => item.line)).toEqual([1, 5]);
    expect(candidates[0].start).not.toBe(candidates[1].start);
  });
});

describe('exclusions keep code, comments, frontmatter and Excalidraw data out', () => {
  it('skips fenced code (backtick, tilde, longer and indented fences), comments and frontmatter', () => {
    const note = [
      '---',
      'q: frontmatter',
      'Q: in frontmatter',
      'A: no',
      '---',
      '```md',
      'Q: in code',
      'A: no',
      '```',
      '~~~~',
      'Q: in tilde code',
      '```',
      'A: still code',
      '~~~~',
      '  ```',
      'Q: indented fence',
      'A: no',
      '  ```',
      '%%',
      'Q: in comment',
      'A: no',
      '%%',
      'Q: 本物 %%inline%%',
      'A: はい',
    ].join('\n');
    expect(pick(extractCandidates(note))).toEqual([{ question: '本物 %%inline%%', answer: 'はい', status: 'new' }]);
  });

  it('closes a fence only with the same character and at least the opening length', () => {
    const longer = ['````', '```', 'Q: still code', 'A: no', '````', 'Q: after', 'A: yes'].join('\n');
    expect(pick(extractCandidates(longer)).map((item) => item.question)).toEqual(['after']);
    const kind = ['```', '~~~', 'Q: still code', 'A: no', '```', 'Q: after', 'A: yes'].join('\n');
    expect(pick(extractCandidates(kind)).map((item) => item.question)).toEqual(['after']);
  });

  it('skips HTML comments and $$ math blocks, single- and multi-line', () => {
    const note = [
      '<!--',
      'Q: in html comment',
      'A: no',
      '-->',
      '<!-- one line --> ',
      'Q: 本物1',
      'A: はい',
      '',
      'x <!-- open',
      'Q: in comment',
      'A: no',
      'close --> <!-- reopen',
      'Q: still comment',
      'A: no',
      '-->',
      '$$',
      'Q: in math',
      'A: no',
      '$$',
      'Q: 本物2 $$x$$',
      'A: はい',
    ].join('\n');
    expect(pick(extractCandidates(note)).map((item) => item.question)).toEqual(['本物1', '本物2 $$x$$']);
  });

  it('keeps a comment open when a line closes one HTML comment and opens another', () => {
    const note = ['<!-- a --> b <!-- c', 'Q: in comment', 'A: no', '-->', 'Q: 本物', 'A: はい'].join('\n');
    expect(extractCandidates(note).map((item) => item.question)).toEqual(['本物']);
  });

  it('handles a UTF-8 BOM before frontmatter or a first-line question', () => {
    expect(extractCandidates('\uFEFF---\nQ: in fm\nA: no\n---\nQ: 本物\nA: はい').map((item) => item.question)).toEqual(['本物']);
    const [first] = extractCandidates('\uFEFFQ: 先頭\nA: はい');
    expect(first).toMatchObject({ question: '先頭', start: 0 });
  });

  it('excludes an unclosed fence to the end of the note, but an unclosed frontmatter is ordinary text', () => {
    expect(extractCandidates('Q: a\nA: b\n```\nQ: c\nA: d')).toHaveLength(1);
    expect(extractCandidates('---\nQ: a\nA: b')).toHaveLength(1);
  });

  it('stops a block at the start of an excluded region', () => {
    const [candidate] = extractCandidates('Q: 問い\nA: 答え\n```\ncode\n```');
    expect(candidate.answer).toBe('答え');
  });

  it('excludes Excalidraw text elements and drawing data but keeps the note body above them', () => {
    const note = [
      '---',
      'excalidraw-plugin: parsed',
      'tags: [excalidraw]',
      '---',
      '==⚠  Switch to EXCALIDRAW VIEW ⚠==',
      '',
      'Q: 図の上の問い',
      'A: 図の上の答え',
      '',
      '# Excalidraw Data',
      '',
      '## Text Elements',
      'Q: 描画内の問い ^aBcD1234',
      'A: 描画内の答え ^eFgH5678',
      '',
      '%%',
      '## Drawing',
      '```compressed-json',
      'N4KAkARALgngDgUwgLgAQQQDwMYEMA2AlgCYBOuA7hADTgQBuCpAzoQPYB2KqAJrSHzBUAlhYBEAB3g',
      '```',
      '%%',
    ].join('\n');
    expect(pick(extractCandidates(note))).toEqual([{ question: '図の上の問い', answer: '図の上の答え', status: 'new' }]);
    const kinds = classifyLines(splitLines(note));
    expect(kinds.slice(9).every((kind) => kind === 'excalidraw')).toBe(true);
  });

  it('applies the Excalidraw section rule only to Excalidraw notes', () => {
    expect(extractCandidates('# Drawing\nQ: 普通のノート\nA: 対象')).toHaveLength(1);
  });
});

describe('adoption markers and duplicate detection', () => {
  it('treats a trailing ^kioku- block ID as adopted and keeps identity when the text was edited', () => {
    const note = 'Q: 編集後の問い\nA: 答えを後から書き換えた ^kioku-abcdefghij';
    const [candidate] = extractCandidates(note);
    expect(candidate).toMatchObject({ status: 'adopted', cardId: 'kioku-abcdefghij', answer: '答えを後から書き換えた',
      sourceText: 'Q: 編集後の問い\nA: 答えを後から書き換えた' });
  });

  it('reads the edit record of an adopted card and ignores its Q/A as a candidate', () => {
    const note = ['Q: 原文', 'A: 原文の答え ^kioku-abcdefghij', '', '%%kioku-edit:kioku-abcdefghij', 'Q: 編集後', 'A: 編集後の答え', '%%'].join('\n');
    const candidates = extractCandidates(note);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].edit).toEqual({ question: '編集後', answer: '編集後の答え' });
  });

  it('reads edit records only from real %% comments, never from code blocks', () => {
    const note = ['Q: 原文', 'A: 答え ^kioku-abcdefghij', '', '```', '%%kioku-edit:kioku-abcdefghij', 'Q: 偽', 'A: 偽', '%%', '```'].join('\n');
    expect(extractCandidates(note)[0].edit).toBeNull();
  });

  it('flags blocks that are directly followed by text as needing a blank line', () => {
    expect(extractCandidates('Q: a\nA: b\nQ: c\nA: d\n\nQ: e\nA: f').map((item) => item.needsBlankLine)).toEqual([true, false, false]);
    expect(extractCandidates('- Q: a\n- A: b\n- Q: c\n- A: d').map((item) => item.needsBlankLine)).toEqual([false, false]);
    expect(extractCandidates('Q: a\nA:\n1. x\n2. y\n- Q: c\n- A: d').map((item) => item.needsBlankLine)).toEqual([false, false]);
    expect(extractCandidates('- Q: a\n- A: b\nQ: c\nA: d').map((item) => item.needsBlankLine)).toEqual([true, false]);
    // Lazy / indented continuation of the A item still belongs to the list item: stay tight.
    expect(extractCandidates('- Q: a\n- A: b\n  more\n- Q: c\n- A: d').map((item) => item.needsBlankLine)).toEqual([false, false]);
    expect(extractCandidates('- Q: a\n- A: b\nmore\n- Q: c\n- A: d').map((item) => item.needsBlankLine)).toEqual([false, false]);
    // A paragraph followed by a list needs the blank line.
    expect(extractCandidates('Q: a\nA: b\n- Q: c\n- A: d').map((item) => item.needsBlankLine)).toEqual([true, false]);
    expect(extractCandidates('- Q: a\n- A: b\n- Q: c\n- A: d').map((item) => item.followedByText)).toEqual([true, false]);
  });

  it('marks copied kioku IDs as duplicate and foreign block IDs as not adoptable', () => {
    const note = ['Q: a', 'A: b ^kioku-abcdefghij', '', 'Q: a', 'A: b ^kioku-abcdefghij', '', 'Q: c', 'A: d ^my-block'].join('\n');
    expect(extractCandidates(note).map((item) => item.status)).toEqual(['duplicate-id', 'duplicate-id', 'foreign-block-id']);
  });

  it('warns when a new candidate equals the effective content of an adopted card', () => {
    const note = ['Q: 同じ', 'A: 内容 ^kioku-abcdefghij', '', 'Q: 同じ', 'A: 内容', '', 'Q: 別', 'A: 内容'].join('\n');
    expect(extractCandidates(note).map((item) => item.sameAsAdopted)).toEqual([false, true, false]);
    const edited = ['Q: 原文', 'A: x ^kioku-abcdefghij', '', '%%kioku-edit:kioku-abcdefghij', 'Q: 編集後', 'A: y', '%%', '', 'Q: 編集後', 'A: y'].join('\n');
    expect(extractCandidates(edited).map((item) => item.sameAsAdopted)).toEqual([false, true]);
  });

  it('collects existing IDs from block IDs and edit records', () => {
    expect([...existingCardIds('a ^kioku-aaaaaaaaaa\n%%kioku-edit:kioku-bbbbbbbbbb\n%%')].sort())
      .toEqual(['kioku-aaaaaaaaaa', 'kioku-bbbbbbbbbb']);
  });
});

describe('selection', () => {
  const note = ['Q: 1', 'A: 1', '', 'Q: 2', 'A: 2', '', 'Q: 3', 'A: 3'].join('\n');
  it('keeps only blocks overlapping a non-empty selection, in either direction', () => {
    const from = note.indexOf('A: 2');
    expect(extractCandidates(note, { from, to: from + 2 }).map((item) => item.question)).toEqual(['2']);
    expect(extractCandidates(note, { from: note.length, to: note.indexOf('Q: 2') }).map((item) => item.question)).toEqual(['2', '3']);
  });
  it('uses the whole note for an empty selection (caret)', () => {
    expect(extractCandidates(note, { from: 3, to: 3 })).toHaveLength(3);
  });
  it('does not turn code inside a selection into candidates', () => {
    const code = '```\nQ: x\nA: y\n```';
    expect(extractCandidates(code, { from: 4, to: code.length - 4 })).toEqual([]);
  });
});
