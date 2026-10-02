// Jev (TypeSafe AI) systemone judge (docs/m3-design.md §3.1, §5.3).
import { call, isRecord, parseJson, type SlotGate } from '../call';
import { JEV_HOST } from '../settings';
import type { Clock, DecisionProvider, DecisionQuestion, DecisionResult, HttpClient, ProviderOutcome } from '../types';

export const JEV_ENDPOINT = `https://${JEV_HOST}/v1/systemone`;

export interface JevOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly http: HttpClient;
  readonly clock: Clock;
  readonly gate: SlotGate;
  readonly timeoutMs: number;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function probabilities(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  return entries.every(([, probability]) => finite(probability)) ? Object.fromEntries(entries) as Record<string, number> : null;
}

/**
 * Normalizes one systemone answer into `DecisionResult` (§5.1): noul gets yes/no probabilities and a
 * derived confidence (Jev returns none for noul); choice and score are passed through. A score is
 * Jev's probability-weighted, continuous value over 0-based levels (`"score": 1.05`, probabilities
 * keyed "0", "1", …), so any finite 0 ≤ score ≤ criteria.length − 1 is valid.
 */
export function normalizeJevAnswer(question: DecisionQuestion, answer: unknown): DecisionResult | null {
  if (!isRecord(answer)) return null;
  if (question.type === 'noul') {
    const value = answer.noul;
    if (!finite(value) || value < 0 || value > 1) return null;
    return { value, probabilities: { yes: value, no: 1 - value }, confidence: Math.max(value, 1 - value) };
  }
  const probs = probabilities(answer.probabilities);
  const confidence = answer.confidence;
  if (!probs || !finite(confidence)) return null;
  if (question.type === 'choice') {
    return typeof answer.choice === 'string' && answer.choice in question.criteria
      ? { value: answer.choice, probabilities: probs, confidence } : null;
  }
  const score = answer.score;
  return finite(score) && score >= 0 && score <= question.criteria.length - 1
    ? { value: score, probabilities: probs, confidence } : null;
}

export function createJevJudge(options: JevOptions): DecisionProvider {
  return {
    id: 'jev',
    label: 'Jev',
    external: true,
    endpointHost: JEV_HOST,
    async decide(state, questions, signal): Promise<ProviderOutcome<Readonly<Record<string, DecisionResult>>>> {
      const started = options.clock.now();
      const ms = (): number => options.clock.now() - started;
      const result = await call(options.http, {
        url: JEV_ENDPOINT,
        method: 'POST',
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: options.model, state, questions }),
      }, { gate: options.gate, clock: options.clock, signal, timeoutMs: options.timeoutMs });
      if (!result.ok) return { ok: false, failure: result.failure, ms: ms() };
      const body = parseJson(result.response.text);
      const answers = isRecord(body) ? body.answers : null;
      if (!isRecord(answers)) return { ok: false, failure: { kind: 'invalid-response', detail: 'answers がありません' }, ms: ms() };
      // A malformed answer is left out rather than failing the call: the caller decides what it
      // needs (e.g. `quality` is only a display-order hint; missing noul answers mean 未判定).
      const value: Record<string, DecisionResult> = {};
      for (const [key, question] of Object.entries(questions)) {
        const normalized = normalizeJevAnswer(question, answers[key]);
        if (normalized) value[key] = normalized;
      }
      if (!Object.keys(value).length) return { ok: false, failure: { kind: 'invalid-response', detail: '答えを読み取れません' }, ms: ms() };
      return { ok: true, value, ms: ms() };
    },
  };
}
