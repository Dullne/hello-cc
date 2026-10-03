import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createAutoAttach } from '../lib/web/auto-attach.mjs';
import { reconcileRunningPeerBindings } from '../lib/core/peers/reconcile.mjs';

const root = '/hcc-dsh-runtime-boundary';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL,
      actor TEXT, task_id INTEGER, payload TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE peers (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, role TEXT, worktree TEXT,
      pid INTEGER, status TEXT NOT NULL, last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE peer_bindings (
      peer TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_session_id TEXT,
      provider_session_name TEXT, resume_mode TEXT NOT NULL, resume_arg TEXT,
      command TEXT, transport TEXT NOT NULL, runtime_session_id TEXT,
      runtime_target TEXT, updated_at INTEGER NOT NULL
    );
  `);
  function add(id, kind, pid, transport, sessionId, target = null) {
    db.prepare('INSERT INTO peers VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, kind, 'peer', root, pid, 'working', 1000);
    db.prepare('INSERT INTO peer_bindings VALUES (?, ?, ?, NULL, ?, NULL, NULL, ?, ?, ?, ?)')
      .run(id, kind, sessionId, 'detected', transport, id, target, 1000);
  }
  return { db, add };
}

function bindings(db) {
  return db.prepare('SELECT * FROM peer_bindings ORDER BY peer').all().map((row) => ({ ...row }));
}

test('two dsh hook sessions sharing a live service PID and tmux pane keep logical bindings', (t) => {
  const { db, add } = fixture(t);
  add('dsh-first', 'dsh', 77, 'hook', 's.first/non-uuid');
  add('dsh-second', 'dsh', 77, 'hook', 's.second/non-uuid');
  add('codex-normal', 'codex', 88, 'detected', 'codex-session');
  add('claude-normal', 'claude', 99, 'hook', 'claude-session');
  const before = bindings(db).filter((row) => row.provider === 'dsh');
  const attaches = [];
  const sessions = new Map();
  const { autoAttachPoller, scanAndAttachDetectedPeers } = createAutoAttach({
    ctx: { root }, sessions,
    connectWebProject: () => ({ prepare: db.prepare.bind(db), close() {} }),
    now: () => 1000, ACTIVE_PEER_TTL: 60, addEvent() {},
    reconcileRunningPeerBindings,
    redactedLogText: (text) => text,
    sessionsForProject: () => [...sessions.values()],
    resolveSessionPeerId: (_db, session) => session.id,
    latestHookProviderSession: () => null,
    reAdoptOrphanManagedTmuxSessions: () => new Set(),
    reapDeadPeersForProject() {},
    runTmux: () => `%service|77|node|${root}\n%codex|88|codex|${root}\n%claude|99|claude|${root}`,
    attachTmuxSession(input) {
      attaches.push(input);
      db.prepare('UPDATE peer_bindings SET transport = ?, runtime_target = ? WHERE peer = ?')
        .run('tmux', input.pane, input.id);
      const session = { id: input.id, peerId: input.id, pane: input.pane, type: 'tmux', status: 'running' };
      sessions.set(input.id, session);
      return session;
    }
  });
  clearInterval(autoAttachPoller);
  scanAndAttachDetectedPeers();
  assert.deepEqual(attaches.map((input) => input.id).sort(), ['claude-normal', 'codex-normal']);
  assert.deepEqual(bindings(db).filter((row) => row.provider === 'dsh'), before);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM peers WHERE kind = ?').get('dsh').count, 2);
  assert.ok(attaches.every((input) => input.pane !== '%service'));
});

test('tmux identity reconciliation excludes dsh hook sessions while preserving normal backfill', (t) => {
  const { db, add } = fixture(t);
  add('dsh-first', 'dsh', 77, 'hook', 's.first/non-uuid');
  add('dsh-second', 'dsh', 77, 'hook', 's.second/non-uuid');
  add('codex-tmux', 'codex', 88, 'tmux', null, '%codex');
  const before = bindings(db).filter((row) => row.provider === 'dsh');
  const observed = [];
  const result = reconcileRunningPeerBindings(db, { root }, {
    now: () => 1100,
    panes: [
      { pane: '%service', pid: 77, cwd: root },
      { pane: '%codex', pid: 88, cwd: root }
    ],
    latestProviderSessionForPeer(peer) {
      observed.push(peer);
      return '00000000-0000-0000-0000-000000000001';
    }
  });
  assert.equal(result.checked, 1);
  assert.equal(result.backfilled, 1);
  assert.deepEqual(observed, ['codex-tmux']);
  assert.deepEqual(bindings(db).filter((row) => row.provider === 'dsh'), before);
  assert.equal(db.prepare('SELECT provider_session_id FROM peer_bindings WHERE peer = ?')
    .get('codex-tmux').provider_session_id, '00000000-0000-0000-0000-000000000001');
});
