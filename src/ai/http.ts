// The runtime HttpClient and Clock. Only this file in src/ai/ touches Obsidian or browser timers;
// everything else receives them as arguments so unit tests use fakes (docs/m3-design.md §12).
import { requestUrl } from 'obsidian';
import type { Clock, HttpClient } from './types';

/**
 * `requestUrl` reaches http://localhost without CORS. It has no abort and no timeout
 * (docs/m3-design.md §3.6); `throw: false` returns every HTTP status so callers can map it.
 */
export const obsidianHttpClient: HttpClient = {
  async request(request) {
    const response = await requestUrl({ url: request.url, method: request.method, headers: { ...request.headers },
      body: request.body, contentType: request.body === undefined ? undefined : 'application/json', throw: false });
    let text = '';
    try {
      text = response.text;
    } catch {
      text = '';
    }
    return { status: response.status, headers: response.headers ?? {}, text };
  },
};

export const browserClock: Clock = {
  now: () => Date.now(),
  random: () => Math.random(),
  sleep: (ms, signal) => new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const onAbort = (): void => {
      window.clearTimeout(timer);
      resolve(false);
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  }),
};
