import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createHttpRoutes } from '../lib/web/http-routes.mjs';
import { scheduleResponseShutdown } from '../lib/web/shutdown-response.mjs';
import { createAutoAttach } from '../lib/web/auto-attach.mjs';

for (const firstEvent of ['finish', 'close', 'deadline']) {
  test(`accepted stop cleans up once after response ${firstEvent}, even if other signals arrive`, () => {
    const response = new EventEmitter();
    let deadline, cancelled = 0, shutdowns = 0;
    scheduleResponseShutdown(response, () => { shutdowns++; }, {
      schedule(callback, delay) { assert.equal(delay, 250); deadline = callback; return 42; },
      cancel(id) { assert.equal(id, 42); cancelled++; }
    });
    assert.equal(shutdowns, 0, 'must allow the response to be written before cleanup');
    if (firstEvent === 'deadline') deadline();
    else response.emit(firstEvent);
    assert.equal(shutdowns, 1);
    response.emit('finish'); response.emit('close'); deadline();
    assert.equal(shutdowns, 1, 'late completion and abort must not repeat cleanup');
    assert.equal(cancelled, 1);
    assert.equal(response.listenerCount('finish'), 0);
    assert.equal(response.listenerCount('close'), 0);
  });
}

async function fixture(t) {
  const ctx = { root: '/stop-test', dbPath: '/stop-test/.hello-cc/mesh.db' };
  const events = [];
  let stopping = false, pendingBody;
  const bodyStarted = new Promise(resolve => { pendingBody = resolve; });
  const { handleWebRequest } = createHttpRoutes({
    ctx, sessions: new Map(), token: 'fixture-token',
    webAuthMode: (_url, req) => req.headers['x-test-auth'] === 'none' ? null : req.headers['x-test-auth'] || 'token',
    cookieSessionOk: req => req.headers['x-test-auth'] === 'cookie',
    projectFromRequest() { events.push('project'); return ctx; },
    prepareShutdown() { stopping = true; events.push('quiesced'); },
    isStopping: () => stopping,
    shutdown() { events.push('cleanup'); },
    sessionsForProject: () => [],
    getSession: () => null,
    startSession() { events.push('session-created'); return { id: 'late' }; },
    serializeSession: value => value,
    connectWebProject: () => ({ close() {} }),
    webErrorStatus: error => error.code === 'RUNTIME_ADMIN_REQUIRED' ? 403 : error.code === 'RUNTIME_STOPPING' ? 503 : 500
  });
  const server = http.createServer((req, res) => {
    res.once('finish', () => events.push('response:' + res.statusCode));
    void handleWebRequest(req, res);
    if (req.url === '/api/sessions') pendingBody();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = 'http://127.0.0.1:' + server.address().port;
  const post = async (route, headers = {}) => {
    const response = await fetch(url + route, { method: 'POST', headers: { 'X-HCC-API-Version': '2', Origin: url, ...headers } });
    return { status: response.status, body: await response.json() };
  };
  return { url, events, post, bodyStarted };
}

test('accepted HTTP stop quiesces before replying, and the client can read the complete reply', async t => {
  const f = await fixture(t);
  const result = await f.post('/api/runtime/stop');
  assert.deepEqual(result, { status: 200, body: { ok: true, pid: process.pid } });
  assert.deepEqual(f.events, ['project', 'quiesced', 'response:200', 'cleanup']);
});

test('rejected stop requests never quiesce the runtime', async t => {
  const f = await fixture(t);
  for (const [headers, status] of [
    [{ 'X-Test-Auth': 'none' }, 401],
    [{ 'X-Test-Auth': 'cookie' }, 403],
    [{ 'X-Test-Auth': 'cookie', Origin: 'http://untrusted.example' }, 403],
    [{ 'X-HCC-API-Version': '999' }, 426]
  ]) assert.equal((await f.post('/api/runtime/stop', headers)).status, status);
  assert.equal(f.events.includes('quiesced'), false);
  assert.equal(f.events.includes('cleanup'), false);
  assert.equal((await f.post('/api/runtime/stop')).status, 200);
});

test('a session request whose body arrives after stop cannot create a late executor', async t => {
  const f = await fixture(t);
  let pending;
  const result = new Promise((resolve, reject) => {
    pending = http.request(f.url + '/api/sessions', {
      method: 'POST', headers: { 'X-HCC-API-Version': '2', 'Content-Type': 'application/json' }
    }, response => {
      let body = '';
      response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.once('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    pending.once('error', reject);
    pending.write('{"id":"late",');
  });
  t.after(() => pending.destroy());
  await f.bodyStarted;
  assert.equal((await f.post('/api/runtime/stop')).status, 200);
  pending.end('"kind":"shell"}');
  const late = await result;
  assert.equal(late.status, 503);
  assert.equal(late.body.error.code, 'RUNTIME_STOPPING');
  assert.equal(f.events.includes('session-created'), false);
});

test('a queued auto-attach scan does no database or tmux work after stop is accepted', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let stopping = false, databaseOpens = 0, tmuxReads = 0;
  const automatic = createAutoAttach({
    ctx: { root: '/synthetic-stop-project' }, sessions: new Map(),
    isStopping: () => stopping,
    connectWebProject() {
      databaseOpens++;
      return { prepare: () => ({ all: () => [{ id: 'peer', pid: 123 }] }), close() {} };
    },
    now: () => 1000, ACTIVE_PEER_TTL: 60,
    addEvent() {}, reconcileRunningPeerBindings() {}, redactedLogText: value => value,
    sessionsForProject: () => [], latestHookProviderSession() {}, resolveSessionPeerId() {},
    reAdoptOrphanManagedTmuxSessions: () => new Set(), reapDeadPeersForProject() {},
    attachTmuxSession() { assert.fail('must not adopt any real session'); },
    runTmux() { tmuxReads++; return ''; }
  });
  t.after(() => clearInterval(automatic.autoAttachPoller));
  assert.equal(databaseOpens, 1); assert.equal(tmuxReads, 1);
  t.mock.timers.tick(4995);
  stopping = true;
  automatic.scanAndAttachDetectedPeers(); // callback retained by an earlier caller
  t.mock.timers.tick(5); // already-due background poll
  assert.equal(databaseOpens, 1);
  assert.equal(tmuxReads, 1);
});
