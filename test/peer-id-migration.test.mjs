import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  legacyProviderSessionPeerId,
  migrateLegacyProviderPeerIds,
  providerSessionPeerId
} from '../lib/core/peers/session.mjs';

function createMesh() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE peers (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, role TEXT, worktree TEXT, branch TEXT,
      pid INTEGER, status TEXT NOT NULL DEFAULT 'idle', capabilities TEXT,
      created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE peer_bindings (
      peer TEXT PRIMARY KEY, provider TEXT NOT NULL,
      provider_session_id TEXT, provider_session_name TEXT,
      resume_mode TEXT NOT NULL DEFAULT 'new', resume_arg TEXT, command TEXT,
      transport TEXT NOT NULL, runtime_session_id TEXT, runtime_target TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      FOREIGN KEY (peer) REFERENCES peers(id) ON DELETE CASCADE
    );
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT, status TEXT, owner TEXT, assignee TEXT, created_by TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, sender TEXT, recipient TEXT, body TEXT);
    CREATE TABLE message_reads (message_id INTEGER, peer TEXT);
    CREATE TABLE locks (resource TEXT PRIMARY KEY, owner TEXT, reason TEXT);
    CREATE TABLE handoffs (id INTEGER PRIMARY KEY, from_peer TEXT, to_peer TEXT, summary TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, actor TEXT, payload TEXT, created_at INTEGER);
  `);
  return db;
}

function insertLegacyPeer(db, { kind, sessionValue, extra = {} }) {
  const legacyId = legacyProviderSessionPeerId(kind, sessionValue);
  const t = 1_700_000_000;
  db.prepare(`
    INSERT INTO peers(id, kind, role, worktree, branch, pid, status, capabilities, created_at, last_seen_at)
    VALUES (?, ?, 'peer', '/work', '', NULL, 'running', 'tmux', ?, ?)
  `).run(legacyId, kind, t, t);
  const uuidLike = /^[0-9a-f-]{20,}$/i.test(sessionValue);
  db.prepare(`
    INSERT INTO peer_bindings(peer, provider, provider_session_id, provider_session_name,
      resume_mode, transport, runtime_session_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'resume', 'tmux', ?, ?, ?)
  `).run(
    legacyId, kind,
    uuidLike ? sessionValue : null,
    uuidLike ? null : sessionValue,
    legacyId, t, t
  );
  const expected = providerSessionPeerId(kind, sessionValue);
  db.prepare("INSERT INTO tasks(title, status, owner, assignee, created_by) VALUES ('t', 'running', ?, ?, ?)").run(legacyId, legacyId, legacyId);
  db.prepare("INSERT INTO messages(sender, recipient, body) VALUES (?, ?, 'm')").run(legacyId, legacyId);
  db.prepare('INSERT INTO message_reads(message_id, peer) VALUES (1, ?)').run(legacyId);
  db.prepare("INSERT INTO locks(resource, owner, reason) VALUES ('r', ?, 'x')").run(legacyId);
  db.prepare("INSERT INTO handoffs(from_peer, to_peer, summary) VALUES (?, ?, 'h')").run(legacyId, legacyId);
  return { legacyId, expected, sessionValue, kind, ...extra };
}

test('migrates a legacy name-based peer id and all its references', () => {
  const db = createMesh();
  const { legacyId, expected, sessionValue, kind } = insertLegacyPeer(db, { kind: 'codex', sessionValue: 'feature-login' });
  assert.notEqual(legacyId, expected);

  const events = [];
  const result = migrateLegacyProviderPeerIds(db, {
    addEvent: (database, type, actor, taskId, payload) => {
      assert.equal(database, db);
      events.push({ type, actor, payload });
    }
  });

  assert.equal(result.migrated, 1);
  assert.equal(db.prepare('SELECT id FROM peers').get().id, expected);
  assert.equal(db.prepare('SELECT peer FROM peer_bindings').get().peer, expected);
  assert.equal(db.prepare('SELECT runtime_session_id FROM peer_bindings').get().runtime_session_id, expected);
  assert.equal(db.prepare('SELECT owner FROM tasks').get().owner, expected);
  assert.equal(db.prepare('SELECT assignee FROM tasks').get().assignee, expected);
  assert.equal(db.prepare('SELECT created_by FROM tasks').get().created_by, expected);
  assert.equal(db.prepare('SELECT sender FROM messages').get().sender, expected);
  assert.equal(db.prepare('SELECT recipient FROM messages').get().recipient, expected);
  assert.equal(db.prepare('SELECT peer FROM message_reads').get().peer, expected);
  assert.equal(db.prepare('SELECT owner FROM locks').get().owner, expected);
  assert.equal(db.prepare('SELECT from_peer FROM handoffs').get().from_peer, expected);
  assert.equal(db.prepare('SELECT to_peer FROM handoffs').get().to_peer, expected);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'peer.id.migrated');
  assert.equal(events[0].payload.old_peer, legacyId);
  assert.equal(events[0].payload.new_peer, expected);
  assert.equal(events[0].payload.provider_session, sessionValue);
});

test('migration is idempotent and skips non-derived custom ids', () => {
  const db = createMesh();
  const legacy = insertLegacyPeer(db, { kind: 'claude', sessionValue: '11111111-2222-3333-4444-555555555555' });
  // A custom (hand-assigned) peer id that happens to match neither derivation.
  const t = 1_700_000_000;
  db.prepare(`
    INSERT INTO peers(id, kind, role, worktree, branch, pid, status, capabilities, created_at, last_seen_at)
    VALUES ('my-custom-peer', 'shell', 'peer', '/work', '', NULL, 'running', '', ?, ?)
  `).run(t, t);
  db.prepare(`
    INSERT INTO peer_bindings(peer, provider, provider_session_name, transport, runtime_session_id, created_at, updated_at)
    VALUES ('my-custom-peer', 'shell', 'whatever-session', 'detected', 'my-custom-peer', ?, ?)
  `).run(t, t);

  assert.equal(migrateLegacyProviderPeerIds(db).migrated, 1);
  assert.equal(migrateLegacyProviderPeerIds(db).migrated, 0); // idempotent
  assert.equal(db.prepare("SELECT id FROM peers WHERE id = 'my-custom-peer'").get().id, 'my-custom-peer');
  assert.equal(db.prepare('SELECT peer FROM peer_bindings').get().peer, legacy.expected);
});

test('keeps an already-registered hashed id and drops the legacy row', () => {
  const db = createMesh();
  const { legacyId, expected } = insertLegacyPeer(db, { kind: 'codex', sessionValue: 'feature-login' });
  // The hashed id was registered independently (e.g. a shim under the new
  // scheme) — the migration must keep it, not collide with it.
  const t = 1_700_000_000;
  db.prepare(`
    INSERT INTO peers(id, kind, role, worktree, branch, pid, status, capabilities, created_at, last_seen_at)
    VALUES (?, 'codex', 'peer', '/work', '', NULL, 'running', '', ?, ?)
  `).run(expected, t, t);

  migrateLegacyProviderPeerIds(db);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM peers").get().n, 1);
  assert.equal(db.prepare('SELECT id FROM peers').get().id, expected);
  assert.equal(db.prepare('SELECT peer FROM peer_bindings').get().peer, expected);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM peers WHERE id = ?").get(legacyId).n, 0);
});

test('uuid-based legacy ids migrate too', () => {
  const db = createMesh();
  const uuid = '9f2a1b3c-4d5e-6f70-8a9b-0c1d2e3f4a5b';
  const { legacyId, expected } = insertLegacyPeer(db, { kind: 'claude', sessionValue: uuid });
  assert.equal(legacyId, `claude-${uuid.slice(0, 8)}`);
  migrateLegacyProviderPeerIds(db);
  assert.equal(db.prepare('SELECT id FROM peers').get().id, expected);
  assert.equal(db.prepare('SELECT provider_session_id FROM peer_bindings').get().provider_session_id, uuid);
});
