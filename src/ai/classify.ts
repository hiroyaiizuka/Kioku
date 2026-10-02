// Classification of generated candidates from the checks and the judge (docs/m3-design.md §6.2).
import type { DecisionResult } from './types';

export type Verdict = 'recommended' | 'review' | 'unjudged' | 'weak';

/** Initial thresholds (§6.2; to be set from the §11 measurements). */
export const THRESHOLDS = { supported: 0.8, answerable: 0.7, oneFact: 0.7, weak: 0.3, lowConfidence: 0.6 } as const;

export const VERDICT_LABELS: Readonly<Record<Exclude<Verdict, 'unjudged'>, string>> = {
  recommended: '推奨',
  review: '要確認',
  weak: '根拠が弱い',
};

/** Display order: 推奨 → 要確認 → 未判定 → 根拠が弱い. */
export const VERDICT_ORDER: Readonly<Record<Verdict, number>> = { recommended: 0, review: 1, unjudged: 2, weak: 3 };

export interface Judgement {
  readonly verdict: Verdict;
  /** Badge text, e.g. 「推奨」 or 「未判定（Jev 未設定）」. */
  readonly label: string;
  /** Why it is not 推奨 (judge part only; check warnings are shown separately). */
  readonly reasons: readonly string[];
  /** Quality level 1–5 when judged (display order hint only). */
  readonly quality: number | null;
}

export const unjudged = (why: string): Judgement => ({ verdict: 'unjudged', label: `未判定（${why}）`, reasons: [], quality: null });

const num = (result: DecisionResult | undefined): number | null =>
  (result && typeof result.value === 'number' && Number.isFinite(result.value) ? result.value : null);

const percent = (value: number): string => `${Math.round(value * 100)}%`;

/**
 * Applies §6.2: 根拠が弱い when `supported` < 0.3; 推奨 when there are no check warnings and
 * supported ≥ 0.8, answerable ≥ 0.7, one_fact ≥ 0.7; otherwise 要確認 with reasons. A response
 * without the three noul answers is treated as unjudged (never as 推奨).
 */
export function classify(results: Readonly<Record<string, DecisionResult>>, hasWarnings: boolean): Judgement {
  const supported = num(results.supported);
  const answerable = num(results.answerable);
  const oneFact = num(results.one_fact);
  if (supported === null || answerable === null || oneFact === null) return unjudged('AI の応答が不完全');
  const quality = num(results.quality);
  if (supported < THRESHOLDS.weak) {
    return { verdict: 'weak', label: VERDICT_LABELS.weak, reasons: [`答えが引用から導けない可能性が高い（${percent(supported)}）。`], quality };
  }
  const reasons: string[] = [];
  if (supported < THRESHOLDS.supported) reasons.push(`答えが引用だけから導けるか不確か（${percent(supported)}）。`);
  if (answerable < THRESHOLDS.answerable) reasons.push(`問いが一意に答えられるか不確か（${percent(answerable)}）。`);
  if (oneFact < THRESHOLDS.oneFact) reasons.push(`1枚に複数の知識を含む可能性（${percent(1 - oneFact)}）。`);
  if (!reasons.length && !hasWarnings) return { verdict: 'recommended', label: VERDICT_LABELS.recommended, reasons, quality };
  const confidences = ['supported', 'answerable', 'one_fact'].map((key) => results[key]?.confidence ?? 1);
  if (Math.min(...confidences) < THRESHOLDS.lowConfidence) reasons.push('AI の確信度が低い。');
  return { verdict: 'review', label: VERDICT_LABELS.review, reasons, quality };
}
