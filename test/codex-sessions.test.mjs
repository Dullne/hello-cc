import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { initSchema } from '../lib/db/schema.mjs';
import { createEventHelpers } from '../lib/db/events.mjs';
import { createPeerHelpers } from '../lib/core/peers/peer-helpers.mjs';
import { createPeerBindingStore } from '../lib/db/stores/peers.mjs';
import { createCodexSessions } from '../lib/web/codex-sessions.mjs';
import { createSessionSerialize } from '../lib/web/session-serialize.mjs';
import { nextSessionId } from '../lib/web/runtime.mjs';
import { captureSelectedCwdIdentity } from '../lib/process/selected-cwd-identity.mjs';

function fixture(t, hooks = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-codex-manager-'));
  const ctx = { root, dbPath: path.join(root, 'mesh.db') };
  const connect = (project = ctx) => {
    const db = new DatabaseSync(project.dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    return db;
  };
  const setup = connect();
  initSchema(setup);
  setup.close();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = () => 1000;
  const events = createEventHelpers({ now });
  const peerStore = createPeerHelpers({
    now, addEvent: events.addEvent,
    liveProcessIdentity: (pid) => pid ? { pid, startToken: `start-${pid}`, commandHash: 'a'.repeat(64) } : null
  });
  const bindings = createPeerBindingStore({ now, addEvent: events.addEvent });
  const evidence = new Map();
  const adapters = [];
  const calls = [];
  const broadcasts = [];
  const scopedConfigs = [];
  const read = (fn, project = ctx) => {
    const db = connect(project);
    try { return fn(db); } finally { db.close(); }
  };

  function adapterFactory(options) {
    hooks.adapterFactory?.();
    const n = adapters.length + 1;
    const state = { pid: 30_000 + n, executorId: `executor-${n}`, status: 'ready', processExited: false };
    let closePromise;
    let started = false;
    async function initialize() {
      if (!started) { started = true; await options.onSpawn?.({ pid: state.pid, executorId: state.executorId }); }
    }
    const adapter = {
      options,
      initialize,
      snapshot: () => ({ ...state }),
      async startThread(params) {
        await initialize();
        calls.push({ adapter: n, method: 'startThread', params });
        await hooks.startThread?.(n);
        return { thread: { id: `thread-${n}` } };
      },
      async resumeThread(threadId, params) {
        await initialize();
        calls.push({ adapter: n, method: 'resumeThread', threadId, params });
        await hooks.resumeThread?.({ n, threadId, params, read });
        return { thread: { id: threadId } };
      },
      async startTurn(threadId, input) {
        calls.push({ adapter: n, method: 'startTurn', threadId, input });
        await hooks.startTurn?.({ n, threadId, input, read });
        return { turn: { id: `turn-${n}`, status: 'inProgress' } };
      },
      async steer(threadId, turnId, input) {
        calls.push({ adapter: n, method: 'steer', threadId, turnId, input });
        await hooks.steer?.({ n, threadId, turnId, input, read });
        return { turn: { id: turnId } };
      },
      async readThread(threadId, params) {
        calls.push({ adapter: n, method: 'readThread', threadId, params });
        return { thread: { id: threadId, turns: [] } };
      },
      async peekThread(threadId) {
        await initialize();
        calls.push({ adapter: n, method: 'peekThread', threadId });
        return { thread: { id: threadId, turns: [], cwd: options.cwd,
          ...await hooks.peekThread?.({ n, threadId, read }) } };
      },
      async listThreads(params) {
        await initialize(); calls.push({ adapter: n, method: 'listThreads', params });
        return await hooks.listThreads?.({ n, params, read }) || { data: [], nextCursor: null };
      },
      async forkThread(threadId, params, beforeSubmit = () => {}) {
        await initialize(); beforeSubmit();
        calls.push({ adapter: n, method: 'forkThread', threadId, params });
        return await hooks.forkThread?.({ n, threadId, params, read }) ||
          { thread: { id: `fork-${n}`, cwd: options.cwd, turns: [] } };
      },
      async interrupt(threadId, turnId) {
        calls.push({ adapter: n, method: 'interrupt', threadId, turnId });
        return {};
      },
      async approve(input) {
        calls.push({ adapter: n, method: 'approve', input });
        return { approved: true };
      },
      disconnect() {
        state.status = 'disconnected';
        options.onChange?.({ ...state });
      },
      close() {
        if (!closePromise) closePromise = (async () => {
          calls.push({ adapter: n, method: 'close' });
          state.status = 'closed';
          options.onChange?.({ ...state });
          await hooks.close?.({ n, read });
          state.processExited = true;
        })();
        return closePromise;
      }
    };
    adapters.push(adapter);
    return adapter;
  }

  function manager(sessions = new Map()) {
    return {
      sessions,
      ...createCodexSessions({
        sessions,
        sessionKey: (project, id) => `${project.root}\0${id}`,
        nextProjectSessionId: (project, kind) => nextSessionId([
          ...[...sessions.values()].map((session) => session.id),
          ...read((db) => db.prepare('SELECT id FROM peers').all().map((peer) => peer.id), project)
        ], kind),
        connectWebProject: connect,
        upsertPeer: peerStore.upsertPeer,
        upsertCanonicalPeerBinding: (...args) => {
          hooks.beforeBinding?.();
          return bindings.upsertCanonicalPeerBinding(...args);
        },
        observePeerEvidence: (_project, peer) => ({ state: evidence.get(peer.id) || 'unknown' }),
        broadcast: (session, payload) => broadcasts.push({ session: session.id, payload }),
        closeSessionClients: (session) => { session.clients.clear(); },
        now, addEvent: events.addEvent, adapterFactory,
        waitForOwnerIdentity: async pid => ({ state: 'live', identity: { pid, startToken: `start-${pid}`, commandHash: 'a'.repeat(64) } }),
        mcpConfigFactory: input => {
          const capability = { input, config: { command: 'test-scoped-mcp', args: [], env: { HCC_MCP_BOOTSTRAP_TOKEN: 'private-test-capability' } }, disposed: false,
            dispose() { this.disposed = true; } };
          scopedConfigs.push(capability); return capability;
        }
      })
    };
  }

  function oldOwner(state) {
    read((db) => {
      peerStore.upsertPeer(db, { id: 'old-owner', kind: 'codex', pid: 777, status: 'running' });
      bindings.upsertCanonicalPeerBinding(db, {
        peer: 'old-owner', provider: 'codex', provider_session_id: 'old-thread',
        transport: 'tmux', runtime_session_id: 'old-owner', runtime_target: '%old'
      });
    });
    evidence.set('old-owner', state);
  }

  return {
    ctx, manager, adapters, calls, broadcasts, read, oldOwner, scopedConfigs,
    project(name) {
      const projectRoot = path.join(root, name);
      fs.mkdirSync(projectRoot);
      const project = { root: projectRoot, dbPath: path.join(projectRoot, 'mesh.db') };
      const db = connect(project);
      initSchema(db);
      db.close();
      return project;
    },
    start: (m, input = {}) => m.startCodexSession({ kind: 'codex', projectCtx: ctx, ...input }),
    events: () => read((db) => db.prepare('SELECT * FROM events ORDER BY id').all().map((event) => ({
      ...event, payload: JSON.parse(event.payload)
    })))
  };
}

test('new structured session persists a real peer, thread binding, and executor receipt', async (t) => {
  const f = fixture(t);
  const m = f.manager();
  const session = await f.start(m);
  assert.equal(session.type, 'app-server');
  assert.equal(session.status, 'running');
  assert.equal(session.executorId, 'executor-1');
  assert.equal(m.sessions.size, 1);
  const stored = f.read((db) => ({
    peer: { ...db.prepare('SELECT * FROM peers WHERE id = ?').get(session.peerId) },
    binding: { ...db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get(session.peerId) }
  }));
  assert.equal(stored.peer.pid, f.adapters[0].snapshot().pid);
  assert.equal(stored.peer.capabilities, 'codex-app-server');
  assert.equal(stored.binding.provider_session_id, 'thread-1');
  assert.equal(stored.binding.transport, 'app-server');
  assert.equal(stored.binding.runtime_session_id, session.id);
  const receipt = f.events().find((event) => event.type === 'codex.executor.started');
  assert.equal(receipt.payload.executor_id, 'executor-1');
  assert.equal(receipt.payload.thread_id, 'thread-1');
  assert.equal(f.adapters[0].options.cwd, f.ctx.root);
  assert.equal(f.adapters[0].options.env.HCC_PEER, session.id);
  assert.equal(f.adapters[0].options.env.HCC_ROOT, f.ctx.root);
  assert.equal(f.adapters[0].options.env.HCC_DB, f.ctx.dbPath);
  assert.equal(f.calls.filter((call) => call.method === 'startTurn').length, 0);
});

test('session listing uses the pinned executor identity without copying retained conversation state', async (t) => {
  const f = fixture(t), m = f.manager(), session = await f.start(m);
  const original = session.adapter.snapshot;
  let snapshots = 0;
  session.adapter.snapshot = () => { snapshots++; return original(); };
  const serializer = createSessionSerialize({ sessions: m.sessions, ctx: f.ctx,
    sameResolvedPath: (a, b) => a === b, cookieSocketValid: () => true });
  for (let index = 0; index < 20; index++) assert.equal(serializer.serializeSession(session).executor_id, 'executor-1');
  assert.equal(snapshots, 0);
});

test('resume requires explicit handoff confirmation before creating an executor', async (t) => {
  const f = fixture(t);
  const m = f.manager();
  await assert.rejects(f.start(m, { mode: 'resume', resume: 'old-thread' }), { code: 'HANDOFF_REQUIRED' });
  await assert.rejects(f.start(m, { mode: 'resume', resume: '', handoffConfirmed: true }), { code: 'HANDOFF_REQUIRED' });
  assert.equal(f.adapters.length, 0);
  assert.equal(m.sessions.size, 0);
  assert.equal(f.events().length, 0);
});

for (const ownerState of ['live', 'unknown']) {
  test(`resume rejects an existing ${ownerState} owner without changing its binding`, async (t) => {
    const f = fixture(t);
    f.oldOwner(ownerState);
    const before = f.read((db) => db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get('old-owner'));
    const m = f.manager();
    await assert.rejects(f.start(m, { mode: 'resume', resume: 'old-thread', handoffConfirmed: true }), { code: 'THREAD_IN_USE' });
    assert.deepEqual(f.read((db) => db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get('old-owner')), before);
    assert.equal(f.adapters.length, 0);
    assert.equal(m.sessions.size, 0);
  });
}

test('resume can bind a fresh executor after the previous runtime is confirmed dead', async (t) => {
  const f = fixture(t);
  f.oldOwner('dead');
  f.read((db) => db.prepare(`
    INSERT INTO tasks(title, status, owner, priority, created_at, updated_at)
    VALUES ('Preserve task ownership', 'running', 'old-owner', 100, 1000, 1000)
  `).run());
  const m = f.manager();
  const session = await f.start(m, { mode: 'resume', resume: 'old-thread', handoffConfirmed: true });
  assert.equal(session.binding.provider_session_id, 'old-thread');
  assert.equal(session.binding.transport, 'app-server');
  assert.equal(session.binding.peer, session.peerId);
  assert.equal(session.peerId, 'old-owner');
  assert.deepEqual({ ...f.read((db) => db.prepare('SELECT owner, status FROM tasks').get()) },
    { owner: 'old-owner', status: 'running' });
  assert.equal(f.calls.find((call) => call.method === 'resumeThread').threadId, 'old-thread');
  assert.equal(f.read((db) => db.prepare("SELECT COUNT(*) AS n FROM peer_bindings WHERE provider = 'codex' AND provider_session_id = 'old-thread'").get().n), 1);
});

test('a synchronously failed adapter factory leaves no reserved session and permits retry', async (t) => {
  let fail = true;
  const error = new Error('adapter initialization failed');
  const f = fixture(t, { adapterFactory: () => { if (fail) throw error; } });
  const m = f.manager();
  await assert.rejects(f.start(m, { mode: 'resume', resume: 'unowned-thread', handoffConfirmed: true }),
    (actual) => actual === error);
  assert.equal(m.sessions.size, 0);
  assert.equal(f.read((db) => db.prepare('SELECT COUNT(*) AS n FROM peers').get().n), 0);
  fail = false;
  const retried = await f.start(m, { mode: 'resume', resume: 'unowned-thread', handoffConfirmed: true });
  assert.equal(retried.status, 'running');
});

for (const mode of ['new', 'resume']) {
  test(`${mode} rejects a disconnected startup result without persisting an executor and permits retry`, async (t) => {
    let disconnect = true;
    const onStartup = () => { if (disconnect) f.adapters.at(-1).disconnect(); };
    const f = fixture(t, { startThread: onStartup, resumeThread: onStartup });
    if (mode === 'resume') f.oldOwner('dead');
    const before = f.read((db) => ({
      peers: db.prepare('SELECT * FROM peers').all(),
      bindings: db.prepare('SELECT * FROM peer_bindings').all()
    }));
    const m = f.manager();
    const input = mode === 'resume' ? { mode, resume: 'old-thread', handoffConfirmed: true } : { mode };

    await assert.rejects(f.start(m, input), { code: 'CODEX_DISCONNECTED' });
    assert.equal(m.sessions.size, 0);
    assert.equal(f.adapters[0].snapshot().status, 'closed');
    assert.equal(f.adapters[0].snapshot().processExited, true);
    assert.equal(f.calls.filter((call) => call.method === 'close').length, 1);
    assert.deepEqual(f.read((db) => ({
      peers: db.prepare('SELECT * FROM peers').all(),
      bindings: db.prepare('SELECT * FROM peer_bindings').all()
    })), before);
    assert.equal(f.events().filter((event) => event.type === 'codex.executor.started').length, 0);

    disconnect = false;
    const retried = await f.start(m, input);
    assert.equal(retried.status, 'running');
    assert.equal(f.adapters.length, 2);
    assert.equal(f.calls.filter((call) => call.method === 'close').length, 1);
    if (mode === 'resume') assert.equal(retried.peerId, 'old-owner');
  });
}

test('resume rechecks owner liveness after RPC before changing the stored binding', async (t) => {
  const f = fixture(t, { resumeThread: () => { f.oldOwner('live'); } });
  f.oldOwner('dead');
  const before = f.read((db) => db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get('old-owner'));
  const m = f.manager();
  await assert.rejects(f.start(m, { mode: 'resume', resume: 'old-thread', handoffConfirmed: true }), { code: 'THREAD_IN_USE' });
  assert.deepEqual(f.read((db) => db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get('old-owner')), before);
  assert.equal(m.sessions.size, 0);
  assert.equal(f.calls.filter((call) => call.method === 'close').length, 1);
});

test('binding failure rolls back peer registration and executor receipt as one transaction', async (t) => {
  const error = new Error('binding rejected');
  const f = fixture(t, { beforeBinding: () => { throw error; } });
  const m = f.manager();
  await assert.rejects(f.start(m), (actual) => actual === error);
  assert.equal(f.read((db) => db.prepare('SELECT COUNT(*) AS n FROM peers').get().n), 0);
  assert.equal(f.read((db) => db.prepare('SELECT COUNT(*) AS n FROM peer_bindings').get().n), 0);
  assert.equal(f.events().length, 0);
  assert.equal(m.sessions.size, 0);
  assert.equal(f.calls.filter((call) => call.method === 'close').length, 1);
});

test('concurrent new sessions reserve separate runtime IDs before thread startup finishes', async (t) => {
  let finishStartup;
  const startup = new Promise((resolve) => { finishStartup = resolve; });
  const f = fixture(t, { startThread: () => startup });
  const m = f.manager();
  const first = f.start(m);
  const second = f.start(m);
  assert.equal(m.sessions.size, 2);
  assert.equal(new Set([...m.sessions.values()].map((session) => session.id)).size, 2);
  finishStartup();
  const opened = await Promise.all([first, second]);
  assert.notEqual(opened[0].id, opened[1].id);
  assert.notEqual(opened[0].binding.provider_session_id, opened[1].binding.provider_session_id);
  assert.equal(f.read((db) => db.prepare('SELECT COUNT(*) AS n FROM peer_bindings').get().n), 2);
});

test('transport loss retains global thread ownership until the disconnected executor actually exits', async (t) => {
  let finishClose;
  const closing = new Promise((resolve) => { finishClose = resolve; });
  t.after(() => finishClose());
  const f = fixture(t, { close: ({ n }) => n === 1 ? closing : undefined });
  const m = f.manager();
  const original = await f.start(m);
  const otherProject = f.project('other-project');
  const resume = { mode: 'resume', resume: original.binding.provider_session_id,
    handoffConfirmed: true, projectCtx: otherProject };

  f.adapters[0].disconnect();
  assert.equal(original.status, 'exited');
  assert.equal(f.adapters[0].snapshot().processExited, false);
  await assert.rejects(f.start(m, resume), { code: 'THREAD_IN_USE' });
  assert.equal(f.adapters.length, 1, 'another project must not create an executor for a live disconnected owner');
  assert.equal(f.calls.filter((call) => call.method === 'close').length, 1,
    'transport loss schedules closure of the original executor');
  assert.equal(f.adapters[0].snapshot().status, 'closed');
  await assert.rejects(f.start(m, resume), { code: 'THREAD_IN_USE' });
  assert.equal(f.read((db) => db.prepare('SELECT COUNT(*) AS n FROM peer_bindings').get().n, otherProject), 0);

  finishClose();
  await f.adapters[0].close();
  assert.equal(f.adapters[0].snapshot().processExited, true);
  const resumed = await f.start(m, resume);
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.root, otherProject.root);
  assert.equal(resumed.binding.provider_session_id, original.binding.provider_session_id);
  assert.equal(f.adapters.length, 2);
  assert.equal(f.read((db) => db.prepare('SELECT COUNT(*) AS n FROM peer_bindings').get().n, otherProject), 1);
});

test('explicit stop keeps global thread ownership while close is pending and releases it after completion', async (t) => {
  let finishClose;
  const closing = new Promise((resolve) => { finishClose = resolve; });
  t.after(() => finishClose());
  const f = fixture(t, { close: ({ n }) => n === 1 ? closing : undefined });
  const m = f.manager();
  const original = await f.start(m);
  const otherProject = f.project('other-project');
  const resume = { mode: 'resume', resume: original.binding.provider_session_id,
    handoffConfirmed: true, projectCtx: otherProject };

  const stopped = m.stopCodexSession(original);
  assert.equal(original.status, 'exited');
  assert.equal(original.executorReleased, undefined);
  assert.equal(f.adapters[0].snapshot().processExited, false);
  await assert.rejects(f.start(m, resume), { code: 'THREAD_IN_USE' });
  assert.equal(f.adapters.length, 1);

  finishClose();
  await stopped;
  assert.equal(original.executorReleased, true);
  assert.equal(f.adapters[0].snapshot().processExited, true);
  const resumed = await f.start(m, resume);
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.binding.provider_session_id, original.binding.provider_session_id);
  assert.equal(f.calls.filter((call) => call.method === 'close').length, 1);
});

test('turn submission commits pending before calling the executor and prevents duplicate attempts after manager rebuild', async (t) => {
  const submissionId = 'unique_submit_001';
  const f = fixture(t, {
    startTurn({ read }) {
      const receipt = read((db) => db.prepare("SELECT payload FROM events WHERE type = 'codex.submission.pending'").get());
      assert.equal(JSON.parse(receipt.payload).submission_id, submissionId);
    }
  });
  const m = f.manager();
  const session = await f.start(m);
  const submitted = await m.codexAction(session, 'turn', { submissionId, text: 'Please inspect the code.' });
  assert.equal(submitted.submissionId, submissionId);
  await assert.rejects(m.codexAction(session, 'turn', { submissionId, text: 'Do not replay.' }), { code: 'SUBMISSION_EXISTS' });

  const rebuilt = f.manager();
  const reopened = await f.start(rebuilt);
  await assert.rejects(rebuilt.codexAction(reopened, 'turn', { submissionId, text: 'Do not replay after restart.' }), { code: 'SUBMISSION_EXISTS' });
  assert.equal(f.calls.filter((call) => call.method === 'startTurn').length, 1);
  const receipts = f.events().filter((event) => event.type.startsWith('codex.submission.'));
  assert.deepEqual(receipts.map((event) => event.type), ['codex.submission.pending', 'codex.submission.confirmed']);
  assert.equal(receipts[0].payload.executor_id, 'executor-1');
  assert.equal(receipts[0].payload.thread_id, session.binding.provider_session_id);
});

test('an unconfirmed failed submission stays durable and is never automatically retried', async (t) => {
  const error = Object.assign(new Error('transport lost after write'), { code: 'CODEX_TRANSPORT_LOST' });
  const f = fixture(t, { startTurn: () => { throw error; } });
  const m = f.manager();
  const session = await f.start(m);
  const input = { submissionId: 'uncertain_submit_001', text: 'One attempt only.' };
  await assert.rejects(m.codexAction(session, 'turn', input), (actual) => actual === error);
  const rebuilt = f.manager();
  await assert.rejects(rebuilt.codexAction(session, 'turn', input), { code: 'SUBMISSION_EXISTS' });
  assert.equal(f.calls.filter((call) => call.method === 'startTurn').length, 1);
  assert.deepEqual(f.events().filter((event) => event.type.startsWith('codex.submission.')).map((event) => event.type),
    ['codex.submission.pending', 'codex.submission.unconfirmed']);
});

test('reading state creates no submission or model turn and approval/interrupt stay bound to the session thread', async (t) => {
  const f = fixture(t);
  const m = f.manager();
  const session = await f.start(m);
  const before = f.events().length;
  const result = await m.codexAction(session, 'read', {});
  assert.equal(result.thread.id, session.binding.provider_session_id);
  assert.equal(f.events().length, before);
  assert.equal(f.calls.filter((call) => call.method === 'startTurn' || call.method === 'steer').length, 0);
  await m.codexAction(session, 'approve', {
    executorId: 'executor-1', threadId: 'spoofed-thread', turnId: 'turn-1', requestId: 'approval-1', decision: 'accept', content: { note: 'private-form-note', enabled: false }
  });
  const approval = f.calls.find((call) => call.method === 'approve').input;
  assert.equal(approval.threadId, session.binding.provider_session_id);
  assert.equal(approval.executorId, 'executor-1');
  assert.equal(approval.turnId, 'turn-1');
  assert.equal(approval.requestId, 'approval-1');
  assert.deepEqual(approval.content, { note: 'private-form-note', enabled: false });
  assert.equal(JSON.stringify(f.events()).includes('private-form-note'), false);
  await m.codexAction(session, 'interrupt', { threadId: 'spoofed-thread', turnId: 'turn-1' });
  const interrupt = f.calls.find((call) => call.method === 'interrupt');
  assert.equal(interrupt.threadId, session.binding.provider_session_id);
  assert.equal(interrupt.turnId, 'turn-1');
});

test('executor close marks its peer exited while preserving project task ownership and status', async (t) => {
  const f = fixture(t);
  const m = f.manager();
  const session = await f.start(m);
  f.read((db) => db.prepare(`
    INSERT INTO tasks(title, status, owner, assignee, priority, created_at, updated_at)
    VALUES ('Continue independently', 'running', ?, ?, 100, 1000, 1000)
  `).run(session.peerId, session.peerId));
  const before = f.read((db) => db.prepare('SELECT * FROM tasks').all());
  await m.stopCodexSession(session);
  assert.equal(session.status, 'exited');
  assert.equal(f.read((db) => db.prepare('SELECT status FROM peers WHERE id = ?').get(session.peerId).status), 'exited');
  assert.deepEqual(f.read((db) => db.prepare('SELECT * FROM tasks').all()), before);
  assert.equal(f.calls.filter((call) => call.method === 'close').length, 1);
  assert.equal(f.events().at(-1).type, 'codex.executor.stopped');
});

test('MCP capability uses the same peer/process identity as registration and is revoked on executor close', async t => {
  const f = fixture(t), m = f.manager(), session = await f.start(m);
  const capability = f.scopedConfigs[0];
  assert.equal(capability.input.peer, session.peerId); assert.equal(capability.input.executorId, 'executor-1');
  const owner = f.read(db => db.prepare('SELECT pid,pid_start_token,pid_command_hash FROM peers WHERE id = ?').get(session.peerId));
  assert.equal(owner.pid, capability.input.ownerIdentity.pid);
  assert.equal(owner.pid_start_token, capability.input.ownerIdentity.startToken);
  assert.equal(owner.pid_command_hash, capability.input.ownerIdentity.commandHash);
  await m.stopCodexSession(session); assert.equal(capability.disposed, true);
});

test('history listing filters foreign cwd and reading reuses a live executor without resuming or submitting', async t => {
  const f = fixture(t, { listThreads: ({ params }) => ({ data: [
    { id: 'thread-1', cwd: params.cwd }, { id: 'foreign', cwd: os.tmpdir() }
  ], nextCursor: 'cursor-2' }) });
  const m = f.manager(), session = await f.start(m);
  const listed = await m.listCodexThreads(f.ctx, { limit: 10 });
  assert.equal(listed.threads.length, 1); assert.equal(listed.threads[0].managedSessionId, session.id);
  assert.equal(listed.nextCursor, 'cursor-2');
  assert.equal((await m.readCodexThread(f.ctx, 'history-only')).thread.id, 'history-only');
  assert.equal(f.adapters.length, 1);
  assert.equal(f.calls.filter(call => call.method === 'resumeThread' || call.method === 'startTurn').length, 0);
});

test('history listing does not label an old inode executor as managed by a replacement root', async t => {
  const f = fixture(t, { listThreads: ({ params }) => ({ data: [
    { id: 'thread-1', cwd: params.cwd }
  ], nextCursor: null }) });
  f.ctx.rootIdentity = captureSelectedCwdIdentity(f.ctx.root);
  const m = f.manager();
  const oldSession = await f.start(m);
  const moved = `${f.ctx.root}-moved`;
  fs.renameSync(f.ctx.root, moved);
  fs.mkdirSync(f.ctx.root);
  const replacement = { root: f.ctx.root, dbPath: f.ctx.dbPath,
    rootIdentity: captureSelectedCwdIdentity(f.ctx.root) };
  t.after(() => {
    f.ctx.rootIdentity.release();
    replacement.rootIdentity.release();
    fs.rmSync(moved, { recursive: true, force: true });
  });

  const listed = await m.listCodexThreads(replacement);
  assert.equal(listed.threads.length, 1);
  assert.equal(listed.threads[0].managedSessionId, null);
  assert.equal(oldSession.status, 'running', 'rejecting reuse must not stop the old executor');
  await assert.rejects(m.codexAction(oldSession, 'read', {}), { code: 'PROJECT_PATH_CHANGED' });
});

test('history listing reports a root rebound during thread validation instead of an empty result', async t => {
  let moved;
  const f = fixture(t, { listThreads: ({ params }) => ({ data: [{
    id: 'thread-1',
    get cwd() {
      fs.renameSync(params.cwd, moved);
      fs.mkdirSync(params.cwd);
      return params.cwd;
    }
  }], nextCursor: null }) });
  moved = `${f.ctx.root}-moved`;
  f.ctx.rootIdentity = captureSelectedCwdIdentity(f.ctx.root);
  t.after(() => {
    f.ctx.rootIdentity.release();
    fs.rmSync(moved, { recursive: true, force: true });
  });

  await assert.rejects(f.manager().listCodexThreads(f.ctx), { code: 'PROJECT_PATH_CHANGED' });
});

test('history read without a running adapter closes its temporary executor and rejects foreign cwd', async t => {
  const f = fixture(t, { peekThread: () => ({ cwd: os.tmpdir() }) }), m = f.manager();
  await assert.rejects(m.readCodexThread(f.ctx, 'foreign-history'), { code: 'PROJECT_PATH_FORBIDDEN' });
  assert.equal(f.calls.filter(call => call.method === 'close').length, 1);
  assert.equal(f.calls.filter(call => call.method === 'startThread' || call.method === 'resumeThread' || call.method === 'startTurn').length, 0);
});

test('Codex history and resume reject a rebound selected project before opening an executor', async t => {
  const f = fixture(t);
  const selected = captureSelectedCwdIdentity(f.ctx.root);
  f.ctx.rootIdentity = selected;
  t.after(() => selected.release());
  const moved = `${f.ctx.root}-moved`;
  t.after(() => fs.rmSync(moved, { recursive: true, force: true }));
  fs.renameSync(f.ctx.root, moved);
  fs.mkdirSync(f.ctx.root);
  const m = f.manager();
  await assert.rejects(m.listCodexThreads(f.ctx), { code: 'PROJECT_PATH_CHANGED' });
  await assert.rejects(m.readCodexThread(f.ctx, 'history-only'), { code: 'PROJECT_PATH_CHANGED' });
  await assert.rejects(m.forkCodexThread(f.ctx, 'history-only', { confirmed: true }), { code: 'PROJECT_PATH_CHANGED' });
  await assert.rejects(m.startCodexSession({ projectCtx: f.ctx, kind: 'codex', mode: 'resume',
    resume: 'history-only', handoffConfirmed: true }), { code: 'PROJECT_PATH_CHANGED' });
  assert.equal(f.adapters.length, 0);
});

test('fork uses a separate temporary executor, closes it before new resume, and preserves the active source owner', async t => {
  const f = fixture(t), m = f.manager(), source = await f.start(m);
  const ownerBefore = f.read(db => db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get(source.peerId));
  const fork = await m.forkCodexThread(f.ctx, source.binding.provider_session_id,
    { confirmed: true, authorizeMutation: () => {} });
  assert.notEqual(fork.thread.id, source.binding.provider_session_id);
  assert.notEqual(fork.session.peerId, source.peerId); assert.equal(source.status, 'running');
  assert.deepEqual(f.read(db => db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get(source.peerId)), ownerBefore);
  const forkCall = f.calls.find(call => call.method === 'forkThread'); assert.equal(forkCall.adapter, 2);
  const closeIndex = f.calls.findIndex(call => call.adapter === 2 && call.method === 'close');
  const resumeIndex = f.calls.findIndex(call => call.adapter === 3 && call.method === 'resumeThread');
  assert.ok(closeIndex >= 0 && resumeIndex > closeIndex);
  assert.equal(f.calls.filter(call => call.adapter === 1 && ['forkThread','resumeThread','close'].includes(call.method)).length, 0);
});

test('fork denies a control change after peek and does not create a thread or a second managed executor', async t => {
  const f = fixture(t), m = f.manager(); await f.start(m);
  await assert.rejects(m.forkCodexThread(f.ctx, 'thread-1', { confirmed: true,
    authorizeMutation: () => { throw new Error('lease epoch changed'); } }), /lease epoch changed/);
  assert.equal(f.calls.filter(call => call.method === 'forkThread').length, 0);
  assert.equal(f.adapters.length, 2);
});

test('a fork helper whose exit is not confirmed cannot spawn the resume executor', async t => {
  let f;
  f = fixture(t, { forkThread: ({ n }) => {
    f.adapters[n - 1].close = async () => {};
    return { thread: { id: 'saved-fork', cwd: f.ctx.root } };
  } });
  const m = f.manager();
  await assert.rejects(m.forkCodexThread(f.ctx, 'old-thread', { confirmed: true }), { code: 'CODEX_EXECUTOR_CLOSE_UNCONFIRMED' });
  assert.equal(f.adapters.length, 1); assert.equal(f.calls.filter(call => call.method === 'resumeThread').length, 0);
});

test('resume refuses to migrate a foreign project thread into this project', async t => {
  const f = fixture(t, { peekThread: () => ({ cwd: os.tmpdir() }) }), m = f.manager();
  await assert.rejects(f.start(m, { mode: 'resume', resume: 'foreign', handoffConfirmed: true }), { code: 'PROJECT_PATH_FORBIDDEN' });
  assert.equal(f.calls.filter(call => call.method === 'resumeThread').length, 0);
});


test('account reads are fenced to the current Web executor and leave task and submission state unchanged', async t => {
  const f=fixture(t), manager=f.manager(); const session=await manager.startCodexSession({kind:'codex',projectCtx:f.ctx});
  let reads=0; session.adapter.readAccount=async()=>{reads++;return {status:'ready',authentication:'providerManaged'};};
  await assert.rejects(manager.codexAction(session,'account',{executorId:'old-executor'}),{code:'CODEX_EXECUTOR_MISMATCH'});
  const state=await manager.codexAction(session,'account',{executorId:session.executorId});
  assert.equal(state.authentication,'providerManaged'); assert.equal(reads,1);
  assert.equal(f.read(db=>db.prepare("SELECT count(*) n FROM events WHERE type LIKE 'codex.submission.%'").get().n),0);
});
