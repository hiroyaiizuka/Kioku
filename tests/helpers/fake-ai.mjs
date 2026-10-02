// Test doubles for src/ai/: a manual clock and a scripted HttpClient. No real network or timers.

/** Lets pending promise chains run (several macrotask turns). */
export async function drain(turns = 10) {
  for (let turn = 0; turn < turns; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** A Clock whose time only moves with `advance`. */
export function fakeClock() {
  let now = 0;
  const timers = [];
  const clock = {
    now: () => now,
    random: () => 0,
    sleep(ms, signal) {
      return new Promise((resolve) => {
        if (signal.aborted) { resolve(false); return; }
        const timer = { at: now + ms, resolve };
        timers.push(timer);
        signal.addEventListener('abort', () => {
          const index = timers.indexOf(timer);
          if (index >= 0) timers.splice(index, 1);
          resolve(false);
        }, { once: true });
      });
    },
    pending: () => timers.length,
    async advance(ms) {
      const target = now + ms;
      await drain();
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > target) break;
        timers.shift();
        now = next.at;
        next.resolve(true);
        await drain();
      }
      now = target;
      await drain();
    },
  };
  return clock;
}

/**
 * An HttpClient answering from `respond(request, index)`: return `{ status, text?, headers? }`,
 * throw to simulate a network error, or return `'hang'` for a request that never settles until
 * `release(index)` resolves it.
 */
export function fakeHttp(respond) {
  const requests = [];
  const hung = new Map();
  const http = {
    requests,
    async request(request) {
      const index = requests.length;
      requests.push(request);
      const answer = await respond(request, index);
      if (answer === 'hang') {
        return new Promise((resolve, reject) => hung.set(index, { resolve, reject }));
      }
      return { status: answer.status, headers: answer.headers ?? {}, text: answer.text ?? '' };
    },
    /** Settles a hung request (as a network error when `error` is true). */
    release(index, { status = 200, text = '{}', error = false } = {}) {
      const pending = hung.get(index);
      hung.delete(index);
      if (error) pending?.reject(new Error('net::ERR_CONNECTION_RESET'));
      else pending?.resolve({ status, headers: {}, text });
    },
    hungCount: () => hung.size,
  };
  return http;
}

export const json = (value, status = 200, headers = {}) => ({ status, headers, text: JSON.stringify(value) });

/** An OpenAI-compatible chat completion whose message content is `content` (an object is JSON-encoded). */
export const chat = (content) => json({ choices: [{ message: { role: 'assistant',
  content: typeof content === 'string' ? content : JSON.stringify(content) } }] });

/** A Jev systemone response with the four Kioku questions. */
export const jevAnswers = ({ supported = 0.95, answerable = 0.9, oneFact = 0.9, score = 4 } = {}) => json({
  model: 'jev-latest',
  answers: {
    supported: { noul: supported },
    answerable: { noul: answerable },
    one_fact: { noul: oneFact },
    quality: { score, legend: 'x', probabilities: { 1: 0, 2: 0, 3: 0.1, 4: 0.8, 5: 0.1 }, confidence: 0.8 },
  },
  usage: { input_tokens: 900 },
});
