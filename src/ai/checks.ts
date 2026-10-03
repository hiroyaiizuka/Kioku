// Deterministic checks (docs/m3-design.md §6.1, S2). Always run, with or without an AI judge.
import { normalizeField, validateEdit } from '../cards/adoption';
import type { CardText } from '../cards/parser';
import { validateQuoteRecord } from '../cards/insertion';
import { locateQuote, normalizeForMatch, type LocatedQuote, type SourceText } from './source';
import type { GeneratedCandidate } from './types';

/** Initial limits (§6.1; to be tuned by the §11 measurements). */
export const LIMITS = { question: 120, answer: 200, quote: 300 } as const;
/** Safety cap per page, never a target (§4). */
export const MAX_CANDIDATES = 20;

export const CHECK_REASONS = {
  answerNotInQuote: '答えが引用にそのまま含まれていません。',
  questionLong: `問いが長めです（${LIMITS.question} 字超）。`,
  answerLong: `答えが長めです（${LIMITS.answer} 字超）。`,
  quoteLong: `引用が長めです（${LIMITS.quote} 字超）。`,
  manyFacts: '複数の知識を含む可能性があります。',
  elsewhere: '同じ文が複数箇所にあります（カードは最初の箇所の直後に入ります）。',
  duplicateExplicit: 'ノートに書いた問い・答えと同じ内容です。',
} as const;

export interface CheckedCandidate {
  readonly generated: GeneratedCandidate;
  /** Q/A as normalized for display and adoption. */
  readonly card: CardText;
  readonly quote: LocatedQuote;
  /** 要確認 reasons from the deterministic checks. */
  readonly warnings: readonly string[];
  /** Set when the card can never be adopted as is (the quote cannot be recorded). */
  readonly blocked: string | null;
}

export interface CheckReport {
  /** In order of appearance in the note. */
  readonly candidates: readonly CheckedCandidate[];
  /** Quote not found in the sent text: removed (never shown, §6.1). */
  readonly quoteMismatch: number;
  /** Empty question or answer: removed. */
  readonly empty: number;
  /** Same as a card already adopted in this note: hidden. */
  readonly sameAsAdopted: number;
  /** Same as an earlier candidate: the first is kept. */
  readonly duplicates: number;
  /** Beyond the safety cap. */
  readonly overCap: number;
}

const dedupeKey = (card: CardText): string => `${normalizeForMatch(card.question)}\u0000${normalizeForMatch(card.answer)}`;

/** Length and "one card, one fact" heuristics, shared by explicit and generated candidates. */
export function contentWarnings(card: CardText): string[] {
  const warnings: string[] = [];
  if (card.question.length > LIMITS.question) warnings.push(CHECK_REASONS.questionLong);
  if (card.answer.length > LIMITS.answer) warnings.push(CHECK_REASONS.answerLong);
  const listLines = card.answer.split('\n').filter((line) => /^\s*(?:[-*+・]|\d+[.)])\s*/.test(line)).length;
  const enumerated = card.answer.split(/[、・,，]/).filter((part) => part.trim()).length;
  const broadQuestion = /それぞれ|すべて|全て|両方|(?:と|や).+の(?:違い|共通点|関係)/.test(card.question);
  if (listLines >= 3 || enumerated >= 4 || broadQuestion) warnings.push(CHECK_REASONS.manyFacts);
  return warnings;
}

/**
 * Checks generated candidates against the note. `explicit` are the note's own Q/A candidates
 * (shown first; a generated duplicate of one is dropped), `adopted` the cards already adopted.
 */
export function checkGenerated(note: string, source: SourceText, generated: readonly GeneratedCandidate[],
  context: { readonly explicit: readonly CardText[]; readonly adopted: readonly CardText[] }): CheckReport {
  const adopted = new Set(context.adopted.map(dedupeKey));
  const seen = new Set(context.explicit.map(dedupeKey));
  let quoteMismatch = 0;
  let empty = 0;
  let sameAsAdopted = 0;
  let duplicates = 0;
  const kept: CheckedCandidate[] = [];
  for (const item of generated) {
    const card = { question: normalizeField(item.question), answer: normalizeField(item.answer) };
    if (!card.question || !card.answer) {
      empty += 1;
      continue;
    }
    const quote = locateQuote(note, source, item.quote);
    if (!quote) {
      quoteMismatch += 1;
      continue;
    }
    const key = dedupeKey(card);
    if (adopted.has(key)) {
      sameAsAdopted += 1;
      continue;
    }
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    const warnings = contentWarnings(card);
    if (!normalizeForMatch(quote.text).includes(normalizeForMatch(card.answer))) warnings.unshift(CHECK_REASONS.answerNotInQuote);
    if (quote.text.length > LIMITS.quote) warnings.push(CHECK_REASONS.quoteLong);
    if (quote.elsewhere) warnings.push(CHECK_REASONS.elsewhere);
    const syntax = validateEdit(card);
    if (syntax) warnings.push(`このままでは採用できません：${syntax}`);
    kept.push({ generated: item, card, quote, warnings, blocked: validateQuoteRecord(quote.text) });
  }
  const ordered = kept.map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.quote.start - b.item.quote.start || a.index - b.index)
    .map(({ item }) => item);
  return { candidates: ordered.slice(0, MAX_CANDIDATES), quoteMismatch, empty, sameAsAdopted, duplicates,
    overCap: Math.max(0, ordered.length - MAX_CANDIDATES) };
}
