import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { withFixtureHttpDiagnostic, fixtureFailureDiagnostic, runtimeFetch } from '../scripts/regression.mjs';

test('runtimeFetch captures safe source coordinates even if request construction fails', async () => {
  // An imported regression module has no fixture runtime.json. This exercises
  // the real wrapper call site without starting a runtime or sending a request.
  await assert.rejects(runtimeFetch('/api/projects'), error => {
    assert.equal(error.code, 'ENOENT');
    const saved = fixtureFailureDiagnostic(error).http;
    assert.equal(saved.method, 'GET');
    assert.equal(saved.route, '/api/projects');
    assert.equal(saved.code, null);
    assert.ok(saved.callFrames.length >= 1);
    for (const frame of saved.callFrames) {
      assert.deepEqual(Object.keys(frame), ['file', 'line', 'column']);
      assert.equal(frame.file, 'scripts/regression.mjs');
      assert.ok(Number.isSafeInteger(frame.line) && frame.line > 0);
      assert.ok(Number.isSafeInteger(frame.column) && frame.column > 0);
      assert.ok(Object.isFrozen(frame));
    }
    return true;
  });
});

test('HTTP diagnostic preserves the original error and stores only frozen allowlisted context', async () => {
  const error = new TypeError('PRIVATE_MESSAGE', { cause: { code: 'ECONNRESET', body: 'PRIVATE_CAUSE' } });
  for (const key of ['stack', 'message', 'url', 'body']) {
    Object.defineProperty(error, key, { get() { throw new Error(`must not read ${key}`); } });
  }
  let calls = 0;
  await assert.rejects(withFixtureHttpDiagnostic(
    '/api/peers/PRIVATE_PEER/actions/state?token=PRIVATE_TOKEN#PRIVATE_FRAGMENT',
    { method: 'POST', headers: { Authorization: 'PRIVATE_AUTH' }, body: 'PRIVATE_BODY' },
    () => { calls += 1; throw error; }
  ), observed => observed === error);
  assert.equal(calls, 1);
  const saved = fixtureFailureDiagnostic(error).http;
  assert.equal(saved.method, 'POST');
  assert.equal(saved.route, '/api/peers/:peer/actions/state');
  assert.equal(saved.code, 'ECONNRESET');
  assert.ok(Number.isSafeInteger(saved.elapsedMs) && saved.elapsedMs >= 0);
  assert.deepEqual(saved.callFrames, []);
  assert.ok(Object.isFrozen(saved));
  assert.ok(Object.isFrozen(saved.callFrames));
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_|token|Authorization|body|message/);
  assert.throws(() => { saved.route = 'PRIVATE_CHANGED'; }, TypeError);
  error.http = { route: 'PRIVATE_FORGED' };
  assert.equal(fixtureFailureDiagnostic(error).http, saved);
});

test('unknown routes and codes are omitted and arbitrary error getters are not evaluated', async () => {
  const error = new TypeError('PRIVATE_ERROR');
  for (const key of ['code', 'cause']) {
    Object.defineProperty(error, key, { get() { throw new Error(`must not read ${key}`); } });
  }
  await assert.rejects(withFixtureHttpDiagnostic('https://PRIVATE_HOST/api/projects',
    { method: 'PRIVATE_METHOD' }, () => Promise.reject(error)), observed => observed === error);
  const saved = fixtureFailureDiagnostic(error).http;
  assert.equal(saved.method, null);
  assert.equal(saved.route, null);
  assert.equal(saved.code, null);
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_/);
  const forged = new TypeError('PRIVATE_UNREGISTERED');
  forged.http = { code: 'ECONNRESET', route: '/api/projects' };
  assert.equal(fixtureFailureDiagnostic(forged).http, undefined);
  assert.match(fixtureFailureDiagnostic(forged).stack[0], /fixtureFailureDiagnostic/);
});

test('successful HTTP diagnostic returns the same Response and leaves body consumption unchanged', async () => {
  const response = new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
  let calls = 0;
  const observed = await withFixtureHttpDiagnostic('/api/projects', {}, async () => { calls += 1; return response; });
  assert.equal(observed, response);
  assert.equal(calls, 1);
  assert.equal(response.bodyUsed, false);
  assert.deepEqual(await response.json(), { ok: true });
  await assert.rejects(response.json(), error => {
    assert.ok(error instanceof TypeError);
    assert.equal(fixtureFailureDiagnostic(error).http, undefined);
    return true;
  });
});

async function localServer(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('real loopback fetch failure sends exactly one POST and rethrows the identical native error', async (t) => {
  let received = 0, invoked = 0, nativeError;
  const base = await localServer(t, request => { received += 1; request.socket.destroy(); });
  await assert.rejects(withFixtureHttpDiagnostic('/api/projects', { method: 'POST' }, async () => {
    invoked += 1;
    try {
      return await fetch(`${base}/PRIVATE_PATH?token=PRIVATE_TOKEN`, { method: 'POST', body: 'PRIVATE_BODY' });
    } catch (error) { nativeError = error; throw error; }
  }), error => error === nativeError && error instanceof TypeError);
  assert.equal(invoked, 1);
  assert.equal(received, 1);
  const saved = fixtureFailureDiagnostic(nativeError).http;
  assert.equal(saved.method, 'POST');
  assert.equal(saved.route, '/api/projects');
  assert.ok(['UND_ERR_SOCKET', 'ECONNRESET'].includes(saved.code));
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_|127\.0\.0\.1/);
});

test('response-body network failure is explicitly outside the initial-fetch diagnostic boundary', async (t) => {
  let received = 0, fixtureSocket;
  const base = await localServer(t, (request, response) => {
    received += 1;
    fixtureSocket = request.socket;
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
    response.write('{"ok":');
  });
  const response = await withFixtureHttpDiagnostic('/api/projects', {}, () => fetch(base));
  assert.equal(response.status, 200);
  const body = response.json();
  fixtureSocket.destroy();
  await assert.rejects(body, error => {
    assert.ok(error instanceof TypeError);
    assert.equal(fixtureFailureDiagnostic(error).http, undefined);
    return true;
  });
  assert.equal(received, 1);
});
