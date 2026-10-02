import { describe, expect, it } from 'vitest';
import { CHECK_REASONS, MAX_CANDIDATES, checkGenerated, contentWarnings } from '../../src/ai/checks.ts';
import { classify, unjudged } from '../../src/ai/classify.ts';
import { buildSource } from '../../src/ai/source.ts';

const NOTE = '光合成は糖を作る反応である。葉緑体で行われる。\n\nミトコンドリアは呼吸の場である。\n';
const SOURCE = buildSource(NOTE);
const gen = (question, answer, quote) => ({ fact: 'f', question, answer, quote });
const none = { explicit: [], adopted: [] };

describe('deterministic checks (§6.1)', () => {
  it('drops quotes not in the note and empty cards, counting them; zero candidates is a valid result', () => {
    const report = checkGenerated(NOTE, SOURCE, [
      gen('光合成の場は？', '葉緑体', '葉緑体で行われる。'),
      gen('捏造', '答え', 'ノートに無い文。'),
      gen('', '空', '葉緑体で行われる。'),
    ], none);
    expect(report.candidates.map((item) => item.card.question)).toEqual(['光合成の場は？']);
    expect(report).toMatchObject({ quoteMismatch: 1, empty: 1, duplicates: 0, sameAsAdopted: 0, overCap: 0 });
    expect(checkGenerated(NOTE, SOURCE, [], none).candidates).toEqual([]);
  });

  it('orders by appearance and flags an answer not contained in its quote', () => {
    const report = checkGenerated(NOTE, SOURCE, [
      gen('呼吸の場は？', 'ミトコンドリア', 'ミトコンドリアは呼吸の場である。'),
      gen('光合成で作るものは？', 'ブドウ糖', '光合成は糖を作る反応である。'),
    ], none);
    expect(report.candidates.map((item) => item.card.answer)).toEqual(['ブドウ糖', 'ミトコンドリア']);
    expect(report.candidates[0].warnings).toContain(CHECK_REASONS.answerNotInQuote);
    expect(report.candidates[1].warnings).toEqual([]);
    expect(report.candidates[0].quote.anchor.text).toBe('光合成は糖を作る反応である。葉緑体で行われる。');
  });

  it('hides duplicates of adopted cards and of explicit / earlier candidates', () => {
    const card = gen('光合成の場は？', '葉緑体', '葉緑体で行われる。');
    expect(checkGenerated(NOTE, SOURCE, [card], { explicit: [], adopted: [{ question: '光合成の場は？', answer: '葉緑体' }] }))
      .toMatchObject({ candidates: [], sameAsAdopted: 1 });
    expect(checkGenerated(NOTE, SOURCE, [card], { explicit: [{ question: '光合成の場は？', answer: ' 葉緑体 ' }], adopted: [] }))
      .toMatchObject({ candidates: [], duplicates: 1 });
    expect(checkGenerated(NOTE, SOURCE, [card, { ...card, quote: '光合成は糖を作る反応である。' }], none))
      .toMatchObject({ duplicates: 1 });
  });

  it('caps at 20 as a safety limit only', () => {
    const many = Array.from({ length: 25 }, (_, index) => gen(`問${index}`, '葉緑体', '葉緑体で行われる。'));
    const report = checkGenerated(NOTE, SOURCE, many, none);
    expect(report.candidates).toHaveLength(MAX_CANDIDATES);
    expect(report.overCap).toBe(5);
  });

  it('warns on length, several facts and syntax that cannot be stored', () => {
    expect(contentWarnings({ question: 'あ'.repeat(121), answer: 'x' })).toContain(CHECK_REASONS.questionLong);
    expect(contentWarnings({ question: 'q', answer: 'あ'.repeat(201) })).toContain(CHECK_REASONS.answerLong);
    expect(contentWarnings({ question: 'q', answer: '- a\n- b\n- c' })).toContain(CHECK_REASONS.manyFacts);
    expect(contentWarnings({ question: 'q', answer: 'a、b、c、d' })).toContain(CHECK_REASONS.manyFacts);
    expect(contentWarnings({ question: '葉緑体とミトコンドリアの違いは？', answer: 'x' })).toContain(CHECK_REASONS.manyFacts);
    expect(contentWarnings({ question: '光合成とは？', answer: '光で糖を作る反応' })).toEqual([]);
    const report = checkGenerated(NOTE, SOURCE, [gen('50%% の場合は？', '葉緑体', '葉緑体で行われる。')], none);
    expect(report.candidates[0].warnings.some((warning) => warning.startsWith('このままでは採用できません'))).toBe(true);
  });
});

describe('classification (§6.2)', () => {
  const noul = (value) => ({ value, probabilities: { yes: value, no: 1 - value }, confidence: Math.max(value, 1 - value) });
  const results = (supported, answerable = 0.9, oneFact = 0.9) =>
    ({ supported: noul(supported), answerable: noul(answerable), one_fact: noul(oneFact), quality: { value: 3, probabilities: {}, confidence: 0.8 } });

  it('recommends only with clean checks and high scores; weak below 0.3; otherwise review with reasons', () => {
    expect(classify(results(0.9), false)).toMatchObject({ verdict: 'recommended', label: '推奨', quality: 4 });
    expect(classify(results(0.9), true)).toMatchObject({ verdict: 'review', label: '要確認' });
    expect(classify(results(0.2), false)).toMatchObject({ verdict: 'weak', label: '根拠が弱い' });
    const review = classify(results(0.5, 0.6, 0.6), false);
    expect(review.verdict).toBe('review');
    expect(review.reasons).toHaveLength(4); // three low scores + low confidence (0.5)
  });

  it('never recommends an incomplete response', () => {
    expect(classify({ supported: noul(0.9) }, false)).toMatchObject({ verdict: 'unjudged', label: '未判定（AI の応答が不完全）' });
    expect(unjudged('Jev 未設定').label).toBe('未判定（Jev 未設定）');
  });
});
