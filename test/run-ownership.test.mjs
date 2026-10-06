import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createRunCommands } from '../lib/cli/commands/run.mjs';
import { createPeerHelpers } from '../lib/core/peers/peer-helpers.mjs';
import { createPeerBindingStore } from '../lib/db/stores/peers.mjs';
import { createEventHelpers } from '../lib/db/events.mjs';
import { initSchema } from '../lib/db/schema.mjs';
import { inspectProcessIdentity } from '../lib/process/identity.mjs';
import { captureSelectedCwdSnapshot } from '../lib/process/selected-cwd-identity.mjs';

function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-run-ownership-'));
  t.mock.method(os, 'homedir', () => directory);
  const previousEnvironment = process.env;
  const previousExitCode = process.exitCode;
  process.env = { ...previousEnvironment };
  delete process.env.HCC_PEER;
  delete process.env.HCC_INTERNAL_WEB_MANAGED_RUN;
  const root = path.join(directory, 'project');
  const dbPath = path.join(root, '.hello-cc', 'mesh.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const connect = () => {
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    return db;
  };
  const setup = connect();
  initSchema(setup);
  setup.close();
  const now = () => 1000;
  const events = createEventHelpers({ now });
  const peers = createPeerHelpers({
    now, addEvent: events.addEvent,
    liveProcessIdentity: (pid) => inspectProcessIdentity(pid).identity
  });
  const bindings = createPeerBindingStore({ now, addEvent: events.addEvent });
  const commands = createRunCommands({
    connect, now, ...events,
    upsertPeer: peers.upsertPeer,
    upsertCanonicalPeerBinding: bindings.upsertCanonicalPeerBinding,
    helpRun() {}, redactedLogText: (value) => value, CLI_NAME: 'hcc', BUFS_DIR_NAME: 'bufs',
    ...overrides
  });
  t.after(() => {
    process.env = previousEnvironment;
    process.exitCode = previousExitCode;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    commands, peers, bindings, ctx: { root, cwd: root, dbPath },
    read(fn) { const db = connect(); try { return fn(db); } finally { db.close(); } },
    write(fn) { const db = connect(); try { return fn(db); } finally { db.close(); } }
  };
}

test('ordinary run rejects an existing live owner without replacing peer or binding, including --force', async (t) => {
  const f = fixture(t);
  f.write((db) => {
    f.peers.upsertPeer(db, { id: 'active', kind: 'shell', pid: process.pid, status: 'running' });
    db.prepare('UPDATE peers SET last_seen_at = 1 WHERE id = ?').run('active');
    f.bindings.upsertPeerBinding(db, { peer: 'active', provider: 'shell', transport: 'hcc-run' });
  });
  const before = f.read((db) => ({
    peer: db.prepare('SELECT * FROM peers WHERE id = ?').get('active'),
    binding: db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get('active')
  }));
  for (const flags of [[], ['--force']]) {
    await assert.rejects(f.commands.cmdRun(f.ctx, [
      '--peer', 'active', '--kind', 'shell', ...flags, '--', process.execPath, '-e', 'process.exit(0)'
    ]), { code: 'PEER_SESSION_EXISTS' });
  }
  assert.deepEqual(f.read((db) => ({
    peer: db.prepare('SELECT * FROM peers WHERE id = ?').get('active'),
    binding: db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get('active')
  })), before);
  assert.equal(f.read((db) => db.prepare('SELECT COUNT(*) AS n FROM events').get().n), 0);
});

test('launch hold refuses run before publishing peer ownership', async (t) => {
  const f = fixture(t);
  process.env.HCC_PINNED_LAUNCH_MODE = 'hold';
  for (const webManaged of [false, true]) {
    if (webManaged) process.env.HCC_INTERNAL_WEB_MANAGED_RUN = '1';
    await assert.rejects(f.commands.cmdRun(f.ctx, [
      '--peer', webManaged ? 'held-web' : 'held', '--kind', 'shell',
      '--', process.execPath, '-e', 'process.exit(0)'
    ]), { code: 'PINNED_LAUNCH_PAUSED' });
  }
  assert.equal(f.read((db) => db.prepare('SELECT COUNT(*) AS n FROM peers').get().n), 0);
  assert.equal(f.read((db) => db.prepare('SELECT COUNT(*) AS n FROM peer_bindings').get().n), 0);
  assert.equal(f.read((db) => db.prepare('SELECT COUNT(*) AS n FROM events').get().n), 0);
  assert.equal(fs.existsSync(path.join(f.ctx.root, '.hello-cc', 'bufs')), false);
});

test('generic run rejects a replaced original root before writing peer, binding, or metadata', async (t) => {
  const f = fixture(t);
  const originalIdentity = captureSelectedCwdSnapshot(f.ctx.root);
  const movedRoot = path.join(path.dirname(f.ctx.root), 'original-project');
  const movedDb = path.join(movedRoot, '.hello-cc', 'mesh.db');
  f.ctx.initialRootIdentity = originalIdentity;
  fs.renameSync(f.ctx.root, movedRoot);
  fs.mkdirSync(f.ctx.root);
  for (const webManaged of [false, true]) {
    if (webManaged) process.env.HCC_INTERNAL_WEB_MANAGED_RUN = '1';
    await assert.rejects(f.commands.cmdRun(f.ctx, [
      '--peer', webManaged ? 'web-rebound' : 'plain-rebound', '--kind', 'shell',
      '--', process.execPath, '-e', 'process.exit(0)'
    ]), { code: 'PROJECT_PATH_CHANGED' });
  }
  const db = new DatabaseSync(movedDb);
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM peers').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM peer_bindings').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
  } finally { db.close(); }
  assert.deepEqual(fs.readdirSync(f.ctx.root), []);
});

test('web-managed run rejects a rebound selected cwd before buffer or DB publication', async (t) => {
  const f = fixture(t);
  const selected = path.join(path.dirname(f.ctx.root), 'selected');
  fs.mkdirSync(selected);
  const expectedCwdIdentity = captureSelectedCwdSnapshot(selected);
  fs.renameSync(selected, `${selected}-original`);
  fs.mkdirSync(selected);
  await assert.rejects(f.commands.cmdRunWebManaged(f.ctx, {
    id: 'selected-rebound', kind: 'shell', role: 'peer', cwd: selected,
    expectedCwdIdentity, command: process.execPath, commandArgs: ['-e', 'process.exit(0)'],
    binding: { peer: 'selected-rebound', provider: 'shell', transport: 'hcc-run' }
  }), { code: 'PROJECT_PATH_CHANGED' });
  assert.equal(f.read((db) => db.prepare('SELECT COUNT(*) AS n FROM peers').get().n), 0);
  assert.equal(f.read((db) => db.prepare('SELECT COUNT(*) AS n FROM peer_bindings').get().n), 0);
  assert.equal(f.read((db) => db.prepare('SELECT COUNT(*) AS n FROM events').get().n), 0);
  assert.equal(fs.existsSync(path.join(f.ctx.root, '.hello-cc', 'bufs')), false);
});

test('synchronous ordinary spawn rejection closes only its own published peer', async (t) => {
  const f = fixture(t, { spawnProcess() {
    throw Object.assign(new Error('simulated spawn refusal'), { code: 'EAGAIN' });
  } });
  await f.commands.cmdRun(f.ctx, [
    '--peer', 'failed-spawn', '--kind', 'shell', '--', process.execPath, '-e', 'process.exit(0)'
  ]);
  const result = f.read((db) => ({
    peer: db.prepare('SELECT * FROM peers WHERE id = ?').get('failed-spawn'),
    binding: db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get('failed-spawn'),
    events: db.prepare('SELECT type FROM events ORDER BY id').all().map((row) => row.type)
  }));
  assert.equal(result.peer.status, 'exited');
  assert.ok(result.binding);
  assert.deepEqual(result.events, ['run.session.started', 'run.session.exited']);
  assert.equal(process.exitCode, 127);
});

test('synchronous spawn rejection does not close a replacement peer owner', async (t) => {
  let f;
  f = fixture(t, { spawnProcess() {
    f.write((db) => f.peers.upsertPeer(db, {
      id: 'replaced-on-spawn', kind: 'shell', pid: process.ppid,
      status: 'running', role: 'replacement'
    }));
    throw Object.assign(new Error('simulated spawn refusal'), { code: 'EAGAIN' });
  } });
  await f.commands.cmdRun(f.ctx, [
    '--peer', 'replaced-on-spawn', '--kind', 'shell', '--', process.execPath, '-e', 'process.exit(0)'
  ]);
  const result = f.read((db) => ({
    peer: db.prepare('SELECT * FROM peers WHERE id = ?').get('replaced-on-spawn'),
    exits: db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'run.session.exited'").get().n
  }));
  assert.equal(result.peer.role, 'replacement');
  assert.equal(result.peer.status, 'running');
  assert.equal(result.exits, 0);
});

test('synchronous PTY rejection removes its own buffers and closes the peer', async (t) => {
  const f = fixture(t, { loadPty: async () => ({ spawn() {
    throw Object.assign(new Error('simulated PTY refusal'), { code: 'EAGAIN' });
  } }) });
  process.env.HCC_INTERNAL_WEB_MANAGED_RUN = '1';
  await assert.rejects(f.commands.cmdRun(f.ctx, [
    '--peer', 'failed-pty', '--kind', 'shell', '--', process.execPath, '-e', 'process.exit(0)'
  ]), { code: 'EAGAIN' });
  const result = f.read((db) => ({
    peer: db.prepare('SELECT * FROM peers WHERE id = ?').get('failed-pty'),
    events: db.prepare('SELECT type FROM events ORDER BY id').all().map((row) => row.type)
  }));
  assert.equal(result.peer.status, 'exited');
  assert.deepEqual(result.events, ['run.session.started', 'run.session.exited']);
  assert.deepEqual(fs.readdirSync(path.join(f.ctx.root, '.hello-cc', 'bufs')), []);
});

test('web-managed run preserves a live ordinary owner even without PTY buffers', async (t) => {
  const f = fixture(t, { loadPty: async () => ({ spawn() {
    throw new Error('PTY must not start for an owned peer');
  } }) });
  f.write((db) => {
    f.peers.upsertPeer(db, { id: 'shared', kind: 'shell', pid: process.pid,
      status: 'running', role: 'original' });
    f.bindings.upsertPeerBinding(db, { peer: 'shared', provider: 'shell', transport: 'hcc-run' });
  });
  const before = f.read((db) => ({
    peer: db.prepare('SELECT * FROM peers WHERE id = ?').get('shared'),
    binding: db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get('shared')
  }));
  process.env.HCC_INTERNAL_WEB_MANAGED_RUN = '1';
  await assert.rejects(f.commands.cmdRun(f.ctx, [
    '--peer', 'shared', '--kind', 'shell', '--', process.execPath, '-e', 'process.exit(0)'
  ]), { code: 'PEER_SESSION_EXISTS' });
  assert.deepEqual(f.read((db) => ({
    peer: db.prepare('SELECT * FROM peers WHERE id = ?').get('shared'),
    binding: db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get('shared')
  })), before);
  assert.equal(f.read((db) => db.prepare('SELECT COUNT(*) AS n FROM events').get().n), 0);
  assert.deepEqual(fs.readdirSync(path.join(f.ctx.root, '.hello-cc', 'bufs')), []);
});

test('a partial buffer publication failure leaves no stale files or peer', async (t) => {
  const f = fixture(t, { loadPty: async () => ({ spawn() {
    throw Object.assign(new Error('simulated PTY refusal'), { code: 'EAGAIN' });
  } }) });
  process.env.HCC_INTERNAL_WEB_MANAGED_RUN = '1';
  const originalOpen = fs.openSync;
  let failOnce = true;
  const mock = t.mock.method(fs, 'openSync', (file, ...args) => {
    if (failOnce && String(file).endsWith('partial.resize')) {
      failOnce = false;
      throw Object.assign(new Error('simulated buffer failure'), { code: 'ENOSPC' });
    }
    return originalOpen(file, ...args);
  });
  await assert.rejects(f.commands.cmdRun(f.ctx, [
    '--peer', 'partial', '--kind', 'shell', '--', process.execPath, '-e', 'process.exit(0)'
  ]), { code: 'ENOSPC' });
  mock.mock.restore();
  assert.deepEqual(fs.readdirSync(path.join(f.ctx.root, '.hello-cc', 'bufs')), []);
  assert.equal(f.read((db) => db.prepare('SELECT COUNT(*) AS n FROM peers').get().n), 0);
  await assert.rejects(f.commands.cmdRun(f.ctx, [
    '--peer', 'partial', '--kind', 'shell', '--', process.execPath, '-e', 'process.exit(0)'
  ]), { code: 'EAGAIN' });
});

test('PTY spawn rejection closes its peer even if its metadata was removed', async (t) => {
  let f;
  f = fixture(t, { loadPty: async () => ({ spawn() {
    fs.unlinkSync(path.join(f.ctx.root, '.hello-cc', 'bufs', 'missing-meta.meta'));
    throw Object.assign(new Error('simulated PTY refusal'), { code: 'EAGAIN' });
  } }) });
  process.env.HCC_INTERNAL_WEB_MANAGED_RUN = '1';
  await assert.rejects(f.commands.cmdRun(f.ctx, [
    '--peer', 'missing-meta', '--kind', 'shell', '--', process.execPath, '-e', 'process.exit(0)'
  ]), { code: 'EAGAIN' });
  const peer = f.read((db) => db.prepare('SELECT * FROM peers WHERE id = ?').get('missing-meta'));
  assert.equal(peer.status, 'exited');
  assert.deepEqual(fs.readdirSync(path.join(f.ctx.root, '.hello-cc', 'bufs')), []);
});

test('managed Codex run refuses ID-less and unverified history before peer registration', async t => {
  const f = fixture(t);
  for (const [argv, code] of [
    [['codex', 'resume', '--last'], 'CODEX_HISTORY_ID_REQUIRED'],
    [['codex', 'fork'], 'CODEX_HISTORY_ID_REQUIRED'],
    [['codex', 'resume', 'legacy-thread'], 'CODEX_HISTORY_UNVERIFIED']
  ]) {
    await assert.rejects(f.commands.cmdRun(f.ctx, [
      '--peer', 'codex-run', '--kind', 'codex', '--', ...argv
    ]), { code });
  }
  assert.equal(f.read(db => db.prepare('SELECT COUNT(*) AS n FROM peers').get().n), 0);
  assert.equal(f.read(db => db.prepare('SELECT COUNT(*) AS n FROM events').get().n), 0);
});

test('ordinary run protects an unresolved live PID even with detached status', async (t) => {
  const f = fixture(t);
  f.write((db) => f.peers.upsertPeer(db, {
    id: 'unresolved', kind: 'shell', pid: process.pid, processIdentity: null, status: 'detached'
  }));
  const before = f.read((db) => db.prepare('SELECT * FROM peers WHERE id = ?').get('unresolved'));
  await assert.rejects(f.commands.cmdRun(f.ctx, [
    '--peer', 'unresolved', '--kind', 'shell', '--', process.execPath, '-e', 'process.exit(0)'
  ]), (error) => error.code === 'PEER_SESSION_EXISTS' && error.extra.evidence_state === 'unknown');
  assert.deepEqual(f.read((db) => db.prepare('SELECT * FROM peers WHERE id = ?').get('unresolved')), before);
});

test('ordinary run rolls peer registration back when provider binding rejects the launch', async (t) => {
  const f = fixture(t);
  f.write((db) => {
    f.peers.upsertPeer(db, { id: 'owner', kind: 'claude', pid: process.pid, status: 'running' });
    f.peers.upsertPeer(db, { id: 'requester', kind: 'claude', status: 'exited', role: 'original' });
    f.bindings.upsertPeerBinding(db, {
      peer: 'owner', provider: 'claude', provider_session_name: 'session-owner', transport: 'tmux', runtime_target: '%1'
    });
    f.bindings.upsertPeerBinding(db, {
      peer: 'requester', provider: 'claude', provider_session_name: 'session-requester', transport: 'tmux', runtime_target: '%2'
    });
  });
  const before = f.read((db) => ({
    peer: db.prepare('SELECT * FROM peers WHERE id = ?').get('requester'),
    bindings: db.prepare('SELECT * FROM peer_bindings ORDER BY peer').all()
  }));
  await assert.rejects(f.commands.cmdRun(f.ctx, [
    '--peer', 'requester', '--kind', 'claude', '--', 'claude', '--resume', 'session-owner'
  ]), { code: 'PROVIDER_SESSION_IN_USE' });
  assert.deepEqual(f.read((db) => ({
    peer: db.prepare('SELECT * FROM peers WHERE id = ?').get('requester'),
    bindings: db.prepare('SELECT * FROM peer_bindings ORDER BY peer').all()
  })), before);
  assert.equal(f.read((db) => db.prepare('SELECT COUNT(*) AS n FROM events').get().n), 0);
});

test('ordinary run preserves a replacement owner and emits no stale exit event', async (t) => {
  const f = fixture(t);
  const pending = f.commands.cmdRun(f.ctx, [
    '--peer', 'reuse', '--kind', 'shell', '--', process.execPath, '-e', 'setTimeout(() => {}, 150)'
  ]);
  f.write((db) => f.peers.upsertPeer(db, {
    id: 'reuse', kind: 'shell', pid: process.ppid, status: 'running', role: 'replacement'
  }));
  const replacement = f.read((db) => db.prepare('SELECT * FROM peers WHERE id = ?').get('reuse'));
  await pending;
  assert.deepEqual(f.read((db) => db.prepare('SELECT * FROM peers WHERE id = ?').get('reuse')), replacement);
  assert.equal(f.read((db) => db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='run.session.exited'").get().n), 0);
});

test('ordinary run rolls registration and binding back if the startup event cannot be recorded', async (t) => {
  const f = fixture(t);
  f.write((db) => {
    f.peers.upsertPeer(db, { id: 'failed-event', kind: 'shell', status: 'exited', role: 'original' });
    f.bindings.upsertPeerBinding(db, { peer: 'failed-event', provider: 'shell', transport: 'manual-shell' });
    db.exec(`CREATE TRIGGER reject_launch BEFORE INSERT ON events
      WHEN NEW.type='run.session.started' BEGIN SELECT RAISE(ABORT, 'launch audit unavailable'); END`);
  });
  const before = f.read((db) => ({
    peer: db.prepare('SELECT * FROM peers WHERE id = ?').get('failed-event'),
    binding: db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get('failed-event')
  }));
  await assert.rejects(f.commands.cmdRun(f.ctx, [
    '--peer', 'failed-event', '--kind', 'shell', '--', process.execPath, '-e', 'process.exit(0)'
  ]), /launch audit unavailable/);
  assert.deepEqual(f.read((db) => ({
    peer: db.prepare('SELECT * FROM peers WHERE id = ?').get('failed-event'),
    binding: db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get('failed-event')
  })), before);
});

test('ordinary run records its own normal child exit and permits reuse of a dead owner', async (t) => {
  const f = fixture(t);
  f.write((db) => f.peers.upsertPeer(db, { id: 'finished', kind: 'shell', status: 'exited' }));
  await f.commands.cmdRun(f.ctx, [
    '--peer', 'finished', '--kind', 'shell', '--', process.execPath, '-e', 'process.exit(0)'
  ]);
  const result = f.read((db) => ({
    peer: db.prepare('SELECT * FROM peers WHERE id = ?').get('finished'),
    events: db.prepare('SELECT type FROM events ORDER BY id').all().map((row) => row.type)
  }));
  assert.equal(result.peer.status, 'exited');
  assert.deepEqual(result.events, ['run.session.started', 'run.session.exited']);
});
