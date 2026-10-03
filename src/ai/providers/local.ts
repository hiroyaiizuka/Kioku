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
 * Server-specific request fields. Ollama: `reasoning_effort: "none"` turns the model's thinking off
 * on the OpenAI-compatible endpoint (Ollama maps it to `think: false`; models without thinking
 * ignore it). Thinking models otherwise reason at length before the JSON — measured on gemma4:26b
 * (docs/m3-design.md §16.2): ~5,000 characters of reasoning and 180 s to over 300 s; without it
 * 31–96 s depending on system load (stable success within 60 s is not established). llama.cpp and LM Studio have no verified equivalent, so nothing is added for
 * them. A server that rejects the field (HTTP 400, as Ollama does for a value it does not know) is
 * asked once more without it.
 */
export function serverOptions(server: LocalProviderSettings['server']): Record<string, unknown> {
  return server === 'ollama' ? { reasoning_effort: 'none' } : {};
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
      }, { gate: options.gate, clock: options.clock, signal, timeoutMs, onWaiting: progress?.onWaiting, onSending: () => {
        sentAt ??= options.clock.now();
        progress?.onSending?.();
      } });
      const extra = serverOptions(settings.server);
      let result = await send(extra, options.timeoutMs);
      if (!result.ok && result.failure.kind === 'invalid-request' && result.failure.detail === 'HTTP 400' && Object.keys(extra).length) {
        // The server rejected an optional field: ask once more without it, within the same budget.
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
