import { describe, expect, it } from 'vitest';
import { SlotGate } from '../../src/ai/call.ts';
import { AiRuntime, prepareRun, runPipeline } from '../../src/ai/pipeline.ts';
import { JUDGE_QUESTIONS } from '../../src/ai/prompts.ts';
import { JEV_ENDPOINT, createJevJudge } from '../../src/ai/providers/jev.ts';
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
  const events = { waiting: 0, generated: null, judged: [] };
  return { events, callbacks: {
    onWaiting: () => { events.waiting += 1; },
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
    expect(outcome.value.quality).toMatchObject({ value: 4, confidence: 0.8 });
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
    expect(body.messages[1].content).toContain('本文');
    expect(outcome).toMatchObject({ ok: true, value: { candidates: [CARDS.cards[0]], malformed: 1 } });
    expect(parseGeneration('not json')).toBeNull();
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
    http.release(0, { error: true });
    await drain();
    const { events: later, callbacks: laterCallbacks } = collect();
    await runPipeline(prepareRun(runtime, ai, NOTE), context, laterCallbacks, new AbortController().signal);
    expect(later.waiting).toBe(0);
    expect(later.generated).toMatchObject({ ok: true });
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
