import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { initSchema } from '../lib/db/schema.mjs';
import { createHttpRoutes } from '../lib/web/http-routes.mjs';
import { createControlLease } from '../lib/web/control-lease.mjs';
import { CliError } from '../lib/shared/errors.mjs';
import { pruneOldEventsPreservingTmuxAuthority } from '../lib/core/coordination/event-retention.mjs';
import { createHistoryGcSnapshot, captureHistoryGcPlan, dropHistoryGcSnapshot } from '../lib/core/coordination/gc-plan.mjs';
import { adoptionPaused, writeAdoptionState } from '../lib/web/adoption-state.mjs';

async function fixture(t, authMode = 'loopback') {
  const db = new DatabaseSync(':memory:'); initSchema(db);
  const ctx = { root: '/web-control-test', dbPath: '/web-control-test/.hello-cc/mesh.db' };
  const session = { id: 'codex-a', peerId: 'codex-a', pane: '%1', pid: 123, type: 'tmux', status: 'running', ctx };
  const lease = createControlLease();
  const controller = lease.connect(session, 'controller');
  lease.connect(session, 'observer');
  const writes = [], changes = [];
  const assertWrite = (s, input) => {
    try { lease.assertControl(s, input.action_token, input.epoch); }
    catch (error) { throw new CliError(error.code, error.message); }
  };
  const { handleWebRequest } = createHttpRoutes({ ctx, token: '', webAuthMode: () => authMode,
    cookieSessionOk: () => authMode === 'cookie', projectFromRequest: () => ctx,
    connectWebProject: () => ({ prepare: db.prepare.bind(db), close() {} }),
    sessionsForProject: () => [session], getSession: (_ctx, id) => id === session.id ? session : null,
    serializeSession: s => ({ id: s.id }), resolveSessionPeerId: (_db, s) => s.peerId,
    assertWebWrite: assertWrite, now: () => 1000, auditPayload: value => value, addEvent() {},
    writeSessionInput: (_s, data) => writes.push(data), detachTmuxSession: () => changes.push('detach'),
    attachTmuxSession: () => { changes.push('attach'); return session; },
    startSession: () => { changes.push('start'); return session; },
    codexAction: async (_s, action) => { changes.push(action); return { ok: true }; },
    shutdown: () => changes.push('runtime stop'),
    webErrorStatus: err => err.code === 'BAD_REQUEST' ? 400 : err.code === 'RUNTIME_ADMIN_REQUIRED' ? 403 : 409
  });
  const server = http.createServer(handleWebRequest);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { lease.forget(session); await new Promise(resolve => server.close(resolve)); db.close(); });
  const post = async (route, body) => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + route, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-HCC-API-Version': '2',
        Origin: 'http://127.0.0.1:' + server.address().port }, body: JSON.stringify(body)
    }); return { status: response.status, body: await response.json() };
  };
  return { db, session, lease, controller, writes, changes, post };
}

test('observer cannot inject, resize via attach, stop, or recreate an existing session through HTTP', async t => {
  const f = await fixture(t);
  for (const [route, body] of [
    ['/api/sessions/codex-a/input', { text: 'echo bypass' }],
    ['/api/sessions/codex-a/stop', {}],
    ['/api/sessions/attach', { id: 'codex-a', pane: '%1', force: true }],
    ['/api/sessions', { id: 'codex-a', kind: 'codex' }]
  ]) {
    const rejected = await f.post(route, { ...body, action_token: 'observer', epoch: f.controller.epoch });
    assert.equal(rejected.status, 409); assert.equal(rejected.body.error.code, 'CONTROL_REQUIRED');
  }
  assert.deepEqual(f.writes, []); assert.deepEqual(f.changes, []);
  const accepted = await f.post('/api/sessions/codex-a/input', { text: 'echo accepted', action_token: 'controller', epoch: f.controller.epoch });
  assert.equal(accepted.status, 200); assert.deepEqual(f.writes, ['echo accepted\r']);
  f.lease.claim(f.session, 'observer', { epoch: f.controller.epoch, takeover: true });
  const stale = await f.post('/api/sessions/codex-a/input', { text: 'stale', action_token: 'controller', epoch: f.controller.epoch });
  assert.equal(stale.body.error.code, 'STALE_CONTROL_EPOCH'); assert.equal(f.writes.length, 1);
});

test('detected stop/restart cannot bypass the managed session endpoint', async t => {
  const f = await fixture(t);
  for (const action of ['stop', 'restart']) {
    const result = await f.post('/api/detected/codex-a/' + action, { kill_tmux: true });
    assert.equal(result.status, 409); assert.equal(result.body.error.code, 'CONTROL_REQUIRED');
  }
  assert.deepEqual(f.changes, []);
});

test('a cookie-authenticated observer cannot bypass session control by stopping the whole runtime', async t => {
  const f = await fixture(t, 'cookie');
  const result = await f.post('/api/runtime/stop', {});
  assert.equal(result.status, 403); assert.equal(result.body.error.code, 'RUNTIME_ADMIN_REQUIRED');
  assert.deepEqual(f.changes, []);
});

test('structured turns, steer, interruption and approval require the same current controller', async t => {
  const f = await fixture(t); f.session.type = 'app-server';
  for (const action of ['turn', 'steer', 'interrupt', 'approve']) {
    const result = await f.post('/api/sessions/codex-a/codex/' + action, { action_token: 'observer', epoch: f.controller.epoch });
    assert.equal(result.status, 409); assert.equal(result.body.error.code, 'CONTROL_REQUIRED');
  }
  assert.deepEqual(f.changes, []);
  const owner = await f.post('/api/sessions/codex-a/codex/approve', { action_token: 'controller', epoch: f.controller.epoch });
  assert.equal(owner.status, 200); assert.deepEqual(f.changes, ['approve']);
});

test('direct and planned history GC preserve the latest pause and submission deduplication receipt', () => {
  const db = new DatabaseSync(':memory:'); initSchema(db);
  try {
    const session = { id: 'peer', peerId: 'peer', pane: '%1', pid: 123 };
    writeAdoptionState(db, session, true, 1);
    writeAdoptionState(db, session, false, 2);
    writeAdoptionState(db, session, true, 3);
    db.prepare("INSERT INTO events(type,actor,payload,created_at) VALUES ('codex.submission.pending','peer',?,1)")
      .run(JSON.stringify({ submission_id: 'never-replay' }));
    db.prepare("INSERT INTO events(type,actor,payload,created_at) VALUES ('ordinary','peer','{}',1)").run();
    const snapshot = createHistoryGcSnapshot(db, 100);
    try {
      const plan = captureHistoryGcPlan(db, 100, { snapshot });
      assert.ok(plan.events.every(e => e.type !== 'codex.submission.pending'));
      assert.ok(plan.events.every(e => e.id !== 3));
    } finally { dropHistoryGcSnapshot(db, snapshot); }
    assert.equal(pruneOldEventsPreservingTmuxAuthority(db, 100), 3);
    assert.equal(adoptionPaused(db, { peer: 'peer', pane: '%1', pid: 123 }), true);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'codex.submission.pending'").get().n, 1);
  } finally { db.close(); }
});
