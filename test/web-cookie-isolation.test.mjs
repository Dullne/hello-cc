import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { createCookieAuth, createCookieNameForRequest } from '../lib/web/cookie-auth.mjs';
import { createHttpRoutes } from '../lib/web/http-routes.mjs';
import { authOk, requestIsSecure, requestOriginMatches } from '../lib/web/http.mjs';

// All fixtures use one hostname. A browser sends cookies to every port on that
// hostname; a shared jar models that behavior instead of isolating by origin.
function sharedCookieJar() {
  const cookies = new Map([['hcc_sid', 'legacy-session']]);
  return {
    cookies,
    header: () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
    receive(response) {
      const header = response.headers.get('set-cookie');
      if (!header) return;
      const pair = header.split(';')[0], index = pair.indexOf('=');
      const name = pair.slice(0, index), value = pair.slice(index + 1);
      if (/Max-Age=0(?:;|$)/i.test(header)) cookies.delete(name);
      else cookies.set(name, value);
    }
  };
}

async function runtime(t, { port = 0 } = {}) {
  const token = 'owned-cookie-fixture-token';
  const auth = createCookieAuth({ now: () => Date.now() / 1000, ttlSec: 60, maxSessions: 10,
    cookieNameForRequest: createCookieNameForRequest(), requestIsSecure, authOk, token });
  const { handleWebRequest } = createHttpRoutes({ ...auth, token,
    renderWebIndex: () => 'Workspace', renderWebLogin: () => 'Sign in',
    sendWebHtml(res, render) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(render()); },
    projectFromRequest() { throw new Error('Cookie fixture must not access project data'); },
    webErrorStatus: () => 500
  });
  const server = http.createServer(handleWebRequest), wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const record = auth.cookieSessionRecord(req);
    if (!record || !requestOriginMatches(req)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      ws.hccCookieAuth = record;
      record.session.sockets.add(ws);
      ws.on('message', data => { if (auth.cookieSocketValid(ws)) ws.send(data); });
      ws.on('close', () => record.session.sockets.delete(ws));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  let stopping;
  const stop = () => stopping ||= new Promise(resolve => {
    for (const client of wss.clients) client.terminate();
    wss.close();
    server.closeAllConnections();
    server.close(resolve);
  });
  t.after(stop);
  const actualPort = server.address().port, base = `http://127.0.0.1:${actualPort}`;
  async function request(jar, route, options = {}) {
    const response = await fetch(base + route, { ...options, redirect: 'manual',
      headers: { cookie: jar.header(), ...options.headers } });
    jar.receive(response);
    await response.text();
    return response;
  }
  return { auth, base, port: actualPort, stop,
    pane: jar => request(jar, '/pane'),
    login: jar => request(jar, '/login', { method: 'POST', body: JSON.stringify({ token }) }),
    logout: jar => request(jar, '/logout', { method: 'POST', headers: { origin: base } }),
    async connect(jar) {
      const ws = new WebSocket(base.replace('http:', 'ws:') + '/fixture', {
        headers: { cookie: jar.header(), origin: base }
      });
      t.after(() => ws.terminate());
      await once(ws, 'open', { signal: AbortSignal.timeout(2000) });
      return ws;
    }
  };
}

test('same-host runtimes retain independent HTTP and socket sessions through login and logout', { timeout: 10000 }, async t => {
  const a = await runtime(t), b = await runtime(t), jar = sharedCookieJar();
  assert.notEqual(a.port, b.port);
  assert.equal((await a.login(jar)).status, 302);
  const socketA = await a.connect(jar);
  assert.equal((await b.login(jar)).status, 302);
  const socketB = await b.connect(jar);
  assert.equal((await a.pane(jar)).status, 200, 'refreshing A after login to B retains A');
  assert.equal((await b.pane(jar)).status, 200);
  assert.deepEqual([...jar.cookies.keys()].sort(), [
    'hcc_sid', `hcc_sid_v2_http_${a.port}`, `hcc_sid_v2_http_${b.port}`
  ].sort());

  const closedA = once(socketA, 'close', { signal: AbortSignal.timeout(2000) });
  const logout = await a.logout(jar);
  assert.equal(logout.status, 204);
  assert.equal((await closedA)[0], 4001);
  assert.match(logout.headers.get('set-cookie'), new RegExp(`^hcc_sid_v2_http_${a.port}=;`));
  assert.equal(jar.cookies.has(`hcc_sid_v2_http_${a.port}`), false);
  assert.equal(jar.cookies.get('hcc_sid'), 'legacy-session', 'old runtime cookie remains untouched');
  assert.equal((await a.pane(jar)).status, 401);
  assert.equal((await b.pane(jar)).status, 200, 'logout from A does not log out B');
  const reply = once(socketB, 'message', { signal: AbortSignal.timeout(2000) });
  socketB.send('B remains connected');
  assert.equal(String((await reply)[0]), 'B remains connected');
  const closedB = once(socketB, 'close', { signal: AbortSignal.timeout(2000) });
  assert.equal((await b.logout(jar)).status, 204);
  assert.equal((await closedB)[0], 4001);
});

test('restart on the same endpoint replaces one scoped cookie and requires a fresh login', { timeout: 10000 }, async t => {
  const first = await runtime(t), jar = sharedCookieJar();
  await first.login(jar);
  const names = [...jar.cookies.keys()];
  await first.stop();
  const restarted = await runtime(t, { port: first.port });
  assert.equal((await restarted.pane(jar)).status, 401, 'the previous runtime session is not reused');
  assert.equal((await restarted.login(jar)).status, 302);
  assert.equal((await restarted.pane(jar)).status, 200);
  assert.deepEqual([...jar.cookies.keys()], names, 'restart does not accumulate per-start cookie names');
});

test('cookie names use the actual listener and configured transport independently of request headers', () => {
  const plain = createCookieNameForRequest(), tls = createCookieNameForRequest({ useTls: true });
  const req = { socket: { localPort: 43210 }, headers: { host: 'localhost:8787' } };
  assert.equal(plain(req), 'hcc_sid_v2_http_43210');
  assert.equal(tls(req), 'hcc_sid_v2_https_43210');
  req.headers = { host: '[::1]:8788', 'x-forwarded-host': 'public.example.test:443', 'x-forwarded-proto': 'https' };
  assert.equal(plain(req), 'hcc_sid_v2_http_43210');
  assert.equal(tls(req), 'hcc_sid_v2_https_43210');
});

test('trusted proxy cookie names use configured public protocol and effective port', () => {
  for (const [proxyOrigin, expected] of [
    ['http://public.example.test', 'http_80'], ['http://public.example.test:80', 'http_80'],
    ['https://public.example.test', 'https_443'], ['https://public.example.test:443', 'https_443'],
    ['https://public.example.test:9443', 'https_9443'], ['http://[::1]:8080', 'http_8080']
  ]) {
    const resolver = createCookieNameForRequest({ trustProxy: true, proxyOrigin });
    for (const headers of [{}, { host: 'localhost:10001', 'x-forwarded-proto': 'http', 'x-forwarded-host': 'localhost:10002' }]) {
      assert.equal(resolver({ socket: { localPort: 12345 }, headers }), `hcc_sid_v2_${expected}`);
    }
  }
});

function authFixture(options = {}) {
  return createCookieAuth({ now: () => 100, ttlSec: 60, maxSessions: 2,
    cookieNameForRequest: createCookieNameForRequest(), requestIsSecure, authOk, token: 'fixture-token', ...options });
}

test('invalid endpoint configuration or cookie resolver fails closed without a legacy fallback', () => {
  for (const proxyOrigin of ['', 'not an origin', 'file:///tmp/fixture', 'https://example.test/path',
    'https://example.test/?query=1', 'https://example.test/#fragment', 'https://user@example.test', 'https://example.test:0']) {
    assert.throws(() => createCookieNameForRequest({ trustProxy: true, proxyOrigin }), /configured proxy/);
  }
  assert.throws(() => createCookieNameForRequest({ proxyOrigin: 'https://example.test' }), /trustProxy/);
  const resolver = createCookieNameForRequest();
  for (const localPort of [undefined, 0, -1, 65536, 1.5, '8787']) {
    assert.throws(() => resolver({ socket: { localPort } }), /listener port/);
  }
  assert.throws(() => authFixture({ cookieNameForRequest: undefined }), /cookieNameForRequest/);
  for (const name of ['hcc_sid', '', 'hcc_sid_v2_http_0', 'hcc_sid_v2_http_65536']) {
    const auth = authFixture({ cookieNameForRequest: () => name }), req = { headers: {} };
    assert.throws(() => auth.parseCookieSid(req), /scoped cookie name/);
    assert.throws(() => auth.sessionCookieHeader('fixture-sid', req), /scoped cookie name/);
    assert.throws(() => auth.expiredSessionCookieHeader(req), /scoped cookie name/);
  }
});

test('cookie attributes retain transport protection and legacy credentials are ignored', () => {
  const req = { socket: { localPort: 8787 }, headers: {} }, auth = authFixture(), sid = auth.issueSession();
  assert.equal(auth.sessionCookieHeader(sid, req), `hcc_sid_v2_http_8787=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=60`);
  req.headers.cookie = `hcc_sid=${sid}`;
  assert.equal(auth.cookieSessionOk(req), false);
  req.headers.cookie += `; hcc_sid_v2_http_8787=${sid}`;
  assert.equal(auth.cookieSessionOk(req), true);
  assert.equal(auth.expiredSessionCookieHeader(req), 'hcc_sid_v2_http_8787=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');

  const tls = authFixture({ cookieNameForRequest: createCookieNameForRequest({ useTls: true }) });
  assert.match(tls.sessionCookieHeader('fixture-sid', { headers: {}, socket: { localPort: 9443, encrypted: true } }),
    /^hcc_sid_v2_https_9443=.*; Secure$/);
  const proxy = { trustProxy: true, proxyOrigin: 'https://public.example.test' };
  const proxied = authFixture({ ...proxy, cookieNameForRequest: createCookieNameForRequest(proxy) });
  const proxyReq = { socket: { localPort: 8787, remoteAddress: '127.0.0.1' },
    headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'public.example.test' } };
  assert.match(proxied.sessionCookieHeader('fixture-sid', proxyReq), /^hcc_sid_v2_https_443=.*; Secure$/);
  assert.match(proxied.expiredSessionCookieHeader(proxyReq), /^hcc_sid_v2_https_443=;.*; Secure$/);
});

test('scoped sessions retain expiry, eviction and attached socket revocation', () => {
  let time = 100;
  const auth = authFixture({ now: () => time, ttlSec: 5 }), closed = [];
  function sessionSocket() {
    const sid = auth.issueSession(), session = auth.webSessions.get(sid);
    const ws = { hccCookieAuth: { sid, session }, close(code, reason) { closed.push([code, reason]); } };
    session.sockets.add(ws);
    return { sid, ws, req: { socket: { localPort: 8787 }, headers: { cookie: `hcc_sid_v2_http_8787=${sid}` } } };
  }
  const first = sessionSocket(), second = sessionSocket();
  assert.equal(auth.cookieSessionOk(first.req), true);
  assert.equal(auth.cookieSocketValid(first.ws), true);
  sessionSocket();
  assert.deepEqual(closed, [[4001, 'session limit reached']]);
  assert.equal(auth.cookieSessionOk(first.req), false);
  assert.equal(auth.cookieSessionOk(second.req), true);
  time += 5;
  assert.equal(auth.cookieSocketValid(second.ws), false);
  assert.equal(auth.cookieSessionOk(second.req), false);
  auth.pruneWebSessions();
  assert.deepEqual(closed, [[4001, 'session limit reached'], [4001, 'session expired'], [4001, 'session expired']]);
  assert.equal(auth.webSessions.size, 0);
});
