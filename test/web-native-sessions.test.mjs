import assert from 'node:assert/strict';
import fs from 'node:fs';
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
import { startNativeService } from '../lib/runtime/native/service.mjs';
import { nativeRequest } from '../lib/runtime/native/client.mjs';
import { createNativeSessions } from '../lib/web/native-sessions.mjs';
import { createClaudeAdapter } from '../lib/integrations/native/claude.mjs';
import { createCodexAdapter } from '../lib/integrations/native/codex.mjs';
import { createNativeStore } from '../lib/runtime/native/store.mjs';
import { createAgentDefaults } from '../lib/web/agent-defaults.mjs';
import { createSessionSerialize } from '../lib/web/session-serialize.mjs';
import { createSessionSync } from '../lib/web/browser/session-sync.mjs';
import { createNativeTestRoot } from './helpers/native-root.mjs';

// Real project SQLite and authenticated loopback native protocol, fake owned
// provider adapters. No model, account, external terminal, or tmux is invoked.
async function fixture(t, configuration = {}) {
  const root = await createNativeTestRoot('hcc-web-native-');
  const ctx = { root, dbPath: path.join(root, '.hello-cc', 'mesh.db') };
  fs.mkdirSync(path.dirname(ctx.dbPath));
  const mesh = new DatabaseSync(ctx.dbPath);
  initSchema(mesh);
  mesh.exec('PRAGMA journal_mode=WAL');
  const connect = (project = ctx) => {
    const db = new DatabaseSync(project.dbPath);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
    return db;
  };
  const events = createEventHelpers();
  const bindings = createPeerBindingStore(events);
  const peers = createPeerHelpers({ now: () => Math.floor(Date.now() / 1000), liveProcessIdentity: () => null });
  const messages = createMessageStore(events);
  const deps = { ...events, ...bindings, ...peers, ...messages,
    connect, detectBranch: () => '', liveProcessIdentity: () => inspectProcessIdentity(process.pid).identity };
  const adapters = new Map(), created = [], bridges = [];
  const options = { pollMs: 60000, adapterFactory: async (provider, options) => {
    const peer = options.env.HCC_PEER;
    if (configuration[peer]?.codexRpc) {
      const adapter = createCodexAdapter({ ...options, rpcFactory: () => configuration[peer].codexRpc });
      adapters.set(peer, adapter); created.push(adapter); return adapter;
    }
    if (configuration[peer]?.realClaude) {
      const adapter = createClaudeAdapter({ ...options, query: () => { throw new Error('This fixture must not start a model query'); } });
      adapters.set(peer, adapter); created.push(adapter); return adapter;
    }
    if (configuration[peer]?.claudeSdk) {
      const sdk = configuration[peer].claudeSdk;
      const adapter = createClaudeAdapter({ ...options, query: input => sdk.query(input),
        onEvent: event => { options.onEvent(event); sdk.observed(event); } });
      adapters.set(peer, adapter); created.push(adapter); return adapter;
    }
    const state = { provider, status: 'new', sessionId: null, turnId: null, executorId: options.executorId,
      capabilities: { send: true, resume: true, interrupt: true, close: true } };
    const adapter = { state, options, sent: [], interrupted: [], closed: 0,
      capabilities: state.capabilities, snapshot: () => structuredClone(state),
      async open(input) { this.openInput = input; state.sessionId = input.sessionId || (configuration[peer]?.unknownSession ? null : 'session-' + peer);
        if (configuration[peer]?.resumeError && input.sessionId) throw configuration[peer].resumeError;
        state.status = 'idle'; return this.snapshot(); },
      async send(input) { this.sent.push(input); this.active = input; state.status = 'running'; state.turnId = 'turn-' + peer;
        return { status: 'queued', turnId: state.turnId }; },
      emit(event) { options.onEvent({ provider, sessionId: state.sessionId, ...event }); },
      complete() { const turnId = state.turnId; state.status = 'idle'; state.turnId = null;
        this.emit({ type: 'message', text: 'answer from ' + peer, submissionId: this.active.submissionId, turnId });
        this.emit({ type: 'completed', status: 'completed', submissionId: this.active.submissionId, turnId }); },
      async interrupt(input) { this.interrupted.push(input); return { status: 'interrupt_requested', turnId: input.turnId }; },
      async close() { if (state.status === 'closed') return; this.closed++; if (configuration[peer]?.closeError) throw configuration[peer].closeError; state.status = 'closed'; }
    };
    adapters.set(peer, adapter); created.push(adapter); return adapter;
  } };
  let service = await startNativeService(ctx, deps, options);
  const api = (method, route, body) => nativeRequest(ctx, method, route, body, { timeoutMs: 3000 });
  const key = (project, id) => project.root + '\0' + id;
  function bridge(nativeApi = nativeRequest, sessions = new Map(), options = {}) {
    const broadcasts = [], closedClients = [];
    const manager = createNativeSessions({ sessions, sessionKey: key, connectWebProject: connect,
      addEvent: events.addEvent, nativeApi,
      broadcast: (session, payload) => broadcasts.push({ session, payload }),
      closeSessionClients: (session) => { closedClients.push(session); session.clients.clear(); session.actionTokens.clear(); }, ...options });
    bridges.push(manager);
    return { ...manager, sessions, broadcasts, closedClients,
      session: (peer = 'a') => sessions.get(key(ctx, peer)) };
  }
  t.after(async () => {
    for (const bridge of bridges) bridge.closeNativeBridge();
    await service.shutdown(); mesh.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  return { ctx, mesh, api, adapters, created, bridge, key, defaults: createAgentDefaults({ connectWebProject: connect }),
    start: (peer = 'a', extra = {}) => api('POST', '/workers', { peer, provider: 'codex', ...extra }),
    get service() { return service; },
    async restart() { await service.shutdown(); service = await startNativeService(ctx, deps, options); },
    receipts: () => mesh.prepare("SELECT type,payload FROM events WHERE type LIKE 'native.web.submission.%' ORDER BY id").all()
      .map((row) => ({ ...row, payload: JSON.parse(row.payload) })) };
}

function controlledCodexRpc() {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const rpc = {
    async start() {}, async notify() {}, async close() {},
    async request(method, input) {
      calls.push(method);
      if (method === 'initialize') return {};
      if (method === 'thread/start') { entered(); await gate; return { thread: { id: 'confirmed-codex-session', turns: [] } }; }
      if (method === 'thread/resume') return { thread: { id: input.threadId, turns: [] } };
      throw new Error('This fixture must not send a model or account request: ' + method);
    }
  };
  return { rpc, calls, started, release: () => release() };
}

for (const viaReadAction of [false, true]) for (const applyFreshFirst of [false, true]) {
  test(`Codex creation preserves its opening Web view when a null-session ${viaReadAction ? 'explicit read' : 'poll snapshot'} arrives late${applyFreshFirst ? ' after a fresh read' : ''}`, async t => {
    const provider = controlledCodexRpc();
    const f = await fixture(t, { a: { codexRpc: provider.rpc } });
    let hold = false, capture, release, captureCreate, releaseCreate, stateReads = 0;
    const captured = new Promise(resolve => { capture = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const created = new Promise(resolve => { captureCreate = resolve; });
    const createGate = new Promise(resolve => { releaseCreate = resolve; });
    t.after(() => { provider.release(); release(); releaseCreate(); });
    const web = f.bridge(async (ctx, method, route, body, options) => {
      if (method === 'GET' && route.startsWith('/workers/a/state')) stateReads++;
      const value = await nativeRequest(ctx, method, route, body, options);
      if (method === 'POST' && route === '/workers') { captureCreate(value); await createGate; }
      if (hold && method === 'GET' && route.startsWith('/workers/a/state')) { hold = false; capture(value); await gate; }
      return value;
    });
    const starting = web.startNativeSession({ projectCtx: f.ctx, transport: 'native', kind: 'codex', id: 'a' });
    void starting.catch(() => {}); // Keep an earlier lifecycle assertion failure from leaking this pending rejection.
    await provider.started;
    await web.discoverNativeSessions(f.ctx);
    const view = web.session(), client = { fixture: true };
    view.clients.add(client); view.actionTokens.add('opening-controller');
    assert.equal(view.nativeIdentity.sessionId, null);
    assert.equal(view.nativeSnapshot().status, 'opening');
    hold = true;
    const reading = viaReadAction ? web.nativeAction(view, 'read') : web.discoverNativeSessions(f.ctx);
    const stale = await captured;
    assert.equal(stale.snapshot.sessionId, null);
    provider.release();
    const receipt = await created;
    assert.equal(receipt.sessionId, 'confirmed-codex-session');
    if (applyFreshFirst) await web.nativeAction(view, 'read');
    const readsBeforeRelease = stateReads;
    release(); await reading;
    assert.equal(stateReads, readsBeforeRelease + 1, 'initialization confirmation uses one extra state read');
    releaseCreate();
    assert.equal(await starting, view);
    assert.equal(web.session(), view);
    assert.equal(view.nativeRetired, undefined);
    assert.equal(view.nativeIdentity.sessionId, receipt.sessionId);
    assert.equal(view.nativeIdentity.owner, receipt.executorId);
    assert.equal(view.nativeSnapshot().connected, true);
    assert.equal(view.nativeSnapshot().status, 'idle');
    assert.equal(view.clients.has(client), true);
    assert.equal(view.actionTokens.has('opening-controller'), true);
    assert.equal(web.closedClients.includes(view), false);
    assert.equal(f.created.length, 1);
    assert.deepEqual(provider.calls, ['initialize', 'thread/start']);
  });
}

for (const replaceService of [false, true]) {
  test(`Codex initialization confirmation rejects a ${replaceService ? 'service generation' : 'worker owner'} replaced before the second read`, async t => {
    const provider = controlledCodexRpc();
    const f = await fixture(t, { a: { codexRpc: provider.rpc } });
    let hold = false, replace = false, capture, release, captureCreate, releaseCreate;
    const captured = new Promise(resolve => { capture = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const created = new Promise(resolve => { captureCreate = resolve; });
    const createGate = new Promise(resolve => { releaseCreate = resolve; });
    t.after(() => { provider.release(); release(); releaseCreate(); });
    const web = f.bridge(async (ctx, method, route, body, options) => {
      if (replace && method === 'GET' && route.startsWith('/workers/a/state')) {
        replace = false;
        if (replaceService) await f.restart();
        else await f.api('POST', '/close', { peer: 'a' });
        await f.start('a', { resume: 'last' });
      }
      const value = await nativeRequest(ctx, method, route, body, options);
      if (method === 'POST' && route === '/workers') { captureCreate(); await createGate; }
      if (hold && method === 'GET' && route.startsWith('/workers/a/state')) { hold = false; capture(); await gate; }
      return value;
    });
    const starting = web.startNativeSession({ projectCtx: f.ctx, transport: 'native', kind: 'codex', id: 'a' });
    void starting.catch(() => {});
    await provider.started;
    await web.discoverNativeSessions(f.ctx);
    const view = web.session(); view.actionTokens.add('old-controller');
    hold = true;
    const scanning = web.discoverNativeSessions(f.ctx);
    await captured;
    provider.release(); await created;
    replace = true; release(); await scanning;
    assert.equal(view.nativeRetired, true);
    assert.equal(view.nativeSnapshot().error.code, 'NATIVE_OWNER_CHANGED');
    assert.equal(view.actionTokens.size, 0);
    releaseCreate();
    await assert.rejects(starting, { code: 'NATIVE_WORKER_DISCOVERY_FAILED' });
    await assert.rejects(web.nativeAction(view, 'read'), { code: 'NATIVE_OWNER_CHANGED' });
    assert.equal(f.mesh.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
  });
}

test('a nonnull Codex session mismatch is rejected without initialization retry', async t => {
  const f = await fixture(t); await f.start('a');
  let mismatch = false, stateReads = 0;
  const web = f.bridge(async (ctx, method, route, body, options) => {
    const value = await nativeRequest(ctx, method, route, body, options);
    if (method === 'GET' && route.startsWith('/workers/a/state')) {
      stateReads++;
      if (mismatch) value.snapshot.sessionId = 'different-session';
    }
    return value;
  });
  await web.discoverNativeSessions(f.ctx);
  const view = web.session(), before = stateReads;
  mismatch = true;
  await assert.rejects(web.nativeAction(view, 'read'), { code: 'NATIVE_OWNER_CHANGED' });
  assert.equal(stateReads, before + 1);
  assert.equal(view.nativeRetired, true);
});

function controlledClaudeSdk() {
  const output = [];
  let waiting, ended = false, request, confirmInit, confirmQuery;
  const initialized = new Promise(resolve => { confirmInit = resolve; });
  const queryStarted = new Promise(resolve => { confirmQuery = resolve; });
  const stream = {
    [Symbol.asyncIterator]() { return this; },
    next() {
      if (output.length) return Promise.resolve({ value: output.shift(), done: false });
      if (ended) return Promise.resolve({ done: true });
      return new Promise(resolve => { waiting = resolve; });
    },
    async close() {
      ended = true;
      await request?.prompt.return();
      waiting?.({ done: true }); waiting = null;
    }
  };
  return {
    query(input) { request = input; confirmQuery(input); return stream; },
    async consume() { return (await queryStarted).prompt.next(); },
    observed(event) { if (event.initialized) confirmInit(); },
    async initialize(sessionId) {
      const value = { type: 'system', subtype: 'init', session_id: sessionId };
      if (waiting) { const resolve = waiting; waiting = null; resolve({ value, done: false }); }
      else output.push(value);
      await initialized;
    }
  };
}

for (const viaReadAction of [false, true]) for (const applyFreshFirst of [false, true]) {
  test(`Claude initialization preserves its Web owner when a running/null ${viaReadAction ? 'explicit read' : 'poll snapshot'} arrives late${applyFreshFirst ? ' after a fresh read' : ''}`, async t => {
    const sdk = controlledClaudeSdk();
    const f = await fixture(t, { c: { claudeSdk: sdk } });
    await f.start('c', { provider: 'claude' });
    let hold = false, captured, release;
    const capturedSnapshot = new Promise(resolve => { captured = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const sessions = new Map(), frames = [], clientCloses = [], receiverRecoveries = [];
    const serializer = createSessionSerialize({ sessions, ctx: f.ctx, cookieSocketValid: () => true,
      sameResolvedPath: (a, b) => path.resolve(a) === path.resolve(b) });
    const receiver = createSessionSync({ root: f.ctx.root, sessionId: 'c',
      requestSnapshot: frame => receiverRecoveries.push(frame) });
    const client = { OPEN: 1, readyState: 1, bufferedAmount: 0, hccStateSync: true,
      send(text) { const frame = JSON.parse(text); frames.push(frame); receiver.receive(frame); },
      close(code, reason) { clientCloses.push({ code, reason }); } };
    let stateReads = 0;
    const web = f.bridge(async (ctx, method, route, body, options) => {
      if (route.startsWith('/workers/c/state')) stateReads++;
      const value = await nativeRequest(ctx, method, route, body, options);
      if (hold && method === 'GET' && route.startsWith('/workers/c/state')) {
        hold = false; captured(value); await gate;
      }
      return value;
    }, sessions, { broadcast: serializer.broadcast, closeSessionClients: serializer.closeSessionClients });
    await web.discoverNativeSessions(f.ctx);
    const view = web.session('c');
    const identity = { ...view.nativeIdentity };
    view.actionTokens.add('original-controller');
    view.clients.add(client);
    serializer.sendStateSnapshot(view, client);
    assert.equal(receiver.state.sessionId, null);
    await web.nativeAction(view, 'send', { text: 'controlled first message', submissionId: 'claude_init_order_1' });
    await f.service.poll();
    await sdk.consume();
    hold = true;
    const poll = viaReadAction ? web.nativeAction(view, 'read') : web.pollNativeSessions(f.ctx);
    const stale = await capturedSnapshot;
    assert.equal(stale.snapshot.status, 'running');
    assert.equal(stale.snapshot.sessionId, null);
    await sdk.initialize('confirmed-sdk-session');
    assert.equal(f.mesh.prepare('SELECT provider_session_id FROM peer_bindings WHERE peer=?').get('c').provider_session_id,
      'confirmed-sdk-session');
    if (applyFreshFirst) await web.nativeAction(view, 'read');
    const readsBeforeRelease = stateReads;
    release(); await poll;
    assert.equal(web.session('c'), view);
    assert.equal(view.nativeRetired, undefined);
    assert.equal(view.nativeSnapshot().connected, true);
    assert.equal(view.nativeIdentity.owner, identity.owner);
    assert.equal(view.nativeIdentity.generation, identity.generation);
    assert.equal(view.nativeIdentity.sessionId, 'confirmed-sdk-session');
    assert.equal(view.actionTokens.has('original-controller'), true);
    assert.equal(web.closedClients.length, 0);
    assert.equal(stateReads, readsBeforeRelease + 1, 'initialization confirmation uses exactly one extra state read');
    assert.equal(receiver.state.sessionId, 'confirmed-sdk-session');
    assert.equal(receiver.state.connected, true);
    assert.equal(receiver.state.owner, identity.owner);
    assert.equal(receiver.state.generation, identity.generation);
    assert.equal(new Set(frames.map(frame => frame.generation)).size, 1, 'wire generation stays stable');
    assert.deepEqual(receiverRecoveries, []);
    assert.deepEqual(clientCloses, []);
    assert.equal(f.created.length, 1);
  });
}

for (const replaceService of [false, true]) {
  test(`Claude initialization confirmation rejects a ${replaceService ? 'service generation' : 'worker owner'} replaced before the second read`, async t => {
    const sdk = controlledClaudeSdk();
    const f = await fixture(t, { c: { claudeSdk: sdk } });
    await f.start('c', { provider: 'claude' });
    let hold = false, captured, release, replace = false;
    const capturedSnapshot = new Promise(resolve => { captured = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const web = f.bridge(async (ctx, method, route, body, options) => {
      if (replace && method === 'GET' && route.startsWith('/workers/c/state')) {
        replace = false;
        if (replaceService) await f.restart();
        else await f.api('POST', '/close', { peer: 'c' });
        await f.start('c', { provider: 'claude', resume: 'last' });
      }
      const value = await nativeRequest(ctx, method, route, body, options);
      if (hold && method === 'GET' && route.startsWith('/workers/c/state')) {
        hold = false; captured(); await gate;
      }
      return value;
    });
    await web.discoverNativeSessions(f.ctx);
    const view = web.session('c'); view.actionTokens.add('old-controller');
    await web.nativeAction(view, 'send', { text: 'first message', submissionId: 'claude_replace_order_1' });
    await f.service.poll(); await sdk.consume();
    hold = true;
    const poll = web.pollNativeSessions(f.ctx);
    await capturedSnapshot;
    await sdk.initialize('confirmed-sdk-session');
    replace = true; release(); await poll;
    assert.equal(view.nativeRetired, true);
    assert.equal(view.nativeSnapshot().error.code, 'NATIVE_OWNER_CHANGED');
    assert.equal(view.actionTokens.size, 0);
    assert.ok(web.closedClients.includes(view));
    await assert.rejects(web.nativeAction(view, 'send', { text: 'stale message', submissionId: 'claude_replace_order_2' }),
      { code: 'NATIVE_OWNER_CHANGED' });
    assert.equal(f.mesh.prepare('SELECT COUNT(*) AS n FROM messages WHERE kind<>?').get('reply').n, 1,
      'replacement never receives input through the original controller');
  });
}

test('a confirmed Claude session cannot change to another UUID on the same worker owner', async t => {
  const f = await fixture(t); await f.start('c', { provider: 'claude' });
  let stateReads = 0;
  const web = f.bridge((ctx, method, route, body, options) => {
    if (route.startsWith('/workers/c/state')) stateReads++;
    return nativeRequest(ctx, method, route, body, options);
  });
  await web.discoverNativeSessions(f.ctx);
  const view = web.session('c'); view.actionTokens.add('old-controller');
  f.adapters.get('c').state.sessionId = 'different-confirmed-uuid';
  f.adapters.get('c').emit({ type: 'status', status: 'idle' });
  const before = stateReads;
  await assert.rejects(web.nativeAction(view, 'read'), { code: 'NATIVE_OWNER_CHANGED' });
  assert.equal(stateReads, before + 1, 'known identity changes never enter initialization confirmation');
  assert.equal(view.nativeRetired, true);
  assert.equal(view.nativeIdentity.sessionId, 'session-c');
  assert.equal(view.actionTokens.size, 0);
});

test('Web creates each native provider through the existing daemon and opens the same owned worker', async t => {
  const f = await fixture(t), web = f.bridge();
  const cwd = path.join(f.ctx.root, 'subproject'); fs.mkdirSync(cwd);
  for (const kind of ['codex', 'claude', 'dsh']) {
    const session = await web.startNativeSession({ projectCtx: f.ctx, transport: 'native', kind, id: `new-${kind}`,
      ...(kind === 'claude' ? {} : { cwd: 'subproject', model: 'provider-model' }) });
    assert.equal(session.type, 'native'); assert.equal(session.kind, kind);
    assert.equal(session.nativeIdentity.owner, f.adapters.get(session.id).state.executorId);
    assert.equal(session.cwd, kind === 'claude' ? f.ctx.root : cwd);
    assert.equal(f.adapters.get(session.id).openInput.model, kind === 'claude' ? undefined : 'provider-model');
    assert.equal(f.adapters.get(session.id).openInput.sessionId, undefined);
    assert.equal(session.adapter, undefined);
  }
  assert.equal(f.created.length, 3);
  web.closeNativeBridge();
  assert.ok((await f.api('GET', '/status')).workers.every(worker => worker.owned));
  assert.ok(f.created.every(adapter => adapter.closed === 0));
});

test('Web native creation rejects ambiguous inputs, foreign paths and existing owners before launching', async t => {
  const f = await fixture(t);
  let launches = 0;
  const web = f.bridge(nativeRequest, new Map(), { ensureRuntime: async () => { launches++; } });
  const base = { projectCtx: f.ctx, transport: 'native', kind: 'codex', id: 'new-worker' };
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-native-outside-')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(f.ctx.root, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(f.ctx.root, 'ordinary-file'), 'not a directory');
  for (const change of [{ kind: 'shell' }, { id: 'all' }, { id: '' }, { id: '../escape' }, { id: null },
    { model: 1 }, { model: 'x'.repeat(257) }, { cwd: '' }, { cwd: null }, { cwd: 'missing' },
    { cwd: 'ordinary-file' }, { mode: 'new' }, { resume: 'last' }, { force: false },
    { binary: 'codex' }, { env: {} }, { command: 'codex' }, { backend: 'native' }, { db: outside }]) {
    await assert.rejects(web.startNativeSession({ ...base, ...change }), { code: 'BAD_REQUEST' });
  }
  for (const cwd of [outside, 'outside', '..']) {
    await assert.rejects(web.startNativeSession({ ...base, cwd }), { code: 'PROJECT_PATH_FORBIDDEN' });
  }
  await f.start('new-worker');
  const binding = f.mesh.prepare('SELECT * FROM peer_bindings WHERE peer=?').get('new-worker');
  await assert.rejects(web.startNativeSession(base), { code: 'NATIVE_PEER_IN_USE' });
  assert.deepEqual(f.mesh.prepare('SELECT * FROM peer_bindings WHERE peer=?').get('new-worker'), binding);
  assert.equal(launches, 0); assert.equal(f.created.length, 1);
});

test('Web native creation reserves explicit names and gives concurrent unnamed requests distinct stable peers', async t => {
  const f = await fixture(t);
  let ready;
  const gate = new Promise(resolve => { ready = resolve; });
  const web = f.bridge(nativeRequest, new Map(), { ensureRuntime: () => gate });
  const base = { projectCtx: f.ctx, transport: 'native', kind: 'codex' };
  const first = web.startNativeSession({ ...base, id: 'reserved' });
  await assert.rejects(web.startNativeSession({ ...base, id: 'reserved' }), { code: 'NATIVE_WORKER_EXISTS' });
  const anonymous = Array.from({ length: 4 }, () => web.startNativeSession(base));
  ready();
  const created = await Promise.all([first, ...anonymous]);
  assert.equal(new Set(created.map(session => session.id)).size, 5);
  assert.equal(f.created.length, 5);
  for (const session of created) assert.equal(session.nativeSnapshot().peer, session.id);
});

test('created native worker survives a failed first Web read and recovers by its original peer without another create', async t => {
  const f = await fixture(t); let createCalls = 0, failRead = true;
  const web = f.bridge(async (ctx, method, route, body, options) => {
    if (method === 'POST' && route === '/workers') createCalls++;
    if (failRead && route.includes('/state')) throw Object.assign(new Error('lost first read'), { code: 'NATIVE_RUNTIME_OFFLINE' });
    return nativeRequest(ctx, method, route, body, options);
  });
  let peer;
  await assert.rejects(web.startNativeSession({ projectCtx: f.ctx, transport: 'native', kind: 'codex' }), error => {
    assert.equal(error.code, 'NATIVE_WORKER_DISCOVERY_FAILED'); assert.equal(error.extra.created, true);
    peer = error.extra.peer; assert.ok(peer); assert.match(error.message, /do not create a replacement/); return true;
  });
  assert.equal(createCalls, 1); assert.equal(f.adapters.get(peer).closed, 0);
  failRead = false;
  await web.discoverNativeSessions(f.ctx);
  assert.equal(web.session(peer).id, peer);
  assert.equal(createCalls, 1); assert.equal(f.created.length, 1);
});

test('an uncertain native create reports its stable peer and never automatically replays admission', async t => {
  const f = await fixture(t); let createCalls = 0;
  const web = f.bridge(async (ctx, method, route, body, options) => {
    const result = await nativeRequest(ctx, method, route, body, options);
    if (method === 'POST' && route === '/workers') {
      createCalls++;
      throw Object.assign(new Error('response lost'), { code: 'NATIVE_CLIENT_TIMEOUT', extra: { uncertain: true } });
    }
    return result;
  });
  let peer;
  await assert.rejects(web.startNativeSession({ projectCtx: f.ctx, transport: 'native', kind: 'claude' }), error => {
    assert.equal(error.code, 'NATIVE_CREATE_UNCONFIRMED'); assert.equal(error.extra.uncertain, true);
    peer = error.extra.peer; return Boolean(peer);
  });
  await web.discoverNativeSessions(f.ctx);
  assert.equal(web.session(peer).kind, 'claude');
  assert.equal(createCalls, 1); assert.equal(f.created.length, 1);
});

test('native creation rechecks its project directory after awaiting daemon startup', async t => {
  const f = await fixture(t);
  const cwd = path.join(f.ctx.root, 'work'); fs.mkdirSync(cwd);
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-native-moved-')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const web = f.bridge(nativeRequest, new Map(), { ensureRuntime: async () => {
    fs.renameSync(cwd, path.join(f.ctx.root, 'original-work'));
    fs.symlinkSync(outside, cwd, process.platform === 'win32' ? 'junction' : 'dir');
  } });
  await assert.rejects(web.startNativeSession({ projectCtx: f.ctx, transport: 'native', kind: 'codex', cwd }),
    { code: 'PROJECT_PATH_FORBIDDEN' });
  assert.equal(f.created.length, 0);
});

test('a stale discovery list cannot retire a worker created while its status read was in flight', async t => {
  const f = await fixture(t);
  let release, observed;
  const gate = new Promise(resolve => { release = resolve; });
  const statusRead = new Promise(resolve => { observed = resolve; });
  const web = f.bridge(async (ctx, method, route, body, options) => {
    const result = await nativeRequest(ctx, method, route, body, options);
    if (route === '/status') { observed(); await gate; }
    return result;
  });
  const scan = web.discoverNativeSessions(f.ctx);
  await statusRead;
  const session = await web.startNativeSession({ projectCtx: f.ctx, transport: 'native', kind: 'codex', id: 'new-during-scan' });
  release(); await scan;
  assert.equal(web.session(session.id), session);
  assert.equal(session.nativeRetired, undefined);
  assert.equal(session.status, 'running'); assert.equal(web.closedClients.length, 0);
});

for (const restoring of [false, true]) {
  test(`a delayed discovery state preserves the connected view established by ${restoring ? 'restore' : 'creation'}`, async t => {
    const f = await fixture(t);
    let holdCreate = false, holdScan = false, captureCreate, captureScan, releaseCreate, releaseScan;
    const created = new Promise(resolve => { captureCreate = resolve; });
    const scanned = new Promise(resolve => { captureScan = resolve; });
    const createGate = new Promise(resolve => { releaseCreate = resolve; });
    const scanGate = new Promise(resolve => { releaseScan = resolve; });
    t.after(() => { releaseCreate(); releaseScan(); });
    const web = f.bridge(async (ctx, method, route, body, options) => {
      const value = await nativeRequest(ctx, method, route, body, options);
      if (holdCreate && method === 'POST' && route === '/workers') {
        holdCreate = false; captureCreate(value); await createGate;
      }
      if (holdScan && method === 'GET' && route.startsWith('/workers/a/state')) {
        holdScan = false; captureScan(value); await scanGate;
      }
      return value;
    });
    let previous, saved;
    if (restoring) {
      await f.start('a'); await web.discoverNativeSessions(f.ctx);
      previous = web.session();
      await web.nativeAction(previous, 'close');
      saved = (await web.listNativeHistory(f.ctx)).workers[0];
    }
    holdCreate = true;
    const opening = restoring
      ? web.resumeNativeSession(f.ctx, 'a', { owner: saved.owner, sessionId: saved.sessionId, confirmed: true })
      : web.startNativeSession({ projectCtx: f.ctx, transport: 'native', kind: 'codex', id: 'a' });
    const receipt = await created;
    holdScan = true;
    const scanning = web.discoverNativeSessions(f.ctx);
    const captured = await scanned;
    releaseCreate();
    const view = await opening;
    const client = { fixture: true };
    view.clients.add(client); view.actionTokens.add('current-controller');
    assert.equal(web.session(), view);
    assert.equal(captured.owner, receipt.executorId);
    releaseScan(); await scanning;
    assert.equal(web.session(), view, 'the connected view survives the delayed discovery response');
    assert.equal(view.nativeRetired, undefined);
    assert.equal(view.clients.has(client), true);
    assert.equal(view.actionTokens.has('current-controller'), true);
    assert.equal(web.closedClients.includes(view), false);
    const state = await web.nativeAction(view, 'read');
    assert.equal(state.owner, receipt.executorId);
    assert.equal(state.connected, true);
    await web.nativeAction(view, 'send', { text: 'current controller remains usable', submissionId: 'scan_current_view_1' });
    assert.equal(f.receipts().filter(row => row.type === 'native.web.submission.queued').length, 1);
    assert.equal(f.created.length, restoring ? 2 : 1);
    if (restoring) {
      assert.equal(previous.nativeRetired, true);
      assert.equal(view.nativeIdentity.sessionId, saved.sessionId);
      await assert.rejects(web.nativeAction(previous, 'read'), { code: 'NATIVE_OWNER_CHANGED' });
    }
  });
}

for (const failBeforeRequest of [false, true]) {
  test(`a delayed old-owner discovery ${failBeforeRequest ? 'request rejection' : 'response'} cannot change the restored view`, async t => {
    const f = await fixture(t); await f.start('a');
    let hold = false, capture, release;
    const captured = new Promise(resolve => { capture = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const web = f.bridge(async (ctx, method, route, body, options) => {
      const gated = hold && method === 'GET' && route.startsWith('/workers/a/state');
      if (gated) hold = false;
      if (gated && failBeforeRequest) { capture(); await gate; }
      const value = await nativeRequest(ctx, method, route, body, options);
      if (gated && !failBeforeRequest) { capture(); await gate; }
      return value;
    });
    await web.discoverNativeSessions(f.ctx);
    const previous = web.session();
    hold = true;
    const scanning = web.discoverNativeSessions(f.ctx);
    await captured;
    await web.nativeAction(previous, 'close');
    const saved = (await web.listNativeHistory(f.ctx)).workers[0];
    const view = await web.resumeNativeSession(f.ctx, 'a', { owner: saved.owner, sessionId: saved.sessionId, confirmed: true });
    const client = { fixture: true };
    view.clients.add(client); view.actionTokens.add('restored-controller');
    release(); await scanning;
    assert.equal(web.session(), view);
    assert.equal(view.nativeRetired, undefined);
    assert.equal(view.nativeSnapshot().connected, true);
    assert.equal(view.clients.has(client), true);
    assert.equal(view.actionTokens.has('restored-controller'), true);
    assert.equal(web.closedClients.includes(view), false);
    assert.equal(previous.nativeRetired, true);
    await assert.rejects(web.nativeAction(previous, 'read'), { code: 'NATIVE_OWNER_CHANGED' });
    assert.equal((await web.nativeAction(view, 'read')).owner, view.nativeIdentity.owner);
  });
}

for (const retireView of [false, true]) {
  test(`a delayed discovery state cannot revive a ${retireView ? 'retired' : 'closed'} view after its executor closed`, async t => {
    const f = await fixture(t); await f.start('a');
    let hold = false, capture, release;
    const captured = new Promise(resolve => { capture = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const web = f.bridge(async (ctx, method, route, body, options) => {
      const value = await nativeRequest(ctx, method, route, body, options);
      if (hold && method === 'GET' && route.startsWith('/workers/a/state')) {
        hold = false; capture(); await gate;
      }
      return value;
    });
    await web.discoverNativeSessions(f.ctx);
    const view = web.session();
    view.actionTokens.add('original-controller');
    hold = true;
    const scanning = web.discoverNativeSessions(f.ctx);
    await captured;
    await web.nativeAction(view, 'close');
    if (retireView) {
      await assert.rejects(web.nativeAction(view, 'read'), { code: 'NATIVE_WORKER_NOT_FOUND' });
      assert.equal(view.nativeRetired, true);
    }
    release(); await scanning;
    assert.equal(web.session(), view);
    if (retireView) assert.equal(view.nativeRetired, true);
    else { assert.equal(view.status, 'exited'); assert.equal(view.nativeSnapshot().status, 'closed'); }
    assert.equal(view.nativeSnapshot().connected, false);
    assert.equal(view.actionTokens.size, 0);
    await assert.rejects(web.nativeAction(view, 'read'), { code: retireView ? 'NATIVE_OWNER_CHANGED' : 'NATIVE_WORKER_NOT_FOUND' });
    assert.equal(f.created.length, 1);
  });
}

test('a delayed discovery status cannot retire the restored view using its previous owner', async t => {
  const f = await fixture(t); await f.start('a');
  let hold = false, capture, release, released = false;
  const captured = new Promise(resolve => { capture = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const stateReadsAfterRelease = [];
  t.after(() => release());
  const web = f.bridge(async (ctx, method, route, body, options) => {
    if (released && method === 'GET' && route.startsWith('/workers/a/state')) stateReadsAfterRelease.push(route);
    const value = await nativeRequest(ctx, method, route, body, options);
    if (hold && method === 'GET' && route === '/status') { hold = false; capture(value); await gate; }
    return value;
  });
  await web.discoverNativeSessions(f.ctx);
  const previous = web.session();
  hold = true;
  const scanning = web.discoverNativeSessions(f.ctx);
  const oldStatus = await captured;
  assert.equal(oldStatus.workers[0].owner, previous.nativeIdentity.owner);
  await web.nativeAction(previous, 'close');
  const saved = (await web.listNativeHistory(f.ctx)).workers[0];
  const view = await web.resumeNativeSession(f.ctx, 'a', { owner: saved.owner, sessionId: saved.sessionId, confirmed: true });
  const client = { fixture: true };
  view.clients.add(client); view.actionTokens.add('restored-controller');
  released = true; release(); await scanning;
  assert.equal(web.session(), view);
  assert.equal(view.nativeRetired, undefined);
  assert.equal(view.nativeSnapshot().connected, true);
  assert.equal(view.clients.has(client), true);
  assert.equal(view.actionTokens.has('restored-controller'), true);
  assert.equal(web.closedClients.includes(view), false);
  assert.deepEqual(stateReadsAfterRelease, [], 'the old discovery status cannot address the new view through its old owner');
  assert.equal((await web.nativeAction(view, 'read')).owner, view.nativeIdentity.owner);
  await web.nativeAction(view, 'send', { text: 'restored controller remains usable', submissionId: 'scan_status_owner_1' });
  assert.equal(f.receipts().filter(row => row.type === 'native.web.submission.queued').length, 1);
  assert.equal(f.created.length, 2);
});

test('Web discovers only actual native workers, reuses their binding, and creates no executor', async (t) => {
  const f = await fixture(t); await f.start();
  const before = f.mesh.prepare('SELECT * FROM peer_bindings WHERE peer=?').get('a');
  const calls = [];
  const web = f.bridge((ctx, method, route, body, options) => {
    calls.push({ method, route }); return nativeRequest(ctx, method, route, body, options);
  });
  const sessions = await web.discoverNativeSessions(f.ctx);
  assert.equal(sessions.length, 1);
  const session = web.session();
  assert.equal(session.type, 'native'); assert.equal(session.id, 'a'); assert.equal(session.peerId, 'a');
  assert.equal(session.binding.provider_session_id, 'session-a');
  assert.equal(session.binding.runtime_target, session.nativeSnapshot().owner);
  assert.equal(f.mesh.prepare('SELECT pid FROM peers WHERE id=?').get('a').pid, (await f.api('GET', '/status')).pid,
    'peer liveness belongs to the native service daemon');
  assert.equal(session.pid, null, 'the Web view does not claim a provider or Web process PID');
  assert.equal(session.adapter, undefined); assert.equal(session.pty, undefined);
  assert.equal(f.created.length, 1); assert.ok(calls.every((call) => call.method === 'GET'));
  assert.deepEqual(f.mesh.prepare('SELECT * FROM peer_bindings WHERE peer=?').get('a'), before);
  const snapshot = session.nativeSnapshot(); snapshot.events.push({ id: 999 });
  assert.equal(session.nativeSnapshot().events.length, 0, 'UI snapshots cannot mutate the cached worker state');
  await f.api('POST', '/close', { peer: 'a' });
  const freshWeb = f.bridge();
  assert.equal((await freshWeb.discoverNativeSessions(f.ctx)).length, 0, 'saved closed workers are not live executors');
});

test('Claude and dsh workers share the bridge and first provider identity binds without replacing the view', async (t) => {
  const f = await fixture(t, { c: { unknownSession: true } });
  await f.start('c', { provider: 'claude' }); await f.start('d', { provider: 'dsh' });
  const web = f.bridge(); await web.discoverNativeSessions(f.ctx);
  const claude = web.session('c');
  assert.equal(claude.kind, 'claude'); assert.equal(claude.nativeSnapshot().sessionId, null);
  assert.equal(web.session('d').kind, 'dsh'); assert.equal(web.session('d').nativeSnapshot().sessionId, 'session-d');
  claude.actionTokens.add('same-controller');
  f.adapters.get('c').state.sessionId = 'actual-claude-session';
  f.adapters.get('c').emit({ type: 'status', status: 'idle' });
  await web.pollNativeSessions();
  assert.equal(web.session('c'), claude); assert.equal(claude.nativeSnapshot().sessionId, 'actual-claude-session');
  assert.equal(claude.nativeIdentity.sessionId, 'actual-claude-session');
  assert.equal(claude.actionTokens.has('same-controller'), true); assert.equal(web.closedClients.length, 0);
  assert.equal(f.created.length, 2);
});

test('actual worker state endpoint scopes provider events and queue receipts to its bound worker', async (t) => {
  const f = await fixture(t); await f.start('a'); await f.start('b');
  await f.api('POST', '/send', { peer: 'a', from: 'shell', body: 'task a' });
  await f.api('POST', '/send', { peer: 'b', from: 'shell', body: 'task b' });
  await f.service.poll(); f.adapters.get('a').complete(); f.adapters.get('b').complete();
  const state = await f.api('GET', '/workers/a/state');
  assert.equal(state.peer, 'a'); assert.equal(state.root, f.ctx.root); assert.equal(state.meshDb, f.ctx.dbPath);
  assert.equal(state.snapshot.sessionId, 'session-a');
  assert.ok(state.events.length); assert.ok(state.events.every((event) => event.peer === 'a'));
  assert.equal(state.deliveries.length, 1); assert.equal(state.deliveries[0].peer, 'a');
  const cursor = state.events.at(-1).id;
  assert.deepEqual((await f.api('GET', '/workers/a/state?after=' + cursor)).events, []);
  await assert.rejects(f.api('GET', '/workers/a/state?after=-1'), { code: 'BAD_ARGS' });
  await assert.rejects(f.api('GET', '/workers/a/state?generation=stale'), { code: 'NATIVE_OWNER_CHANGED' });
  await assert.rejects(f.api('GET', '/workers/missing/state'), { code: 'NATIVE_WORKER_NOT_FOUND' });
});

test('Web send commits its durable ID before native send and reports a queue receipt without replay', async (t) => {
  const f = await fixture(t); await f.start();
  const submissionId = 'web_submission_001';
  const web = f.bridge((ctx, method, route, body, options) => {
    if (method === 'POST' && route === '/send') {
      assert.equal(body.from, 'web'); assert.equal(body.peer, 'a'); assert.equal(body.submissionId, submissionId);
      assert.equal(f.receipts()[0].type, 'native.web.submission.pending');
      assert.equal(f.receipts()[0].payload.submission_id, submissionId);
    }
    return nativeRequest(ctx, method, route, body, options);
  });
  await web.discoverNativeSessions(f.ctx);
  const receipt = await web.nativeAction(web.session(), 'send', { text: 'inspect this', submissionId });
  assert.equal(receipt.submission_id, submissionId); assert.equal(receipt.state, 'queued');
  assert.equal(f.adapters.get('a').sent.length, 0, 'queue admission is not provider admission');
  await assert.rejects(web.nativeAction(web.session(), 'send', { text: 'inspect this', submissionId }), { code: 'SUBMISSION_EXISTS' });
  assert.equal(f.mesh.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind='ask'").get().n, 1);
  assert.deepEqual(f.receipts().map((event) => event.type), ['native.web.submission.pending', 'native.web.submission.queued']);
  await web.pollNativeSessions();
  assert.equal(web.session().nativeSnapshot().deliveries[0].submission_id, submissionId);
});

test('native submission IDs are durable and reject peer, sender, body, or task substitution', async (t) => {
  const f = await fixture(t); await f.start('a'); await f.start('b');
  const input = { peer: 'a', from: 'web', body: 'one message', submissionId: 'web_submission_001' };
  const receipt = await f.api('POST', '/send', input);
  assert.deepEqual(await f.api('POST', '/send', input), receipt);
  for (const change of [{ peer: 'b' }, { from: 'other-sender' }, { body: 'different' }, { taskId: 1 }]) {
    await assert.rejects(f.api('POST', '/send', { ...input, ...change }), { code: 'NATIVE_SUBMISSION_MISMATCH' });
  }
  assert.equal(f.mesh.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
  const cli = { peer: 'a', from: 'shell', body: 'old CLI semantics' };
  const first = await f.api('POST', '/send', cli), second = await f.api('POST', '/send', cli);
  assert.notEqual(first.submission_id, second.submission_id);
  assert.equal(f.mesh.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 3);
});

test('polling preserves provider events and distinct delivery stages without creating another turn', async (t) => {
  const f = await fixture(t); await f.start();
  const web = f.bridge(); await web.discoverNativeSessions(f.ctx);
  await web.nativeAction(web.session(), 'send', { text: 'work', submissionId: 'web_submission_002' });
  await f.service.poll(); await web.pollNativeSessions();
  assert.equal(web.session().nativeSnapshot().deliveries[0].state, 'submitted');
  f.adapters.get('a').complete(); await web.pollNativeSessions();
  const state = web.session().nativeSnapshot();
  assert.equal(state.deliveries[0].state, 'completed'); assert.equal(state.status, 'idle');
  assert.ok(state.events.some((event) => event.payload.type === 'message' && event.payload.text === 'answer from a'));
  await web.pollNativeSessions();
  assert.equal(web.session().nativeSnapshot().events.length, state.events.length);
  assert.equal(f.adapters.get('a').sent.length, 1); assert.equal(f.created.length, 1);
  assert.ok(web.broadcasts.every(({ payload }) => payload.type === 'native_state'));
});

test('unchanged native polling sends one initial full snapshot and keeps explicit reads independent', async (t) => {
  const f = await fixture(t); await f.start();
  for (let index = 0; index < 100; index++) f.adapters.get('a').emit({ type: 'message', text: 'x'.repeat(1000) + index });
  let stateReads = 0;
  const web = f.bridge((ctx, method, route, body, options) => {
    if (route.startsWith('/workers/a/state')) stateReads++;
    return nativeRequest(ctx, method, route, body, options);
  });
  await web.discoverNativeSessions(f.ctx);
  const original = web.session().nativeSnapshot();
  for (let index = 0; index < 10; index++) await web.pollNativeSessions();
  const bytes = web.broadcasts.reduce((total, { payload }) => total + Buffer.byteLength(JSON.stringify(payload)), 0);
  t.diagnostic(JSON.stringify({ repeatedPolls: 10, stateReads, broadcastFrames: web.broadcasts.length, broadcastBytes: bytes,
    initialSnapshotBytes: Buffer.byteLength(JSON.stringify(web.broadcasts[0].payload)) }));
  assert.equal(stateReads, 11, 'unchanged broadcasts do not suppress worker or binding validation');
  assert.equal(web.broadcasts.length, 1);
  assert.deepEqual(web.session().nativeSnapshot(), original);
  const read = await web.nativeAction(web.session(), 'read');
  assert.deepEqual(read, original);
  read.events[0].payload.text = 'local edit';
  assert.deepEqual(web.session().nativeSnapshot(), original, 'HTTP-style read results remain independently cloned');
  assert.equal(web.broadcasts.length, 1);
});

test('native metadata, approvals and receipts broadcast changes without advancing the provider event cursor', async (t) => {
  const f = await fixture(t); await f.start();
  let overlay = {};
  const web = f.bridge(async (ctx, method, route, body, options) => {
    const value = await nativeRequest(ctx, method, route, body, options);
    if (!route.startsWith('/workers/a/state')) return value;
    return { ...value, ...structuredClone(overlay), snapshot: { ...value.snapshot, ...structuredClone(overlay.snapshot || {}) } };
  });
  await web.discoverNativeSessions(f.ctx);
  const cursor = web.session().nativeSnapshot().eventCursor;
  async function change(next, inspect) {
    overlay = next;
    const count = web.broadcasts.length;
    await web.pollNativeSessions();
    assert.equal(web.broadcasts.length, count + 1, 'each semantic change emits a full state frame');
    const state = web.broadcasts.at(-1).payload.state;
    assert.equal(state.eventCursor, cursor);
    inspect(state);
    await web.pollNativeSessions();
    assert.equal(web.broadcasts.length, count + 1, 'a repeated unchanged state stays quiet');
  }
  const approval = { requestId: 'approval', params: { command: 'inspect' }, status: 'pending' };
  await change({ snapshot: { pendingApprovals: [approval] } }, state => assert.equal(state.pendingApprovals[0].params.command, 'inspect'));
  await change({ snapshot: { pendingApprovals: [{ ...approval, params: { command: 'updated command' } }] } }, state => assert.equal(state.pendingApprovals[0].params.command, 'updated command'));
  await change({ snapshot: { pendingApprovals: [] } }, state => assert.deepEqual(state.pendingApprovals, []));
  await change({ snapshot: { capabilities: { send: false, interrupt: true } } }, state => assert.equal(state.capabilities.send, false));
  const previous = web.broadcasts.length;
  overlay = { snapshot: { capabilities: { interrupt: true, send: false } } };
  await web.pollNativeSessions();
  assert.equal(web.broadcasts.length, previous, 'object property order is not a semantic state change');
  const metrics = { source: 'provider/tokenUsage', scope: 'session', inputTokens: 42, outputTokens: 7, observedAt: 123 };
  const metadata = { model: 'reported-model', permissionMode: 'default', commands: [] };
  await change({ snapshot: { metrics, runtimeMetadata: metadata } }, state => { assert.deepEqual(state.metrics, metrics); assert.deepEqual(state.runtimeMetadata, metadata); });
  await change({ snapshot: { metrics: null, runtimeMetadata: null } }, state => { assert.equal(state.metrics, null); assert.equal(state.runtimeMetadata, null); });
  await change({ closing: true }, state => assert.equal(state.closing, true));
  await change({ quarantined: true }, state => assert.equal(state.quarantined, true));
  await change({ active_delivery: { message_id: 1, submission_id: 'submission', turn_id: 'turn-one' } }, state => assert.equal(state.turnId, 'turn-one'));
  const receipt = { id: 1, peer: 'a', message_id: 1, submission_id: 'submission', state: 'queued' };
  await change({ deliveries: [receipt] }, state => assert.equal(state.deliveries[0].state, 'queued'));
  await change({ deliveries: [{ ...receipt, state: 'completed', detail: { evidence: 'finished' } }] }, state => assert.equal(state.deliveries[0].detail.evidence, 'finished'));
  await change({ deliveries: [{ ...receipt, state: 'completed', detail: { evidence: 'corrected' } }] }, state => assert.equal(state.deliveries[0].detail.evidence, 'corrected'));
});

test('identical polls still validate the binding and retire a replaced owner', async (t) => {
  const f = await fixture(t); await f.start();
  let invalidateBinding = false;
  const web = f.bridge(async (ctx, method, route, body, options) => {
    const value = await nativeRequest(ctx, method, route, body, options);
    if (invalidateBinding && route.startsWith('/workers/a/state')) {
      invalidateBinding = false;
      f.mesh.prepare('UPDATE peer_bindings SET runtime_target=? WHERE peer=?').run('changed-owner', 'a');
    }
    return value;
  });
  await web.discoverNativeSessions(f.ctx);
  const session = web.session();
  session.actionTokens.add('controller'); session.actionTokenSockets = new Map([['controller', {}]]);
  for (let index = 0; index < 3; index++) await web.pollNativeSessions();
  assert.equal(web.broadcasts.length, 1);
  invalidateBinding = true;
  await web.pollNativeSessions();
  assert.equal(web.broadcasts.length, 2);
  assert.equal(session.nativeSnapshot().error.code, 'NATIVE_OWNER_CHANGED');
  assert.equal(session.nativeRetired, true); assert.equal(session.actionTokens.size, 0); assert.equal(session.actionTokenSockets.size, 0);
  assert.ok(web.closedClients.includes(session));
});

test('repeated disconnects stay quiet, recovery broadcasts, and identical retirement state still revokes clients', async (t) => {
  const f = await fixture(t); await f.start();
  let failure = '';
  const web = f.bridge((ctx, method, route, body, options) => {
    if (failure === 'offline') return Promise.reject(Object.assign(new Error('native offline'), { code: 'NATIVE_RUNTIME_OFFLINE' }));
    if (failure === 'missing-status' && route === '/status' || failure === 'missing-state' && route.startsWith('/workers/a/state')) {
      return Promise.reject(Object.assign(new Error('worker missing'), { code: 'NATIVE_WORKER_NOT_FOUND' }));
    }
    return nativeRequest(ctx, method, route, body, options);
  });
  await web.discoverNativeSessions(f.ctx); const session = web.session();
  failure = 'offline'; await web.pollNativeSessions();
  assert.equal(web.broadcasts.length, 2); assert.equal(session.nativeSnapshot().connected, false);
  await web.pollNativeSessions(); await web.pollNativeSessions();
  assert.equal(web.broadcasts.length, 2);
  failure = ''; await web.pollNativeSessions();
  assert.equal(web.broadcasts.length, 3); assert.equal(session.nativeSnapshot().connected, true);
  assert.equal(session.nativeSnapshot().error, undefined);
  session.actionTokens.add('controller'); session.actionTokenSockets = new Map([['controller', {}]]);
  failure = 'missing-status'; await web.pollNativeSessions();
  assert.equal(session.nativeRetired, undefined); assert.equal(session.actionTokens.size, 1);
  const beforeRetirement = web.broadcasts.length, beforeState = session.nativeSnapshot();
  failure = 'missing-state'; await web.pollNativeSessions();
  assert.deepEqual(session.nativeSnapshot(), beforeState);
  assert.equal(web.broadcasts.length, beforeRetirement, 'the visible disconnect state is unchanged');
  assert.equal(session.nativeRetired, true); assert.equal(session.actionTokens.size, 0); assert.equal(session.actionTokenSockets.size, 0);
  assert.ok(web.closedClients.includes(session), 'retirement cannot be skipped when its visible state is unchanged');
});

test('offline native service and Web shutdown disconnect the view while the worker keeps running', async (t) => {
  const f = await fixture(t); await f.start();
  let offline = false;
  const posts = [];
  const web = f.bridge((ctx, method, route, body, options) => {
    if (method === 'POST') posts.push(route);
    if (offline) return Promise.reject(Object.assign(new Error('native offline'), { code: 'NATIVE_RUNTIME_OFFLINE' }));
    return nativeRequest(ctx, method, route, body, options);
  });
  await web.discoverNativeSessions(f.ctx); offline = true;
  await web.pollNativeSessions();
  assert.equal(web.session().status, 'disconnected'); assert.equal(web.session().nativeSnapshot().connected, false);
  assert.equal(f.adapters.get('a').closed, 0);
  offline = false; await web.pollNativeSessions();
  assert.equal(web.session().status, 'running');
  web.closeNativeBridge();
  assert.equal(web.session().status, 'disconnected'); assert.equal(f.adapters.get('a').closed, 0);
  assert.deepEqual(posts, []); assert.deepEqual(await web.discoverNativeSessions(f.ctx), []);
});

test('service generation changes replace the Web view and fence its previous control identity', async (t) => {
  const f = await fixture(t); await f.start();
  const web = f.bridge(); await web.discoverNativeSessions(f.ctx);
  const original = web.session(); original.actionTokens.add('old-browser');
  const generation = original.nativeSnapshot().generation;
  await f.restart(); await f.start('a', { resume: 'last' }); await web.pollNativeSessions();
  const current = web.session();
  assert.notEqual(current, original); assert.notEqual(current.nativeSnapshot().generation, generation);
  assert.equal(current.nativeSnapshot().sessionId, 'session-a');
  assert.equal(original.nativeRetired, true); assert.equal(original.actionTokens.size, 0);
  assert.ok(web.closedClients.includes(original));
  await assert.rejects(web.nativeAction(original, 'close'), { code: 'NATIVE_OWNER_CHANGED' });
  assert.equal(f.adapters.get('a').closed, 0);
});

test('same-service worker replacement changes owner and rejects stale send, interrupt, and close', async (t) => {
  const f = await fixture(t); await f.start();
  const before = await f.api('GET', '/workers/a/state');
  const web = f.bridge(); await web.discoverNativeSessions(f.ctx); const original = web.session();
  await f.api('POST', '/close', { peer: 'a' }); await f.start('a', { resume: 'last' });
  const after = await f.api('GET', '/workers/a/state');
  assert.equal(after.generation, before.generation); assert.notEqual(after.owner, before.owner);
  const identity = { peer: 'a', generation: before.generation, owner: before.owner,
    provider: 'codex', sessionId: before.snapshot.sessionId };
  for (const route of ['/send', '/interrupt', '/close']) {
    await assert.rejects(f.api('POST', route, { ...identity, from: 'web', body: 'stale', submissionId: 'stale_submission_1' }),
      { code: 'NATIVE_OWNER_CHANGED' });
  }
  await web.pollNativeSessions(); assert.notEqual(web.session(), original);
  assert.equal(original.nativeRetired, true); assert.equal(f.adapters.get('a').closed, 0);
  assert.equal(f.mesh.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
});

test('native owner is checked again at the mutation endpoint after the Web state read', async (t) => {
  const f = await fixture(t); await f.start();
  let replace = true;
  const web = f.bridge(async (ctx, method, route, body, options) => {
    if (method === 'POST' && route === '/send' && replace) {
      replace = false; await f.api('POST', '/close', { peer: 'a' }); await f.start('a', { resume: 'last' });
    }
    return nativeRequest(ctx, method, route, body, options);
  });
  await web.discoverNativeSessions(f.ctx);
  await assert.rejects(web.nativeAction(web.session(), 'send', { text: 'stale', submissionId: 'web_submission_003' }),
    { code: 'NATIVE_OWNER_CHANGED' });
  assert.equal(f.mesh.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
  assert.equal(f.adapters.get('a').sent.length, 0);
  assert.deepEqual(f.receipts().map((event) => event.type), ['native.web.submission.pending', 'native.web.submission.unconfirmed']);
});

test('an uncertain Web receipt is never resent after rebuilding the bridge and remains inspectable', async (t) => {
  const f = await fixture(t); await f.start();
  let sends = 0;
  const web = f.bridge(async (ctx, method, route, body, options) => {
    const result = await nativeRequest(ctx, method, route, body, options);
    if (method === 'POST' && route === '/send') { sends++;
      throw Object.assign(new Error('lost queue response'), { code: 'NATIVE_CLIENT_TIMEOUT', extra: { uncertain: true } }); }
    return result;
  });
  await web.discoverNativeSessions(f.ctx);
  const input = { text: 'one attempt', submissionId: 'web_submission_004' };
  await assert.rejects(web.nativeAction(web.session(), 'send', input), { code: 'NATIVE_CLIENT_TIMEOUT' });
  const rebuilt = f.bridge(); await rebuilt.discoverNativeSessions(f.ctx);
  await assert.rejects(rebuilt.nativeAction(rebuilt.session(), 'send', input), { code: 'SUBMISSION_EXISTS' });
  assert.equal(sends, 1); assert.equal(f.mesh.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
  assert.equal(rebuilt.session().nativeSnapshot().deliveries[0].submission_id, input.submissionId);
});

test('lease authorization is rechecked after awaited state reads before persistence or mutation', async (t) => {
  const f = await fixture(t); await f.start();
  let canControl = true;
  const web = f.bridge(async (ctx, method, route, body, options) => {
    const result = await nativeRequest(ctx, method, route, body, options);
    if (route.includes('/state')) canControl = false;
    return result;
  });
  await web.discoverNativeSessions(f.ctx); canControl = true;
  await assert.rejects(web.nativeAction(web.session(), 'send', { text: 'do not submit', submissionId: 'web_submission_005',
    authorizeMutation() { if (!canControl) throw Object.assign(new Error('control was taken over'), { code: 'CONTROL_REQUIRED' }); } }),
    { code: 'CONTROL_REQUIRED' });
  assert.equal(f.receipts().length, 0); assert.equal(f.mesh.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
});

test('interrupt and explicit close reuse the owned worker and preserve business task state', async (t) => {
  const f = await fixture(t); await f.start('a'); await f.start('b');
  f.mesh.prepare("INSERT INTO tasks(title,status,owner,priority,created_at,updated_at) VALUES ('keep working','running','a',100,1000,1000)").run();
  const tasks = f.mesh.prepare('SELECT * FROM tasks').all();
  const web = f.bridge(); await web.discoverNativeSessions(f.ctx);
  await web.nativeAction(web.session(), 'send', { text: 'work', submissionId: 'web_submission_006' });
  await f.service.poll(); await web.pollNativeSessions();
  const interrupt = await web.nativeAction(web.session(), 'interrupt', { turnId: 'turn-a' });
  assert.equal(interrupt.status, 'interrupt_requested'); assert.equal(f.adapters.get('a').interrupted.length, 1);
  await assert.rejects(web.nativeAction(web.session(), 'approve', {}), { code: 'BAD_REQUEST' });
  const closed = await web.nativeAction(web.session(), 'close');
  assert.equal(closed.status, 'closed'); assert.equal(web.session().status, 'exited');
  assert.equal(f.adapters.get('a').closed, 1); assert.equal(f.adapters.get('b').closed, 0);
  assert.deepEqual(f.mesh.prepare('SELECT * FROM tasks').all(), tasks);
  assert.equal((await f.api('GET', '/status')).stopping, false);
});

test('foreign project responses and existing terminal views cannot become native Web sessions', async (t) => {
  const f = await fixture(t); await f.start();
  const foreign = f.bridge(async (ctx, method, route, body, options) => {
    const result = await nativeRequest(ctx, method, route, body, options);
    return { ...result, root: '/different-project' };
  });
  assert.deepEqual(await foreign.discoverNativeSessions(f.ctx), []);
  const terminal = { id: 'a', peerId: 'a', type: 'tmux', status: 'running' };
  const sessions = new Map([[f.key(f.ctx, 'a'), terminal]]);
  const web = f.bridge(nativeRequest, sessions); await web.discoverNativeSessions(f.ctx);
  assert.equal(web.session(), terminal); assert.equal(f.created.length, 1);
});


test('Web discovers a lazy Claude resume without clearing its saved provider binding', async (t) => {
  const f = await fixture(t); await f.start('a', { provider: 'claude' });
  const saved = f.mesh.prepare('SELECT * FROM peer_bindings WHERE peer=?').get('a');
  const adapter = f.adapters.get('a');
  adapter.state.sessionId = null;
  adapter.state.status = 'ready';
  const bridge = f.bridge();
  const views = await bridge.discoverNativeSessions(f.ctx);
  assert.equal(views.length, 1);
  const view = bridge.session();
  assert.equal(view.nativeSnapshot().sessionId, null, 'saved identity is not a confirmed SDK init');
  assert.deepEqual(f.mesh.prepare('SELECT * FROM peer_bindings WHERE peer=?').get('a'), saved);
  adapter.state.sessionId = saved.provider_session_id;
  adapter.state.status = 'idle';
  await bridge.pollNativeSessions(f.ctx);
  assert.equal(bridge.session(), view);
  assert.equal(view.nativeSnapshot().sessionId, saved.provider_session_id);
});

test('a missing active session or another transport cannot use the lazy Claude resume exception', async (t) => {
  const f = await fixture(t); await f.start('a', { provider: 'claude' });
  const adapter = f.adapters.get('a');
  adapter.state.sessionId = null;
  adapter.state.status = 'running';
  const bridge = f.bridge();
  assert.equal((await bridge.discoverNativeSessions(f.ctx)).length, 0);
  adapter.state.status = 'ready';
  f.mesh.prepare("UPDATE peer_bindings SET runtime_target='another-owner' WHERE peer='a'").run();
  assert.equal((await bridge.discoverNativeSessions(f.ctx)).length, 0);
});


test('Web reads account state from the independent native executor using its exact owner/session identity', async t => {
  const f=await fixture(t); await f.start();
  const adapter=f.adapters.get('a'); adapter.capabilities.accountRead=true;
  let reads=0; adapter.readAccount=async()=>{reads++;adapter.state.account={status:'ready',authentication:'providerManaged',rateLimits:{status:'notApplicable',buckets:[]}};};
  const calls=[], web=f.bridge((ctx,method,route,body,options)=>{calls.push({method,route});return nativeRequest(ctx,method,route,body,options);});
  await web.discoverNativeSessions(f.ctx); const session=web.session(), identity=session.nativeIdentity;
  const before=f.mesh.prepare('SELECT * FROM peer_bindings WHERE peer=?').get('a');
  const result=await web.nativeAction(session,'account',{...identity,authorizeMutation(){throw new Error('read must not ask for control');}});
  assert.equal(result.account.authentication,'providerManaged'); assert.equal(reads,1);
  assert.equal(result.owner,identity.owner); assert.equal(result.sessionId,identity.sessionId);
  assert.ok(calls.every(c=>c.method==='GET')); assert.equal(f.created.length,1); assert.equal(adapter.sent.length,0);
  assert.deepEqual(f.mesh.prepare('SELECT * FROM peer_bindings WHERE peer=?').get('a'),before);
});

test('stale and unsupported native account reads are refused before requesting provider account data', async t => {
  const f=await fixture(t); await f.start(); const adapter=f.adapters.get('a');
  let reads=0; adapter.readAccount=async()=>{reads++;};
  const web=f.bridge(); await web.discoverNativeSessions(f.ctx); const session=web.session(),identity=session.nativeIdentity;
  await assert.rejects(web.nativeAction(session,'account',{...identity}),{code:'NATIVE_CAPABILITY_UNSUPPORTED'});
  adapter.capabilities.accountRead=true; await web.nativeAction(session,'read');
  for(const patch of [{owner:'old-owner'},{generation:'old-generation'},{sessionId:'old-thread'}]) {
    await assert.rejects(web.nativeAction(session,'account',{...identity,...patch}),{code:'NATIVE_OWNER_CHANGED'});
    const query=new URLSearchParams({...identity,...patch});
    await assert.rejects(f.api('GET','/workers/a/account?'+query),{code:'NATIVE_OWNER_CHANGED'});
  }
  await assert.rejects(f.api('GET','/workers/a/account'),{code:'BAD_ARGS'});
  assert.equal(reads,0); assert.equal(session.nativeRetired,undefined);
});

test('native account read rechecks binding ownership after the provider response', async t => {
  const f=await fixture(t); await f.start(); const adapter=f.adapters.get('a'); adapter.capabilities.accountRead=true;
  let finish,called; const requested=new Promise(resolve=>{called=resolve;});
  adapter.readAccount=()=>new Promise(resolve=>{finish=resolve;called();});
  const web=f.bridge(); await web.discoverNativeSessions(f.ctx); const session=web.session();
  const reading=web.nativeAction(session,'account',{...session.nativeIdentity}); await requested;
  f.mesh.prepare('UPDATE peer_bindings SET runtime_target=? WHERE peer=?').run('replaced-owner','a');
  finish(); await assert.rejects(reading,{code:'NATIVE_PEER_IN_USE'});
  assert.equal(f.mesh.prepare('SELECT runtime_target FROM peer_bindings WHERE peer=?').get('a').runtime_target,'replaced-owner');
});

test('new native workers resolve one project-default snapshot before awaiting runtime startup', async t => {
  const f = await fixture(t); fs.mkdirSync(path.join(f.ctx.root, 'work'));
  const original = f.defaults.readAgentDefaults(f.ctx); original.defaultProvider = 'claude';
  original.providers.claude = { model: 'first-model', cwd: 'work' };
  const saved = f.defaults.saveAgentDefaults(f.ctx, original);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const web = f.bridge(nativeRequest, new Map(), { ensureRuntime: () => gate });
  const pending = web.startNativeSession({ projectCtx: f.ctx, transport: 'native' });
  saved.defaultProvider = 'dsh'; saved.providers.claude = { model: 'later-model', cwd: '.' };
  f.defaults.saveAgentDefaults(f.ctx, saved); release();
  const session = await pending;
  assert.equal(session.kind, 'claude'); assert.match(session.id, /^native-claude-/);
  assert.equal(session.cwd, path.join(f.ctx.root, 'work'));
  assert.equal(f.adapters.get(session.id).openInput.model, 'first-model');
  const later = await web.startNativeSession({ projectCtx: f.ctx, transport: 'native' });
  assert.equal(later.kind, 'dsh');
});

test('explicit native model clearing omits model downstream and does not change the saved defaults or resume', async t => {
  const f = await fixture(t), settings = f.defaults.readAgentDefaults(f.ctx);
  settings.providers.codex.model = 'saved-model'; f.defaults.saveAgentDefaults(f.ctx, settings);
  const posts = [], web = f.bridge((ctx, method, route, body, options) => {
    if (method === 'POST' && route === '/workers') posts.push(body);
    return nativeRequest(ctx, method, route, body, options);
  });
  for (const model of [null, '', '   ']) {
    await web.startNativeSession({ projectCtx: f.ctx, transport: 'native', kind: 'codex', model });
    assert.equal(Object.hasOwn(posts.at(-1), 'model'), false);
  }
  const inherited = await web.startNativeSession({ projectCtx: f.ctx, transport: 'native', kind: 'codex' });
  assert.equal(posts.at(-1).model, 'saved-model');
  await f.api('POST', '/close', { peer: inherited.id });
  const row = (await web.nativeWorkerHistory(f.ctx, inherited.id)).worker;
  await web.resumeNativeSession(f.ctx, row.peer, { owner: row.owner, sessionId: row.sessionId, confirmed: true });
  assert.equal(Object.hasOwn(posts.at(-1), 'model'), false);
  assert.equal(f.defaults.readAgentDefaults(f.ctx).providers.codex.model, 'saved-model');
});

test('native defaults with a directory removed during startup fail before provider admission', async t => {
  const f = await fixture(t); const directory = path.join(f.ctx.root, 'work'); fs.mkdirSync(directory);
  const settings = f.defaults.readAgentDefaults(f.ctx); settings.providers.codex.cwd = 'work'; f.defaults.saveAgentDefaults(f.ctx, settings);
  const web = f.bridge(nativeRequest, new Map(), { ensureRuntime: async () => { fs.rmdirSync(directory); } });
  await assert.rejects(web.startNativeSession({ projectCtx: f.ctx, transport: 'native' }), { code: 'BAD_REQUEST' });
  assert.equal(f.created.length, 0);
  assert.equal(f.defaults.readAgentDefaults(f.ctx).providers.codex.cwd, 'work');
});

test('Web retained history stays project scoped and readable after the native daemon closes', async t => {
  const f = await fixture(t), web = f.bridge();
  await f.start('a'); f.adapters.get('a').emit({ type: 'message', text: 'retained output' });
  let history = await web.listNativeHistory(f.ctx);
  assert.equal(history.workers[0].owned, true); assert.equal(history.workers[0].resumeReason, 'active');
  assert.equal(history.retention.complete, false);
  await f.service.shutdown();
  history = await web.listNativeHistory(f.ctx);
  assert.equal(history.runtimeAvailable, false); assert.equal(history.workers[0].resumable, true);
  assert.equal(history.workers[0].status, 'closed');
  const detail = await web.nativeWorkerHistory(f.ctx, 'a');
  assert.ok(detail.events.some(event => event.payload.text === 'retained output'));
  assert.ok(detail.events.every(event => event.peer === 'a'));
  await assert.rejects(web.nativeWorkerHistory(f.ctx, 'foreign'), { code: 'NATIVE_HISTORY_NOT_FOUND' });
});

test('Web history does not offer restore for a rebound or unverified native cwd', async t => {
  const f = await fixture(t), web = f.bridge();
  const selected = path.join(f.ctx.root, 'selected');
  fs.mkdirSync(selected);
  await f.start('a', { cwd: selected });
  await f.api('POST', '/close', { peer: 'a' });
  const before = (await web.listNativeHistory(f.ctx)).workers[0];
  assert.equal(before.resumable, true);
  fs.renameSync(selected, path.join(f.ctx.root, 'original'));
  fs.mkdirSync(selected);
  let row = (await web.listNativeHistory(f.ctx)).workers[0];
  assert.equal(row.resumeReason, 'cwd_changed');
  await assert.rejects(web.resumeNativeSession(f.ctx, 'a', {
    owner: row.owner, sessionId: row.sessionId, confirmed: true
  }), { code: 'NATIVE_RESUME_NOT_READY' });
  const store = createNativeStore(f.ctx);
  try { store.db.prepare("UPDATE workers SET cwd_identity=NULL WHERE peer='a'").run(); }
  finally { store.close(); }
  row = (await web.listNativeHistory(f.ctx)).workers[0];
  assert.equal(row.resumeReason, 'history_unverified');
  assert.equal(row.resumable, false);
  assert.equal(f.created.length, 1);
});

test('Web resumes only a confirmed closed saved worker with the original peer and provider session', async t => {
  const f = await fixture(t), web = f.bridge();
  await f.start('a'); await web.discoverNativeSessions(f.ctx);
  const previousView = web.session();
  await f.api('POST', '/close', { peer: 'a' });
  const saved = (await web.listNativeHistory(f.ctx)).workers[0];
  const restored = await web.resumeNativeSession(f.ctx, 'a', { owner: saved.owner, sessionId: saved.sessionId, confirmed: true });
  assert.equal(restored.id, 'a'); assert.equal(restored.kind, 'codex');
  assert.equal(restored.binding.provider_session_id, saved.sessionId); assert.notEqual(restored.nativeIdentity.owner, saved.owner);
  assert.equal(previousView.nativeRetired, true);
  assert.deepEqual(f.adapters.get('a').openInput, { sessionId: saved.sessionId, model: undefined });
  await assert.rejects(web.resumeNativeSession(f.ctx, 'a', { owner: saved.owner, sessionId: saved.sessionId, confirmed: true }), { code: 'NATIVE_OWNER_CHANGED' });
  assert.equal(f.created.length, 2);
});

test('Web restore confirmation, capabilities, unchanged ownership and confirmed shutdown are required', async t => {
  const f = await fixture(t), web = f.bridge(); await f.start('a');
  let row = (await web.listNativeHistory(f.ctx)).workers[0];
  const input = () => ({ owner: row.owner, sessionId: row.sessionId, confirmed: true });
  await assert.rejects(web.resumeNativeSession(f.ctx, 'a', { ...input(), confirmed: false }), { code: 'BAD_REQUEST' });
  await assert.rejects(web.resumeNativeSession(f.ctx, 'a', { ...input(), model: 'other-model' }), { code: 'BAD_REQUEST' });
  await assert.rejects(web.resumeNativeSession(f.ctx, 'a', input()), { code: 'NATIVE_RESUME_NOT_READY' });
  await f.api('POST', '/close', { peer: 'a' });
  const store = createNativeStore(f.ctx);
  try {
    store.db.prepare("UPDATE workers SET status='disconnected' WHERE peer='a'").run();
    row = (await web.listNativeHistory(f.ctx)).workers[0]; assert.equal(row.resumeReason, 'not_closed');
    await assert.rejects(web.resumeNativeSession(f.ctx, 'a', input()), { code: 'NATIVE_RESUME_NOT_READY' });
    store.db.prepare("UPDATE workers SET status='closed' WHERE peer='a'").run();
  } finally { store.close(); }
  f.mesh.prepare("UPDATE peer_bindings SET runtime_target='different-owner' WHERE peer='a'").run();
  await assert.rejects(web.resumeNativeSession(f.ctx, 'a', input()), { code: 'NATIVE_OWNER_CHANGED' });
  assert.equal(f.created.length, 1);
  await f.start('dsh-no-resume', { provider: 'dsh' });
  f.adapters.get('dsh-no-resume').state.capabilities.resume = false;
  await f.api('POST', '/close', { peer: 'dsh-no-resume' });
  const unsupported = (await web.listNativeHistory(f.ctx)).workers.find(worker => worker.peer === 'dsh-no-resume');
  assert.equal(unsupported.resumeReason, 'provider_unsupported'); assert.equal(unsupported.resumable, false);
});

test('daemon admission fences an owner replaced after the Web restore preflight', async t => {
  const f = await fixture(t); await f.start('a'); await f.api('POST', '/close', { peer: 'a' });
  let posts = 0;
  const web = f.bridge(async (ctx, method, route, body, options) => {
    if (method === 'POST' && route === '/workers') {
      posts++; f.mesh.prepare("UPDATE peer_bindings SET runtime_target='replacement-owner' WHERE peer='a'").run();
    }
    return nativeRequest(ctx, method, route, body, options);
  });
  const row = (await web.listNativeHistory(f.ctx)).workers[0];
  await assert.rejects(web.resumeNativeSession(f.ctx, 'a', { owner: row.owner, sessionId: row.sessionId, confirmed: true }), { code: 'NATIVE_RESUME_UNCONFIRMED' });
  assert.equal(posts, 1); assert.equal(f.created.length, 1);
  assert.equal(f.mesh.prepare("SELECT runtime_target FROM peer_bindings WHERE peer='a'").get().runtime_target, 'replacement-owner');
});

test('an uncertain restore is never replayed and the original peer is discoverable', async t => {
  const f = await fixture(t); await f.start('a'); await f.api('POST', '/close', { peer: 'a' });
  let posts = 0;
  const web = f.bridge(async (ctx, method, route, body, options) => {
    const result = await nativeRequest(ctx, method, route, body, options);
    if (method === 'POST' && route === '/workers') { posts++; throw Object.assign(new Error('lost response'), { code: 'NATIVE_CLIENT_TIMEOUT', extra: { uncertain: true } }); }
    return result;
  });
  const row = (await web.listNativeHistory(f.ctx)).workers[0], input = { owner: row.owner, sessionId: row.sessionId, confirmed: true };
  await assert.rejects(web.resumeNativeSession(f.ctx, 'a', input), error => error.code === 'NATIVE_RESUME_UNCONFIRMED' && error.extra.peer === 'a');
  await web.discoverNativeSessions(f.ctx);
  assert.equal(web.session().binding.provider_session_id, row.sessionId);
  await assert.rejects(web.resumeNativeSession(f.ctx, 'a', input), { code: 'NATIVE_OWNER_CHANGED' });
  assert.equal(posts, 1); assert.equal(f.created.length, 2);
});

for (const missingReceipt of [null, undefined]) {
  test(`an empty native restore receipt (${missingReceipt}) preserves recovery without another admission`, async t => {
    const f = await fixture(t); await f.start('a'); await f.api('POST', '/close', { peer: 'a' });
    let posts = 0;
    const web = f.bridge(async (ctx, method, route, body, options) => {
      const result = await nativeRequest(ctx, method, route, body, options);
      if (method === 'POST' && route === '/workers') { posts++; return missingReceipt; }
      return result;
    });
    const saved = (await web.listNativeHistory(f.ctx)).workers[0];
    const input = { owner: saved.owner, sessionId: saved.sessionId, confirmed: true };
    await assert.rejects(web.resumeNativeSession(f.ctx, 'a', input), error => {
      assert.equal(error.code, 'NATIVE_WORKER_DISCOVERY_FAILED');
      assert.equal(error.extra.cause, 'NATIVE_RESPONSE_INVALID');
      assert.equal(error.extra.peer, 'a'); assert.equal(error.extra.provider, 'codex');
      assert.equal(error.extra.created, true); assert.equal(error.extra.executorId, undefined);
      assert.match(error.message, /Refresh the Agent list; do not create a replacement/);
      return true;
    });
    assert.equal(posts, 1); assert.equal(f.created.length, 2);
    assert.equal(f.adapters.get('a').closed, 0);
    await web.discoverNativeSessions(f.ctx);
    assert.equal(web.session().id, 'a');
    assert.equal(web.session().binding.provider_session_id, saved.sessionId);
    assert.notEqual(web.session().nativeIdentity.owner, saved.owner);
    await assert.rejects(web.resumeNativeSession(f.ctx, 'a', input), { code: 'NATIVE_OWNER_CHANGED' });
    assert.equal(posts, 1); assert.equal(f.created.length, 2);
  });
}

test('resume provider failure preserves its saved identity and refuses another attempt under the stale owner', async t => {
  const configuration = { a: {} }, f = await fixture(t, configuration), web = f.bridge();
  await f.start('a'); await f.api('POST', '/close', { peer: 'a' });
  const row = (await web.listNativeHistory(f.ctx)).workers[0], input = { owner: row.owner, sessionId: row.sessionId, confirmed: true };
  configuration.a.resumeError = Object.assign(new Error('provider restore unavailable'), { code: 'NATIVE_UNSUPPORTED' });
  await assert.rejects(web.resumeNativeSession(f.ctx, 'a', input), error => error.code === 'NATIVE_RESUME_UNCONFIRMED' && /provider restore unavailable/.test(error.message));
  const history = (await web.listNativeHistory(f.ctx)).workers[0];
  assert.equal(history.status, 'error'); assert.equal(history.sessionId, row.sessionId); assert.equal(history.resumable, false);
  await assert.rejects(web.resumeNativeSession(f.ctx, 'a', input), { code: 'NATIVE_OWNER_CHANGED' });
  assert.equal(f.created.length, 2);
});

test('real Claude adapter lazy restore keeps the saved session binding before its first model query', async t => {
  const configuration = { a: {} }, f = await fixture(t, configuration), web = f.bridge();
  await f.start('a', { provider: 'claude' }); await f.api('POST', '/close', { peer: 'a' });
  const row = (await web.listNativeHistory(f.ctx)).workers[0]; configuration.a.realClaude = true;
  const restored = await web.resumeNativeSession(f.ctx, 'a', { owner: row.owner, sessionId: row.sessionId, confirmed: true });
  assert.equal(restored.nativeSnapshot().status, 'ready'); assert.equal(restored.nativeSnapshot().sessionId, null);
  assert.equal(restored.binding.provider_session_id, row.sessionId); assert.equal(restored.id, 'a');
  assert.notEqual(restored.nativeIdentity.owner, row.owner);
});

for (const retirePrevious of [false, true]) {
  test(`Claude lazy restore replaces a ${retirePrevious ? 'retired' : 'closed'} confirmed Web view and waits for SDK initialization`, async t => {
    const originalSdk = controlledClaudeSdk(), resumedSdk = controlledClaudeSdk();
    const configuration = { a: { claudeSdk: originalSdk } };
    const f = await fixture(t, configuration), web = f.bridge();
    await f.start('a', { provider: 'claude' });
    await web.discoverNativeSessions(f.ctx);
    const previousView = web.session();
    await web.nativeAction(previousView, 'send', { text: 'first message', submissionId: 'claude_before_resume_1' });
    await f.service.poll(); await originalSdk.consume();
    await originalSdk.initialize('retained-claude-session');
    await web.nativeAction(previousView, 'read');
    assert.equal(previousView.nativeIdentity.sessionId, 'retained-claude-session');
    await web.nativeAction(previousView, 'close');
    if (retirePrevious) await web.discoverNativeSessions(f.ctx);
    assert.equal(Boolean(previousView.nativeRetired), retirePrevious);
    const saved = (await web.listNativeHistory(f.ctx)).workers[0];
    configuration.a.claudeSdk = resumedSdk;
    const before = f.mesh.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
    const restored = await web.resumeNativeSession(f.ctx, 'a', {
      owner: saved.owner, sessionId: saved.sessionId, confirmed: true
    });
    assert.notEqual(restored, previousView);
    assert.equal(previousView.nativeRetired, true);
    assert.notEqual(restored.nativeIdentity.owner, saved.owner);
    assert.equal(restored.nativeIdentity.generation, previousView.nativeIdentity.generation);
    assert.equal(restored.nativeSnapshot().status, 'ready');
    assert.equal(restored.nativeSnapshot().sessionId, null);
    assert.equal(restored.binding.provider_session_id, saved.sessionId);
    assert.equal(f.mesh.prepare('SELECT COUNT(*) AS n FROM messages').get().n, before,
      'restoring does not send an automatic prompt');
    restored.actionTokens.add('resumed-controller');
    await web.nativeAction(restored, 'send', { text: 'continue saved session', submissionId: 'claude_after_resume_1' });
    await f.service.poll();
    await web.nativeAction(restored, 'read');
    assert.equal(restored.nativeSnapshot().status, 'queued');
    assert.equal(restored.nativeSnapshot().sessionId, null);
    await resumedSdk.consume();
    await web.pollNativeSessions(f.ctx);
    assert.equal(restored.nativeSnapshot().status, 'running');
    assert.equal(restored.nativeSnapshot().sessionId, null);
    assert.equal(restored.nativeRetired, undefined);
    assert.equal(restored.actionTokens.has('resumed-controller'), true);
    await resumedSdk.initialize(saved.sessionId);
    await web.nativeAction(restored, 'read');
    assert.equal(web.session(), restored);
    assert.equal(restored.nativeSnapshot().sessionId, saved.sessionId);
    assert.equal(restored.nativeSnapshot().connected, true);
    assert.equal(restored.actionTokens.has('resumed-controller'), true);
    assert.equal(f.created.length, 2);
    await assert.rejects(web.nativeAction(previousView, 'send', {
      text: 'stale controller', submissionId: 'claude_stale_resume_1'
    }), { code: 'NATIVE_OWNER_CHANGED' });
  });
}
