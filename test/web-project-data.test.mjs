import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadBroker, createProjectRequests, fetchJson, sharedProjectBroker, scheduleVisiblePoll } from '../lib/web/browser/project-data.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
function deferredFetch({ honorAbort = true } = {}) {
  const calls = [];
  const fetcher = (url, options) => new Promise((resolve, reject) => {
    const call = { url, options, resolve, reject };
    calls.push(call);
    if (honorAbort) {
      const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    }
  });
  return { calls, fetcher };
}

test('read broker shares requests while cancellation and returned data stay consumer-local', async () => {
  const { calls, fetcher } = deferredFetch();
  const broker = createReadBroker({ fetchJson: fetcher });
  const first = new AbortController(), second = new AbortController();
  const a = broker.read('/api/state?root=A', { signal: first.signal });
  const cancelled = assert.rejects(a, { name: 'AbortError' });
  const b = broker.read('/api/state?root=A', { signal: second.signal });
  const c = broker.read('/api/state?root=A');
  await flush();
  assert.equal(calls.length, 1);
  first.abort();
  await cancelled;
  assert.equal(calls[0].options.signal.aborted, false);
  calls[0].resolve({ peers: [{ name: 'one' }] });
  const [value, sibling] = await Promise.all([b, c]);
  value.peers[0].name = 'changed';
  assert.equal(sibling.peers[0].name, 'one');
  assert.equal((await broker.read('/api/state?root=A')).peers[0].name, 'one');
});

test('last consumer cancellation aborts the underlying request and permits a fresh visit', async () => {
  const { calls, fetcher } = deferredFetch();
  const broker = createReadBroker({ fetchJson: fetcher });
  const controller = new AbortController();
  const cancelled = assert.rejects(broker.read('/api/state?root=A', { signal: controller.signal }), { name: 'AbortError' });
  await flush();
  controller.abort();
  await cancelled;
  assert.equal(calls[0].options.signal.aborted, true);
  const next = broker.read('/api/state?root=A');
  await flush();
  assert.equal(calls.length, 2);
  calls[1].resolve({ fresh: true });
  assert.deepEqual(await next, { fresh: true });
});

test('cache TTL, pending capacity, failure eviction and invalidation bound actual work', async () => {
  let clock = 0;
  const { calls, fetcher } = deferredFetch({ honorAbort: false });
  const broker = createReadBroker({ fetchJson: fetcher, now: () => clock, ttlMs: 10, maxEntries: 1 });
  const first = broker.read('/api/state?root=A');
  const cancelled = assert.rejects(first, { name: 'AbortError' });
  await flush();
  await assert.rejects(broker.read('/api/state?root=B'), { code: 'READ_BROKER_BUSY' });
  broker.invalidate();
  await cancelled;
  // An implementation that ignores AbortSignal must still occupy a slot.
  await assert.rejects(broker.read('/api/state?root=B'), { code: 'READ_BROKER_BUSY' });
  calls[0].resolve({ obsolete: true });
  await flush();
  const fresh = broker.read('/api/state?root=A');
  await flush(); calls[1].resolve({ value: 2 }); await fresh;
  clock = 9;
  assert.deepEqual(await broker.read('/api/state?root=A'), { value: 2 });
  assert.equal(calls.length, 2);
  clock = 10;
  const expired = broker.read('/api/state?root=A');
  const failed = assert.rejects(expired, /offline/);
  await flush(); calls[2].reject(new Error('offline')); await failed;
  const retry = broker.read('/api/state?root=A');
  await flush(); calls[3].resolve({ value: 3 }); await retry;
  assert.equal(calls.length, 4);
});

test('root, URL and peer headers isolate reads including Headers objects and mutable inputs', async () => {
  const { calls, fetcher } = deferredFetch();
  const broker = createReadBroker({ fetchJson: fetcher });
  const headers = { 'X-HCC-Peer': 'p1' };
  const promises = [broker.read('/api/state?root=A', { headers })];
  headers['X-HCC-Peer'] = 'p2';
  promises.push(broker.read('/api/state?root=A', { headers: new Headers({ 'x-hcc-peer': 'p1' }) }));
  promises.push(broker.read('/api/state?root=A', { headers }));
  promises.push(broker.read('/api/state?root=B', { headers }));
  promises.push(broker.read('/api/sessions?root=A', { headers }));
  await flush();
  assert.equal(calls.length, 4);
  assert.equal(calls[0].options.headers['x-hcc-peer'], 'p1');
  calls.forEach((call, index) => call.resolve({ index }));
  assert.deepEqual((await Promise.all(promises)).map(value => value.index), [0, 0, 1, 2, 3]);
  assert.throws(() => broker.read('/api/session/start'), /Only project read/);
});

test('invalidation rejects both pending reads and cached reads not yet delivered', async () => {
  const { calls, fetcher } = deferredFetch();
  const broker = createReadBroker({ fetchJson: fetcher });
  const first = broker.read('/api/state');
  await flush(); calls[0].resolve({ version: 1 }); await first;
  const cached = assert.rejects(broker.read('/api/state'), { name: 'AbortError' });
  const pending = assert.rejects(broker.read('/api/sessions'), { name: 'AbortError' });
  broker.invalidate();
  await Promise.all([cached, pending]);
  await flush();
});

test('project visit generation rejects A to B to A late replies without cancelling sibling pane', async () => {
  const { calls, fetcher } = deferredFetch({ honorAbort: false });
  const broker = createReadBroker({ fetchJson: fetcher });
  const left = createProjectRequests({ broker, fetcher, root: 'A' });
  const right = createProjectRequests({ broker, fetcher, root: 'A' });
  const old = assert.rejects(left.request('/api/state'), { name: 'AbortError' });
  const sibling = right.request('/api/state');
  await flush();
  left.setRoot('B');
  const b = assert.rejects(left.request('/api/state'), { name: 'AbortError' });
  await flush();
  left.setRoot('A');
  const returned = left.request('/api/state');
  calls[0].resolve({ root: 'A', version: 1 });
  calls[1].resolve({ root: 'B', version: 1 });
  await Promise.all([old, b]);
  assert.deepEqual(await sibling, { root: 'A', version: 1 });
  assert.deepEqual(await returned, { root: 'A', version: 1 });
  assert.equal(calls.length, 2);
  // Nonshared read results obey the same visit boundary even if fetch ignores abort.
  const detail = assert.rejects(left.request('/api/session/detail'), { name: 'AbortError' });
  left.setRoot('B');
  calls[2].resolve({ obsolete: true });
  await detail;
  left.dispose(); right.dispose();
});

test('writes invalidate both panes before and after completion and are never shared or retried', async () => {
  const reads = deferredFetch(), writes = deferredFetch();
  const broker = createReadBroker({ fetchJson: reads.fetcher });
  const left = createProjectRequests({ broker, fetcher: writes.fetcher, root: 'A', headers: { 'x-peer': 'left' } });
  const right = createProjectRequests({ broker, fetcher: writes.fetcher, root: 'A', headers: { 'x-peer': 'right' } });
  const before = assert.rejects(right.request('/api/state'), { name: 'AbortError' });
  await flush();
  const write = left.request('/api/session/input', { method: 'POST', body: '{"input":"hello"}' });
  await before;
  assert.equal(writes.calls.length, 1);
  assert.equal(writes.calls[0].url, '/api/session/input?root=A');
  assert.equal(writes.calls[0].options.headers['x-peer'], 'left');
  const during = assert.rejects(right.request('/api/state'), { name: 'AbortError' });
  await flush();
  writes.calls[0].resolve({ sent: true });
  assert.deepEqual(await write, { sent: true });
  await during;
  const after = right.request('/api/state');
  await flush(); reads.calls.at(-1).resolve({ version: 2 });
  assert.deepEqual(await after, { version: 2 });
  assert.equal(writes.calls.length, 1);
  left.dispose(); right.dispose();
});

test('fetchJson distinguishes timeout, user cancellation and structured HTTP errors', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { calls, fetcher } = deferredFetch();
  const timeout = assert.rejects(fetchJson('/api/state', {}, { fetchImpl: fetcher, timeoutMs: 50 }), { code: 'REQUEST_TIMEOUT' });
  t.mock.timers.tick(50);
  await timeout;
  assert.equal(calls[0].options.signal.aborted, true);
  const controller = new AbortController();
  const cancelled = assert.rejects(fetchJson('/api/state', { signal: controller.signal }, { fetchImpl: fetcher }), { name: 'AbortError' });
  controller.abort(); await cancelled;
  await assert.rejects(fetchJson('/api/state', {}, { fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ error: { code: 'CONFLICT', message: 'Changed' } }) }) }), { code: 'CONFLICT', status: 409, message: 'Changed' });
  const length = calls.length;
  await assert.rejects(fetchJson('/api/state', { signal: controller.signal }, { fetchImpl: fetcher }), { name: 'AbortError' });
  assert.equal(calls.length, length);
});

test('same-origin panes reuse their parent broker and cross-origin access stays isolated', () => {
  const parent = { location: { origin: 'http://local' } }; parent.parent = parent;
  const broker = sharedProjectBroker(parent);
  assert.equal(sharedProjectBroker(parent), broker);
  assert.equal(sharedProjectBroker({ parent, location: { origin: 'http://local' } }), broker);
  const other = { parent, location: { origin: 'http://other' } };
  assert.notEqual(sharedProjectBroker(other), broker);
  const restricted = { location: { origin: 'http://local' } };
  Object.defineProperty(restricted, 'parent', { get() { throw new Error('Cross-origin frame'); } });
  assert.notEqual(sharedProjectBroker(restricted), broker);
});

test('visibility polling avoids overlap, slows hidden pages and resumes on online events', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const doc = Object.assign(new EventTarget(), { hidden: false });
  const surface = Object.assign(new EventTarget(), { navigator: { onLine: true } });
  let runs = 0, finish;
  const stop = scheduleVisiblePoll(() => { runs++; return new Promise(resolve => { finish = resolve; }); }, { intervalMs: 10, hiddenMs: 100, document: doc, surface });
  t.mock.timers.tick(10); assert.equal(runs, 1);
  surface.dispatchEvent(new Event('online'));
  t.mock.timers.tick(100); assert.equal(runs, 1);
  doc.hidden = true; finish(); await flush();
  t.mock.timers.tick(99); assert.equal(runs, 1);
  t.mock.timers.tick(1); assert.equal(runs, 2);
  finish(); await flush();
  doc.hidden = false; surface.navigator.onLine = false;
  doc.dispatchEvent(new Event('visibilitychange')); await flush();
  assert.equal(runs, 2);
  surface.navigator.onLine = true; surface.dispatchEvent(new Event('online'));
  assert.equal(runs, 3);
  stop(); finish(); await flush(); t.mock.timers.tick(1000);
  surface.dispatchEvent(new Event('online')); assert.equal(runs, 3);
});
