import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runtimeRequest } from '../lib/runtime/client.mjs';

async function stalledRuntime(t, phase) {
  const server = http.createServer((_req, res) => {
    if (phase === 'body') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"ok":');
    }
    setTimeout(() => {
      if (!res.writableEnded) res.end(phase === 'body' ? 'true}' : '{"ok":true}');
    }, 250);
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
      '/api/runtime/gc-buffers',
      { cutoffMs: 1, dryRun: false },
      { base_url: baseUrl, token: 'test-token' },
      { timeoutMs: 40 }
    ),
    (error) => error?.code === 'RUNTIME_UNREACHABLE'
  );
  assert.ok(Date.now() - startedAt < 200, `${phase} deadline was not bounded`);
}

test('runtime request deadline covers waiting for response headers', async (t) => {
  await expectRuntimeDeadline(t, 'headers');
});

test('runtime request deadline covers waiting for the complete response body', async (t) => {
  await expectRuntimeDeadline(t, 'body');
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
