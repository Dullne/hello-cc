import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { initSchema } from '../lib/db/schema.mjs';
import { createHttpRoutes } from '../lib/web/http-routes.mjs';
import { CliError } from '../lib/shared/errors.mjs';

async function fixture(t, { attachError } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-dsh-web-'));
  const dbPath = path.join(root, 'mesh.db');
  const ctx = { root, dbPath };
  const db = new DatabaseSync(dbPath);
  initSchema(db);
  for (const [id, kind, transport, session] of [
    ['dsh-a', 'dsh', 'hook', 'session.opaque/A'],
    ['dsh-b', 'dsh', 'hook', 'session.opaque/B'],
    ['dsh-c', 'dsh', 'cordis', 'session.opaque/C'],
    ['claude-a', 'claude', 'hook', 'claude-session'],
    ['managed', 'codex', 'tmux', 'codex-session']
  ]) {
    db.prepare("INSERT INTO peers(id, kind, role, status, worktree, pid, created_at, last_seen_at) VALUES (?, ?, 'peer', 'running', ?, 4321, 1000, 1000)").run(id, kind, root);
    db.prepare("INSERT INTO peer_bindings(peer, provider, provider_session_id, transport, runtime_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1000, 1000)").run(id, kind, session, transport, id);
  }
  db.close();
  let killCount = 0;
  let attachCount = 0;
  const { handleWebRequest } = createHttpRoutes({
    ctx, token: '', cookieSessionOk: () => false, webAuthMode: () => 'loopback',
    projectFromRequest: () => ctx,
    connectWebProject: () => new DatabaseSync(dbPath),
    sessionsForProject: () => [{ id: 'managed' }],
    resolveSessionPeerId: (_db, session) => session.id,
    now: () => 1000, ACTIVE_PEER_TTL: 600, DETECTED_PEER_MAX_AGE: 3600,
    auditPayload: (value) => value,
    addEvent: (db, type, actor, task, payload) => db.prepare('INSERT INTO events(type, actor, task_id, payload, created_at) VALUES (?, ?, ?, ?, 1000)').run(type, actor, task, JSON.stringify(payload)),
    sendMessage: (db, sender, recipient, task, kind, body) => Number(db.prepare('INSERT INTO messages(sender, recipient, task_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?, 1000)').run(sender, recipient, task, kind, body).lastInsertRowid),
    killDbProvenTmuxSession: () => { killCount++; return null; },
    attachTmuxSession: () => { attachCount++; throw attachError || new Error('Unexpected terminal attachment'); },
    webErrorStatus: () => 500
  });
  const server = http.createServer(handleWebRequest);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const request = async (route, body) => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-HCC-API-Version': '2', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() };
  };
  const read = (fn) => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { return fn(db); } finally { db.close(); }
  };
  return { request, read, kills: () => killCount, attaches: () => attachCount };
}

test('detected API preserves distinct dsh provider sessions and accepts addressed collaboration messages', async (t) => {
  const f = await fixture(t);
  const result = await f.request('/api/detected');
  assert.equal(result.status, 200);
  assert.equal(result.body.detected.length, 4, 'managed terminal is excluded');
  const dsh = result.body.detected.filter((peer) => peer.kind === 'dsh');
  assert.deepEqual(dsh.map((peer) => [peer.id, peer.provider_session_id, peer.transport]), [
    ['dsh-a', 'session.opaque/A', 'hook'], ['dsh-b', 'session.opaque/B', 'hook'], ['dsh-c', 'session.opaque/C', 'cordis']
  ]);
  assert.ok(dsh.every((peer) => peer.pid === 4321));
  assert.ok(dsh.every((peer) => !Object.hasOwn(peer, 'pid_command_hash')));
  const sent = await f.request('/api/detected/dsh-a/msg', { body: 'Only session A should receive this' });
  assert.equal(sent.status, 200);
  const messages = f.read((db) => db.prepare('SELECT sender, recipient, body FROM messages').all());
  assert.deepEqual(messages.map((row) => ({ ...row })), [{ sender: 'web', recipient: 'dsh-a', body: 'Only session A should receive this' }]);
});

test('dsh detected stop/restart rejects without peer changes or service kills while Claude controls still work', async (t) => {
  const f = await fixture(t);
  const state = () => f.read((db) => JSON.stringify({
    peers: db.prepare('SELECT * FROM peers ORDER BY id').all(),
    bindings: db.prepare('SELECT * FROM peer_bindings ORDER BY peer').all(),
    events: db.prepare('SELECT * FROM events ORDER BY id').all()
  }));
  const before = state();
  for (const peer of ['dsh-a', 'dsh-b', 'dsh-c']) {
    for (const action of ['stop', 'restart']) {
      const result = await f.request('/api/detected/' + peer + '/' + action, { kill_tmux: true });
      assert.equal(result.status, 409);
      assert.equal(result.body.error.code, 'DSH_SESSION_CONTROL_UNSUPPORTED');
      assert.match(result.body.error.message, /dsh Web UI/);
    }
  }
  assert.equal(f.kills(), 0);
  assert.equal(state(), before);
  const restart = await f.request('/api/detected/claude-a/restart', {});
  assert.equal(restart.status, 200);
  const stop = await f.request('/api/detected/claude-a/stop', {});
  assert.equal(stop.status, 200);
  assert.equal(f.read((db) => db.prepare('SELECT status FROM peers WHERE id = ?').get('claude-a').status), 'exited');
});

test('manual Web attach cannot convert dsh hook identities or a dsh service into a terminal agent', async (t) => {
  const f = await fixture(t);
  const state = () => f.read((db) => JSON.stringify({
    peers: db.prepare('SELECT * FROM peers ORDER BY id').all(),
    bindings: db.prepare('SELECT * FROM peer_bindings ORDER BY peer').all(),
    events: db.prepare('SELECT * FROM events ORDER BY id').all()
  }));
  const before = state();
  for (const input of [
    { id: 'dsh-a', pane: '%service', kind: 'shell' },
    { id: 'dsh-c', pane: '%service', kind: 'shell', force: true },
    { id: 'new-service', pane: '%service', kind: 'dsh' },
    { id: 'new-service', pane: '%service', binding: { provider: 'dsh' } }
  ]) {
    const result = await f.request('/api/sessions/attach', input);
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, 'DSH_SESSION_CONTROL_UNSUPPORTED');
  }
  assert.equal(f.attaches(), 0);
  assert.equal(f.kills(), 0);
  assert.equal(state(), before);
});

test('core dsh rejection remains an HTTP 409 when a pane infers its provider after API preflight', async (t) => {
  const f = await fixture(t, { attachError: new CliError('DSH_SESSION_CONTROL_UNSUPPORTED', 'Use hcc dsh web to control this agent') });
  const before = f.read((db) => JSON.stringify(db.prepare('SELECT * FROM peer_bindings ORDER BY peer').all()));
  const result = await f.request('/api/sessions/attach', { id: 'unregistered-agent', pane: '%dsh-service' });
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'DSH_SESSION_CONTROL_UNSUPPORTED');
  assert.match(result.body.error.message, /hcc dsh web/);
  assert.equal(f.attaches(), 1);
  assert.equal(f.kills(), 0);
  assert.equal(f.read((db) => JSON.stringify(db.prepare('SELECT * FROM peer_bindings ORDER BY peer').all())), before);
});
