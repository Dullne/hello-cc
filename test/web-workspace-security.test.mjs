import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';
import { randomBytes, randomUUID } from 'node:crypto';
import { createHttpRoutes } from '../lib/web/http-routes.mjs';
import { createCookieAuth } from '../lib/web/cookie-auth.mjs';
import { authOk, contentSecurityPolicy, requestIsSecure, sendHttp } from '../lib/web/http.mjs';
import { nativePanelScript } from '../lib/web/ui-native.mjs';

// Exercise the production sender without importing the CLI entry point, which
// would initialize unrelated CLI services. HTML content is a small fixture.
const appSource = fs.readFileSync(new URL('../lib/cli/app.mjs', import.meta.url), 'utf8');
const senderSource = appSource.slice(appSource.indexOf('function sendWebHtml('), appSource.indexOf('\nfunction webErrorStatus('));
const sendWebHtml = vm.runInNewContext('(' + senderSource + ')', { randomBytes, sendHttp });

async function fixture(t) {
  let currentTime = 1000;
  const token = 'workspace-test-token';
  const auth = createCookieAuth({ now: () => currentTime, ttlSec: 60, maxSessions: 10,
    requestIsSecure, authOk, token, trustProxy: false });
  const renders = [];
  const { handleWebRequest } = createHttpRoutes({ ...auth, token,
    renderWebIndex(options) { renders.push(options); return options?.pane ? '<main>Auxiliary pane</main>' : '<main>Workspace</main>'; },
    renderWebLogin() { return '<main>Sign in</main>'; }, sendWebHtml,
    projectFromRequest() { throw new Error('UI routes must not access project data'); },
    webErrorStatus: () => 500
  });
  const server = http.createServer(handleWebRequest);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = (route, headers = {}) => fetch(base + route, { headers, redirect: 'manual' });
  const sid = auth.issueSession();
  return { ...auth, base, get, sid, cookie: 'hcc_sid=' + sid, renders,
    expire() { currentTime += 61; } };
}

test('only authenticated pane HTML opts into same-origin framing and forbids nested frames', async t => {
  const f = await fixture(t);
  const root = await f.get('/', { cookie: f.cookie, accept: 'text/html' });
  const login = await f.get('/', { accept: 'text/html' });
  for (const response of [root, login]) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  }
  assert.match(await root.text(), /Workspace/);
  assert.match(await login.text(), /Sign in/);
  const pane = await f.get('/pane?project=%2Fproject&session=one', { cookie: f.cookie });
  assert.equal(pane.status, 200);
  assert.equal(pane.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(pane.headers.get('content-security-policy'), /frame-ancestors 'self'; frame-src 'none'/);
  assert.match(pane.headers.get('content-security-policy'), /script-src 'self' 'nonce-[A-Za-z0-9_-]+'/);
  assert.equal(pane.headers.get('referrer-policy'), 'no-referrer');
  assert.match(await pane.text(), /Auxiliary pane/);
  assert.equal(typeof f.renders[0], 'string', 'legacy root renderer still receives a nonce');
  assert.equal(f.renders[1].pane, true, 'pane renderer receives the server-owned mode');
  assert.match(f.renders[1].nonce, /^[A-Za-z0-9_-]{16,}$/);
});

test('pane route rejects missing, forged, expired and token-only credentials without rendering a login frame', async t => {
  const f = await fixture(t);
  for (const [route, headers] of [
    ['/pane', {}], ['/pane', { cookie: 'hcc_sid=forged' }],
    ['/pane?token=workspace-test-token', {}], ['/pane', { authorization: 'Bearer workspace-test-token' }]
  ]) {
    const response = await f.get(route, headers);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'none'");
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal((await response.json()).error.code, 'UNAUTHORIZED');
  }
  f.expire();
  const expired = await f.get('/pane', { cookie: f.cookie });
  assert.equal(expired.status, 401);
  assert.equal(expired.headers.get('x-frame-options'), 'DENY');
  assert.equal(f.renders.length, 0);
});

test('token exchange preserves the explicit session while dropping credentials and unrecognized pane parameters', async t => {
  const f = await fixture(t);
  const response = await f.get('/?token=workspace-test-token&project=%2Fproject&session=peer%2Fone&pane=1&action_token=secret', { accept: 'text/html' });
  assert.equal(response.status, 302);
  const next = new URL(response.headers.get('location'), f.base);
  assert.equal(next.searchParams.get('project'), '/project');
  assert.equal(next.searchParams.get('session'), 'peer/one');
  assert.equal(next.searchParams.has('token'), false);
  assert.equal(next.searchParams.has('action_token'), false);
  assert.equal(next.searchParams.has('pane'), false);
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
});

test('logout revokes both pane sockets and prevents subsequent embedded page loads', async t => {
  const f = await fixture(t), closed = [];
  for (const name of ['primary', 'auxiliary']) f.webSessions.get(f.sid).sockets.add({ close(code, reason) { closed.push({ name, code, reason }); } });
  const response = await fetch(f.base + '/logout', { method: 'POST', headers: { cookie: f.cookie, origin: f.base } });
  assert.equal(response.status, 204);
  assert.deepEqual(closed.map(item => [item.name, item.code]), [['primary', 4001], ['auxiliary', 4001]]);
  assert.equal(f.webSessions.has(f.sid), false);
  const pane = await f.get('/pane', { cookie: f.cookie });
  assert.equal(pane.status, 401);
  assert.equal(pane.headers.get('x-frame-options'), 'DENY');
});

test('framing exception requires an explicit boolean and retains nonce validation', () => {
  const nonce = 'workspace-policy-test-nonce';
  assert.match(contentSecurityPolicy(nonce, { pane: 'true' }), /frame-ancestors 'none'/);
  assert.throws(() => contentSecurityPolicy('short', { pane: true }), /valid CSP nonce/);
  let headers;
  sendHttp({ writeHead(_status, value) { headers = value; }, end() {} }, 401, 'application/json', '{}', { pane: true });
  assert.equal(headers['X-Frame-Options'], 'DENY');
  assert.equal(headers['Content-Security-Policy'], "frame-ancestors 'none'");
});

function nativeBrowser(storage, draftScope = '') {
  const nodes = new Map(), requests = [];
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', hidden: false, disabled: false, checked: false, dataset: {}, listeners: {},
      addEventListener(name, callback) { this.listeners[name] = callback; }, querySelectorAll() { return []; } });
    return nodes.get(id);
  };
  const state = { peer: 'peer', root: '/project', connected: true, status: 'idle', generation: 1, owner: 'worker', deliveries: [], events: [] };
  const bridge = { active: 'same-session', projectRoot: '/project', draftScope, actionToken: 'connection-' + draftScope, epoch: 1,
    canControl: true, session: { type: 'native', peer_id: 'peer' }, tr: key => key, esc: String,
    api(route, options) { return new Promise(resolve => requests.push({ route, options, resolve })); } };
  const window = { hccHandoff: bridge, hccUi: { safeGet: key => storage.get(key), safeSet: (key, value) => storage.set(key, value) }, addEventListener() {} };
  vm.runInNewContext(nativePanelScript(), { window, document: { getElementById: element }, crypto: { randomUUID } });
  window.hccNative.render(state);
  return { state, window, element, requests,
    fill(text) { element('nativeDraft').value = text; element('nativeDraft').listeners.input(); },
    send() { return element('nativeSend').listeners.click(); } };
}

test('same native session keeps pane drafts and asynchronous admission receipts independent', async () => {
  const storage = new Map(), primary = nativeBrowser(storage), auxiliary = nativeBrowser(storage, 'auxiliary');
  primary.fill('main pending text'); auxiliary.fill('secondary pending text');
  const mainSending = primary.send(), secondarySending = auxiliary.send();
  const mainId = JSON.parse(primary.requests[0].options.body).submissionId;
  const secondaryId = JSON.parse(auxiliary.requests[0].options.body).submissionId;
  const primaryKey = 'hcc.nativeDraft:["/project","same-session"]';
  const secondaryKey = primaryKey + ':pane:"auxiliary"';
  assert.equal(JSON.parse(storage.get(primaryKey)).pending.id, mainId);
  assert.equal(JSON.parse(storage.get(secondaryKey)).pending.id, secondaryId);
  auxiliary.requests[0].resolve({ receipt: { submission_id: secondaryId, message_id: 42 }, state: auxiliary.state });
  await secondarySending;
  assert.equal(JSON.parse(storage.get(primaryKey)).text, 'main pending text');
  assert.equal(JSON.parse(storage.get(primaryKey)).pending.id, mainId);
  assert.equal(JSON.parse(storage.get(secondaryKey)).pending, null);
  auxiliary.fill('secondary later edits');
  primary.requests[0].resolve({ receipt: { submission_id: mainId, message_id: 43 }, state: primary.state });
  await mainSending;
  assert.equal(nativeBrowser(storage).element('nativeDraft').value, '');
  assert.equal(nativeBrowser(storage, 'auxiliary').element('nativeDraft').value, 'secondary later edits');
});
