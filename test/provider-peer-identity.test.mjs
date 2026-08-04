import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { providerSessionPeerId } from '../lib/core/peers/session.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hccBin = path.join(repoRoot, 'bin', 'hcc.mjs');

function v1PeerId(kind, providerId) {
  const digest = createHash('sha1').update(providerId).digest('hex');
  return `${kind}-${digest.slice(0, 8)}`;
}

function runHcc(root, home, args) {
  return execFileSync(process.execPath, [hccBin, '--root', root, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      HCC_RUNTIME_URL: ''
    }
  });
}

function createV6IdentityGraph(dbPath, root, legacyId, providerSession) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  const t = 1_700_000_000;
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta(key, value) VALUES ('schema_version', '6');
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL
    );
    CREATE TABLE peers (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, role TEXT, worktree TEXT, branch TEXT,
      pid INTEGER, status TEXT NOT NULL DEFAULT 'idle', capabilities TEXT,
      created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE peer_bindings (
      peer TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_session_id TEXT,
      provider_session_name TEXT, resume_mode TEXT NOT NULL DEFAULT 'new',
      resume_arg TEXT, command TEXT, transport TEXT NOT NULL,
      runtime_session_id TEXT, runtime_target TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT,
      status TEXT NOT NULL DEFAULT 'pending', assignee TEXT, owner TEXT,
      parent_id INTEGER, team_role TEXT, priority INTEGER NOT NULL DEFAULT 100,
      created_by TEXT, claimed_at INTEGER, completed_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, recipient TEXT,
      task_id INTEGER, kind TEXT NOT NULL DEFAULT 'note', body TEXT NOT NULL,
      reply_to INTEGER, thread_id INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE message_reads (
      message_id INTEGER NOT NULL, peer TEXT NOT NULL, read_at INTEGER NOT NULL,
      PRIMARY KEY (message_id, peer)
    );
    CREATE TABLE locks (
      resource TEXT PRIMARY KEY, base_resource TEXT, scope TEXT NOT NULL DEFAULT '*',
      owner TEXT NOT NULL, task_id INTEGER, reason TEXT, expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL, ttl_sec INTEGER NOT NULL DEFAULT 900
    );
    CREATE TABLE handoffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, from_peer TEXT NOT NULL,
      to_peer TEXT, summary TEXT NOT NULL, changed_files TEXT, tests TEXT, risks TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, actor TEXT,
      task_id INTEGER, payload TEXT, created_at INTEGER NOT NULL
    );
    PRAGMA user_version = 6;
  `);
  const insertMigration = db.prepare(`
    INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)
  `);
  for (let version = 1; version <= 6; version += 1) {
    insertMigration.run(version, `v${version}`, t);
  }
  db.prepare(`
    INSERT INTO peers(
      id, kind, role, worktree, branch, pid, status, capabilities, created_at, last_seen_at
    ) VALUES (?, 'codex', 'peer', ?, '', NULL, 'idle', 'pre-v1', ?, ?)
  `).run(legacyId, root, t, t);
  db.prepare(`
    INSERT INTO peer_bindings(
      peer, provider, provider_session_id, provider_session_name, resume_mode,
      resume_arg, command, transport, runtime_session_id, runtime_target,
      created_at, updated_at
    ) VALUES (?, 'codex', NULL, ?, 'resume', ?, ?, 'detected', ?, NULL, ?, ?)
  `).run(legacyId, providerSession, providerSession, `codex resume ${providerSession}`, legacyId, t, t);
  db.prepare(`
    INSERT INTO tasks(title, status, assignee, owner, created_by, created_at, updated_at)
    VALUES ('pre-v1 task', 'running', ?, ?, ?, ?, ?)
  `).run(legacyId, legacyId, legacyId, t, t);
  db.prepare(`
    INSERT INTO messages(sender, recipient, kind, body, created_at)
    VALUES (?, ?, 'note', 'pre-v1 message', ?)
  `).run(legacyId, legacyId, t);
  db.prepare('INSERT INTO message_reads(message_id, peer, read_at) VALUES (1, ?, ?)').run(legacyId, t);
  db.prepare(`
    INSERT INTO locks(resource, base_resource, scope, owner, reason, expires_at, created_at, ttl_sec)
    VALUES ('pre-v1-lock', 'pre-v1-lock', '*', ?, 'pre-v1', ?, ?, 900)
  `).run(legacyId, t + 900, t);
  db.prepare(`
    INSERT INTO handoffs(from_peer, to_peer, summary, created_at)
    VALUES (?, ?, 'pre-v1 handoff', ?)
  `).run(legacyId, legacyId, t);
  db.prepare(`
    INSERT INTO events(type, actor, payload, created_at)
    VALUES ('pre-v1.event', ?, '{}', ?)
  `).run(legacyId, t);
  db.close();
}

function identityGraph(db, peerId) {
  const plain = (row) => row ? { ...row } : null;
  return {
    peer: plain(db.prepare('SELECT id, capabilities, created_at FROM peers WHERE id = ?').get(peerId)),
    binding: plain(db.prepare(`
      SELECT peer, provider_session_name, runtime_session_id
      FROM peer_bindings WHERE peer = ?
    `).get(peerId)),
    task: plain(db.prepare(`
      SELECT owner, assignee, created_by FROM tasks
      WHERE owner = ? OR assignee = ? OR created_by = ?
    `).get(peerId, peerId, peerId)),
    message: plain(db.prepare(`
      SELECT sender, recipient FROM messages WHERE sender = ? OR recipient = ?
    `).get(peerId, peerId)),
    read: plain(db.prepare('SELECT peer FROM message_reads WHERE peer = ?').get(peerId)),
    lock: plain(db.prepare('SELECT owner FROM locks WHERE owner = ?').get(peerId)),
    handoff: plain(db.prepare(`
      SELECT from_peer, to_peer FROM handoffs WHERE from_peer = ? OR to_peer = ?
    `).get(peerId, peerId))
  };
}

test('provider peer IDs hash the complete provider value under the v1 contract', () => {
  for (const [kind, providerId] of [
    ['claude', '123e4567-e89b-12d3-a456-426614174000'],
    ['codex', 'feature-login'],
    ['codex', 'feature-logout']
  ]) {
    assert.equal(providerSessionPeerId(kind, providerId), v1PeerId(kind, providerId));
  }
  assert.notEqual(
    providerSessionPeerId('codex', 'feature-login'),
    providerSessionPeerId('codex', 'feature-logout')
  );
});

test('v1 connect preserves the pre-v1 identity graph and registers a new peer independently', (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-v1-provider-break-'));
  const root = path.join(sandbox, 'project');
  const home = path.join(sandbox, 'home');
  const dbPath = path.join(root, '.hello-cc', 'mesh.db');
  const providerSession = 'feature-login';
  const legacyId = 'codex-feature';
  const newId = providerSessionPeerId('codex', providerSession);
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  createV6IdentityGraph(dbPath, root, legacyId, providerSession);

  runHcc(root, home, ['--json', 'status', '--peer', 'v1-connect-check']);

  let db = new DatabaseSync(dbPath);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7);
  assert.deepEqual(identityGraph(db, legacyId), {
    peer: { id: legacyId, capabilities: 'pre-v1', created_at: 1_700_000_000 },
    binding: { peer: legacyId, provider_session_name: providerSession, runtime_session_id: legacyId },
    task: { owner: legacyId, assignee: legacyId, created_by: legacyId },
    message: { sender: legacyId, recipient: legacyId },
    read: { peer: legacyId },
    lock: { owner: legacyId },
    handoff: { from_peer: legacyId, to_peer: legacyId }
  });
  assert.equal(identityGraph(db, newId).peer, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'peer.id.migrated'").get().n, 0);
  db.close();

  runHcc(root, home, ['register', '--peer', newId, '--kind', 'codex', '--role', 'peer']);
  db = new DatabaseSync(dbPath);
  assert.ok(identityGraph(db, newId).peer, 'new v1 peer was not created');
  assert.equal(identityGraph(db, newId).binding, null, 'new peer inherited the pre-v1 binding');
  assert.equal(identityGraph(db, newId).task, null, 'new peer inherited pre-v1 task ownership');
  assert.equal(identityGraph(db, newId).message, null, 'new peer inherited pre-v1 messages');
  assert.equal(identityGraph(db, newId).lock, null, 'new peer inherited pre-v1 locks');
  assert.ok(identityGraph(db, legacyId).peer, 'legacy peer was removed after v1 registration');
  db.close();

  const backups = fs.readdirSync(path.dirname(dbPath))
    .filter((name) => name.startsWith('mesh.db.pre-v6-to-v7.') && name.endsWith('.bak'));
  assert.equal(backups.length, 1);
  const backup = new DatabaseSync(path.join(path.dirname(dbPath), backups[0]), { readOnly: true });
  assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 6);
  assert.ok(identityGraph(backup, legacyId).peer, 'pre-v1 peer is not queryable from the backup');
  assert.equal(identityGraph(backup, newId).peer, null, 'backup unexpectedly contains the new v1 identity');
  backup.close();
});

test('provider session module and connect contain no pre-v1 provider ID migration path', () => {
  const sessionSource = fs.readFileSync(path.join(repoRoot, 'lib', 'core', 'peers', 'session.mjs'), 'utf8');
  const cliSource = fs.readFileSync(hccBin, 'utf8');
  assert.doesNotMatch(sessionSource, /legacyProviderSessionPeerId|migrateLegacyProviderPeerIds/);
  assert.doesNotMatch(cliSource, /legacyProviderSessionPeerId|migrateLegacyProviderPeerIds/);
});
