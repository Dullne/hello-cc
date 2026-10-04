import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { inspectProcessIdentity } from '../lib/process/identity.mjs';
import { initSchema } from '../lib/db/schema.mjs';
import { createEventHelpers } from '../lib/db/events.mjs';
import { createPeerHelpers } from '../lib/core/peers/peer-helpers.mjs';
import { createPeerBindingStore } from '../lib/db/stores/peers.mjs';
import { createMessageStore } from '../lib/core/coordination/messages.mjs';
import { pruneOldEventsPreservingTmuxAuthority } from '../lib/core/coordination/event-retention.mjs';
import { createHistoryGcSnapshot, captureHistoryGcPlan, dropHistoryGcSnapshot } from '../lib/core/coordination/gc-plan.mjs';
import { CliError } from '../lib/shared/errors.mjs';
import { startNativeService } from '../lib/runtime/native/service.mjs';
import { nativeRequest } from '../lib/runtime/native/client.mjs';
import { createControlLease } from '../lib/web/control-lease.mjs';
import { createCodexSessions } from '../lib/web/codex-sessions.mjs';
import { createNativeSessions } from '../lib/web/native-sessions.mjs';
import { createPtySessions } from '../lib/web/pty-sessions.mjs';
import { createTaskResults } from '../lib/web/task-results.mjs';
import { createHttpRoutes } from '../lib/web/http-routes.mjs';

// Production HTTP routing, ownership stores, and native loopback protocol;
// provider adapters are in-memory fakes, with no CLI, model, or tmux calls.
// OS socket-lock behavior has its own file-lock/native-runtime coverage. These
// route fixtures must not depend on unrelated desktop listeners on hashed ports.
function createFixtureOwnership() {
  const owners = new Map();
  return target => {
    const key = path.join(fs.realpathSync.native(path.dirname(target)), path.basename(target));
    if (owners.has(key)) throw Object.assign(new Error('Fixture native owner already held'), { code: 'ERR_FILE_LOCK_BUSY' });
    const owner = Symbol('fixture native owner');
    owners.set(key, owner);
    return Object.freeze({
      canonicalTarget: key,
      assertHeld() {
        if (owners.get(key) !== owner) throw Object.assign(new Error('Fixture native owner released'), { code: 'ERR_FILE_LOCK_LOST' });
      },
      release() { if (owners.get(key) === owner) owners.delete(key); }
    });
  };
}

async function fixture(t, hooks = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-http-structured-')));
  const cleanups = [];
  t.after(async () => {
    const failures = [];
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    // Preserve the private root for diagnosis if a resource could not close.
    if (failures.length) throw new AggregateError(failures, 'Structured route fixture cleanup failed');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const ctx = { root, dbPath: path.join(root, '.hello-cc', 'mesh.db') };
  fs.mkdirSync(path.dirname(ctx.dbPath));
  const db = new DatabaseSync(ctx.dbPath);
  cleanups.push(() => db.close());
  initSchema(db); db.exec('PRAGMA journal_mode=WAL');
  const connect = (project = ctx) => {
    const connection = new DatabaseSync(project.dbPath);
    connection.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
    return connection;
  };
  const now = () => 1000;
  const events = createEventHelpers({ now });
  const peers = createPeerHelpers({ now, liveProcessIdentity: () => null });
  const bindings = createPeerBindingStore(events);
  const messages = createMessageStore(events);
  const sessions = new Map(), lease = createControlLease();
  cleanups.push(() => { for (const session of sessions.values()) lease.forget(session); });
  const key = (project, id) => project.root + '\0' + id;
  const sessionsForProject = (project) => [...sessions.values()].filter(s => s.ctx.root === project.root);
  const closeSessionClients = (session) => { lease.forget(session); session.clients.clear(); session.actionTokens.clear(); };
  const nativeAdapters = new Map(), nativePosts = [], nativeReads = [];
  let onNativeRead = null;
  const service = await startNativeService(ctx, { ...events, ...peers, ...bindings, ...messages,
    connect, detectBranch: () => '', liveProcessIdentity: () => inspectProcessIdentity(process.pid).identity }, {
    pollMs: 60000,
    acquireOwnership: createFixtureOwnership(),
    adapterFactory: async (provider, options) => {
      await hooks.beforeNativeAdapter?.(provider, options);
      const peer = options.env.HCC_PEER;
      const state = { provider, status: 'idle', sessionId: 'session-' + peer, turnId: null,
        executorId: options.executorId, pendingApprovals: [], capabilities: { send: true, resume: true, interrupt: true, close: true, approvals: true } };
      const adapter = { capabilities: state.capabilities, state, sent: [], interrupts: [], closed: 0,
        snapshot: () => structuredClone(state), async open(input) {
          await hooks.nativeOpen?.({ provider, peer, ...input }); return this.snapshot();
        },
        async send(input) { this.sent.push(input); state.status = 'running'; state.turnId = 'turn-' + peer;
          return { status: 'queued', turnId: state.turnId }; },
        async interrupt(input) { this.interrupts.push(input); return { status: 'interrupt_requested' }; },
        respond(input) {
          const request = state.pendingApprovals.find(request => request.requestId === input.requestId);
          if (!request || input.turnId !== request.turnId || input.sessionId !== request.sessionId || input.executorId !== state.executorId) throw new CliError('NATIVE_APPROVAL_MISMATCH', 'Interaction expired');
          state.pendingApprovals = state.pendingApprovals.filter(value => value !== request);
          return { requestId: request.requestId, status: 'submitted' };
        },
        async close() { this.closed++; state.status = 'closed'; }
      };
      nativeAdapters.set(peer, adapter); return adapter;
    }
  });
  cleanups.push(() => service.shutdown());
  const api = (method, route, body) => nativeRequest(ctx, method, route, body, { timeoutMs: 3000 });
  const native = createNativeSessions({ sessions, sessionKey: key, connectWebProject: connect,
    broadcast() {}, closeSessionClients, now, addEvent: events.addEvent,
    nativeApi: async (project, method, route, body) => {
      if (method === 'POST') nativePosts.push({ route, body });
      const result = await nativeRequest(project, method, route, body, { timeoutMs: 3000 });
      if (route.includes('/state')) { nativeReads.push(route); await onNativeRead?.(); }
      return result;
    }
  });
  cleanups.push(() => native.closeNativeBridge());
  const codexAdapters = [], codexCalls = [];
  cleanups.push(async () => {
    const results = await Promise.allSettled(codexAdapters.map(adapter => Promise.resolve().then(() => adapter.close())));
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Fixture Codex adapters did not all close');
  });
  let nextId = 0;
  const codex = createCodexSessions({ sessions, sessionKey: key,
    nextProjectSessionId: () => 'codex-' + (++nextId), connectWebProject: connect,
    upsertPeer: peers.upsertPeer, upsertCanonicalPeerBinding: bindings.upsertCanonicalPeerBinding,
    observePeerEvidence: () => ({ state: 'dead' }), broadcast() {}, closeSessionClients,
    now, addEvent: events.addEvent,
    adapterFactory: () => {
      const n = codexAdapters.length + 1;
      const state = { executorId: 'executor-' + n, status: 'ready', pid: null, processExited: false };
      const adapter = { state, snapshot: () => ({ ...state }),
        async startThread(params) { codexCalls.push({ method: 'start', n, params }); return { thread: { id: 'thread-' + n, cwd: root } }; },
        async resumeThread(threadId, params) { codexCalls.push({ method: 'resume', n, threadId, params }); return { thread: { id: threadId, cwd: root } }; },
        async listThreads(params) { codexCalls.push({ method: 'list', n, params });
          return { data: [{ id: 'thread-1', cwd: root }, { id: 'foreign', cwd: os.tmpdir() }], nextCursor: 'cursor' }; },
        async peekThread(threadId) { codexCalls.push({ method: 'peek', n, threadId }); await hooks.peekThread?.();
          return { thread: { id: threadId, cwd: root, turns: [] } }; },
        async forkThread(threadId, params, beforeSubmit = () => {}) { await hooks.beforeForkSubmit?.(); beforeSubmit();
          codexCalls.push({ method: 'fork', n, threadId, params }); return { thread: { id: 'fork-' + n, cwd: root, turns: [] } }; },
        async close() { codexCalls.push({ method: 'close', n }); state.status = 'closed'; state.processExited = true; }
      };
      codexAdapters.push(adapter); return adapter;
    }
  });
  const resultService = createTaskResults({ connectWebProject: connect,
    resolveSessionPeerId: (_db, session) => session.peerId, now, addEvent: events.addEvent });
  const ptySpawns = [];
  const ptyManager = createPtySessions({ ctx, sessions, sessionKey: key, connectWebProject: connect,
    nextProjectSessionId: () => 'pty-' + (++nextId), broadcast() {}, closeSessionClients,
    now, ...events, ...peers, ...bindings, refreshPeerIoHeartbeat() {},
    startTmuxManagedSession() { throw new Error('fixture must not operate tmux'); },
    pty: { spawn(...args) { ptySpawns.push(args); return { pid: 43210, onData() {}, onExit() {}, kill() {}, resize() {} }; } }
  });
  const writes = [];
  const assertWebWrite = (session, input) => {
    try { lease.assertControl(session, input.action_token, input.epoch); }
    catch (error) { throw new CliError(error.code, error.message); }
  };
  const serializeSession = s => ({ id: s.id, type: s.type, peerId: s.peerId,
    threadId: s.binding?.provider_session_id });
  const { handleWebRequest } = createHttpRoutes({ ctx, sessions, token: '',
    webAuthMode: () => 'cookie', cookieSessionOk: () => true, projectFromRequest: () => ctx,
    connectWebProject: connect, sessionsForProject, getSession: (_project, id) => sessions.get(key(ctx, id)),
    serializeSession, resolveSessionPeerId: (_db, s) => s.peerId,
    assertWebWrite, ...codex, ...native, ...resultService, startSession: ptyManager.startSession,
    now, addEvent: events.addEvent, auditPayload: events.auditPayload,
    sendMessage: messages.sendMessage,
    writeSessionInput: (_session, input) => writes.push(input),
    webErrorStatus: error => error.code === 'BAD_REQUEST' ? 400 : error.code === 'NOT_FOUND' ? 404 : 409
  });
  const server = http.createServer(handleWebRequest);
  cleanups.push(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = async (route, input, headers = {}, method = input === undefined ? 'GET' : 'POST') => {
    const response = await fetch(base + route, { method,
      headers: { 'X-HCC-API-Version': '2', Origin: base, 'Content-Type': 'application/json', ...headers },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json() };
  };
  const controllers = session => {
    const controller = lease.connect(session, 'controller'), observer = lease.connect(session, 'observer');
    return { controller: { action_token: 'controller', epoch: controller.epoch },
      observer: { action_token: 'observer', epoch: observer.epoch } };
  };
  return { ctx, db, request, api, native, codex, lease, sessions, controllers,
    nativeAdapters, nativePosts, nativeReads, codexAdapters, codexCalls, ptySpawns, writes,
    setNativeReadHook(fn) { onNativeRead = fn; }, pollNative: () => service.poll(),
    async nativeSession(peer = 'native-a') {
      await api('POST', '/workers', { peer, provider: 'codex' }); await native.discoverNativeSessions(ctx);
      return sessions.get(key(ctx, peer));
    },
    async codexSession() { return codex.startCodexSession({ kind: 'codex', projectCtx: ctx }); },
    task(peer, id = 1) { db.prepare("INSERT INTO tasks(id,title,status,owner,created_at,updated_at) VALUES(?,'keep working','running',?,1,1)").run(id, peer); },
    resultEvents() { return db.prepare("SELECT payload FROM events WHERE type='task.result.recorded'").all().map(row => JSON.parse(row.payload)); },
    pendingCount() { return db.prepare("SELECT COUNT(*) n FROM events WHERE type='native.web.submission.pending'").get().n; }
  };
}

test('POST sessions creates and returns each native provider view without terminal or Web-owned executor startup', async t => {
  const f = await fixture(t);
  fs.mkdirSync(path.join(f.ctx.root, 'child'));
  for (const kind of ['codex', 'claude', 'dsh']) {
    const response = await f.request('/api/sessions', { transport: 'native', kind, id: `web-${kind}`, cwd: 'child', model: 'selected-model' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.session, { id: `web-${kind}`, type: 'native', peerId: `web-${kind}`, threadId: `session-web-${kind}` });
    const call = f.nativePosts.at(-1);
    assert.equal(call.route, '/workers');
    assert.deepEqual(call.body, { peer: `web-${kind}`, provider: kind, cwd: path.join(f.ctx.root, 'child'), model: 'selected-model' });
  }
  assert.equal(f.nativePosts.length, 3); assert.equal(f.codexAdapters.length, 0); assert.equal(f.ptySpawns.length, 0);
  const listed = await f.request('/api/sessions');
  assert.equal(listed.body.sessions.length, 3);
});

test('project defaults HTTP uses revision CAS, rejects cross-origin writes and applies only to new native sessions', async t => {
  const f = await fixture(t); fs.mkdirSync(path.join(f.ctx.root, 'work'));
  const response = await f.request('/api/agent-defaults'), settings = response.body;
  assert.equal(response.status, 200); assert.equal(settings.revision, 0);
  settings.defaultProvider = 'dsh'; settings.providers.dsh = { model: 'default-dsh-model', cwd: 'work' };
  assert.equal((await f.request('/api/agent-defaults', settings, { Origin: 'https://different.example' }, 'PUT')).status, 403);
  assert.equal((await f.request('/api/agent-defaults', { ...settings, secret: 'not accepted' }, {}, 'PUT')).status, 400);
  const saved = await f.request('/api/agent-defaults', settings, {}, 'PUT'); assert.equal(saved.status, 200); assert.equal(saved.body.revision, 1);
  const conflict = await f.request('/api/agent-defaults', settings, {}, 'PUT');
  assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, 'AGENT_DEFAULTS_CONFLICT');
  const inherited = await f.request('/api/sessions', { transport: 'native' });
  assert.equal(inherited.status, 200); assert.match(inherited.body.session.id, /^native-dsh-/);
  assert.equal(f.nativePosts.at(-1).body.provider, 'dsh'); assert.equal(f.nativePosts.at(-1).body.model, 'default-dsh-model');
  assert.equal(f.nativePosts.at(-1).body.cwd, path.join(f.ctx.root, 'work'));
  const cleared = await f.request('/api/sessions', { transport: 'native', kind: 'dsh', model: null, cwd: '.' });
  assert.equal(cleared.status, 200); assert.equal(Object.hasOwn(f.nativePosts.at(-1).body, 'model'), false);
  assert.equal(f.nativePosts.at(-1).body.cwd, f.ctx.root);
  const appServer = await f.request('/api/sessions', { transport: 'app-server', kind: 'codex' });
  assert.equal(appServer.status, 200); assert.equal(appServer.body.session.type, 'app-server');
  assert.equal((await f.request('/api/agent-defaults')).body.revision, 1);
});

test('native history HTTP exposes retained project records and restores only an explicitly confirmed saved identity', async t => {
  const f = await fixture(t); await f.nativeSession('history-a');
  let listing = await f.request('/api/native/history');
  assert.equal(listing.status, 200); assert.equal(listing.body.workers[0].resumeReason, 'active');
  assert.equal(listing.body.retention.complete, false);
  await f.api('POST', '/close', { peer: 'history-a' });
  listing = await f.request('/api/native/history');
  const row = listing.body.workers[0]; assert.equal(row.resumable, true);
  const detail = await f.request('/api/native/history/history-a?after=0');
  assert.equal(detail.status, 200); assert.equal(detail.body.worker.peer, 'history-a'); assert.ok(Array.isArray(detail.body.events));
  const input = { owner: row.owner, sessionId: row.sessionId, confirmed: true };
  assert.equal((await f.request('/api/native/history/history-a/resume', { ...input, confirmed: false })).status, 400);
  assert.equal((await f.request('/api/native/history/history-a/resume', { ...input, cwd: f.ctx.root })).status, 400);
  assert.equal((await f.request('/api/native/history/history-a/resume', input, { Origin: 'https://different.example' })).status, 403);
  assert.equal(f.nativePosts.length, 0);
  const restored = await f.request('/api/native/history/history-a/resume', input);
  assert.equal(restored.status, 200); assert.equal(restored.body.session.id, 'history-a');
  assert.equal(restored.body.session.threadId, row.sessionId);
  const repeated = await f.request('/api/native/history/history-a/resume', input);
  assert.equal(repeated.status, 409); assert.equal(repeated.body.error.code, 'NATIVE_OWNER_CHANGED');
  assert.equal(f.nativePosts.length, 1);
  for (const cursor of ['-1', '1.5', '1e2', '9007199254740992']) {
    assert.equal((await f.request('/api/native/history/history-a?after=' + cursor)).status, 400);
  }
});

test('restored worker HTTP view failures preserve recovery identity without another provider admission', async t => {
  const f = await fixture(t); await f.nativeSession('history-a'); await f.api('POST', '/close', { peer: 'history-a' });
  const row = (await f.request('/api/native/history')).body.workers[0];
  f.setNativeReadHook(() => { throw new CliError('NATIVE_RUNTIME_OFFLINE', 'temporary view failure'); });
  const response = await f.request('/api/native/history/history-a/resume', { owner: row.owner, sessionId: row.sessionId, confirmed: true });
  assert.equal(response.status, 409); assert.equal(response.body.error.code, 'NATIVE_WORKER_DISCOVERY_FAILED');
  assert.equal(response.body.error.extra.peer, row.peer); assert.equal(response.body.error.extra.created, true);
  assert.ok(response.body.error.extra.executorId); assert.notEqual(response.body.error.extra.executorId, row.owner);
  f.setNativeReadHook(null);
  assert.ok((await f.request('/api/sessions')).body.sessions.some(session => session.id === row.peer));
  assert.equal(f.nativePosts.length, 1);
});

test('native initialization failures retain their error code and give actionable guidance for the saved peer', async t => {
  const f = await fixture(t, {
    beforeNativeAdapter(provider) {
      if (provider === 'dsh') throw new CliError('NATIVE_BINARY_MISSING', 'dsh executable was not found');
    },
    nativeOpen({ model }) {
      if (model === 'unavailable-model') throw new CliError('NATIVE_UNSUPPORTED_MODEL', 'The selected model is unavailable');
    }
  });
  for (const failure of [
    { kind: 'codex', model: 'unavailable-model', code: 'NATIVE_UNSUPPORTED_MODEL', detail: 'The selected model is unavailable' },
    { kind: 'dsh', id: 'missing-binary', code: 'NATIVE_BINARY_MISSING', detail: 'dsh executable was not found' }
  ]) {
    const response = await f.request('/api/sessions', { transport: 'native', kind: failure.kind,
      ...(failure.id ? { id: failure.id } : {}), ...(failure.model ? { model: failure.model } : {}) });
    const peer = f.nativePosts.at(-1).body.peer;
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, failure.code);
    assert.ok(response.body.error.message.startsWith(failure.detail));
    assert.ok(response.body.error.message.includes(`Peer ${peer} is still reserved`));
    assert.match(response.body.error.message, /hcc native status/);
    assert.match(response.body.error.message, /choose a new Agent name to retry/);
    const binding = f.db.prepare('SELECT * FROM peer_bindings WHERE peer=?').get(peer);
    assert.equal(binding.transport, 'native');
    const saved = (await f.api('GET', '/status')).workers.find(worker => worker.peer === peer);
    assert.equal(saved.status, 'error'); assert.equal(saved.owned, false);
    const sameName = await f.request('/api/sessions', { transport: 'native', kind: failure.kind, id: peer });
    assert.equal(sameName.body.error.code, 'NATIVE_PEER_IN_USE');
    assert.deepEqual(f.db.prepare('SELECT * FROM peer_bindings WHERE peer=?').get(peer), binding);
  }
  const retried = await f.request('/api/sessions', { transport: 'native', kind: 'codex', id: 'corrected-model', model: 'available-model' });
  assert.equal(retried.status, 200);
  assert.equal(retried.body.session.id, 'corrected-model');
});

test('native creation HTTP contract rejects injection, ambiguous transports and cross-origin writes', async t => {
  const f = await fixture(t);
  const base = { transport: 'native', kind: 'codex' };
  for (const input of [null, [], { ...base, binary: 'custom-codex' }, { ...base, env: {} },
    { ...base, command: 'anything' }, { ...base, resume: 'last' }, { ...base, force: false },
    { ...base, backend: 'app-server' }, { transport: 'app-server', backend: 'native', kind: 'codex' },
    { backend: 'native', kind: 'codex' }, { ...base, projectCtx: f.ctx }]) {
    const rejected = await f.request('/api/sessions', input);
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.equal(rejected.body.error.code, 'BAD_REQUEST');
  }
  const crossOrigin = await f.request('/api/sessions', base, { Origin: 'https://different.example' });
  assert.equal(crossOrigin.status, 403); assert.equal(crossOrigin.body.error.code, 'CSRF_ORIGIN');
  assert.equal(f.nativePosts.length, 0); assert.equal(f.codexAdapters.length, 0); assert.equal(f.ptySpawns.length, 0);
});

test('native create HTTP preserves an occupied peer and exposes recovery identity after admitted creation loses its view', async t => {
  const f = await fixture(t), original = await f.nativeSession('occupied');
  const binding = f.db.prepare('SELECT * FROM peer_bindings WHERE peer=?').get('occupied');
  const duplicate = await f.request('/api/sessions', { transport: 'native', kind: 'codex', id: 'occupied' });
  assert.equal(duplicate.status, 409); assert.equal(duplicate.body.error.code, 'NATIVE_PEER_IN_USE');
  assert.deepEqual(f.db.prepare('SELECT * FROM peer_bindings WHERE peer=?').get('occupied'), binding);
  assert.equal(original.nativeIdentity.owner, binding.runtime_target);
  f.setNativeReadHook(() => { throw new CliError('NATIVE_RUNTIME_OFFLINE', 'fixture first read failed'); });
  const created = await f.request('/api/sessions', { transport: 'native', kind: 'dsh' });
  assert.equal(created.status, 409); assert.equal(created.body.error.code, 'NATIVE_WORKER_DISCOVERY_FAILED');
  const { peer, provider, created: admitted } = created.body.error.extra;
  assert.equal(provider, 'dsh'); assert.equal(admitted, true); assert.ok(peer);
  assert.equal(f.nativePosts.filter(call => call.route === '/workers').length, 1);
  f.setNativeReadHook(null);
  const listed = await f.request('/api/sessions');
  assert.ok(listed.body.sessions.some(session => session.id === peer && session.type === 'native'));
  assert.equal(f.nativeAdapters.get(peer).closed, 0);
});

test('native HTTP reads actual state; observers cannot mutate a worker, inject terminal input, or write acceptance', async t => {
  const f = await fixture(t), session = await f.nativeSession(); f.task(session.peerId);
  const { controller, observer } = f.controllers(session);
  const read = await f.request('/api/sessions/native-a/native/state');
  assert.equal(read.status, 200); assert.equal(read.body.state.owner, session.binding.runtime_target);
  assert.equal(read.body.state.sessionId, 'session-native-a');
  for (const [route, body] of [
    ['native/send', { text: 'work', submissionId: 'http_native_001' }],
    ['native/interrupt', {}], ['native/close', {}], ['stop', {}], ['input', { text: 'bypass' }],
    ['results', { taskId: 1, title: 'unearned acceptance', status: 'passed', evidence: ['log'] }]
  ]) {
    const rejected = await f.request('/api/sessions/native-a/' + route, { ...body, ...observer });
    assert.equal(rejected.status, 409, route); assert.equal(rejected.body.error.code, 'CONTROL_REQUIRED');
  }
  const raw = await f.request('/api/sessions/native-a/input', { ...controller, text: 'bypass' });
  assert.equal(raw.status, 400); assert.equal(raw.body.error.code, 'BAD_REQUEST');
  assert.deepEqual(f.writes, []); assert.deepEqual(f.nativePosts, []); assert.deepEqual(f.resultEvents(), []);
});

test('native send HTTP preserves the queued receipt and stable ID without turning queue success into completion', async t => {
  const f = await fixture(t), session = await f.nativeSession(); f.task(session.peerId);
  const { controller } = f.controllers(session);
  const input = { ...controller, text: 'queued work', submissionId: 'http_native_002' };
  const result = await f.request('/api/sessions/native-a/native/send', input);
  assert.equal(result.status, 200); assert.equal(result.body.receipt.state, 'queued');
  assert.equal(result.body.receipt.submission_id, input.submissionId);
  assert.equal(result.body.state.backend, 'native'); assert.equal(f.pendingCount(), 1);
  assert.equal(f.nativePosts.length, 1); assert.equal(f.nativeAdapters.get('native-a').sent.length, 0);
  const repeat = await f.request('/api/sessions/native-a/native/send', input);
  assert.equal(repeat.status, 409); assert.equal(repeat.body.error.code, 'SUBMISSION_EXISTS');
  assert.equal(f.nativePosts.length, 1); assert.equal(f.db.prepare('SELECT COUNT(*) n FROM messages').get().n, 1);
  assert.equal(f.db.prepare('SELECT status FROM tasks WHERE id=1').get().status, 'running');
  assert.deepEqual(f.resultEvents(), []);
});

test('native HTTP lease takeover after the awaited state read fences queue persistence and submission', async t => {
  const f = await fixture(t), session = await f.nativeSession();
  const { controller } = f.controllers(session);
  let readsBeforeTakeover = 2;
  f.setNativeReadHook(() => { if (--readsBeforeTakeover === 0) f.lease.claim(session, 'observer', { epoch: controller.epoch, takeover: true }); });
  const rejected = await f.request('/api/sessions/native-a/native/send',
    { ...controller, text: 'do not queue', submissionId: 'http_native_003' });
  assert.equal(rejected.status, 409); assert.equal(rejected.body.error.code, 'STALE_CONTROL_EPOCH');
  assert.equal(readsBeforeTakeover, 0); assert.equal(f.pendingCount(), 0); assert.deepEqual(f.nativePosts, []);
});

test('native HTTP result records keep task owner, executor identity, and independent verification stages', async t => {
  const f = await fixture(t), session = await f.nativeSession(); f.task(session.peerId); f.task('other-peer', 2);
  const { controller } = f.controllers(session);
  const mismatch = await f.request('/api/sessions/native-a/results',
    { ...controller, taskId: 2, title: 'wrong task', status: 'passed', evidence: ['test.log'] });
  assert.equal(mismatch.status, 409); assert.equal(mismatch.body.error.code, 'TASK_OWNER_MISMATCH');
  for (const [stage, status, evidence] of [['local', 'passed', ['test.log']], ['publication', 'pending', []]]) {
    const result = await f.request('/api/sessions/native-a/results', { ...controller, taskId: 1, stage, status, evidence, title: stage });
    assert.equal(result.status, 200); assert.equal(result.body.result.executor_id, session.nativeSnapshot().executorId);
    assert.equal(result.body.result.thread_id, 'session-native-a');
  }
  const read = await f.request('/api/sessions/native-a/results');
  assert.equal(read.body.results.length, 2); assert.equal(read.body.summary.local.status, 'passed');
  assert.equal(read.body.summary.publication.status, 'pending'); assert.equal(read.body.summary.business, null);
  assert.equal(f.db.prepare('SELECT status,owner FROM tasks WHERE id=1').get().status, 'running');
  assert.deepEqual(f.nativePosts, []);
});

test('native result HTTP rechecks lease after the owner read and refuses an old controller', async t => {
  const f = await fixture(t), session = await f.nativeSession(); f.task(session.peerId);
  const { controller } = f.controllers(session);
  f.setNativeReadHook(() => f.lease.claim(session, 'observer', { epoch: controller.epoch, takeover: true }));
  const rejected = await f.request('/api/sessions/native-a/results',
    { ...controller, taskId: 1, title: 'stale acceptance', status: 'passed', evidence: ['log'] });
  assert.equal(rejected.status, 409); assert.equal(rejected.body.error.code, 'STALE_CONTROL_EPOCH');
  assert.deepEqual(f.resultEvents(), []);
});

test('native HTTP close retires browser credentials while preserving independent business task state', async t => {
  const f = await fixture(t), session = await f.nativeSession(); f.task(session.peerId);
  const { controller } = f.controllers(session);
  const closed = await f.request('/api/sessions/native-a/native/close', controller);
  assert.equal(closed.status, 200); assert.equal(closed.body.state.status, 'closed');
  assert.equal(f.nativeAdapters.get('native-a').closed, 1); assert.equal(f.lease.status(session).has_controller, false);
  assert.equal(f.db.prepare('SELECT status FROM tasks WHERE id=1').get().status, 'running');
  const stale = await f.request('/api/sessions/native-a/results',
    { ...controller, taskId: 1, title: 'after close', status: 'passed', evidence: ['log'] });
  assert.equal(stale.status, 409); assert.deepEqual(f.resultEvents(), []);
});

test('native HTTP worker replacement forgets the old owner lease and refuses its pending submission', async t => {
  const f = await fixture(t), source = await f.nativeSession();
  const { controller } = f.controllers(source), originalOwner = source.nativeSnapshot().owner;
  await f.api('POST', '/close', { peer: source.peerId });
  await f.api('POST', '/workers', { peer: source.peerId, provider: 'codex', resume: 'last' });
  const rejected = await f.request('/api/sessions/native-a/native/send',
    { ...controller, text: 'old owner send', submissionId: 'http_native_004' });
  assert.equal(rejected.status, 409); assert.equal(source.nativeRetired, true);
  const replacement = [...f.sessions.values()].find(session => session.id === source.id);
  assert.notEqual(replacement, source); assert.notEqual(replacement.nativeSnapshot().owner, originalOwner);
  assert.equal(f.lease.status(replacement).has_controller, false); assert.equal(f.pendingCount(), 0);
  assert.deepEqual(f.nativePosts, []);
});

test('native result HTTP verifies the old view owner before writing after same-generation replacement', async t => {
  const f = await fixture(t), source = await f.nativeSession(); f.task(source.peerId);
  const { controller } = f.controllers(source);
  await f.api('POST', '/close', { peer: source.peerId });
  await f.api('POST', '/workers', { peer: source.peerId, provider: 'codex', resume: 'last' });
  const rejected = await f.request('/api/sessions/native-a/results',
    { ...controller, taskId: 1, title: 'wrong executor acceptance', status: 'passed', evidence: ['log'] });
  assert.equal(rejected.status, 409); assert.equal(rejected.body.error.code, 'NATIVE_OWNER_CHANGED');
  assert.equal(source.nativeRetired, true); assert.equal(f.lease.status(source).has_controller, false);
  assert.deepEqual(f.resultEvents(), []);
});

test('native result accepts the executor identity of a valid maximum-length peer', async t => {
  const f = await fixture(t), session = await f.nativeSession('n'.repeat(128)); f.task(session.peerId);
  const { controller } = f.controllers(session);
  const result = await f.request('/api/sessions/' + session.id + '/results',
    { ...controller, taskId: 1, title: 'long peer identity', status: 'passed', evidence: ['test.log'] });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.result.executor_id, session.nativeSnapshot().executorId);
});

test('legacy PTY creation cannot replace a disconnected native worker with the same peer', async t => {
  const f = await fixture(t), source = await f.nativeSession();
  const { controller } = f.controllers(source);
  const before = { ...f.db.prepare('SELECT * FROM peer_bindings WHERE peer=?').get(source.id) };
  source.status = 'disconnected';
  const rejected = await f.request('/api/sessions', { ...controller, id: source.id, kind: 'codex',
    backend: 'pty', command: 'fake-codex-command', force: true });
  assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
  assert.equal(f.ptySpawns.length, 0);
  assert.deepEqual({ ...f.db.prepare('SELECT * FROM peer_bindings WHERE peer=?').get(source.id) }, before);
});

test('legacy PTY creation cannot adopt an unscanned native provider thread through a new peer alias', async t => {
  const f = await fixture(t), source = await f.nativeSession();
  f.sessions.clear();
  const before = { ...f.db.prepare('SELECT * FROM peer_bindings WHERE peer=?').get(source.id) };
  const rejected = await f.request('/api/sessions', { id: 'new-alias', kind: 'codex', backend: 'pty', force: true,
    command: 'fake-codex-command', binding: { provider: 'codex', provider_session_id: 'session-native-a' } });
  assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
  assert.equal(f.ptySpawns.length, 0);
  assert.deepEqual({ ...f.db.prepare('SELECT * FROM peer_bindings WHERE peer=?').get(source.id) }, before);
});

test('legacy detected inbox HTTP cannot bypass native worker control with an observer message', async t => {
  const f = await fixture(t), session = await f.nativeSession();
  const { observer } = f.controllers(session);
  const rejected = await f.request('/api/detected/native-a/msg', { ...observer, body: 'observer bypass' });
  await f.pollNative();
  assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM messages').get().n, 0);
  assert.equal(f.nativeAdapters.get('native-a').sent.length, 0);
});

test('legacy detected inbox HTTP cannot submit to an unscanned native worker', async t => {
  const f = await fixture(t); await f.nativeSession(); f.sessions.clear();
  const rejected = await f.request('/api/detected/native-a/msg', { body: 'unscanned bypass' });
  await f.pollNative();
  assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM messages').get().n, 0);
  assert.equal(f.nativeAdapters.get('native-a').sent.length, 0);
});

test('legacy detected broadcast HTTP cannot inject turns into unscanned native workers', async t => {
  const f = await fixture(t); await f.nativeSession(); f.sessions.clear();
  const rejected = await f.request('/api/detected/all/msg', { body: 'broadcast bypass' });
  await f.pollNative();
  assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM messages').get().n, 0);
  assert.equal(f.nativeAdapters.get('native-a').sent.length, 0);
});

test('Codex HTTP history is project scoped and reads without changing the live source executor', async t => {
  const f = await fixture(t), source = await f.codexSession(); f.controllers(source);
  const adaptersBefore = f.codexAdapters.length;
  const listed = await f.request('/api/codex/threads?limit=1');
  assert.equal(listed.status, 200); assert.deepEqual(listed.body.threads.map(row => row.id), ['thread-1']);
  assert.equal(listed.body.threads[0].managedSessionId, source.id);
  const read = await f.request('/api/codex/threads/thread-1');
  assert.equal(read.status, 200); assert.equal(read.body.thread.id, 'thread-1');
  assert.equal(f.codexAdapters.length, adaptersBefore); assert.equal(source.binding.provider_session_id, 'thread-1');
  assert.equal(f.codexCalls.some(call => ['fork', 'resume'].includes(call.method)), false);
  const bad = await f.request('/api/codex/threads?limit=0'); assert.equal(bad.status, 400);
});

test('Codex HTTP fork rejects observers and stale leases, returns the new session wrapper, and keeps source task ownership', async t => {
  const f = await fixture(t), source = await f.codexSession(); f.task(source.peerId);
  const { controller, observer } = f.controllers(source);
  const rejected = await f.request('/api/codex/threads/thread-1/fork', { ...observer, confirmed: true });
  assert.equal(rejected.status, 409); assert.equal(rejected.body.error.code, 'CONTROL_REQUIRED');
  assert.equal(f.codexAdapters.length, 1);
  const forked = await f.request('/api/codex/threads/thread-1/fork', { ...controller, confirmed: true });
  assert.equal(forked.status, 200, JSON.stringify(forked.body));
  assert.equal(forked.body.session.type, 'app-server'); assert.equal(forked.body.session.threadId, forked.body.thread.id);
  assert.equal(forked.body.source_thread_id, 'thread-1'); assert.notEqual(forked.body.session.id, source.id);
  assert.equal(f.codexAdapters[1].snapshot().processExited, true, 'temporary fork executor closes before managed resume');
  assert.equal(f.codexAdapters[0].snapshot().processExited, false);
  assert.equal(f.db.prepare('SELECT owner,status FROM tasks WHERE id=1').get().owner, source.peerId);
  f.lease.claim(source, 'observer', { epoch: controller.epoch, takeover: true });
  const stale = await f.request('/api/codex/threads/thread-1/fork', { ...controller, confirmed: true });
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'STALE_CONTROL_EPOCH');
  assert.equal(f.codexCalls.filter(call => call.method === 'fork').length, 1);
});

test('Codex HTTP fork rechecks source authority after async read and immediately before fork mutation', async t => {
  let takeover;
  const f = await fixture(t, { beforeForkSubmit: () => takeover() }), source = await f.codexSession();
  const { controller } = f.controllers(source);
  takeover = () => f.lease.claim(source, 'observer', { epoch: controller.epoch, takeover: true });
  const rejected = await f.request('/api/codex/threads/thread-1/fork', { ...controller, confirmed: true });
  assert.equal(rejected.status, 409); assert.equal(rejected.body.error.code, 'STALE_CONTROL_EPOCH');
  assert.equal(f.codexCalls.some(call => call.method === 'fork'), false);
  assert.equal(f.codexCalls.some(call => call.method === 'resume'), false);
  assert.equal(f.codexAdapters[1].snapshot().processExited, true);
});

test('Codex HTTP fork still fences an exited view whose owned executor has not confirmed exit', async t => {
  const f = await fixture(t), source = await f.codexSession();
  const { observer } = f.controllers(source);
  // A transport disconnect marks the view exited before asynchronous process
  // termination is confirmed; it must not release the source controller fence.
  source.status = 'exited'; f.codexAdapters[0].state.status = 'disconnected';
  assert.equal(source.executorReleased, undefined); assert.equal(source.adapter.snapshot().processExited, false);
  const rejected = await f.request('/api/codex/threads/thread-1/fork', { ...observer, confirmed: true });
  assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
  assert.equal(rejected.body.error.code, 'CONTROL_REQUIRED');
  assert.equal(f.codexCalls.some(call => call.method === 'fork'), false);
});

test('history GC preserves native dedup, task evidence, and the executor receipt used by scoped MCP authority', async t => {
  const f = await fixture(t), session = await f.nativeSession(); f.task(session.peerId);
  const { controller } = f.controllers(session);
  await f.codexSession();
  const queued = await f.request('/api/sessions/native-a/native/send',
    { ...controller, text: 'GC must not replay', submissionId: 'http_native_005' });
  assert.equal(queued.status, 200);
  const recorded = await f.request('/api/sessions/native-a/results',
    { ...controller, taskId: 1, title: 'GC must retain evidence', status: 'passed', evidence: ['log'] });
  assert.equal(recorded.status, 200);
  const durable = ['native.web.submission.pending', 'task.result.recorded', 'codex.executor.started'];
  const before = f.db.prepare('SELECT id,type,payload FROM events ORDER BY id').all().filter(row => durable.includes(row.type));
  assert.equal(before.length, 3);
  f.db.prepare("INSERT INTO events(type,payload,created_at) VALUES('diagnostic','{}',1)").run();
  const snapshot = createHistoryGcSnapshot(f.db, 2000, { categories: ['events'] });
  try {
    const plan = captureHistoryGcPlan(f.db, 2000, { snapshot });
    assert.equal(plan.events.some(row => durable.includes(row.type)), false);
  } finally { dropHistoryGcSnapshot(f.db, snapshot); }
  pruneOldEventsPreservingTmuxAuthority(f.db, 2000);
  assert.deepEqual(f.db.prepare('SELECT id,type,payload FROM events ORDER BY id').all(), before);
  const duplicate = await f.request('/api/sessions/native-a/native/send',
    { ...controller, text: 'GC must not replay', submissionId: 'http_native_005' });
  assert.equal(duplicate.status, 409); assert.equal(duplicate.body.error.code, 'SUBMISSION_EXISTS');
  assert.equal(f.nativePosts.length, 1); assert.equal(f.resultEvents().length, 1);
});

test('native interaction HTTP requires the current controller and exact executor/session/turn/request', async t => {
  const f = await fixture(t), session = await f.nativeSession(), adapter = f.nativeAdapters.get(session.peerId);
  const state = session.nativeSnapshot(), pending = { executorId: state.executorId, sessionId: state.sessionId, turnId: 'turn-approve', requestId: 21, kind: 'approval', status: 'pending', params: { command: 'npm test' } };
  adapter.state.turnId = pending.turnId; adapter.state.pendingApprovals = [pending];
  const { controller, observer } = f.controllers(session), route = '/api/sessions/' + session.id + '/native/respond';
  const forbidden = await f.request(route, { ...pending, ...observer, decision: 'accept' });
  assert.equal(forbidden.body.error.code, 'CONTROL_REQUIRED'); assert.equal(f.nativePosts.length, 0);
  const oldExecutor = await f.request(route, { ...pending, ...controller, executorId: 'other', decision: 'accept' });
  assert.equal(oldExecutor.body.error.code, 'NATIVE_APPROVAL_MISMATCH');
  const oldTurn = await f.request(route, { ...pending, ...controller, turnId: 'old', decision: 'accept' });
  assert.equal(oldTurn.body.error.code, 'NATIVE_APPROVAL_MISMATCH'); assert.equal(adapter.state.pendingApprovals.length, 1);
  const result = await f.request(route, { ...pending, ...controller, decision: 'accept' });
  assert.equal(result.status, 200); assert.equal(result.body.receipt.status, 'submitted'); assert.equal(result.body.state.pendingApprovals.length, 0);
  const repeated = await f.request(route, { ...pending, ...controller, decision: 'accept' }); assert.equal(repeated.body.error.code, 'NATIVE_APPROVAL_MISMATCH');
});

test('native approval lease takeover during the awaited worker read fences the responder', async t => {
  const f = await fixture(t), session = await f.nativeSession(), adapter = f.nativeAdapters.get(session.peerId), state = session.nativeSnapshot();
  const pending = { executorId: state.executorId, sessionId: state.sessionId, turnId: 'turn-approve', requestId: 'exact', kind: 'approval', params: {} };
  adapter.state.pendingApprovals = [pending]; adapter.state.turnId = pending.turnId;
  const { controller } = f.controllers(session); let reads = 2;
  f.setNativeReadHook(() => { if (--reads === 0) f.lease.claim(session, 'observer', { epoch: controller.epoch, takeover: true }); });
  const result = await f.request('/api/sessions/' + session.id + '/native/respond', { ...pending, ...controller, decision: 'accept' });
  assert.equal(result.body.error.code, 'STALE_CONTROL_EPOCH'); assert.equal(f.nativePosts.length, 0); assert.equal(adapter.state.pendingApprovals.length, 1);
});
