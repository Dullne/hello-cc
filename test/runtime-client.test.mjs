import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { runtimeRequest } from '../lib/runtime/client.mjs';
import { readRuntime } from '../lib/runtime/state.mjs';
import { makeWebToken, normalizeRequestBody } from '../lib/web/runtime.mjs';

async function stalledRuntime(t, phase) {
  const server = http.createServer((_req, res) => {
    if (phase === 'body') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"ok":');
    }
    setTimeout(() => {
      if (!res.writableEnded) res.end(phase === 'body' ? 'true}' : '{"ok":true}');
    }, 1000);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function expectRuntimeDeadline(t, phase) {
  const baseUrl = await stalledRuntime(t, phase);
  const startedAt = Date.now();
  await assert.rejects(
    runtimeRequest(
      { root: '/tmp/runtime-client-test', dbPath: '/tmp/runtime-client-test/mesh.db' },
      'POST',
      '/api/runtime/gc-buffers?token=query-secret',
      { cutoffMs: 1, dryRun: false, evidence: 'body-secret' },
      { base_url: baseUrl, token: 'test-token' },
      { timeoutMs: 40 }
    ),
    (error) => {
      assert.equal(error?.code, 'RUNTIME_UNREACHABLE');
      assert.equal(error.extra.method, 'POST');
      assert.equal(error.extra.path, '/api/runtime/gc-buffers');
      assert.equal(error.extra.timeoutMs, 40);
      assert.ok(Number.isSafeInteger(error.extra.elapsedMs) && error.extra.elapsedMs >= 0);
      assert.ok(['Error', 'TimeoutError'].includes(error.extra.errorName));
      assert.doesNotMatch(JSON.stringify(error.extra), /query-secret|body-secret|test-token/);
      return true;
    }
  );
  // The stalled runtime completes at 1000ms; a working deadline rejects at
  // ~40ms. The 800ms bound sits between the two, so event-loop starvation
  // during the full-suite run cannot turn a healthy rejection into a
  // failure while a broken deadline (which waits for the server) still
  // exceeds it.
  assert.ok(Date.now() - startedAt < 800, `${phase} deadline was not bounded`);
}

test('runtime request deadline covers waiting for response headers', async (t) => {
  await expectRuntimeDeadline(t, 'headers');
});

test('runtime request deadline covers waiting for the complete response body', async (t) => {
  await expectRuntimeDeadline(t, 'body');
});

test('an aborted default-budget request reports only its method and path without retrying', async () => {
  const controller = new AbortController();
  controller.abort(new Error('caller aborted'));
  await assert.rejects(runtimeRequest(
    { root: '/tmp/runtime-client-test', dbPath: '/tmp/runtime-client-test/mesh.db' },
    'GET', '/api/sessions?token=query-secret#private-fragment', null,
    { base_url: 'http://127.0.0.1:1', token: 'test-token' }, { signal: controller.signal }
  ), (error) => {
    assert.equal(error.code, 'RUNTIME_UNREACHABLE');
    assert.equal(error.extra.method, 'GET');
    assert.equal(error.extra.path, '/api/sessions');
    assert.equal(error.extra.timeoutMs, 8000);
    assert.equal(error.extra.errorName, 'Error');
    assert.doesNotMatch(JSON.stringify(error.extra), /query-secret|private-fragment|test-token/);
    return true;
  });
});

test('request body normalization keeps the http and https transports consistent', () => {
  // Both branches must serialize identically: fetch rejects object bodies while
  // https.request needs a string, so a caller passing an object must not see
  // transport-dependent behavior.
  assert.equal(normalizeRequestBody(null), null);
  assert.equal(normalizeRequestBody(undefined), null);
  assert.equal(normalizeRequestBody('already-a-string'), 'already-a-string');
  assert.equal(normalizeRequestBody({ a: 1 }), '{"a":1}');
  assert.equal(normalizeRequestBody(42), '42');
});

test('runtime request composes an external abort signal with its deadline', async (t) => {
  const baseUrl = await stalledRuntime(t, 'headers');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('caller aborted')), 30);
  t.after(() => clearTimeout(timer));
  const startedAt = Date.now();

  await assert.rejects(
    runtimeRequest(
      { root: '/tmp/runtime-client-test', dbPath: '/tmp/runtime-client-test/mesh.db' },
      'GET',
      '/api/runtime',
      null,
      { base_url: baseUrl, token: 'test-token' },
      { timeoutMs: 1_000, signal: controller.signal }
    ),
    (error) => error?.code === 'RUNTIME_UNREACHABLE'
  );
  assert.ok(Date.now() - startedAt < 200, 'external abort signal was overwritten by the deadline');
});

test('generated web tokens are per-runtime and are not persisted', (t) => {
  const originalHome = process.env.HOME;
  const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-web-token-'));
  t.after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  });
  process.env.HOME = runtimeHome;

  const first = makeWebToken({});
  const second = makeWebToken({});
  assert.notEqual(first, second);
  assert.equal(fs.existsSync(path.join(runtimeHome, '.hello-cc', 'web-token')), false);
  assert.equal(makeWebToken({ token: 'explicit-token' }), 'explicit-token');
  assert.equal(fs.existsSync(path.join(runtimeHome, '.hello-cc', 'web-token')), false);
});

test('remote HTTPS runtime override carries its explicit CA file', (t) => {
  const previous = {
    url: process.env.HCC_RUNTIME_URL,
    token: process.env.HCC_RUNTIME_TOKEN,
    ca: process.env.HCC_RUNTIME_CA
  };
  t.after(() => {
    if (previous.url === undefined) delete process.env.HCC_RUNTIME_URL;
    else process.env.HCC_RUNTIME_URL = previous.url;
    if (previous.token === undefined) delete process.env.HCC_RUNTIME_TOKEN;
    else process.env.HCC_RUNTIME_TOKEN = previous.token;
    if (previous.ca === undefined) delete process.env.HCC_RUNTIME_CA;
    else process.env.HCC_RUNTIME_CA = previous.ca;
  });
  process.env.HCC_RUNTIME_URL = 'https://runtime.example.test:8787';
  process.env.HCC_RUNTIME_TOKEN = 'runtime-token';
  process.env.HCC_RUNTIME_CA = '/private/ca/runtime-ca.pem';

  assert.deepEqual(readRuntime({ root: '/tmp/runtime-ca-test' }), {
    base_url: 'https://runtime.example.test:8787',
    token: 'runtime-token',
    tls_ca_file: '/private/ca/runtime-ca.pem',
    source: 'env'
  });
});
