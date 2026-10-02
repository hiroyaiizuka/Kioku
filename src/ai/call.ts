// One provider HTTP exchange with a concurrency slot, a timeout, cancellation and 429/529 backoff
// (docs/m3-design.md §10). `requestUrl` cannot be aborted, so timeout and cancel mean "stop waiting
// and drop the result"; the slot is returned only when the request itself settles, so abandoned
// requests never pile up beyond the cap.
import type { Clock, HttpClient, HttpRequest, HttpResponse, ProviderFailure } from './types';

/** A counting semaphore whose waiters can give up through an AbortSignal. */
export class SlotGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly capacity: number) {}

  /** Requests currently holding a slot (including abandoned ones that have not settled). */
  get inFlight(): number {
    return this.active;
  }

  /** Resolves true once a slot is held, false if `signal` aborts first. Calls `onWait` when it has to wait. */
  acquire(signal: AbortSignal, onWait?: () => void): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.active < this.capacity) {
      this.active += 1;
      return Promise.resolve(true);
    }
    onWait?.();
    return new Promise((resolve) => {
      const grant = (): void => {
        signal.removeEventListener('abort', onAbort);
        resolve(true);
      };
      const onAbort = (): void => {
        const index = this.waiters.indexOf(grant);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(false);
      };
      this.waiters.push(grant);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  release(): void {
    const next = this.waiters.shift();
    // Hand the slot straight to the next waiter; `active` stays the same.
    if (next) next();
    else this.active = Math.max(0, this.active - 1);
  }
}

export interface CallOptions {
  readonly gate: SlotGate;
  readonly clock: Clock;
  readonly signal: AbortSignal;
  /** Budget for sending and retries; time spent waiting for a slot does not count. */
  readonly timeoutMs: number;
  /** Called when the call has to wait for a slot held by earlier (possibly abandoned) requests. */
  readonly onWaiting?: () => void;
  /** Called once a slot is held, right before the request is sent (also before each retry). */
  readonly onSending?: () => void;
}

export type CallResult =
  | { readonly ok: true; readonly response: HttpResponse }
  | { readonly ok: false; readonly failure: ProviderFailure };

const RETRY_LIMIT = 3;
const BASE_BACKOFF_MS = 500;

/** Maps a non-2xx status to a failure. `detail` is the status only (never the body). */
export function statusFailure(status: number): ProviderFailure {
  const detail = `HTTP ${status}`;
  if (status === 401 || status === 403) return { kind: 'auth', detail };
  if (status === 402) return { kind: 'quota', detail };
  if (status === 429) return { kind: 'rate-limited', detail };
  if (status === 529 || status === 503) return { kind: 'overloaded', detail };
  if (status === 400 || status === 404 || status === 413 || status === 422) return { kind: 'invalid-request', detail };
  if (status >= 500) return { kind: 'server', detail };
  return { kind: 'invalid-response', detail };
}

/** `Retry-After` in seconds (an HTTP date is ignored), as milliseconds. */
function retryAfterMs(headers: Readonly<Record<string, string>>): number | null {
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'retry-after');
  const value = key === undefined ? undefined : headers[key];
  if (value === undefined || !/^\s*\d+(?:\.\d+)?\s*$/.test(value)) return null;
  return Number(value) * 1000;
}

type Attempt = { readonly kind: 'response'; readonly response: HttpResponse } | { readonly kind: 'error' }
  | { readonly kind: 'timeout' } | { readonly kind: 'cancelled' };

async function attempt(http: HttpClient, request: HttpRequest, options: CallOptions, remainingMs: number): Promise<Attempt> {
  const { gate, clock, signal } = options;
  if (!(await gate.acquire(signal, options.onWaiting))) return { kind: 'cancelled' };
  options.onSending?.();
  const holder: { settled: Attempt | null } = { settled: null };
  const stop = new AbortController();
  const onAbort = (): void => stop.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  void Promise.resolve()
    .then(() => http.request(request))
    .then((response): Attempt => ({ kind: 'response', response }), (): Attempt => ({ kind: 'error' }))
    .then((settled) => {
      holder.settled = settled;
      stop.abort();
    })
    .finally(() => gate.release());
  const timedOut = await clock.sleep(remainingMs, stop.signal);
  signal.removeEventListener('abort', onAbort);
  if (signal.aborted) return { kind: 'cancelled' };
  if (holder.settled) return holder.settled;
  return timedOut ? { kind: 'timeout' } : { kind: 'cancelled' };
}

/**
 * Sends `request`, retrying 429 / 529 / 503 up to 3 times (Retry-After, else 0.5 → 1 → 2 s plus
 * jitter) while the total stays within the timeout. Any other status is returned as a failure.
 */
export async function call(http: HttpClient, request: HttpRequest, options: CallOptions): Promise<CallResult> {
  const { clock, signal, timeoutMs } = options;
  let spent = 0;
  // The budget runs from the actual send: time spent waiting for a slot is not counted.
  let sentAt = clock.now();
  const sending: CallOptions = { ...options, onSending: () => {
    sentAt = clock.now();
    options.onSending?.();
  } };
  for (let retry = 0; ; retry += 1) {
    const result = await attempt(http, request, sending, Math.max(0, timeoutMs - spent));
    spent += clock.now() - sentAt;
    if (result.kind === 'cancelled') return { ok: false, failure: { kind: 'cancelled', detail: '' } };
    if (result.kind === 'timeout') return { ok: false, failure: { kind: 'timeout', detail: `${Math.round(timeoutMs / 1000)} 秒` } };
    if (result.kind === 'error') return { ok: false, failure: { kind: 'network', detail: '' } };
    const { response } = result;
    if (response.status >= 200 && response.status < 300) return { ok: true, response };
    const failure = statusFailure(response.status);
    if (failure.kind !== 'rate-limited' && failure.kind !== 'overloaded') return { ok: false, failure };
    if (retry >= RETRY_LIMIT) return { ok: false, failure };
    const wait = retryAfterMs(response.headers) ?? BASE_BACKOFF_MS * 2 ** retry + Math.floor(clock.random() * 250);
    if (spent + wait >= timeoutMs) return { ok: false, failure };
    const waitStarted = clock.now();
    if (!(await clock.sleep(wait, signal))) return { ok: false, failure: { kind: 'cancelled', detail: '' } };
    spent += clock.now() - waitStarted;
  }
}

/** Parses a JSON body; `null` when it is not JSON. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
