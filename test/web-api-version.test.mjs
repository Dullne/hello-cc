import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import {
  API_VERSION,
  apiVersionUnsupportedBody,
  readHttpApiVersion,
  readWebSocketApiVersion,
  withRuntimeApiVersionHeader
} from '../lib/web/api-version.mjs';
import { runtimeRequest } from '../lib/runtime/client.mjs';
import {
  probeRuntime,
  readHealthyGlobalRuntime,
  writeGlobalRuntime
} from '../lib/runtime/state.mjs';
import { webIndexHtml } from '../lib/web/ui-template.mjs';

test('reads Runtime API v2 from the HTTP header', () => {
  assert.equal(API_VERSION, 2);
  assert.deepEqual(
    readHttpApiVersion({ headers: { 'x-hcc-api-version': '2' } }),
    { ok: true, version: 2 }
  );
});

test('rejects missing, old, and malformed protected HTTP API versions', () => {
  assert.deepEqual(readHttpApiVersion({ headers: {} }), { ok: false, version: null });
  assert.deepEqual(
    readHttpApiVersion({ headers: { 'x-hcc-api-version': '1' } }),
    { ok: false, version: 1 }
  );
  assert.deepEqual(
    readHttpApiVersion({ headers: { 'x-hcc-api-version': '2junk' } }),
    { ok: false, version: null }
  );
});

test('reads Runtime API v2 from the browser WebSocket query', () => {
  assert.deepEqual(
    readWebSocketApiVersion(new URL('http://localhost/ws?api_version=2')),
    { ok: true, version: 2 }
  );
});

test('rejects missing and old WebSocket API versions', () => {
  assert.deepEqual(
    readWebSocketApiVersion(new URL('http://localhost/ws')),
    { ok: false, version: null }
  );
  assert.deepEqual(
    readWebSocketApiVersion(new URL('http://localhost/ws?api_version=1')),
    { ok: false, version: 1 }
  );
});

test('uses the standard Runtime API version rejection body', () => {
  assert.deepEqual(apiVersionUnsupportedBody(), {
    ok: false,
    error: {
      code: 'API_VERSION_UNSUPPORTED',
      message: 'Runtime API version 2 is required',
      supported_version: 2
    }
  });
});

test('forces one Runtime API v2 header regardless of caller casing', () => {
  assert.deepEqual(
    withRuntimeApiVersionHeader({
      Accept: 'application/json',
      'x-hcc-api-version': '1'
    }),
    {
      Accept: 'application/json',
      'X-HCC-API-Version': '2'
    }
  );
});

test('browser API and terminal WebSocket clients advertise Runtime API v2', () => {
  const html = webIndexHtml();
  assert.match(html, /'X-HCC-API-Version': String\(runtimeApiVersion\)/);
  assert.match(html, /requestQuery\(\{ api_version: runtimeApiVersion \}\)/);
});

test('runtime requests send v2 and probes reject legacy runtime metadata', async (t) => {
  const observed = [];
  let runtimeMetadata = { ok: true };
  const server = http.createServer((req, res) => {
    observed.push(req.headers['x-hcc-api-version']);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(runtimeMetadata));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const runtime = { base_url: `http://127.0.0.1:${server.address().port}` };

  await runtimeRequest(
    { root: '/tmp/api-v2-root', dbPath: '/tmp/api-v2-root/.hello-cc/mesh.db' },
    'GET',
    '/api/runtime',
    null,
    runtime
  );
  assert.equal(await probeRuntime(runtime), false);

  const previousHome = process.env.HOME;
  const runtimeHome = fs.mkdtempSync(`${os.tmpdir()}/hcc-api-v2-home-`);
  process.env.HOME = runtimeHome;
  try {
    writeGlobalRuntime({ ...runtime, pid: process.pid });
    assert.equal(await readHealthyGlobalRuntime(), null);

    runtimeMetadata = { api_version: API_VERSION };
    assert.equal((await readHealthyGlobalRuntime())?.base_url, runtime.base_url);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }

  runtimeMetadata = { api_version: API_VERSION };
  assert.equal(await probeRuntime(runtime), true);

  assert.deepEqual(observed, ['2', '2', '2', '2', '2']);
});
