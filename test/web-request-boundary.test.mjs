import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { authOk, requestOriginMatches, tokenlessRequestAllowed } from '../lib/web/http.mjs';
import { createHttpRoutes } from '../lib/web/http-routes.mjs';
import { localRuntimeUrl, publicRuntimeUrl, requestUrl, runtimeBaseUrl } from '../lib/web/runtime.mjs';

function request(host, origin = '', remoteAddress = '127.0.0.1') {
  return {
    method: 'GET',
    url: '/',
    headers: { host, ...(origin ? { origin } : {}) },
    socket: { remoteAddress, encrypted: false }
  };
}

function response() {
  return {
    status: null,
    body: '',
    writeHead(status) { this.status = status; },
    end(body = '') { this.body = String(body); }
  };
}

test('malformed Host and request targets fail within the HTTP request', async () => {
  const { handleWebRequest } = createHttpRoutes({
    token: 'runtime-token',
    webAuthMode: () => 'token',
    cookieSessionOk: () => false,
    projectFromRequest: () => ({}),
    webErrorStatus: (error) => error.code === 'BAD_REQUEST' ? 400 : 500
  });
  for (const [host, target] of [
    ['[', '/'],
    ['user@localhost', '/'],
    ['localhost:8787/path', '/'],
    ['localhost:8787', '//elsewhere.test/'],
    ['localhost:8787', 'http://elsewhere.test/']
  ]) {
    const req = request(host);
    req.url = target;
    const res = response();
    await handleWebRequest(req, res);
    assert.equal(res.status, 400, `${host} ${target}`);
    assert.equal(JSON.parse(res.body).error.code, 'BAD_REQUEST');
  }
  const good = response();
  const goodReq = request('localhost:8787');
  goodReq.url = '/missing';
  await handleWebRequest(goodReq, good);
  assert.equal(good.status, 404);
});

test('a malformed network request does not prevent the next request', async (t) => {
  const { handleWebRequest } = createHttpRoutes({
    token: 'runtime-token',
    webAuthMode: () => 'token',
    cookieSessionOk: () => false,
    projectFromRequest: () => ({}),
    webErrorStatus: (error) => error.code === 'BAD_REQUEST' ? 400 : 500
  });
  let dispatched = 0;
  const server = http.createServer((req, res) => {
    dispatched += 1;
    void handleWebRequest(req, res).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const get = (host, target) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: target,
      headers: { Host: host } }, (res) => {
      res.resume();
      res.once('end', () => resolve(res.statusCode));
    });
    req.once('error', reject);
    req.end();
  });
  assert.equal(await get('[', '/'), 400);
  assert.equal(await get('localhost', '/missing'), 404);
  assert.equal(dispatched, 2);
});

test('tokenless access requires a trusted local authority, including with a matching attacker Origin', () => {
  const rebound = request('attacker.example:8787', 'http://attacker.example:8787');
  assert.equal(requestOriginMatches(rebound), true);
  assert.equal(tokenlessRequestAllowed(rebound), false);
  assert.equal(authOk(requestUrl(rebound), rebound, ''), false);
  for (const host of ['localhost:8787', '127.0.0.1:8787', '[::1]:8787']) {
    assert.equal(tokenlessRequestAllowed(request(host)), true, host);
  }
  for (const host of ['127.1:8787', '2130706433:8787', 'user@localhost:8787', 'localhost:0']) {
    assert.equal(tokenlessRequestAllowed(request(host)), false, host);
  }
  assert.equal(tokenlessRequestAllowed(request('localhost:8787', '', '203.0.113.9')), false);
  assert.equal(authOk(requestUrl(rebound), rebound, 'secret'), false);
  const bearer = request('attacker.example:8787', '', '203.0.113.9');
  bearer.headers.authorization = 'Bearer secret';
  assert.equal(authOk(requestUrl(bearer), bearer, 'secret'), true);
});

test('trusted proxy origin stays usable in tokenless loopback mode', () => {
  const options = { trustProxy: true, proxyOrigin: 'https://public.example.test' };
  const proxied = request('public.example.test', 'https://public.example.test');
  proxied.headers['x-forwarded-host'] = 'public.example.test:443';
  proxied.headers['x-forwarded-proto'] = 'https';
  assert.equal(tokenlessRequestAllowed(proxied, options), true);
  assert.equal(authOk(requestUrl(proxied), proxied, '', options), true);
  proxied.headers.host = 'attacker.example';
  assert.equal(tokenlessRequestAllowed(proxied, options), false);
});

test('concrete IPv6 bind addresses produce valid browser and API URLs', () => {
  assert.equal(runtimeBaseUrl('::1', 8787), 'http://[::1]:8787');
  const runtime = { host: '::1', port: 8787, token: 'token' };
  assert.equal(new URL(localRuntimeUrl(runtime)).hostname, '[::1]');
  assert.equal(new URL(publicRuntimeUrl(runtime)).hostname, '[::1]');
  assert.equal(runtimeBaseUrl('::', 8787), 'http://127.0.0.1:8787');
});
