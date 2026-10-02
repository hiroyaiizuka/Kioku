// Generation → deterministic checks → judge, with partial results and cancellation
// (docs/m3-design.md §4, §10). Pure apart from the injected HttpClient and Clock.
import type { CardText, Range } from '../cards/parser';
import { SlotGate } from './call';
import { MAX_CANDIDATES, checkGenerated, type CheckReport } from './checks';
import { classify, unjudged, type Judgement } from './classify';
import { JUDGE_QUESTIONS, judgeState } from './prompts';
import { createJevJudge } from './providers/jev';
import { createLocalGenerator } from './providers/local';
import { AI_GUIDANCE, consentRequired, failureMessage, tooLong, unjudgedWhy, type FailureContext } from './reasons';
import { JEV_HOST, hasConsent, type AiSettings } from './settings';
import { MAX_SOURCE_CHARS, buildSource, isExcalidrawNote, type SourceText } from './source';
import type { Clock, DecisionProvider, GeneratorProvider, HttpClient } from './types';

/** In-flight caps (§10): one generation per local server at a time, 4 judge calls per provider. */
export const GENERATION_SLOTS = 1;
export const JUDGE_SLOTS = 4;

/** Jev price (§3.1): input $0.042 / 1M tokens, output free. ~2,000 tokens per candidate is an unverified estimate. */
const JEV_USD_PER_TOKEN = 0.042 / 1_000_000;
const JEV_TOKENS_PER_CANDIDATE = 2000;

/**
 * Long-lived per plugin instance: the slots outlive a popup, so requests abandoned by a closed
 * popup or a cancel still count until they settle (§10). `requestUrl` cannot be aborted, so a
 * request that never settles holds its slot until the plugin is reloaded (a new runtime).
 */
export class AiRuntime {
  private readonly gates = new Map<string, SlotGate>();

  constructor(readonly http: HttpClient, readonly clock: Clock) {}

  gate(key: string, capacity: number): SlotGate {
    let gate = this.gates.get(key);
    if (!gate) {
      gate = new SlotGate(capacity);
      this.gates.set(key, gate);
    }
    return gate;
  }
}

export type Preparation =
  | { readonly ok: false; readonly reason: string; readonly kind: 'disabled' | 'unconfigured' | 'excalidraw' | 'empty' | 'too-long' | 'consent' }
  | {
    readonly ok: true;
    readonly note: string;
    readonly source: SourceText;
    readonly generator: GeneratorProvider;
    readonly generatorGate: SlotGate;
    readonly generatorContext: FailureContext;
    readonly judge: DecisionProvider | null;
    readonly judgeGate: SlotGate | null;
    /** Why candidates stay 未判定 when there is no judge (Q8). */
    readonly noJudgeWhy: string | null;
    /** True when any part of the run sends text off this computer: ask before sending (E2). */
    readonly external: boolean;
    /** Lines for the pre-send preview: destinations, character count and estimated cost. */
    readonly preview: readonly string[];
  };

/** Decides whether and how a run can happen. Never touches the network. */
export function prepareRun(runtime: AiRuntime, ai: AiSettings, note: string, range?: Range): Preparation {
  if (!ai.enabled) return { ok: false, kind: 'disabled', reason: AI_GUIDANCE.disabled };
  const local = ai.providers.local;
  if (!local.model) return { ok: false, kind: 'unconfigured', reason: AI_GUIDANCE.noModel };
  if (isExcalidrawNote(note)) return { ok: false, kind: 'excalidraw', reason: AI_GUIDANCE.excalidraw };
  const source = buildSource(note, range);
  const chars = source.text.trim().length;
  if (!chars) return { ok: false, kind: 'empty', reason: AI_GUIDANCE.empty };
  if (source.text.length > MAX_SOURCE_CHARS) return { ok: false, kind: 'too-long', reason: tooLong(source.text.length, MAX_SOURCE_CHARS) };
  const generatorGate = runtime.gate(`local|${local.baseUrl}`, GENERATION_SLOTS);
  const generator = createLocalGenerator({ settings: local, http: runtime.http, clock: runtime.clock,
    gate: generatorGate, timeoutMs: ai.timeouts.generateSeconds * 1000 });
  if (generator.external && !hasConsent('local', ai)) {
    return { ok: false, kind: 'consent', reason: consentRequired(generator.label, generator.endpointHost) };
  }
  const generatorContext: FailureContext = { label: generator.label, where: generator.external ? generator.endpointHost : local.baseUrl,
    external: generator.external };
  let judge: DecisionProvider | null = null;
  let judgeGate: SlotGate | null = null;
  let noJudgeWhy: string | null = null;
  if (ai.judge === 'none') noJudgeWhy = '判定なし';
  else if (!ai.providers.jev.apiKey) noJudgeWhy = 'Jev 未設定';
  else if (!hasConsent('jev', ai)) noJudgeWhy = 'Jev への送信に未同意';
  else {
    judgeGate = runtime.gate('jev', JUDGE_SLOTS);
    judge = createJevJudge({ apiKey: ai.providers.jev.apiKey, model: ai.providers.jev.model, http: runtime.http,
      clock: runtime.clock, gate: judgeGate, timeoutMs: ai.timeouts.judgeSeconds * 1000 });
  }
  const perCandidate = JEV_USD_PER_TOKEN * JEV_TOKENS_PER_CANDIDATE;
  const preview = [
    `生成：${generator.label}・${generator.external ? '外部' : 'このパソコン'} ${generator.endpointHost}・本文 ${source.text.length.toLocaleString('en-US')} 字・${
      generator.external ? '費用は送信先の料金に従います（Kioku では概算できません）' : '費用なし'}`,
    judge
      ? `判定：Jev・外部 ${JEV_HOST}・候補ごとに引用と前後の文脈（最大 1,500 字）と問い・答え・概算 1 件 $${perCandidate.toFixed(5)}、最大 ${MAX_CANDIDATES} 件で $${(perCandidate * MAX_CANDIDATES).toFixed(4)}（日本語のトークン数は未検証）`
      : `判定：なし（${noJudgeWhy ?? ''}）。候補は決定的な検査だけで「未判定」と表示します。`,
    'ノート名・ファイルパス・Vault 名は送りません。',
  ];
  return { ok: true, note, source, generator, generatorGate, generatorContext, judge, judgeGate, noJudgeWhy, external: generator.external || judge !== null, preview };
}

export type GenerationResult =
  | { readonly ok: true; readonly report: CheckReport; readonly malformed: number; readonly ms: number }
  | { readonly ok: false; readonly message: string; readonly cancelled: boolean };

export interface RunCallbacks {
  /** The run waits for a slot held by earlier (possibly abandoned) requests. */
  onWaiting(): void;
  onGenerated(result: GenerationResult): void;
  /** One candidate's judgement; `failure` is a user-facing reason when the judge call failed. */
  onJudged(index: number, judgement: Judgement, failure: string | null): void;
}

export interface RunContext {
  /** The note's own Q/A (explicit candidates) and the cards already adopted, for duplicate checks. */
  readonly explicit: readonly CardText[];
  readonly adopted: readonly CardText[];
}

/**
 * Runs one generation and then judges each kept candidate independently (in-flight calls capped
 * by the provider's slots). Results arriving after `signal` aborts are dropped; a candidate whose
 * judgement did not arrive becomes 「未判定（キャンセル）」.
 */
export async function runPipeline(prep: Preparation & { readonly ok: true }, context: RunContext, callbacks: RunCallbacks,
  signal: AbortSignal): Promise<void> {
  // Every slot is held by earlier requests (e.g. abandoned after a cancel on a hung server).
  if (prep.generatorGate.inFlight >= prep.generatorGate.capacity) callbacks.onWaiting();
  const generation = await prep.generator.generate({ source: prep.source.text, maxCandidates: MAX_CANDIDATES }, signal);
  if (signal.aborted) {
    callbacks.onGenerated({ ok: false, message: 'キャンセルしました。', cancelled: true });
    return;
  }
  if (!generation.ok) {
    callbacks.onGenerated({ ok: false, message: failureMessage(generation.failure, prep.generatorContext),
      cancelled: generation.failure.kind === 'cancelled' });
    return;
  }
  const report = checkGenerated(prep.note, prep.source, generation.value.candidates, context);
  callbacks.onGenerated({ ok: true, report, malformed: generation.value.malformed, ms: generation.ms });
  const { judge } = prep;
  if (!judge) {
    report.candidates.forEach((_candidate, index) => callbacks.onJudged(index, unjudged(prep.noJudgeWhy ?? '判定なし'), null));
    return;
  }
  // Before this run sends any judge request, every slot is still held by earlier (abandoned) requests.
  if (prep.judgeGate && prep.judgeGate.inFlight >= prep.judgeGate.capacity) callbacks.onWaiting();
  const judgeContext: FailureContext = { label: judge.label, where: judge.endpointHost, external: judge.external,
    authHint: 'キーは console.typesafe.ai/keys で発行できます。' };
  await Promise.all(report.candidates.map(async (candidate, index) => {
    const state = judgeState(prep.source.text, candidate.quote.sentStart, candidate.quote.sentEnd, candidate.quote.text,
      candidate.card.question, candidate.card.answer);
    const outcome = await judge.decide(state, JUDGE_QUESTIONS, signal);
    if (signal.aborted) {
      callbacks.onJudged(index, unjudged('キャンセル'), null);
      return;
    }
    if (!outcome.ok) {
      callbacks.onJudged(index, unjudged(unjudgedWhy(outcome.failure)), failureMessage(outcome.failure, judgeContext));
      return;
    }
    callbacks.onJudged(index, classify(outcome.value, candidate.warnings.length > 0), null);
  }));
}
