import { describe, expect, it } from 'vitest';
import { buildSource, isExcalidrawNote, locateQuote, normalizeForMatch } from '../../src/ai/source.ts';

const NOTE = [
  '---',
  'tags: [kioku]',
  'secret: frontmatter',
  '---',
  '# 光合成',
  '光合成は、光エネルギーを使って糖を作る反応である。葉緑体で行われる。%%内緒のメモ%%',
  '',
  '```js',
  'const code = "送らない";',
  '```',
  '%%',
  '複数行のコメント',
  '%%',
  '呼吸はミトコンドリアで行われる。<!-- html コメント --> ATP を作る。',
  '$$',
  'E = mc^2',
  '$$',
  '',
].join('\n');

describe('text sent to the generator', () => {
  it('drops frontmatter, fences, comment / math blocks and inline comments; never the note title', () => {
    const source = buildSource(NOTE);
    expect(source.text).toBe('# 光合成\n光合成は、光エネルギーを使って糖を作る反応である。葉緑体で行われる。\n\n\n呼吸はミトコンドリアで行われる。  ATP を作る。');
    for (const hidden of ['secret', '内緒', '送らない', '複数行', 'html コメント', 'mc^2']) expect(source.text).not.toContain(hidden);
    expect(source.origin).toHaveLength(source.text.length);
    // Every kept character maps back to the same character of the note.
    source.text.split('').forEach((char, index) => {
      if (source.origin[index] >= 0 && char !== '\n') expect(NOTE[source.origin[index]]).toBe(char);
    });
  });

  it('sends only the selected range', () => {
    const from = NOTE.indexOf('葉緑体');
    const source = buildSource(NOTE, { from, to: from + '葉緑体で行われる。'.length });
    expect(source.text).toBe('葉緑体で行われる。');
  });

  it('detects Excalidraw notes', () => {
    expect(isExcalidrawNote('---\nexcalidraw-plugin: parsed\n---\n# Text Elements\nA\n')).toBe(true);
    expect(isExcalidrawNote(NOTE)).toBe(false);
  });
});

describe('quote matching (§6.1)', () => {
  const source = buildSource(NOTE);

  it('normalizes NFC and whitespace only', () => {
    expect(normalizeForMatch('  ｶﾞ　が\n x ')).toBe('ｶﾞ が x');
    expect(normalizeForMatch('が')).toBe('が');
  });

  it('maps an exact quote back to the note with its anchor block', () => {
    const quote = locateQuote(NOTE, source, '葉緑体で行われる。');
    expect(quote.text).toBe('葉緑体で行われる。');
    expect(NOTE.slice(quote.start, quote.end)).toBe('葉緑体で行われる。');
    expect(quote.anchor.text).toBe('# 光合成\n光合成は、光エネルギーを使って糖を作る反応である。葉緑体で行われる。%%内緒のメモ%%');
    expect(quote.elsewhere).toBe(false);
  });

  it('accepts whitespace differences but not paraphrases, text across a removed comment, or excluded text', () => {
    expect(locateQuote(NOTE, source, '葉緑体で  行われる。')).toBeNull(); // inserted space is a different text
    expect(locateQuote(NOTE, source, '光合成は、光エネルギーを使って糖を作る反応である。 ')).not.toBeNull();
    expect(locateQuote(NOTE, source, '葉緑体で行われます。')).toBeNull();
    expect(locateQuote(NOTE, source, '行われる。 ATP を作る。')).toBeNull();
    expect(locateQuote(NOTE, source, '呼吸はミトコンドリアで行われる。 ATP')).toBeNull();
    expect(locateQuote(NOTE, source, 'const code')).toBeNull();
    expect(locateQuote(NOTE, source, '内緒のメモ')).toBeNull();
    expect(locateQuote(NOTE, source, '')).toBeNull();
  });

  it('rejects a quote spanning a blank line and flags a sentence that appears in two blocks', () => {
    const note = '甲は乙である。\n\n丙は丁である。\n\n- 甲は乙である。\n';
    const local = buildSource(note);
    expect(locateQuote(note, local, '甲は乙である。 丙は丁である。')).toBeNull();
    const twice = locateQuote(note, local, '甲は乙である。');
    expect(twice).toMatchObject({ start: 0, elsewhere: true });
  });

  it('matches across a line break within one block, including CRLF', () => {
    const note = '一行目の文。\r\n二行目の文。\r\n';
    const quote = locateQuote(note, buildSource(note), '一行目の文。 二行目の文。');
    expect(quote.text).toBe('一行目の文。\r\n二行目の文。');
  });
});
