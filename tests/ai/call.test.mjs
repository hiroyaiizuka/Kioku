import { describe, expect, it } from 'vitest';
import { SlotGate, call, statusFailure } from '../../src/ai/call.ts';
import { drain, fakeClock, fakeHttp, json } from '../helpers/fake-ai.mjs';

const REQUEST = { url: 'http://localhost:11434/v1/chat/completions', method: 'POST', body: '{}' };
const options = (clock, gate, signal = new AbortController().signal, extra = {}) =>
  ({ gate, clock, signal, timeoutMs: 20000, ...extra });

describe('status mapping', () => {
  it('maps HTTP statuses to failure kinds with the status only as detail', () => {
    expect([401, 403, 402, 429, 529, 503, 400, 404, 422, 500, 302].map((status) => statusFailure(status).kind))
      .toEqual(['auth', 'auth', 'quota', 'rate-limited', 'overloaded', 'overloaded', 'invalid-request', 'invalid-request',
        'invalid-request', 'server', 'invalid-response']);
    expect(statusFailure(401)).toEqual({ kind: 'auth', detail: 'HTTP 401' });
  });
});

describe('call', () => {
  it('returns 2xx responses and does not retry 401 / 422', async () => {
    for (const status of [401, 422]) {
      const http = fakeHttp(() => json({ error: 'x' }, status));
      const result = await call(http, REQUEST, options(fakeClock(), new SlotGate(4)));
      expect(result.ok).toBe(false); expect(http.requests).toHaveLength(1);
    }
    const ok = await call(fakeHttp(() => json({ fine: true })), REQUEST, options(fakeClock(), new SlotGate(4)));
    expect(ok).toMatchObject({ ok: true, response: { status: 200 } });
  });

  it('maps a rejected request to a network failure without its message', async () => {
    const http = fakeHttp(() => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434 secret-in-message'); });
    const result = await call(http, REQUEST, options(fakeClock(), new SlotGate(4)));
    expect(result).toEqual({ ok: false, failure: { kind: 'network', detail: '' } });
  });

  it('backs off on 429 / 529 (Retry-After, else 0.5 → 1 → 2 s) at most 3 times', async () => {
    const clock = fakeClock();
    const http = fakeHttp((_request, index) => (index === 0 ? json({}, 429, { 'Retry-After': '3' }) : json({}, 529)));
    const pending = call(http, REQUEST, options(clock, new SlotGate(4)));
    await clock.advance(2999); expect(http.requests).toHaveLength(1);
    await clock.advance(1); expect(http.requests).toHaveLength(2);
    await clock.advance(1000); expect(http.requests).toHaveLength(3);
    await clock.advance(2000); expect(http.requests).toHaveLength(4);
    expect(await pending).toEqual({ ok: false, failure: { kind: 'overloaded', detail: 'HTTP 529' } });
  });

  it('stops retrying when the backoff would exceed the timeout', async () => {
    const clock = fakeClock();
    const http = fakeHttp(() => json({}, 429, { 'retry-after': '30' }));
    const result = await call(http, REQUEST, options(clock, new SlotGate(4)));
    expect(http.requests).toHaveLength(1);
    expect(result).toEqual({ ok: false, failure: { kind: 'rate-limited', detail: 'HTTP 429' } });
  });

  it('times out by no longer waiting, but keeps the slot until the hung request settles', async () => {
    const clock = fakeClock();
    const gate = new SlotGate(1);
    const http = fakeHttp(() => 'hang');
    const first = call(http, REQUEST, options(clock, gate, undefined, { timeoutMs: 60000 }));
    await clock.advance(60000);
    expect(await first).toEqual({ ok: false, failure: { kind: 'timeout', detail: '60 秒' } });
    expect(gate.inFlight).toBe(1);
    // A new call waits (never sends) while the abandoned request still holds the only slot.
    const waits = [];
    const second = call(http, REQUEST, options(clock, gate, undefined,
      { onWaiting: () => waits.push('wait'), onSending: () => waits.push('send') }));
    await drain();
    expect(waits).toEqual(['wait']); expect(http.requests).toHaveLength(1);
    // The slot is freed long after: the new request then gets its full 20 s from the actual send.
    await clock.advance(400000);
    http.release(0, { error: true });
    await drain();
    expect(waits).toEqual(['wait', 'send']);
    expect(http.requests).toHaveLength(2);
    await clock.advance(19999);
    expect(clock.pending()).toBe(1);
    http.release(1, { status: 200 });
    expect((await second).ok).toBe(true);
    expect(gate.inFlight).toBe(0);
  });

  it('cancels while waiting for a slot and while a request is in flight; results arriving later are dropped', async () => {
    const clock = fakeClock();
    const gate = new SlotGate(1);
    const http = fakeHttp(() => 'hang');
    const controller = new AbortController();
    const inFlight = call(http, REQUEST, options(clock, gate, controller.signal));
    const waiting = call(http, REQUEST, options(clock, gate, controller.signal));
    await drain();
    controller.abort();
    expect(await inFlight).toEqual({ ok: false, failure: { kind: 'cancelled', detail: '' } });
    expect(await waiting).toEqual({ ok: false, failure: { kind: 'cancelled', detail: '' } });
    expect(http.requests).toHaveLength(1);
    expect(gate.inFlight).toBe(1);
    http.release(0, { status: 200 });
    await drain();
    expect(gate.inFlight).toBe(0);
    expect(clock.pending()).toBe(0);
  });
});
