import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { nativeRequest } from '../lib/runtime/native/client.mjs';
import { writeNativePointer } from '../lib/runtime/native/store.mjs';

async function fixture(t, handler) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-native-client-'));
  const ctx = { root: sandbox, dbPath: path.join(sandbox, '.hello-cc', 'mesh.db') };
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    requests.push({ method: request.method, route: request.url, headers: request.headers, raw });
    handler(request, response, raw);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  const token = 'test-local-bearer-'.repeat(4);
  writeNativePointer(ctx, { root: fs.realpathSync(sandbox), meshDb: ctx.dbPath,
    port: server.address().port, token, generation: 'test-client-generation', pid: process.pid });
  return { ctx, server, token, requests };
}

function json(response, value, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

test('native client sends bearer authentication and a correctly sized Unicode JSON body to loopback', async (t) => {
  const f = await fixture(t, (_request, response, raw) => json(response, { ok: true, data: { body: raw ? JSON.parse(raw) : null } }));
  const body = { peer: 'worker', body: '中文🙂' };
  assert.deepEqual(await nativeRequest(f.ctx, 'POST', '/send', body), { body });
  const sent = f.requests[0];
  assert.equal(sent.method, 'POST');
  assert.equal(sent.route, '/send');
  assert.equal(sent.headers.authorization, `Bearer ${f.token}`);
  assert.equal(sent.headers.origin, undefined);
  assert.equal(Number(sent.headers['content-length']), Buffer.byteLength(sent.raw));
  assert.equal(sent.headers['content-type'], 'application/json');
  assert.deepEqual(await nativeRequest(f.ctx, 'GET', '/status'), { body: null });
  assert.equal(f.requests[1].raw, '');
});

test('native client preserves structured HTTP error codes and explicit admission evidence', async (t) => {
  const f = await fixture(t, (_request, response) => json(response, {
    ok: false, error: { code: 'NATIVE_WORKER_NOT_FOUND', message: 'Missing worker', extra: { peer: 'missing' } }
  }, 409));
  await assert.rejects(nativeRequest(f.ctx, 'POST', '/send', { peer: 'missing' }), (error) => {
    assert.equal(error.code, 'NATIVE_WORKER_NOT_FOUND');
    assert.equal(error.message, 'Missing worker');
    assert.deepEqual(error.extra, { peer: 'missing' });
    return true;
  });
});

test('native client rejects an HTTP error even when the response body claims success', async (t) => {
  const f = await fixture(t, (_request, response) => json(response, { ok: true, data: { claimed: 'success' } }, 500));
  await assert.rejects(nativeRequest(f.ctx, 'POST', '/send', { body: 'may have been submitted' }), (error) => {
    assert.ok(error.code);
    assert.equal(error.extra?.uncertain, true);
    return true;
  });
});

test('native client timeout distinguishes uncertain mutation from a read-only request', async (t) => {
  const f = await fixture(t, () => {});
  for (const method of ['GET', 'POST']) {
    await assert.rejects(nativeRequest(f.ctx, method, '/stall', method === 'POST' ? { body: 'task' } : null, { timeoutMs: 25 }), (error) => {
      assert.equal(error.code, 'NATIVE_CLIENT_TIMEOUT');
      assert.equal(error.extra.uncertain, method === 'POST');
      return true;
    });
  }
});

test('native client enforces a total deadline while a peer keeps streaming bytes', async (t) => {
  const f = await fixture(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"ok":true,"data":');
    const interval = setInterval(() => response.write(' '), 5);
    const finish = setTimeout(() => response.end('null}'), 200);
    response.once('close', () => { clearInterval(interval); clearTimeout(finish); });
  });
  await assert.rejects(nativeRequest(f.ctx, 'POST', '/slow-stream', { body: 'task' }, { timeoutMs: 45 }), (error) => {
    assert.equal(error.code, 'NATIVE_CLIENT_TIMEOUT');
    assert.equal(error.extra.uncertain, true);
    return true;
  });
});

for (const [name, reply] of [
  ['invalid JSON', (response) => response.end('{"ok":')],
  ['null envelope', (response) => response.end('null')],
  ['missing envelope status', (response) => json(response, { data: {} })],
  ['truncated response', (response) => { response.write('{"ok":'); setImmediate(() => response.socket?.destroy()); }],
  ['oversized response', (response) => response.end(JSON.stringify({ ok: true, data: 'x'.repeat(8 * 1024 * 1024 + 1) }))]
]) {
  test(`native client treats ${name} after a mutation as uncertain`, async (t) => {
    const f = await fixture(t, (_request, response) => reply(response));
    await assert.rejects(nativeRequest(f.ctx, 'POST', '/send', { body: 'task' }), (error) => {
      assert.equal(error.extra?.uncertain, true);
      return true;
    });
  });
}

test('native client unreachable runtime keeps mutation uncertainty and reports a missing runtime', async (t) => {
  const f = await fixture(t, () => {});
  await new Promise((resolve) => f.server.close(resolve));
  for (const method of ['GET', 'POST']) {
    await assert.rejects(nativeRequest(f.ctx, method, '/status', method === 'POST' ? {} : null), (error) => {
      assert.equal(error.code, 'NATIVE_RUNTIME_OFFLINE');
      assert.equal(error.extra.uncertain, method === 'POST');
      return true;
    });
  }
  const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-native-offline-'));
  t.after(() => fs.rmSync(missingRoot, { recursive: true, force: true }));
  await assert.rejects(nativeRequest({ root: missingRoot, dbPath: path.join(missingRoot, 'mesh.db') }, 'GET', '/status'),
    { code: 'NATIVE_RUNTIME_OFFLINE' });
});
