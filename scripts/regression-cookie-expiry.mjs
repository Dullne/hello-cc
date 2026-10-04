import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

const CLOSE_TIMEOUT_MS = 5_000;

// Fixture-only deadlines: cookie validity remains the server's wall-clock
// decision. Clock correction must not make a monotonic sleep prove expiry.
export function createCookieExpiryWindow(ttlMs, {
  monotonicNow = () => performance.now(), wait = sleep,
  setTimer = setTimeout, clearTimer = clearTimeout
} = {}) {
  const startedAt = monotonicNow();
  const deadline = startedAt + ttlMs + CLOSE_TIMEOUT_MS;
  let lastStatus = null;

  function timeout(phase) {
    return Object.assign(new Error(`cookie expiry ${phase} exceeded the original deadline`), {
      code: 'COOKIE_EXPIRY_TIMEOUT',
      extra: { elapsedMs: Math.round(monotonicNow() - startedAt), status: lastStatus }
    });
  }

  async function bounded(operation, until, phase) {
    const remaining = until - monotonicNow();
    if (remaining <= 0) throw timeout(phase);
    const controller = new AbortController();
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimer(() => {
        const error = timeout(phase);
        reject(error);
        controller.abort(error);
      }, remaining);
    });
    try {
      const value = await Promise.race([Promise.resolve().then(() => operation(controller.signal)), expired]);
      if (monotonicNow() >= until) throw timeout(phase);
      return value;
    } finally { clearTimer(timer); }
  }

  return {
    prepare(operation) { return bounded(operation, deadline, 'setup'); },
    async waitForHttpExpiry(probe) {
      // Retain the original quiet TTL wait, but count it against the same
      // overall deadline. Only poll when wall-clock expiry lags behind it.
      await bounded(() => wait(Math.max(0, startedAt + ttlMs - monotonicNow())), deadline, 'initial wait');
      for (;;) {
        const response = await bounded(async signal => {
          const value = await probe(signal);
          lastStatus = value.status;
          if (![200, 401].includes(lastStatus)) {
            throw Object.assign(new Error(`cookie expiry HTTP returned unexpected status ${lastStatus}`), {
              code: 'COOKIE_EXPIRY_HTTP_STATUS', extra: { status: lastStatus }
            });
          }
          await value.body?.cancel();
          return value;
        }, deadline, 'HTTP check');
        if (lastStatus === 401) return response;
        const remaining = deadline - monotonicNow();
        if (remaining <= 0) throw timeout('HTTP check');
        await wait(Math.min(100, remaining));
      }
    },
    waitForClose(closed) {
      return bounded(() => closed, Math.min(deadline, monotonicNow() + CLOSE_TIMEOUT_MS), 'WebSocket close');
    }
  };
}
