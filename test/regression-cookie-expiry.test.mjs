import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createCookieExpiryWindow } from '../scripts/regression-cookie-expiry.mjs';
import { cookieRuntimeFetch } from '../scripts/regression.mjs';

function clock() {
  let elapsed = 0;
  const timers = new Set(), scheduled = [];
  return {
    now: () => elapsed,
    advance(ms) { elapsed += ms; },
    options: {
      monotonicNow: () => elapsed,
      wait: async ms => { elapsed += ms; },
      setTimer: (fn, ms) => { const timer = { fn, ms }; timers.add(timer); scheduled.push(ms); return timer; },
      clearTimer: timer => timers.delete(timer)
    },
    expire() {
      const timer = [...timers].at(-1);
      assert.ok(timer, 'a bounded operation installed a timer');
      elapsed += timer.ms;
      timer.fn();
    },
    timers, scheduled
  };
}

test('cookie expiry observes HTTP 401 after wall time falls behind the original fixed sleep', async () => {
  const c = clock(), window = createCookieExpiryWindow(7000, c.options);
  const probes = [], signals = [];
  const response = await window.waitForHttpExpiry(async signal => {
    signals.push(signal);
    const status = Math.floor(c.now() * 0.99 / 1000) >= 7 ? 401 : 200;
    probes.push({ elapsed: c.now(), status });
    return { status };
  });
  assert.deepEqual(probes, [{ elapsed: 7000, status: 200 }, { elapsed: 7100, status: 401 }]);
  assert.equal(response.status, 401);
  assert.ok(signals.every(signal => signal instanceof AbortSignal));
  assert.equal(c.timers.size, 0);
  assert.equal(c.now(), 7100);
});

test('probe-cookie setup shares the twelve-second window and does not restart the initial wait', async () => {
  const c = clock(), window = createCookieExpiryWindow(7000, c.options);
  let preparationSignal;
  const prepared = await window.prepare(async signal => {
    preparationSignal = signal; c.advance(2000); return { probe: true };
  });
  assert.deepEqual(prepared, { probe: true });
  assert.ok(preparationSignal instanceof AbortSignal);
  await window.waitForHttpExpiry(async () => { assert.equal(c.now(), 7000); return { status: 401 }; });
  assert.equal(c.now(), 7000);
  assert.equal(c.timers.size, 0);
});

test('stalled probe-cookie setup aborts at the same twelve-second deadline', async () => {
  const c = clock(), window = createCookieExpiryWindow(7000, c.options);
  let signal;
  const preparing = window.prepare(current => { signal = current; return new Promise(() => {}); });
  await Promise.resolve();
  const rejected = assert.rejects(preparing, { code: 'COOKIE_EXPIRY_TIMEOUT' });
  c.expire(); await rejected;
  assert.equal(signal.aborted, true); assert.equal(c.now(), 12000); assert.equal(c.timers.size, 0);
});

for (const status of [302, 403, 500]) {
  test(`unexpected HTTP ${status} is an immediate failure`, async () => {
    const c = clock(), window = createCookieExpiryWindow(7000, c.options);
    let probes = 0;
    await assert.rejects(window.waitForHttpExpiry(async () => { probes++; return { status }; }),
      error => error.code === 'COOKIE_EXPIRY_HTTP_STATUS' && error.extra.status === status);
    assert.equal(probes, 1); assert.equal(c.now(), 7000); assert.equal(c.timers.size, 0);
  });
}

test('HTTP and body cancellation failures retain their original errors', async () => {
  for (const bodyFailure of [false, true]) {
    const c = clock(), window = createCookieExpiryWindow(7000, c.options);
    const failure = new Error('fixture network failure');
    await assert.rejects(window.waitForHttpExpiry(async () => {
      if (!bodyFailure) throw failure;
      return { status: 401, body: { cancel: async () => { throw failure; } } };
    }), error => error === failure);
    assert.equal(c.timers.size, 0);
  }
});

test('continuous HTTP 200 fails at exactly the original twelve-second total deadline', async () => {
  const c = clock(), window = createCookieExpiryWindow(7000, c.options);
  await assert.rejects(window.waitForHttpExpiry(async () => ({ status: 200 })),
    error => error.code === 'COOKIE_EXPIRY_TIMEOUT' && error.extra.status === 200);
  assert.equal(c.now(), 12000); assert.equal(c.timers.size, 0);
});

for (const phase of ['fetch', 'body cancellation']) {
  test(`a hung ${phase} is aborted at the original total deadline`, async () => {
    const c = clock(), window = createCookieExpiryWindow(7000, c.options);
    let signal, entered;
    const active = new Promise(resolve => { entered = resolve; });
    const waiting = window.waitForHttpExpiry(async current => {
      signal = current;
      if (phase === 'fetch') { entered(); return new Promise(() => {}); }
      return { status: 401, body: { cancel: () => { entered(); return new Promise(() => {}); } } };
    });
    await active;
    const rejected = assert.rejects(waiting, { code: 'COOKIE_EXPIRY_TIMEOUT' });
    c.expire(); await rejected;
    assert.equal(signal.aborted, true); assert.equal(c.now(), 12000); assert.equal(c.timers.size, 0);
  });
}

for (const elapsedBeforeClose of [7000, 11000]) {
  test(`close wait at ${elapsedBeforeClose}ms stays inside both budgets`, async () => {
    const c = clock(), window = createCookieExpiryWindow(7000, c.options);
    c.advance(elapsedBeforeClose);
    const waiting = window.waitForClose(new Promise(() => {}));
    const rejected = assert.rejects(waiting, { code: 'COOKIE_EXPIRY_TIMEOUT' });
    assert.equal(c.scheduled.at(-1), Math.min(5000, 12000 - elapsedBeforeClose));
    c.expire(); await rejected;
    assert.equal(c.now(), 12000); assert.equal(c.timers.size, 0);
  });
}

test('an early close remains observable after the expiry HTTP response', async () => {
  const c = clock(), window = createCookieExpiryWindow(7000, c.options);
  const closed = Promise.resolve({ code: 4001, reason: 'session expired' });
  await window.waitForHttpExpiry(async () => ({ status: 401 }));
  assert.deepEqual(await window.waitForClose(closed), { code: 4001, reason: 'session expired' });
  assert.equal(c.timers.size, 0);
});

test('cookie HTTP wrapper forwards cancellation to a stalled real request', { timeout: 3000 }, async t => {
  let reached;
  const requested = new Promise(resolve => { reached = resolve; });
  const server = http.createServer(() => reached());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const controller = new AbortController();
  const failure = new Error('fixture cancellation');
  const cookie = `hcc_sid_v2_http_${server.address().port}=fixture-cookie`;
  const request = cookieRuntimeFetch('/api/runtime', { baseUrl, origin: baseUrl, cookie }, { signal: controller.signal });
  const rejected = assert.rejects(request, error => error === failure);
  const watchdog = setTimeout(() => server.closeAllConnections(), 1000);
  try {
    await requested;
    controller.abort(failure);
    await rejected;
  } finally { clearTimeout(watchdog); }
});
