import { describe, expect, it } from 'vitest';
import { buildDeckIndex } from '../../src/decks/index.ts';
import { cleanTag, deckTagsOfNote, matchesTrigger, normalizeTriggerTags } from '../../src/decks/tags.ts';
import { classifyLines } from '../../src/cards/regions.ts';
import { splitLines } from '../../src/cards/lines.ts';

const qa = (id, question = `問${id}`, answer = `答${id}`) => ({ id: `kioku-${id}`, question, answer });

describe('trigger tags', () => {
  it('match the tag itself and its children, case-insensitively, but not longer names', () => {
    const triggers = ['kioku'];
    expect(['#kioku', '#Kioku', 'kioku/医学', '#KIOKU/医学/生理'].every((tag) => matchesTrigger(tag, triggers))).toBe(true);
    expect(['#kiokux', '#kio', '#other/kioku', '#ki/oku'].some((tag) => matchesTrigger(tag, triggers))).toBe(false);
    expect(matchesTrigger('#英単語/動詞', ['kioku', '英単語'])).toBe(true);
  });
  it('normalise settings input', () => {
    expect(normalizeTriggerTags(['#kioku', 'Kioku', ' #医学/ ', '', '123', 'a b', '#x//y'])).toEqual(['kioku', '医学']);
    expect(cleanTag('##deck/')).toBe('deck');
  });
  it('take frontmatter tags and body tags outside M1 exclusion regions', () => {
    const note = ['---', 'tags: [kioku]', '---', '#kioku/医学', '```', '#kioku/code', '```', '%%', '#kioku/comment', '%%',
      '<!--', '#kioku/html', '-->', '$$', '#kioku/math', '$$', '#other #KIOKU/医学'].join('\n');
    const kinds = classifyLines(splitLines(note));
    const body = [[3, '#kioku/医学'], [5, '#kioku/code'], [8, '#kioku/comment'], [11, '#kioku/html'], [14, '#kioku/math'],
      [16, '#other'], [16, '#KIOKU/医学']].map(([line, tag]) => ({ line, tag }));
    expect(deckTagsOfNote(['#kioku'], body, (line) => kinds[line] !== null, ['kioku'])).toEqual(['kioku', 'kioku/医学']);
    expect(deckTagsOfNote(null, [], () => false, ['kioku'])).toEqual([]);
  });
});

describe('deck index', () => {
  const notes = [
    { path: 'b/生理.md', deckTags: ['kioku/医学/生理'], cards: [qa('p1'), qa('p2')] },
    { path: 'a/医学.md', deckTags: ['Kioku/医学', 'kioku/英語'], cards: [qa('m1')] },
    { path: 'c/英語.md', deckTags: ['kioku/英語'], cards: [qa('e1')] },
    { path: 'd/無タグ.md', deckTags: [], cards: [qa('u1'), qa('u2')] },
    { path: 'e/root.md', deckTags: ['kioku'], cards: [qa('r1')] },
  ];

  it('builds child decks; a parent includes its children; 全デッキ is the union; untagged cards are only counted', () => {
    const index = buildDeckIndex(notes, ['kioku']);
    expect(index.roots.map((root) => root.key)).toEqual(['kioku']);
    const kioku = index.nodes.get('kioku');
    expect(kioku.children.map((child) => child.label)).toEqual(['Kioku/医学', 'kioku/英語']);
    expect(index.nodes.get('kioku/医学').children.map((child) => child.name)).toEqual(['生理']);
    expect([...index.nodes.get('kioku/医学/生理').cardIds]).toEqual(['kioku-p1', 'kioku-p2']);
    expect([...index.nodes.get('kioku/医学').cardIds].sort()).toEqual(['kioku-m1', 'kioku-p1', 'kioku-p2']);
    expect([...index.nodes.get('kioku/英語').cardIds].sort()).toEqual(['kioku-e1', 'kioku-m1']);
    expect([...kioku.cardIds].sort()).toEqual(['kioku-e1', 'kioku-m1', 'kioku-p1', 'kioku-p2', 'kioku-r1']);
    expect([...index.all].sort()).toEqual([...kioku.cardIds].sort());
    expect(index.untagged).toBe(2);
    expect(index.nodes.get('kioku/医学/生理').depth).toBe(2);
    // Note order (path order, then occurrence) drives the new-card order.
    expect([...index.cards.values()].sort((a, b) => a.order - b.order).map((card) => card.id))
      .toEqual(['kioku-m1', 'kioku-p1', 'kioku-p2', 'kioku-e1', 'kioku-r1']);
  });

  it('makes one top-level deck per trigger tag', () => {
    const index = buildDeckIndex([...notes, { path: 'f.md', deckTags: ['英単語/動詞'], cards: [qa('v1')] }], ['kioku', '英単語']);
    expect(index.roots.map((root) => root.key)).toEqual(['kioku', '英単語']);
    expect([...index.nodes.get('英単語').cardIds]).toEqual(['kioku-v1']);
    expect(index.all.has('kioku-v1')).toBe(true);
  });

  it('presents a duplicated ID with the same content once (first path), and excludes it with all paths when content differs', () => {
    const index = buildDeckIndex([
      { path: 'z/ノート 2.md', deckTags: ['kioku/b'], cards: [qa('same', '光合成とは？', '光で  糖を作る')] },
      { path: 'a/ノート.md', deckTags: ['kioku/a'], cards: [qa('same', '光合成とは？', '光で 糖を作る'), qa('diff', 'Q', 'A1')] },
      { path: 'm/copy.md', deckTags: [], cards: [qa('diff', 'Q', 'A2')] },
    ], ['kioku']);
    expect(index.cards.get('kioku-same').path).toBe('a/ノート.md');
    expect(index.nodes.get('kioku/a').cardIds.has('kioku-same')).toBe(true);
    expect(index.nodes.get('kioku/b').cardIds.has('kioku-same')).toBe(true);
    expect(index.nodes.get('kioku').cardIds.size).toBe(1);
    expect(index.cards.has('kioku-diff')).toBe(false);
    expect(index.conflicts).toEqual([{ id: 'kioku-diff', paths: ['a/ノート.md', 'm/copy.md'] }]);
    expect(index.untagged).toBe(0);
  });

  it('treats card IDs case-sensitively (unlike tags)', () => {
    const index = buildDeckIndex([{ path: 'a.md', deckTags: ['kioku'], cards: [qa('abc'), { ...qa('abc'), id: 'kioku-ABC', answer: 'x' }] }], ['kioku']);
    expect([...index.cards.keys()].sort()).toEqual(['kioku-ABC', 'kioku-abc']);
    expect(index.conflicts).toEqual([]);
  });
});
