// Provider-neutral types for M3 (docs/m3-design.md §5.1). Nothing here depends on Obsidian.

/** Mirrors Jev systemone question types (§3.1). */
export type DecisionQuestion =
  | { readonly type: 'noul'; readonly instructions: string }
  | { readonly type: 'choice'; readonly instructions: string; readonly criteria: Readonly<Record<string, string>> }
  | { readonly type: 'score'; readonly instructions: string; readonly criteria: readonly string[] };

/** Shaped like Jev systemone; other providers normalize into it. */
export interface DecisionResult {
  /** noul: 0–1, choice: option key, score: level (1-based). */
  readonly value: number | string;
  readonly probabilities: Readonly<Record<string, number>>;
  /** 0–1. */
  readonly confidence: number;
}

export type FailureKind = 'auth' | 'quota' | 'rate-limited' | 'overloaded' | 'invalid-request'
  | 'invalid-response' | 'network' | 'timeout' | 'cancelled' | 'server';

/**
 * Why a provider call did not produce a value. `detail` holds only an HTTP status or a fixed
 * phrase, never response bodies or request headers (API keys must never reach the UI).
 */
export type ProviderFailure =
  | { readonly kind: 'unconfigured' | 'consent-required' }
  | { readonly kind: FailureKind; readonly detail: string };

export type ProviderOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly ms: number }
  | { readonly ok: false; readonly failure: ProviderFailure; readonly ms: number };

export type ProviderId = 'jev' | 'local';

export interface ProviderInfo {
  readonly id: ProviderId;
  readonly label: string;
  /** Non-loopback endpoint, or an Ollama cloud model (§5.1). */
  readonly external: boolean;
  /** Shown in the consent text and the run header. */
  readonly endpointHost: string;
}

export interface DecisionProvider extends ProviderInfo {
  decide(state: string, questions: Readonly<Record<string, DecisionQuestion>>,
    signal: AbortSignal): Promise<ProviderOutcome<Readonly<Record<string, DecisionResult>>>>;
}

export interface GenerationInput {
  /** Excluded regions and inline comments already removed (§4). */
  readonly source: string;
  /** Safety cap only (20), never a target. */
  readonly maxCandidates: number;
}

export interface GeneratedCandidate {
  /** The one fact (the "summary" line). */
  readonly fact: string;
  readonly question: string;
  readonly answer: string;
  /** Must match the source exactly (§6.1). */
  readonly quote: string;
}

export interface GenerationValue {
  readonly candidates: readonly GeneratedCandidate[];
  /** Items in the response that were not valid candidates (dropped). */
  readonly malformed: number;
}

export interface GeneratorProvider extends ProviderInfo {
  generate(input: GenerationInput, signal: AbortSignal): Promise<ProviderOutcome<GenerationValue>>;
}

export interface HttpRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
}

/**
 * The only way `src/ai/` reaches the network. The runtime implementation wraps Obsidian's
 * `requestUrl` (src/ai/http.ts); a rejected promise means the request never got an HTTP status.
 * There is no abort: callers stop waiting instead (§10).
 */
export interface HttpClient {
  request(request: HttpRequest): Promise<HttpResponse>;
}

/** Time source and abortable sleep, injectable so tests run without real timers. */
export interface Clock {
  now(): number;
  /** Resolves true after `ms`, or false as soon as `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<boolean>;
  random(): number;
}
