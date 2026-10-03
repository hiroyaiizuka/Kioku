// Generation through a local OpenAI-compatible server: Ollama (default, Q1), llama.cpp or LM Studio
// (docs/m3-design.md §5.5). The output is always validated by Kioku, whatever the server supports.
import { call, isRecord, parseJson, type SlotGate } from '../call';
import { GENERATION_SCHEMA, GENERATION_SYSTEM_PROMPT, generationUserPrompt } from '../prompts';
import { LOCAL_SERVER_LABELS, hostOf, localIsExternal, type LocalProviderSettings } from '../settings';
import type { Clock, GeneratedCandidate, GenerationValue, GeneratorProvider, HttpClient, ProviderOutcome } from '../types';

export interface LocalGeneratorOptions {
  readonly settings: LocalProviderSettings;
  readonly http: HttpClient;
  readonly clock: Clock;
  readonly gate: SlotGate;
  readonly timeoutMs: number;
}

/** Removes a Markdown code fence some models wrap around JSON. */
function unfence(content: string): string {
  const match = content.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/);
  return match?.[1] ?? content.trim();
}

/**
 * Validates the model's JSON (no runtime schema library, §12): `{ cards: [{ fact, question,
 * answer, quote }] }` with string fields. Invalid items are dropped and counted; a body that is
 * not this shape at all is `null`.
 */
export function parseGeneration(content: string): GenerationValue | null {
  const body = parseJson(unfence(content));
  const cards = isRecord(body) ? body.cards : null;
  if (!Array.isArray(cards)) return null;
  const candidates: GeneratedCandidate[] = [];
  let malformed = 0;
  for (const item of cards as unknown[]) {
    if (isRecord(item) && typeof item.fact === 'string' && typeof item.question === 'string'
      && typeof item.answer === 'string' && typeof item.quote === 'string') {
      candidates.push({ fact: item.fact, question: item.question, answer: item.answer, quote: item.quote });
    } else {
      malformed += 1;
    }
  }
  return { candidates, malformed };
}

/**
 * Server-specific request fields. Ollama: `reasoning_effort: "none"` maps to `think: false` for
 * boolean-thinking models (per docs.ollama.com/api/openai-compatibility); the behaviour on other
 * models is unverified. Measured only on gemma4:26b (docs/m3-design.md §16.2): with thinking,
 * ~5,000 characters of reasoning and 180 s to over 300 s; without it on this product path
 * 45.5–95.6 s depending on system load (stable success within 60 s is not established).
 * llama.cpp and LM Studio have no verified equivalent, so nothing is added for them.
 */
export function serverOptions(server: LocalProviderSettings['server']): Record<string, unknown> {
  return server === 'ollama' ? { reasoning_effort: 'none' } : {};
}

/**
 * True when an HTTP 400 says the reasoning field was rejected (Ollama: `invalid reasoning value: …`).
 * Only then is the note sent a second time; any other 400 fails as is, so an unrelated error never
 * re-sends the note (it may go to an external model). The body is inspected here only, never shown.
 */
export function rejectedReasoningField(response: { readonly status: number; readonly text: string } | undefined): boolean {
  return response?.status === 400 && /reasoning/i.test(response.text);
}

export function createLocalGenerator(options: LocalGeneratorOptions): GeneratorProvider {
  const { settings } = options;
  return {
    id: 'local',
    label: `${LOCAL_SERVER_LABELS[settings.server]}（${settings.model}）`,
    external: localIsExternal(settings),
    endpointHost: hostOf(settings.baseUrl),
    async generate(input, signal, progress): Promise<ProviderOutcome<GenerationValue>> {
      const started = options.clock.now();
      const ms = (): number => options.clock.now() - started;
      let sentAt: number | null = null;
      const send = (extra: Record<string, unknown>, timeoutMs: number): ReturnType<typeof call> => call(options.http, {
        url: `${settings.baseUrl}/v1/chat/completions`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: settings.model,
          temperature: 0.2,
          stream: false,
          messages: [
            { role: 'system', content: GENERATION_SYSTEM_PROMPT },
            { role: 'user', content: generationUserPrompt(input.source, input.maxCandidates) },
          ],
          response_format: { type: 'json_schema', json_schema: { name: 'kioku_cards', strict: true, schema: GENERATION_SCHEMA } },
          ...extra,
        }),
      }, {
        gate: options.gate, clock: options.clock, signal, timeoutMs, configuredTimeoutMs: options.timeoutMs,
        onWaiting: progress?.onWaiting,
        onSending: () => {
          sentAt ??= options.clock.now();
          progress?.onSending?.();
        },
      });
      const extra = serverOptions(settings.server);
      let result = await send(extra, options.timeoutMs);
      if (!result.ok && Object.keys(extra).length && rejectedReasoningField(result.response)) {
        // The server rejected the optional field: ask once more without it, with what is left of the budget.
        const remaining = options.timeoutMs - (options.clock.now() - (sentAt ?? started));
        if (remaining > 0 && !signal.aborted) result = await send({}, remaining);
      }
      if (!result.ok) return { ok: false, failure: result.failure, ms: ms() };
      const body = parseJson(result.response.text);
      const choices: unknown[] = isRecord(body) && Array.isArray(body.choices) ? body.choices as unknown[] : [];
      const first = choices[0];
      const message = isRecord(first) ? first.message : null;
      const content = isRecord(message) && typeof message.content === 'string' ? message.content : null;
      const value = content === null ? null : parseGeneration(content);
      if (!value) return { ok: false, failure: { kind: 'invalid-response', detail: 'JSON を読み取れません' }, ms: ms() };
      return { ok: true, value, ms: ms() };
    },
  };
}
