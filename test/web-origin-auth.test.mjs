import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createCookieAuth, createCookieNameForRequest } from '../lib/web/cookie-auth.mjs';
import { createHttpRoutes } from '../lib/web/http-routes.mjs';
import { authOk, requestIsSecure } from '../lib/web/http.mjs';

async function runtime(t, { token = '', proxy = false } = {}) {
  const proxyOptions = proxy ? { trustProxy: true, proxyOrigin: 'https://workbench.example.test' } : {};
  const cookieNameForRequest = createCookieNameForRequest(proxyOptions);
  const auth = createCookieAuth({ token, ...proxyOptions, cookieNameForRequest,
    now: () => Date.now() / 1000, ttlSec: 60, maxSessions: 100, authOk, requestIsSecure });
  let projectLookups = 0;
  const routes = createHttpRoutes({ ...auth, token, ...proxyOptions,
    projectFromRequest() { projectLookups++; assert.fail('origin checks and logout must precede project access'); },
    webErrorStatus: () => 500 });
  const server = http.createServer(routes.handleWebRequest);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const origin = proxy ? proxyOptions.proxyOrigin : base;
  async function send({ method = 'POST', credential = 'none', origin: suppliedOrigin, invalid = false } = {}) {
    const headers = proxy ? { 'x-forwarded-host': 'workbench.example.test', 'x-forwarded-proto': 'https' } : {};
    let route = method === 'POST' ? '/logout' : '/missing';
    if (credential.includes('bearer')) headers.authorization = `Bearer ${invalid ? 'incorrect-token' : token}`;
    if (credential === 'query') route += '?token=' + encodeURIComponent(token);
    let sid;
    if (credential.includes('cookie')) {
      sid = auth.issueSession();
      headers.cookie = `${cookieNameForRequest({ socket: { localPort: port } })}=${sid}`;
    }
    if (suppliedOrigin !== undefined) headers.origin = suppliedOrigin;
    const result = await fetch(base + route, { method, headers });
    const body = await result.text();
    return { status: result.status, body: body ? JSON.parse(body) : null,
      cookieRetained: sid ? auth.webSessions.has(sid) : null };
  }
  return { origin, send, projectLookups: () => projectLookups };
}

for (const proxy of [false, true]) {
  test(`write origin checks cover tokenless, bearer, query and cookie authentication${proxy ? ' behind a pinned proxy' : ''}`, async t => {
    const local = await runtime(t, { proxy });
    const secured = await runtime(t, { token: 'origin-fixture-token', proxy });
    for (const [f, credential] of [[local, 'none'], [secured, 'bearer'],
      [secured, 'cookie'], [secured, 'bearer-cookie']]) {
      for (const origin of ['https://attacker.example.test', 'null', 'malformed-origin']) {
        const denied = await f.send({ credential, origin });
        assert.equal(denied.status, 403, `${credential}: ${origin}`);
        assert.equal(denied.body.error.code, 'CSRF_ORIGIN');
        if (credential.includes('cookie')) assert.equal(denied.cookieRetained, true);
      }
      const missing = await f.send({ credential });
      assert.equal(missing.status, credential.includes('cookie') ? 403 : 204, credential);
      if (credential.includes('cookie')) assert.equal(missing.cookieRetained, true);
      const same = await f.send({ credential, origin: f.origin });
      assert.equal(same.status, 204, credential);
      if (credential.includes('cookie')) assert.equal(same.cookieRetained, false);
      for (const method of ['GET', 'HEAD', 'OPTIONS']) {
        assert.equal((await f.send({ credential, method, origin: 'https://attacker.example.test' })).status, 404);
      }
    }
    assert.equal((await secured.send({ credential: 'bearer', invalid: true,
      origin: 'https://attacker.example.test' })).status, 401, 'invalid authentication is rejected before write dispatch');
    for (const origin of [undefined, secured.origin, 'https://attacker.example.test']) {
      assert.equal((await secured.send({ credential: 'query', origin })).status, 401,
        'a query token cannot authenticate API or logout requests');
    }
    assert.equal(local.projectLookups(), 0);
    assert.equal(secured.projectLookups(), 0);
  });
}
