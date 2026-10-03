import { describe, expect, it } from 'vitest';
import { SlotGate } from '../../src/ai/call.ts';
import { AiRuntime, prepareRun, runPipeline } from '../../src/ai/pipeline.ts';
import { JUDGE_QUESTIONS } from '../../src/ai/prompts.ts';
import { JEV_ENDPOINT, createJevJudge, normalizeJevAnswer } from '../../src/ai/providers/jev.ts';
import { classify } from '../../src/ai/classify.ts';
import { createLocalGenerator, parseGeneration } from '../../src/ai/providers/local.ts';
import { failureMessage } from '../../src/ai/reasons.ts';
import { consentFingerprint, parseAiSettings } from '../../src/ai/settings.ts';
import { chat, drain, fakeClock, fakeHttp, json, jevAnswers } from '../helpers/fake-ai.mjs';

const KEY = 'tsk-live-0123456789abcdefSECRETKEY';
const NOTE = '# 秘密のタイトル見出しではない\n光合成は糖を作る反応である。葉緑体で行われる。\n\nミトコンドリアは呼吸の場である。\n';
const CARDS = { cards: [
  { fact: 'f1', question: '光合成の場は？', answer: '葉緑体', quote: '葉緑体で行われる。' },
  { fact: 'f2', question: '呼吸の場は？', answer: 'ミトコンドリア', quote: 'ミトコンドリアは呼吸の場である。' },
  { fact: 'f3', question: '捏造の問い', answer: '捏造', quote: 'ノートに無い引用。' },
] };

function settings(overrides = {}) {
  const base = parseAiSettings({ enabled: true, judge: 'jev', providers: { local: { model: 'qwen3:8b' }, jev: { apiKey: KEY } }, ...overrides });
  return base;
}
function consented(ai, provider) {
  return { ...ai, providers: { ...ai.providers, [provider]: { ...ai.providers[provider], consent: consentFingerprint(provider, ai) } } };
}
function collect() {
  const events = { waiting: 0, sending: [], generated: null, judged: [] };
  return { events, callbacks: {
    onWaiting: () => { events.waiting += 1; },
    onSending: (stage) => { events.sending.push(stage); },
    onGenerated: (result) => { events.generated = result; },
    onJudged: (index, judgement, failure) => { events.judged[index] = { ...judgement, failure }; },
  } };
}
const context = { explicit: [], adopted: [] };

describe('providers', () => {
  it('sends Jev systemone requests with the Bearer key, the model, state and the four typed questions', async () => {
    const http = fakeHttp(() => jevAnswers());
    const judge = createJevJudge({ apiKey: KEY, model: 'jev-latest', http, clock: fakeClock(), gate: new SlotGate(4), timeoutMs: 20000 });
    const outcome = await judge.decide('state', JUDGE_QUESTIONS, new AbortController().signal);
    expect(http.requests[0]).toMatchObject({ url: JEV_ENDPOINT, method: 'POST', headers: { Authorization: `Bearer ${KEY}` } });
    const body = JSON.parse(http.requests[0].body);
    expect(body).toMatchObject({ model: 'jev-latest', state: 'state' });
    expect(Object.keys(body.questions)).toEqual(['supported', 'answerable', 'one_fact', 'quality']);
    expect(body.questions.quality).toMatchObject({ type: 'score', criteria: expect.any(Array) });
    expect(body.questions.quality.criteria).toHaveLength(5);
    expect(outcome.ok).toBe(true);
    expect(outcome.value.supported).toEqual({ value: 0.95, probabilities: { yes: 0.95, no: 0.050000000000000044 }, confidence: 0.95 });
    expect(outcome.value.quality).toMatchObject({ value: 3.05, confidence: 0.92, probabilities: { 0: 0, 3: 0.85 } });
  });

  it('accepts fractional 0-based scores within 0 … levels − 1 and rejects others', () => {
    const quality = JUDGE_QUESTIONS.quality;
    const answer = (score) => ({ type: 'score', score, legend: {}, probabilities: { 0: 0.5, 1: 0.5 }, confidence: 0.5 });
    expect([0, 0.5, 1.05, 3.99, 4].map((score) => normalizeJevAnswer(quality, answer(score))?.value)).toEqual([0, 0.5, 1.05, 3.99, 4]);
    expect([-0.1, 4.01, Number.NaN, '2'].map((score) => normalizeJevAnswer(quality, answer(score)))).toEqual([null, null, null, null]);
  });

  it('keeps the noul answers when quality is malformed (quality is only a display hint)', async () => {
    const http = fakeHttp(() => jevAnswers({ quality: { type: 'score', score: 7, legend: {}, probabilities: {}, confidence: 1 } }));
    const judge = createJevJudge({ apiKey: KEY, model: 'jev-latest', http, clock: fakeClock(), gate: new SlotGate(4), timeoutMs: 20000 });
    const outcome = await judge.decide('s', JUDGE_QUESTIONS, new AbortController().signal);
    expect(outcome.ok).toBe(true);
    expect(Object.keys(outcome.value)).toEqual(['supported', 'answerable', 'one_fact']);
    expect(classify(outcome.value, false)).toMatchObject({ verdict: 'recommended', quality: null });
    const fractional = await createJevJudge({ apiKey: KEY, model: 'jev-latest', http: fakeHttp(() => jevAnswers()), clock: fakeClock(),
      gate: new SlotGate(4), timeoutMs: 20000 }).decide('s', JUDGE_QUESTIONS, new AbortController().signal);
    expect(classify(fractional.value, false).quality).toBeCloseTo(4.05);
  });

  it('rejects malformed Jev answers as invalid responses', async () => {
    const http = fakeHttp(() => json({ answers: { supported: { noul: 2 } } }));
    const judge = createJevJudge({ apiKey: KEY, model: 'jev-latest', http, clock: fakeClock(), gate: new SlotGate(4), timeoutMs: 20000 });
    const outcome = await judge.decide('s', JUDGE_QUESTIONS, new AbortController().signal);
    expect(outcome).toMatchObject({ ok: false, failure: { kind: 'invalid-response' } });
  });

  it('asks the local server for JSON with a schema and validates the answer itself', async () => {
    const http = fakeHttp(() => chat('```json\n' + JSON.stringify({ cards: [CARDS.cards[0], { question: 1 }] }) + '\n```'));
    const ai = settings();
    const generator = createLocalGenerator({ settings: ai.providers.local, http, clock: fakeClock(), gate: new SlotGate(1), timeoutMs: 60000 });
    expect(generator).toMatchObject({ id: 'local', external: false, endpointHost: 'localhost:11434', label: 'Ollama（qwen3:8b）' });
    const outcome = await generator.generate({ source: '本文', maxCandidates: 20 }, new AbortController().signal);
    expect(http.requests[0].url).toBe('http://localhost:11434/v1/chat/completions');
    const body = JSON.parse(http.requests[0].body);
    expect(body).toMatchObject({ model: 'qwen3:8b', stream: false, response_format: { type: 'json_schema' } });
    // Ollama: thinking off (a thinking model otherwise reasons for minutes before the JSON).
    expect(body.reasoning_effort).toBe('none');
    expect(body.messages[1].content).toContain('本文');
    expect(outcome).toMatchObject({ ok: true, value: { candidates: [CARDS.cards[0]], malformed: 1 } });
    for (const server of ['llamacpp', 'lmstudio']) {
      const other = fakeHttp(() => chat({ cards: [] }));
      await createLocalGenerator({ settings: { ...ai.providers.local, server, baseUrl: 'http://localhost:8080' }, http: other,
        clock: fakeClock(), gate: new SlotGate(1), timeoutMs: 60000 }).generate({ source: '本文', maxCandidates: 20 }, new AbortController().signal);
      expect(JSON.parse(other.requests[0].body)).not.toHaveProperty('reasoning_effort');
    }
    expect(parseGeneration('not json')).toBeNull();
  });

  it('asks once more without reasoning_effort only when a 400 rejects that field', async () => {
    const ai = settings();
    const make = (http, clock = fakeClock()) => createLocalGenerator({ settings: ai.providers.local, http, clock, gate: new SlotGate(1), timeoutMs: 60000 });
    const input = { source: '本文', maxCandidates: 20 };
    const REJECTED = json({ error: { message: 'invalid reasoning value: "none" (must be "low", "medium" or "high")', type: 'invalid_request_error' } }, 400);
    const rejectsField = fakeHttp((request) => ('reasoning_effort' in JSON.parse(request.body) ? REJECTED : chat({ cards: [CARDS.cards[0]] })));
    const outcome = await make(rejectsField).generate(input, new AbortController().signal);
    expect(outcome).toMatchObject({ ok: true, value: { candidates: [CARDS.cards[0]] } });
    expect(rejectsField.requests.map((request) => JSON.parse(request.body).reasoning_effort)).toEqual(['none', undefined]);
    // An unrelated 400 is not about the field: no second send of the note, and a clear failure.
    const unrelated = fakeHttp(() => json({ error: { message: 'messages: content too long' } }, 400));
    const failed = await make(unrelated).generate(input, new AbortController().signal);
    expect(failed).toMatchObject({ ok: false, failure: { kind: 'invalid-request', detail: 'HTTP 400' } });
    expect(unrelated.requests).toHaveLength(1);
    expect(failureMessage(failed.failure, { label: 'Ollama（qwen3:8b）', where: 'http://localhost:11434', external: false }))
      .toBe('要求が受け付けられませんでした（Ollama（qwen3:8b）、HTTP 400）。本文が長すぎる場合は範囲を選んでください。');
    // Other failures are not retried, and servers without the field never retry.
    const notFound = fakeHttp(() => json({ error: 'model not found' }, 404));
    await make(notFound).generate(input, new AbortController().signal);
    expect(notFound.requests).toHaveLength(1);
    const llama = fakeHttp(() => REJECTED);
    await createLocalGenerator({ settings: { ...ai.providers.local, server: 'llamacpp', baseUrl: 'http://localhost:8080' }, http: llama,
      clock: fakeClock(), gate: new SlotGate(1), timeoutMs: 60000 }).generate(input, new AbortController().signal);
    expect(llama.requests).toHaveLength(1);
  });

  it('gives the second request only what is left of the budget, and skips it when nothing is left or cancelled', async () => {
    const ai = settings();
    const input = { source: '本文', maxCandidates: 20 };
    const REJECTED = { status: 400, text: JSON.stringify({ error: { message: 'invalid reasoning value: "none"' } }) };
    // The rejection arrives after 50 s: the retry has 10 s left (not a fresh 60 s) and reports the configured timeout.
    const clock = fakeClock();
    const http = fakeHttp(() => 'hang');
    const generator = createLocalGenerator({ settings: ai.providers.local, http, clock, gate: new SlotGate(1), timeoutMs: 60000 });
    const pending = generator.generate(input, new AbortController().signal);
    await clock.advance(50000);
    http.release(0, REJECTED);
    await drain();
    expect(http.requests).toHaveLength(2);
    await clock.advance(9999);
    expect(clock.pending()).toBe(1);
    await clock.advance(1);
    expect(await pending).toMatchObject({ ok: false, failure: { kind: 'timeout', detail: '60 秒' } });
    // Nothing left: the rejection came at the end of the budget (the clock jumps past it).
    const base = fakeClock();
    let skew = 0;
    const skewed = { ...base, now: () => base.now() + skew };
    const late = fakeHttp(() => { skew = 61000; return REJECTED; });
    const lateOutcome = await createLocalGenerator({ settings: ai.providers.local, http: late, clock: skewed, gate: new SlotGate(1),
      timeoutMs: 60000 }).generate(input, new AbortController().signal);
    expect(late.requests).toHaveLength(1);
    expect(lateOutcome).toMatchObject({ ok: false, failure: { kind: 'invalid-request' } });
    // Cancelled while the first request was in flight: no second request.
    const controller = new AbortController();
    const cancelled = fakeHttp(() => { controller.abort(); return REJECTED; });
    const cancelledOutcome = await createLocalGenerator({ settings: ai.providers.local, http: cancelled, clock: fakeClock(), gate: new SlotGate(1),
      timeoutMs: 60000 }).generate(input, controller.signal);
    expect(cancelled.requests).toHaveLength(1);
    expect(cancelledOutcome).toMatchObject({ ok: false, failure: { kind: 'cancelled' } });
    expect(parseGeneration('{"cards":[]}')).toEqual({ candidates: [], malformed: 0 });
  });
});

describe('prepareRun (no network)', () => {
  const runtime = () => new AiRuntime(fakeHttp(() => { throw new Error('no network expected'); }), fakeClock());

  it('explains why AI cannot run: disabled, no model, Excalidraw, empty, too long, no consent for an external generator', () => {
    expect(prepareRun(runtime(), parseAiSettings(undefined), NOTE)).toMatchObject({ ok: false, kind: 'disabled', reason: expect.stringContaining('AI が未設定') });
    expect(prepareRun(runtime(), parseAiSettings({ enabled: true }), NOTE)).toMatchObject({ ok: false, kind: 'unconfigured' });
    expect(prepareRun(runtime(), settings(), '---\nexcalidraw-plugin: parsed\n---\n本文\n')).toMatchObject({ ok: false, kind: 'excalidraw' });
    expect(prepareRun(runtime(), settings(), '```\ncode\n```\n')).toMatchObject({ ok: false, kind: 'empty' });
    expect(prepareRun(runtime(), settings(), 'あ'.repeat(8001))).toMatchObject({ ok: false, kind: 'too-long', reason: expect.stringContaining('8,001 字') });
    const cloud = settings({ providers: { local: { model: 'gpt-oss:20b-cloud' } } });
    expect(prepareRun(runtime(), cloud, NOTE)).toMatchObject({ ok: false, kind: 'consent', reason: expect.stringContaining('localhost:11434') });
    const allowed = prepareRun(runtime(), consented(cloud, 'local'), NOTE);
    expect(allowed).toMatchObject({ ok: true, external: true });
    expect(allowed.preview[0]).toContain('外部');
  });

  it('runs generation without a judge when Jev is unset, not consented, or "none" (Q8)', () => {
    const unset = prepareRun(runtime(), settings({ providers: { local: { model: 'qwen3:8b' } } }), NOTE);
    expect(unset).toMatchObject({ ok: true, judge: null, noJudgeWhy: 'Jev 未設定', external: false });
    expect(prepareRun(runtime(), settings(), NOTE)).toMatchObject({ ok: true, judge: null, noJudgeWhy: 'Jev への送信に未同意' });
    expect(prepareRun(runtime(), settings({ judge: 'none' }), NOTE)).toMatchObject({ ok: true, judge: null, noJudgeWhy: '判定なし' });
    const ready = prepareRun(runtime(), consented(settings(), 'jev'), NOTE);
    expect(ready).toMatchObject({ ok: true, external: true });
    expect(ready.judge.endpointHost).toBe('api.typesafe.ai');
    expect(ready.preview.join('\n')).toMatch(/api\.typesafe\.ai.*\$0\.00008/s);
    expect(ready.preview.join('\n')).toContain('ノート名・ファイルパス・Vault 名は送りません');
  });
});

describe('runPipeline', () => {
  it('generates, drops unquoted candidates, and leaves candidates unjudged without a judge', async () => {
    const http = fakeHttp(() => chat(CARDS));
    const prep = prepareRun(new AiRuntime(http, fakeClock()), settings({ providers: { local: { model: 'qwen3:8b' } } }), NOTE);
    const { events, callbacks } = collect();
    await runPipeline(prep, context, callbacks, new AbortController().signal);
    expect(http.requests).toHaveLength(1);
    expect(events.generated.ok).toBe(true);
    expect(events.generated.report.candidates.map((item) => item.card.question)).toEqual(['光合成の場は？', '呼吸の場は？']);
    expect(events.generated.report.quoteMismatch).toBe(1);
    expect(events.judged.map((item) => item.label)).toEqual(['未判定（Jev 未設定）', '未判定（Jev 未設定）']);
    // Only the note body is sent: never the file name or vault (the title is not part of the text).
    expect(http.requests[0].body).not.toContain('生物.md');
  });

  it('judges each candidate with Jev, keeping partial failures per candidate', async () => {
    const http = fakeHttp((request) => {
      if (!request.url.startsWith(JEV_ENDPOINT)) return chat(CARDS);
      return JSON.parse(request.body).state.includes('Question: 呼吸') ? json({ error: 'bad key ' + KEY }, 401) : jevAnswers();
    });
    const prep = prepareRun(new AiRuntime(http, fakeClock()), consented(settings(), 'jev'), NOTE);
    const { events, callbacks } = collect();
    await runPipeline(prep, context, callbacks, new AbortController().signal);
    expect(http.requests).toHaveLength(3);
    expect(events.judged[0]).toMatchObject({ verdict: 'recommended', label: '推奨', failure: null });
    expect(events.judged[1]).toMatchObject({ verdict: 'unjudged', label: '未判定（認証失敗）' });
    expect(events.judged[1].failure).toContain('API キーが無効か期限切れです（Jev、HTTP 401）');
    expect(events.judged[1].failure).not.toContain(KEY);
    const state = JSON.parse(http.requests[1].body).state;
    expect(state).toContain('Quote:'); expect(state).toContain('Question:');
  });

  it('cancels during generation and while judging: arrived results stay, the rest become 未判定（キャンセル）', async () => {
    const clock = fakeClock();
    const hangHttp = fakeHttp(() => 'hang');
    const prep = prepareRun(new AiRuntime(hangHttp, clock), settings(), NOTE);
    const first = collect();
    const controller = new AbortController();
    const run = runPipeline(prep, context, first.callbacks, controller.signal);
    await drain();
    controller.abort();
    await run;
    expect(first.events.generated).toMatchObject({ ok: false, cancelled: true });

    let judged = 0;
    const http = fakeHttp((request) => {
      if (!request.url.startsWith(JEV_ENDPOINT)) return chat(CARDS);
      judged += 1;
      return judged === 1 ? jevAnswers() : 'hang';
    });
    const ready = prepareRun(new AiRuntime(http, clock), consented(settings(), 'jev'), NOTE);
    const second = collect();
    const judging = new AbortController();
    const pending = runPipeline(ready, context, second.callbacks, judging.signal);
    await drain();
    judging.abort();
    await pending;
    expect(second.events.judged.map((item) => item.label).sort()).toEqual(['推奨', '未判定（キャンセル）']);
  });

  it('shows the waiting state when a hung generation from a cancelled run still holds the slot', async () => {
    const clock = fakeClock();
    const http = fakeHttp((_request, index) => (index === 0 ? 'hang' : chat({ cards: [] })));
    const runtime = new AiRuntime(http, clock);
    const ai = settings({ judge: 'none' });
    const first = new AbortController();
    const abandoned = runPipeline(prepareRun(runtime, ai, NOTE), context, collect().callbacks, first.signal);
    await drain();
    first.abort();
    await abandoned;
    const { events, callbacks } = collect();
    const second = new AbortController();
    const retry = runPipeline(prepareRun(runtime, ai, NOTE), context, callbacks, second.signal);
    await drain();
    expect(events.waiting).toBe(1);
    expect(http.requests).toHaveLength(1); // nothing new sent while the slot is held
    // Cancel still works while waiting.
    second.abort();
    await retry;
    expect(events.generated).toMatchObject({ ok: false, cancelled: true });
    expect(events.sending).toEqual([]);
    http.release(0, { error: true });
    await drain();
    const { events: later, callbacks: laterCallbacks } = collect();
    await runPipeline(prepareRun(runtime, ai, NOTE), context, laterCallbacks, new AbortController().signal);
    expect(later.waiting).toBe(0);
    expect(later.generated).toMatchObject({ ok: true });
  });
});

describe('judge slots held by abandoned requests', () => {
  it('shows the waiting state before judging when all Jev slots are still held', async () => {
    const clock = fakeClock();
    const http = fakeHttp((request) => (request.url.startsWith(JEV_ENDPOINT) ? 'hang' : chat({ cards: Array.from({ length: 4 },
      (_, index) => ({ fact: 'f', question: `問${index}`, answer: '葉緑体', quote: '葉緑体で行われる。' })) })));
    const runtime = new AiRuntime(http, clock);
    const ai = consented(settings(), 'jev');
    const first = new AbortController();
    const firstEvents = collect();
    const abandoned = runPipeline(prepareRun(runtime, ai, NOTE), context, firstEvents.callbacks, first.signal);
    await drain();
    expect(http.hungCount()).toBe(4);
    first.abort();
    await abandoned;
    expect(firstEvents.events.waiting).toBe(0);
    const { events, callbacks } = collect();
    const second = new AbortController();
    const retry = runPipeline(prepareRun(runtime, ai, NOTE), context, callbacks, second.signal);
    await drain();
    expect(events.waiting).toBe(1);
    expect(http.requests.filter((request) => request.url.startsWith(JEV_ENDPOINT))).toHaveLength(4);
    expect(events.sending).toEqual(['generation']);
    // One abandoned judge request settles: this run's first judge call gets the slot and sends.
    http.release(1, { error: true });
    await drain();
    expect(events.sending).toEqual(['generation', 'judge']);
    second.abort();
    await retry;
    expect(events.judged.every((item) => item.label === '未判定（キャンセル）')).toBe(true);
  });
});

describe('failure messages', () => {
  it('cover every failure kind without leaking a key', () => {
    const contexts = [{ label: 'Jev', where: 'api.typesafe.ai', external: true, authHint: 'キーは console.typesafe.ai/keys で発行できます。' },
      { label: 'Ollama（qwen3:8b）', where: 'http://localhost:11434', external: false }];
    const kinds = ['auth', 'quota', 'rate-limited', 'overloaded', 'invalid-request', 'invalid-response', 'network', 'timeout', 'cancelled', 'server'];
    for (const context of contexts) {
      for (const kind of kinds) {
        const message = failureMessage({ kind, detail: 'HTTP 401' }, context);
        expect(message.length).toBeGreaterThan(4);
        expect(message).not.toContain(KEY);
      }
      expect(failureMessage({ kind: 'consent-required' }, context)).toContain('同意していません');
    }
    expect(failureMessage({ kind: 'network', detail: '' }, contexts[1])).toBe('http://localhost:11434 に接続できません。Ollama などのサーバーが起動しているか確認してください。');
    expect(failureMessage({ kind: 'timeout', detail: '60 秒' }, contexts[1])).toBe('時間内に応答がありませんでした（Ollama（qwen3:8b）、60 秒）。');
  });
});
