#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import WebSocket from 'ws';

const repoRoot = path.resolve(import.meta.dirname, '..');
const hccBin = path.join(repoRoot, 'bin', 'hcc.mjs');
const testId = `${process.pid}-${Date.now()}`;
const root = path.join(os.tmpdir(), `hcc-reg-root-${testId}`);
const home = path.join(os.tmpdir(), `hcc-reg-home-${testId}`);
const fakeBin = path.join(os.tmpdir(), `hcc-reg-bin-${testId}`);
const outDir = path.join(os.tmpdir(), `hcc-reg-out-${testId}`);
const tmuxSession = `hcc-reg-${process.pid}`;
const port = 22000 + (process.pid % 10000);

let tmuxStarted = false;
let runtimePid = null;
const managedTmuxSessions = new Set();

const env = {
  ...process.env,
  HOME: home,
  PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`
};
for (const key of Object.keys(env)) {
  if (key.startsWith('HCC_')) delete env[key];
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  throw new Error(message);
}

function commandText(command, args) {
  return [command, ...args].join(' ');
}

function sh(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || env,
    input: options.input,
    encoding: 'utf8',
    stdio: options.stdio || [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    fail(`${commandText(command, args)} failed${output ? `\n${output}` : ''}`);
  }
  return result.stdout || '';
}

function runMaybe(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || env,
    input: options.input,
    encoding: 'utf8',
    stdio: options.stdio || [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
  });
}

function hcc(args, options = {}) {
  return run(process.execPath, [hccBin, '--root', root, ...args], options);
}

function hccJson(args, options = {}) {
  const output = hcc(['--json', ...args], options);
  const parsed = JSON.parse(output);
  if (!parsed.ok) fail(`hcc json command failed: ${output}`);
  return parsed.data;
}

function hccMaybe(args, options = {}) {
  return runMaybe(process.execPath, [hccBin, '--root', root, ...args], options);
}

function hccFrom(args, cwd, options = {}) {
  return run(process.execPath, [hccBin, ...args], { ...options, cwd });
}

function hccFromMaybe(args, cwd, options = {}) {
  return runMaybe(process.execPath, [hccBin, ...args], { ...options, cwd });
}

function withMeshDb(fn) {
  const db = new DatabaseSync(path.join(root, '.hello-cc', 'mesh.db'));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function providerBindingRows(provider, sessionName) {
  return withMeshDb((db) => db.prepare(`
    SELECT
      peer, provider, provider_session_id, provider_session_name,
      resume_mode, resume_arg, command, transport, runtime_target
    FROM peer_bindings
    WHERE provider = ? AND provider_session_name = ?
    ORDER BY peer
  `).all(provider, sessionName));
}

function peerBindingIndexNames(dbPath = path.join(root, '.hello-cc', 'mesh.db')) {
  const db = new DatabaseSync(dbPath);
  try {
    return new Set(db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'peer_bindings'
    `).all().map((row) => row.name));
  } finally {
    db.close();
  }
}

function assertPeerBindingIndexes(dbPath) {
  const indexes = peerBindingIndexNames(dbPath);
  for (const name of [
    'idx_peer_bindings_provider_session_id_unique',
    'idx_peer_bindings_provider_session_name_unique',
    'idx_peer_bindings_runtime_target_unique'
  ]) {
    if (!indexes.has(name)) fail(`missing peer binding uniqueness index: ${name}`);
  }
}

function insertStaleProviderBinding(peer, provider, sessionName) {
  withMeshDb((db) => {
    const t = Math.floor(Date.now() / 1000) - 3600;
    db.prepare(`
      INSERT INTO peers(id, kind, role, worktree, branch, pid, status, capabilities, created_at, last_seen_at)
      VALUES (?, ?, 'peer', ?, '', NULL, 'idle', 'regression-stale', ?, ?)
      ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at
    `).run(peer, provider, root, t, t);
    db.prepare(`
      INSERT INTO peer_bindings(
        peer, provider, provider_session_id, provider_session_name, resume_mode,
        resume_arg, command, transport, runtime_session_id, runtime_target, created_at, updated_at
      )
      VALUES (?, ?, NULL, ?, 'detected', NULL, NULL, 'detected', ?, NULL, ?, ?)
      ON CONFLICT(peer) DO UPDATE SET
        provider = excluded.provider,
        provider_session_name = excluded.provider_session_name,
        transport = excluded.transport,
        runtime_target = excluded.runtime_target,
        updated_at = excluded.updated_at
    `).run(peer, provider, sessionName, peer, t, t);
  });
}

function insertRuntimeTargetBinding(peer, provider, sessionName, runtimeTarget) {
  withMeshDb((db) => {
    const t = Math.floor(Date.now() / 1000) - 3600;
    db.prepare(`
      INSERT INTO peers(id, kind, role, worktree, branch, pid, status, capabilities, created_at, last_seen_at)
      VALUES (?, ?, 'peer', ?, '', NULL, 'idle', 'regression-runtime', ?, ?)
      ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at
    `).run(peer, provider, root, t, t);
    db.prepare(`
      INSERT INTO peer_bindings(
        peer, provider, provider_session_id, provider_session_name, resume_mode,
        resume_arg, command, transport, runtime_session_id, runtime_target, created_at, updated_at
      )
      VALUES (?, ?, NULL, ?, 'resume', ?, ?, 'tmux', ?, ?, ?, ?)
    `).run(peer, provider, sessionName, sessionName, `${provider} resume ${sessionName}`, peer, runtimeTarget, t, t);
  });
}

function moveRuntimeBindingPeer(fromPeer, toPeer) {
  withMeshDb((db) => {
    const peer = db.prepare('SELECT * FROM peers WHERE id = ?').get(fromPeer);
    if (!peer) fail(`cannot move missing peer ${fromPeer}`);
    const binding = db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get(fromPeer);
    if (!binding) fail(`cannot move missing peer binding ${fromPeer}`);
    const t = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO peers(id, kind, role, worktree, branch, pid, status, capabilities, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        role = excluded.role,
        worktree = excluded.worktree,
        branch = excluded.branch,
        pid = excluded.pid,
        status = excluded.status,
        capabilities = excluded.capabilities,
        last_seen_at = excluded.last_seen_at
    `).run(
      toPeer,
      peer.kind,
      peer.role,
      peer.worktree,
      peer.branch,
      peer.pid,
      peer.status,
      peer.capabilities,
      t,
      t
    );
    db.prepare('DELETE FROM peer_bindings WHERE peer = ?').run(toPeer);
    db.prepare('UPDATE peer_bindings SET peer = ?, updated_at = ? WHERE peer = ?').run(toPeer, t, fromPeer);
  });
}

function assertSqliteUniqueFailure(label, fn) {
  try {
    fn();
  } catch (err) {
    if (String(err?.message || err).includes('UNIQUE constraint failed')) return;
    throw err;
  }
  fail(`${label} did not fail with a SQLite UNIQUE constraint`);
}

function cleanupBindingPeers(prefix) {
  withMeshDb((db) => {
    db.prepare('DELETE FROM peer_bindings WHERE peer LIKE ?').run(`${prefix}%`);
    db.prepare('DELETE FROM peers WHERE id LIKE ?').run(`${prefix}%`);
  });
}

function assertPeerBindingUniqueConstraints() {
  assertPeerBindingIndexes();
  const providerPrefix = 'unique-provider-';
  const runtimePrefix = 'unique-runtime-';
  cleanupBindingPeers(providerPrefix);
  cleanupBindingPeers(runtimePrefix);

  insertStaleProviderBinding(`${providerPrefix}a`, 'codex', 'unique-provider-session');
  assertSqliteUniqueFailure('duplicate provider session binding', () => {
    insertStaleProviderBinding(`${providerPrefix}b`, 'codex', 'unique-provider-session');
  });
  const providerRows = providerBindingRows('codex', 'unique-provider-session');
  if (providerRows.length !== 1 || providerRows[0].peer !== `${providerPrefix}a`) {
    fail(`provider session unique constraint left unexpected rows:\n${JSON.stringify(providerRows, null, 2)}`);
  }

  insertRuntimeTargetBinding(`${runtimePrefix}a`, 'claude', 'unique-runtime-session-a', '%unique-runtime-target');
  assertSqliteUniqueFailure('duplicate runtime target binding', () => {
    insertRuntimeTargetBinding(`${runtimePrefix}b`, 'codex', 'unique-runtime-session-b', '%unique-runtime-target');
  });
  const runtimeRows = withMeshDb((db) => db.prepare(`
    SELECT peer, provider, provider_session_name, transport, runtime_target
    FROM peer_bindings
    WHERE runtime_target = '%unique-runtime-target'
    ORDER BY peer
  `).all());
  if (runtimeRows.length !== 1 || runtimeRows[0].peer !== `${runtimePrefix}a`) {
    fail(`runtime target unique constraint left unexpected rows:\n${JSON.stringify(runtimeRows, null, 2)}`);
  }

  cleanupBindingPeers(providerPrefix);
  cleanupBindingPeers(runtimePrefix);
}

function createLegacyBindingDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    const oldTime = Math.floor(Date.now() / 1000) - 3600;
    const newTime = oldTime + 60;
    db.exec(`
      CREATE TABLE peer_bindings (
        peer TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_session_id TEXT,
        provider_session_name TEXT,
        resume_mode TEXT NOT NULL DEFAULT 'new',
        resume_arg TEXT,
        command TEXT,
        transport TEXT NOT NULL,
        runtime_session_id TEXT,
        runtime_target TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const insert = db.prepare(`
      INSERT INTO peer_bindings(
        peer, provider, provider_session_id, provider_session_name, resume_mode,
        resume_arg, command, transport, runtime_session_id, runtime_target, created_at, updated_at
      )
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      'legacy-provider-detected', 'claude', 'legacy-provider-session', 'detected',
      null, null, 'detected', 'legacy-provider-detected', null, oldTime, oldTime
    );
    insert.run(
      'legacy-provider-live', 'claude', 'legacy-provider-session', 'resume',
      'legacy-provider-session', 'claude --resume legacy-provider-session', 'tmux',
      'legacy-provider-live', '%legacy-provider-pane', oldTime, newTime
    );
    insert.run(
      'legacy-runtime-old', 'codex', 'legacy-runtime-old-session', 'resume',
      'legacy-runtime-old-session', 'codex resume legacy-runtime-old-session', 'tmux',
      'legacy-runtime-old', '%legacy-runtime-pane', oldTime, oldTime
    );
    insert.run(
      'legacy-runtime-new', 'shell', 'legacy-runtime-new-session', 'command',
      null, 'bash', 'tmux', 'legacy-runtime-new', '%legacy-runtime-pane', oldTime, newTime
    );
  } finally {
    db.close();
  }
}

function createLegacySchemaDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    const t = Math.floor(Date.now() / 1000) - 3600;
    db.exec(`
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO meta(key, value) VALUES ('schema_version', '1');

      CREATE TABLE peers (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        role TEXT,
        worktree TEXT,
        branch TEXT,
        pid INTEGER,
        status TEXT NOT NULL DEFAULT 'idle',
        capabilities TEXT,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );

      CREATE TABLE peer_bindings (
        peer TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_session_id TEXT,
        provider_session_name TEXT,
        resume_mode TEXT NOT NULL DEFAULT 'new',
        resume_arg TEXT,
        command TEXT,
        transport TEXT NOT NULL,
        runtime_session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        assignee TEXT,
        owner TEXT,
        priority INTEGER NOT NULL DEFAULT 100,
        created_by TEXT,
        claimed_at INTEGER,
        completed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT NOT NULL,
        recipient TEXT,
        task_id INTEGER,
        kind TEXT NOT NULL DEFAULT 'note',
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE message_reads (
        message_id INTEGER NOT NULL,
        peer TEXT NOT NULL,
        read_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, peer)
      );

      CREATE TABLE locks (
        resource TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        task_id INTEGER,
        reason TEXT,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE handoffs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        from_peer TEXT NOT NULL,
        to_peer TEXT,
        summary TEXT NOT NULL,
        changed_files TEXT,
        tests TEXT,
        risks TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        actor TEXT,
        task_id INTEGER,
        payload TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX idx_tasks_status_priority ON tasks(status, priority, id);
      CREATE INDEX idx_tasks_owner ON tasks(owner);
      CREATE INDEX idx_messages_recipient_id ON messages(recipient, id);
      CREATE INDEX idx_events_id ON events(id);
      CREATE INDEX idx_locks_expires ON locks(expires_at);

      INSERT INTO peers(id, kind, role, worktree, branch, pid, status, capabilities, created_at, last_seen_at)
      VALUES ('legacy-peer', 'codex', 'peer', '${root.replace(/'/g, "''")}', '', NULL, 'idle', 'legacy', ${t}, ${t});
      INSERT INTO peer_bindings(peer, provider, provider_session_id, provider_session_name, resume_mode, resume_arg, command, transport, runtime_session_id, created_at, updated_at)
      VALUES ('legacy-peer', 'codex', NULL, 'legacy-session', 'detected', NULL, NULL, 'detected', 'legacy-peer', ${t}, ${t});
      INSERT INTO messages(sender, recipient, task_id, kind, body, created_at)
      VALUES ('legacy-peer', 'all', NULL, 'note', 'legacy-message', ${t});
    `);
  } finally {
    db.close();
  }
}

function assertLegacySchemaMigration() {
  const legacyRoot = path.join(os.tmpdir(), `hcc-reg-legacy-schema-root-${testId}`);
  const legacyDb = path.join(legacyRoot, '.hello-cc', 'mesh.db');
  try {
    createLegacySchemaDb(legacyDb);
    run(process.execPath, [hccBin, '--root', legacyRoot, 'status', '--peer', 'legacy-check'], { env });
    const db = new DatabaseSync(legacyDb);
    try {
      const peerBindingColumns = new Set(db.prepare('PRAGMA table_info(peer_bindings)').all().map((row) => row.name));
      if (!peerBindingColumns.has('runtime_target')) fail('legacy migration did not add peer_bindings.runtime_target');
      const messageColumns = new Set(db.prepare('PRAGMA table_info(messages)').all().map((row) => row.name));
      for (const column of ['reply_to', 'thread_id']) {
        if (!messageColumns.has(column)) fail(`legacy migration did not add messages.${column}`);
      }
      const taskColumns = new Set(db.prepare('PRAGMA table_info(tasks)').all().map((row) => row.name));
      for (const column of ['parent_id', 'team_role']) {
        if (!taskColumns.has(column)) fail(`legacy migration did not add tasks.${column}`);
      }
      const lockColumns = new Set(db.prepare('PRAGMA table_info(locks)').all().map((row) => row.name));
      for (const column of ['base_resource', 'scope']) {
        if (!lockColumns.has(column)) fail(`legacy migration did not add locks.${column}`);
      }
      const message = db.prepare('SELECT id, thread_id FROM messages WHERE body = ?').get('legacy-message');
      if (!message || message.thread_id !== message.id) {
        fail(`legacy message thread_id not backfilled:\n${JSON.stringify(message, null, 2)}`);
      }
      const metaVersion = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value;
      const pragmaVersion = db.prepare('PRAGMA user_version').get().user_version;
      if (metaVersion !== '5' || pragmaVersion !== 5) {
        fail(`schema version not synchronized: meta=${metaVersion} pragma=${pragmaVersion}`);
      }
      const migrations = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
      if (migrations.length !== 5 || migrations[4].version !== 5 || migrations[4].name !== 'scoped advisory locks') {
        fail(`schema migrations history wrong:\n${JSON.stringify(migrations, null, 2)}`);
      }
    } finally {
      db.close();
    }
  } finally {
    try { fs.rmSync(legacyRoot, { recursive: true, force: true }); } catch {}
  }
}

function assertRegisteredProjectDbMigration() {
  const otherRoot = path.join(os.tmpdir(), `hcc-reg-registered-legacy-root-${testId}`);
  const otherDb = path.join(otherRoot, '.hello-cc', 'mesh.db');
  const registryFile = path.join(home, '.hello-cc', 'projects.json');
  try {
    createLegacySchemaDb(otherDb);
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    fs.writeFileSync(registryFile, JSON.stringify({
      projects: [
        { root, db: path.join(root, '.hello-cc', 'mesh.db'), name: 'current', last_seen_at: 2 },
        { root: otherRoot, db: otherDb, name: 'registered-legacy', last_seen_at: 1 }
      ]
    }, null, 2));
    hcc(['status', '--peer', 'registered-migration-check']);
    const db = new DatabaseSync(otherDb);
    try {
      const taskColumns = new Set(db.prepare('PRAGMA table_info(tasks)').all().map((row) => row.name));
      if (!taskColumns.has('parent_id') || !taskColumns.has('team_role')) {
        fail(`registered project DB was not migrated:\n${JSON.stringify([...taskColumns], null, 2)}`);
      }
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (version !== 5) fail(`registered project DB user_version wrong: ${version}`);
    } finally {
      db.close();
    }
  } finally {
    try { fs.rmSync(otherRoot, { recursive: true, force: true }); } catch {}
  }
}

function assertFutureSchemaMigrationHistoryRejected() {
  const futureRoot = path.join(os.tmpdir(), `hcc-reg-future-schema-root-${testId}`);
  const futureDb = path.join(futureRoot, '.hello-cc', 'mesh.db');
  try {
    fs.mkdirSync(path.dirname(futureDb), { recursive: true });
    const db = new DatabaseSync(futureDb);
    try {
      db.exec(`
        CREATE TABLE meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO meta(key, value) VALUES ('schema_version', '5');
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        );
        INSERT INTO schema_migrations(version, name, applied_at)
        VALUES (999, 'future migration', 1);
      `);
    } finally {
      db.close();
    }
    const result = runMaybe(process.execPath, [hccBin, '--root', futureRoot, 'status', '--peer', 'future-schema-check'], { env });
    if (result.status === 0 || !`${result.stdout}\n${result.stderr}`.includes('Database schema version 999 is newer than this hcc (5)')) {
      fail(`future schema migration history was not rejected:\nstdout=${result.stdout}\nstderr=${result.stderr}`);
    }
  } finally {
    try { fs.rmSync(futureRoot, { recursive: true, force: true }); } catch {}
  }
}

function assertLegacyBindingRepair() {
  const legacyRoot = path.join(os.tmpdir(), `hcc-reg-legacy-root-${testId}`);
  const legacyDb = path.join(legacyRoot, '.hello-cc', 'mesh.db');
  try {
    createLegacyBindingDb(legacyDb);
    run(process.execPath, [hccBin, '--root', legacyRoot, 'status', '--peer', 'legacy-check'], { env });
    assertPeerBindingIndexes(legacyDb);
    const db = new DatabaseSync(legacyDb);
    try {
      const providerRows = db.prepare(`
        SELECT peer, transport, runtime_target
        FROM peer_bindings
        WHERE provider = 'claude' AND provider_session_name = 'legacy-provider-session'
        ORDER BY peer
      `).all();
      if (providerRows.length !== 1 || providerRows[0].peer !== 'legacy-provider-live') {
        fail(`legacy provider duplicate was not repaired:\n${JSON.stringify(providerRows, null, 2)}`);
      }
      const runtimeRows = db.prepare(`
        SELECT peer, transport, runtime_target
        FROM peer_bindings
        WHERE runtime_target = '%legacy-runtime-pane'
        ORDER BY peer
      `).all();
      if (runtimeRows.length !== 1 || runtimeRows[0].peer !== 'legacy-runtime-new') {
        fail(`legacy runtime duplicate was not repaired:\n${JSON.stringify(runtimeRows, null, 2)}`);
      }
    } finally {
      db.close();
    }
  } finally {
    try { fs.rmSync(legacyRoot, { recursive: true, force: true }); } catch {}
  }
}

function tmuxAvailable() {
  return runMaybe('tmux', ['-V']).status === 0;
}

function trackTmuxPane(pane) {
  if (!pane) return;
  const result = runMaybe('tmux', ['display-message', '-p', '-t', pane, '#S']);
  if (result.status === 0) managedTmuxSessions.add(result.stdout.trim());
}

function parsePane(output) {
  const match = String(output).match(/\bpane=(%\d+)/);
  if (!match) fail(`cannot parse tmux pane from:\n${output}`);
  trackTmuxPane(match[1]);
  return match[1];
}

function envWithoutPeer(extra = {}) {
  const next = { ...env, ...extra };
  delete next.HCC_PEER;
  delete next.HCC_ROOT;
  delete next.HCC_DB;
  return next;
}

function envWithoutProvider(extra = {}) {
  const next = envWithoutPeer();
  for (const key of Object.keys(next)) {
    if (key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_CODE_')) delete next[key];
  }
  return { ...next, ...extra };
}

function envAsCodex(extra = {}) {
  const next = envWithoutPeer({
    CODEX_MANAGED_BY_NPM: '1',
    CODEX_THREAD_ID: `codex-thread-${testId}`,
    ...extra
  });
  delete next.CLAUDE_CODE_SESSION_ID;
  delete next.CLAUDECODE;
  return next;
}

function parseSentPeer(output) {
  const match = String(output).match(/^sent message #\d+ (.+) -> /m);
  if (!match) fail(`cannot parse sender from: ${output}`);
  return match[1];
}

function hasTask(rows, taskId) {
  return rows.some((row) => String(row.id) === String(taskId));
}

function hasInstalledHook(config, event) {
  const entries = config?.hooks?.[event];
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) =>
    Array.isArray(entry?.hooks) &&
    entry.hooks.some((hook) => /\bhcc\.mjs\b.*\bhook\b/.test(String(hook?.command || '')))
  );
}

function hookContext(output, expectedEvent) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    fail(`hook output is not JSON:\n${output}`);
  }
  const specific = parsed?.hookSpecificOutput;
  if (specific?.hookEventName !== expectedEvent) {
    fail(`hookEventName mismatch for ${expectedEvent}:\n${output}`);
  }
  return String(specific.additionalContext || '');
}

function ensureFile(file, expected = null) {
  if (!fs.existsSync(file)) fail(`missing file: ${file}`);
  if (expected !== null) {
    const actual = fs.readFileSync(file, 'utf8').trim();
    if (actual !== expected) fail(`unexpected content in ${file}: ${actual}`);
  }
}

function assertGuidanceLockPolicy(file) {
  const text = fs.readFileSync(file, 'utf8');
  for (const expected of [
    'Read-only work:',
    'do not require locks',
    'For read-only review, do not acquire file locks',
    'not a final commit-ready verdict',
    'Review and monitoring:',
    "Reviewing another peer's work is a read-only activity",
    'proactively send that',
    'affected file or behavior',
    'Do not silently treat a snapshot review as final approval',
    'Before mutating work:',
    'Before editing or mutating shared resources:',
    'module scope',
    'Locks are coordination signals',
    '--scope db-schema',
    '--scope web-ui',
    'narrower scoped locks',
    'Commit-readiness checks are read-only until staging begins',
    'lock `.git/index` only while staging and'
  ]) {
    if (!text.includes(expected)) fail(`guidance lock policy missing ${expected} in ${file}`);
  }
}

function runtimeUrl(runtime, route, params = {}) {
  const url = new URL(route, runtime.base_url || `http://127.0.0.1:${port}`);
  if (runtime.token) url.searchParams.set('token', runtime.token);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function currentRuntime() {
  return JSON.parse(fs.readFileSync(path.join(root, '.hello-cc', 'runtime.json'), 'utf8'));
}

function currentRuntimeUrl(route, params = {}) {
  return runtimeUrl(currentRuntime(), route, params);
}

function runtimeFetch(route, options = {}, params = {}) {
  const runtime = currentRuntime();
  const headers = { ...(options.headers || {}) };
  if (runtime.token) headers.Authorization = `Bearer ${runtime.token}`;
  return fetch(runtimeUrl(runtime, route, params), { ...options, headers });
}

function runtimeWsUrl(peer) {
  const runtime = currentRuntime();
  const url = new URL(`/ws/terminal/${encodeURIComponent(peer)}`, runtime.base_url || `http://127.0.0.1:${port}`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (runtime.token) url.searchParams.set('token', runtime.token);
  return url.toString();
}

async function waitFor(check, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  fail(`timed out waiting for ${label}`);
}

async function waitForFile(file, expected, label = file) {
  await waitFor(() => fs.existsSync(file), label);
  ensureFile(file, expected);
}

async function waitForFileContent(file, expected, label = file) {
  await waitFor(() => {
    if (!fs.existsSync(file)) return false;
    return fs.readFileSync(file, 'utf8').trim() === expected;
  }, label);
  ensureFile(file, expected);
}

async function waitForFileLineCount(file, expected, label = file) {
  await waitFor(() => {
    if (!fs.existsSync(file)) return false;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.length === expected;
  }, label);
}

async function waitRuntime() {
  const runtimeFile = path.join(root, '.hello-cc', 'runtime.json');
  await waitFor(async () => {
    if (!fs.existsSync(runtimeFile)) return false;
    try {
      const response = await runtimeFetch('/api/runtime');
      return response.ok;
    } catch {
      return false;
    }
  }, 'runtime');
}

async function expectWebSocketMarker(peer, marker) {
  await new Promise((resolve, reject) => {
    let sawSnapshot = false;
    let sawMarker = false;
    const ws = new WebSocket(runtimeWsUrl(peer));
    const timer = setTimeout(() => reject(new Error(`${peer} websocket timeout`)), 5000);
    ws.on('open', () => {
      const result = hccMaybe(['inject', peer, `echo ${marker}`]);
      if (result.status !== 0) reject(new Error(result.stderr || result.stdout || 'inject failed'));
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'snapshot') sawSnapshot = true;
      if (['snapshot', 'data', 'replace'].includes(msg.type) && String(msg.data || '').includes(marker)) {
        sawMarker = true;
      }
      if (sawSnapshot && sawMarker) {
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    });
    ws.on('error', reject);
  });
}

async function expectResizeReplaceSnapshot(peer, marker) {
  await new Promise((resolve, reject) => {
    let sawSnapshot = false;
    const ws = new WebSocket(runtimeWsUrl(peer));
    const timer = setTimeout(() => reject(new Error(`${peer} resize replace timeout`)), 5000);
    ws.on('open', () => {
      const result = hccMaybe(['inject', peer, `echo ${marker}`]);
      if (result.status !== 0) reject(new Error(result.stderr || result.stdout || 'inject failed'));
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'snapshot') {
        sawSnapshot = true;
        ws.send(JSON.stringify({ type: 'resize', cols: 96, rows: 28 }));
      }
      if (sawSnapshot && msg.type === 'replace' && String(msg.data || '').includes(marker)) {
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    });
    ws.on('error', reject);
  });
}

async function expectWebSocketInputVisible(peer, marker) {
  await new Promise((resolve, reject) => {
    let sawSnapshot = false;
    let sent = false;
    let sawMarkerAfterInput = false;
    let sawFrameAfterInput = false;
    const ws = new WebSocket(runtimeWsUrl(peer));
    const timer = setTimeout(() => reject(new Error(`${peer} websocket input visibility timeout`)), 5000);
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      const data = String(msg.data || '');
      if (msg.type === 'snapshot') {
        sawSnapshot = true;
        if (!sent) {
          sent = true;
          ws.send(JSON.stringify({ type: 'input', data: `echo ${marker}\r` }));
        }
        return;
      }
      if (sent && ['data', 'replace'].includes(msg.type)) {
        sawFrameAfterInput = true;
        if (data.includes(marker)) sawMarkerAfterInput = true;
      }
      if (sawSnapshot && sawFrameAfterInput && sawMarkerAfterInput) {
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    });
    ws.on('error', reject);
  });
}

function tmuxStreamNodes() {
  const dir = path.join(root, '.hello-cc', 'bufs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.startsWith('tmux-') && name.endsWith('.pipe'))
    .map((name) => path.join(dir, name));
}

function libModuleFiles() {
  return fs.readdirSync(path.join(repoRoot, 'lib'))
    .filter((name) => name.endsWith('.mjs'))
    .sort()
    .map((name) => path.join('lib', name));
}

async function expectBoundedTmuxStream(label) {
  let nodes = [];
  await waitFor(() => {
    nodes = tmuxStreamNodes();
    return nodes.some((file) => {
      try { return fs.lstatSync(file).isFIFO(); } catch { return false; }
    });
  }, label);
  const bad = nodes.filter((file) => {
    try {
      const stat = fs.lstatSync(file);
      return !stat.isFIFO() || stat.size !== 0;
    } catch {
      return true;
    }
  });
  if (bad.length) fail(`tmux stream used growable regular files:\n${bad.join('\n')}`);
}

function writeFakeTools() {
  fs.mkdirSync(fakeBin, { recursive: true });
  for (const name of ['claude', 'codex']) {
    const file = path.join(fakeBin, name);
    fs.writeFileSync(file, `#!/usr/bin/env bash\necho fake-${name} "$@"\nif [ -n "\${HCC_FAKE_LOG:-}" ]; then echo fake-${name} "$@" >> "$HCC_FAKE_LOG"; fi\nif [ "\${HCC_FAKE_STAY_ALIVE:-}" = "1" ]; then exec bash --noprofile --norc; fi\n`, { mode: 0o755 });
  }
}

function startRuntime(options = {}) {
  const runtimeEnv = options.env || env;
  const upOutput = hcc(['up', '--no-discover', '--no-guidance'], { env: runtimeEnv });
  if (!upOutput.includes('local coordination ready')) fail(`hcc up did not report local coordination:\n${upOutput}`);
  if (fs.existsSync(path.join(root, '.hello-cc', 'runtime.json'))) fail('hcc up should not start web runtime');

  const output = hcc(['web', '--local', '--port', String(port), '--no-discover', '--no-guidance'], { env: runtimeEnv });
  const match = output.match(/^pid:\s*(\d+)/m);
  if (!match) fail(`hcc web did not print background pid:\n${output}`);
  runtimePid = Number.parseInt(match[1], 10);
  if (!output.includes('web started in background')) fail(`hcc web did not report background start:\n${output}`);
}

async function stopRuntime() {
  if (!runtimePid) return;
  hccMaybe(['down']);
  await waitFor(() => {
    try {
      process.kill(runtimePid, 0);
      return false;
    } catch {
      return true;
    }
  }, 'runtime process exit', 5000).catch(() => {
    try { process.kill(runtimePid, 'SIGTERM'); } catch {}
  });
  runtimePid = null;
}

function cleanup() {
  try { hccMaybe(['down']); } catch {}
  if (runtimePid) {
    try { process.kill(runtimePid, 'SIGTERM'); } catch {}
  }
  if (tmuxStarted) {
    runMaybe('tmux', ['kill-session', '-t', tmuxSession]);
  }
  for (const session of managedTmuxSessions) {
    runMaybe('tmux', ['kill-session', '-t', session]);
  }
  for (const dir of [root, home, fakeBin, outDir]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

async function setupRegression() {
  log('[1/12] web bootstrap/hooks/shims');
  writeFakeTools();
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(home, '.profile'), 'if [ "$BASH" ]; then . "$HOME/.bashrc"; fi\n');
  fs.writeFileSync(path.join(home, '.bashrc'), '# regression rc\n[ -z "$PS1" ] && return\nexport PATH="/late:$PATH"\n');
  const output = hcc(['web', '--local', '--port', String(port), '--no-discover', '--no-guidance']);
  const match = output.match(/^pid:\s*(\d+)/m);
  if (!match) fail(`hcc web did not print background pid during bootstrap:\n${output}`);
  runtimePid = Number.parseInt(match[1], 10);
  await waitRuntime();
  ensureFile(path.join(root, '.hello-cc', 'mesh.db'));
  if (fs.existsSync(path.join(root, '.hello-cc', 'HCC.md'))) fail('web --no-guidance should not write HCC.md');
  if (fs.existsSync(path.join(root, 'CLAUDE.md'))) fail('web --no-guidance should not write CLAUDE.md');
  if (fs.existsSync(path.join(root, 'AGENTS.md'))) fail('web --no-guidance should not write AGENTS.md');
  ensureFile(path.join(home, '.claude', 'settings.json'));
  ensureFile(path.join(home, '.codex', 'hooks.json'));
  const claudeHooks = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  const codexHooks = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8'));
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'PostToolUse', 'PreToolUse']) {
    if (!hasInstalledHook(claudeHooks, event)) fail(`Claude hook missing ${event}`);
  }
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'PreToolUse']) {
    if (!hasInstalledHook(codexHooks, event)) fail(`Codex hook missing ${event}`);
  }
  ensureFile(path.join(home, '.hcc-shims', 'claude'));
  ensureFile(path.join(home, '.hcc-shims', 'codex'));
  const bashrc = fs.readFileSync(path.join(home, '.bashrc'), 'utf8');
  const shimIndex = bashrc.indexOf('.hcc-shims');
  const guardIndex = bashrc.indexOf('[ -z "$PS1" ] && return');
  if (shimIndex < 0 || guardIndex < 0 || shimIndex > guardIndex) {
    fail(`shim PATH was not installed before bash early return:\n${bashrc}`);
  }
  const latePathIndex = bashrc.indexOf('export PATH="/late:$PATH"');
  const lastShimIndex = bashrc.lastIndexOf('.hcc-shims');
  if (latePathIndex < 0 || lastShimIndex < latePathIndex) {
    fail(`shim PATH was not reasserted after late PATH edits:\n${bashrc}`);
  }
  const nonInteractiveCodex = run('bash', ['-lc', 'command -v codex'], { env }).trim();
  if (nonInteractiveCodex !== path.join(home, '.hcc-shims', 'codex')) {
    fail(`non-interactive bash did not resolve codex shim: ${nonInteractiveCodex}`);
  }
  const interactiveCodex = run('bash', ['-ic', 'command -v codex'], { env }).trim();
  if (interactiveCodex !== path.join(home, '.hcc-shims', 'codex')) {
    fail(`interactive bash did not keep codex shim first: ${interactiveCodex}`);
  }
  if (!hcc(['install-hooks', '--status']).includes('claude=yes codex=yes')) fail('hooks not installed');
  if (!hcc(['shim', 'status']).includes('shims installed')) fail('shims not installed');
  const staleShim = path.join(home, '.hcc-shims', 'claude');
  fs.writeFileSync(staleShim, '#!/usr/bin/env bash\necho stale --web-managed\n', { mode: 0o755 });
  const ensured = hccMaybe(['shim', 'ensure', 'claude', staleShim]);
  if (ensured.status !== 75) {
    fail(`shim ensure did not request re-exec for stale shim:\n${ensured.stdout}\n${ensured.stderr}`);
  }
  const refreshedShim = fs.readFileSync(staleShim, 'utf8');
  if (!refreshedShim.includes('shim ensure "claude"') || refreshedShim.includes('stale --web-managed')) {
    fail(`shim ensure did not refresh stale shim:\n${refreshedShim}`);
  }
  await stopRuntime();
  assertPeerBindingUniqueConstraints();
  assertLegacySchemaMigration();
  assertRegisteredProjectDbMigration();
  assertFutureSchemaMigrationHistoryRejected();
  assertLegacyBindingRepair();

  const tokenOutput = hcc(['web', '--host', '0.0.0.0', '--port', String(port), '--no-discover', '--no-guidance']);
  const tokenMatch = tokenOutput.match(/^pid:\s*(\d+)/m);
  if (!tokenMatch) fail(`token web did not print background pid:\n${tokenOutput}`);
  runtimePid = Number.parseInt(tokenMatch[1], 10);
  if (!tokenOutput.includes('token=') || !tokenOutput.includes('open: http://<machine-ip>:')) {
    fail(`default web output did not include remote token URL:\n${tokenOutput}`);
  }
  await waitRuntime();
  const tokenRuntime = currentRuntime();
  if (tokenRuntime.host !== '0.0.0.0' || !tokenRuntime.token || tokenRuntime.token.length < 24) {
    fail(`default web runtime did not store remote token data:\n${JSON.stringify(tokenRuntime, null, 2)}`);
  }
  const unauthorizedResponse = await fetch(`${tokenRuntime.base_url}/api/runtime`);
  if (unauthorizedResponse.status !== 401) fail(`default web API allowed missing token: ${unauthorizedResponse.status}`);
  const tokenResponse = await runtimeFetch('/api/runtime');
  if (!tokenResponse.ok) fail(`default web API rejected runtime token: ${tokenResponse.status}`);
  const tokenFile = path.join(home, '.hello-cc', 'web-token');
  ensureFile(tokenFile, tokenRuntime.token);
  fs.rmSync(tokenFile, { force: true });
  const existingTokenOutput = hcc(['web', '--host', '0.0.0.0', '--port', String(port), '--no-discover', '--no-guidance']);
  if (!existingTokenOutput.includes('web already running in background')) {
    fail(`web did not reuse existing token runtime:\n${existingTokenOutput}`);
  }
  ensureFile(tokenFile, tokenRuntime.token);
  await stopRuntime();

  const stableTokenOutput = hcc(['web', '--host', '0.0.0.0', '--port', String(port), '--no-discover', '--no-guidance']);
  const stableTokenMatch = stableTokenOutput.match(/^pid:\s*(\d+)/m);
  if (!stableTokenMatch) fail(`stable-token web did not print background pid:\n${stableTokenOutput}`);
  runtimePid = Number.parseInt(stableTokenMatch[1], 10);
  await waitRuntime();
  const stableTokenRuntime = currentRuntime();
  if (stableTokenRuntime.token !== tokenRuntime.token) {
    fail(`default web token changed across restart:\nfirst=${tokenRuntime.token}\nsecond=${stableTokenRuntime.token}`);
  }
  await stopRuntime();

  const fixedToken = `fixed-token-${testId}`;
  const fixedTokenOutput = hcc(['web', '--host', '0.0.0.0', '--port', String(port), '--no-discover', '--no-guidance'], {
    env: { ...env, HCC_WEB_TOKEN: fixedToken }
  });
  const fixedTokenMatch = fixedTokenOutput.match(/^pid:\s*(\d+)/m);
  if (!fixedTokenMatch) fail(`fixed-token web did not print background pid:\n${fixedTokenOutput}`);
  runtimePid = Number.parseInt(fixedTokenMatch[1], 10);
  await waitRuntime();
  const fixedTokenRuntime = currentRuntime();
  if (fixedTokenRuntime.token !== fixedToken || !fixedTokenOutput.includes(`token=${encodeURIComponent(fixedToken)}`)) {
    fail(`explicit stable token was not used:\n${fixedTokenOutput}\n${JSON.stringify(fixedTokenRuntime, null, 2)}`);
  }
  await stopRuntime();

  const persistedFixedOutput = hcc(['web', '--host', '0.0.0.0', '--port', String(port), '--no-discover', '--no-guidance']);
  const persistedFixedMatch = persistedFixedOutput.match(/^pid:\s*(\d+)/m);
  if (!persistedFixedMatch) fail(`persisted fixed-token web did not print background pid:\n${persistedFixedOutput}`);
  runtimePid = Number.parseInt(persistedFixedMatch[1], 10);
  await waitRuntime();
  const persistedFixedRuntime = currentRuntime();
  if (persistedFixedRuntime.token !== fixedToken) {
    fail(`explicit stable token was not persisted:\n${JSON.stringify(persistedFixedRuntime, null, 2)}`);
  }
  await stopRuntime();

  const noTokenOutput = hcc(['web', '--host', '0.0.0.0', '--port', String(port), '--no-token', '--no-discover', '--no-guidance']);
  const noTokenMatch = noTokenOutput.match(/^pid:\s*(\d+)/m);
  if (!noTokenMatch) fail(`explicit no-token web did not print background pid:\n${noTokenOutput}`);
  runtimePid = Number.parseInt(noTokenMatch[1], 10);
  if (noTokenOutput.includes('token=')) {
    fail(`explicit no-token web output included token:\n${noTokenOutput}`);
  }
  await waitRuntime();
  const noTokenRuntime = currentRuntime();
  if (noTokenRuntime.token) fail(`explicit no-token runtime stored token:\n${JSON.stringify(noTokenRuntime, null, 2)}`);
  const noTokenResponse = await fetch(`${noTokenRuntime.base_url}/api/runtime`);
  if (!noTokenResponse.ok) fail(`explicit no-token web API required token: ${noTokenResponse.status}`);
  await stopRuntime();

  const conflictingToken = hccMaybe(['web', '--local', '--port', String(port), '--token', 'abc', '--no-token', '--no-discover', '--no-guidance']);
  if (conflictingToken.status === 0 || !String(conflictingToken.stderr || conflictingToken.stdout).includes('--no-token cannot be combined')) {
    fail(`web accepted conflicting --token and --no-token:\n${conflictingToken.stdout}\n${conflictingToken.stderr}`);
  }

  const childDir = path.join(root, 'packages', 'child');
  fs.mkdirSync(childDir, { recursive: true });
  const childFindRoot = hccFrom(['find-root'], childDir).trim();
  if (childFindRoot !== childDir) fail(`child find-root mismatch: ${childFindRoot} !== ${childDir}`);
  const childStatus = hccFrom(['status'], childDir);
  if (!childStatus.includes(`root: ${childDir}`) || !childStatus.includes(`db: ${path.join(childDir, '.hello-cc', 'mesh.db')}`)) {
    fail(`child command did not stay on current path:\n${childStatus}`);
  }
  ensureFile(path.join(childDir, '.hello-cc', 'mesh.db'));
  const explicitChildRoot = hccFrom(['--root', root, 'find-root'], childDir).trim();
  if (explicitChildRoot !== root) fail(`explicit child find-root mismatch: ${explicitChildRoot} !== ${root}`);
  const explicitChildStatus = hccFrom(['--root', root, 'status'], childDir);
  if (!explicitChildStatus.includes(`root: ${root}`) || !explicitChildStatus.includes(`db: ${path.join(root, '.hello-cc', 'mesh.db')}`)) {
    fail(`explicit child command did not use requested root:\n${explicitChildStatus}`);
  }
  const childHookPayload = JSON.stringify({ session_id: 'child-hook-session', cwd: childDir, hook_event_name: 'UserPromptSubmit', prompt: 'status?' });
  hccFrom(['hook', 'userpromptsubmit'], childDir, { input: childHookPayload, env: envWithoutPeer({ CODEX_THREAD_ID: 'child-hook-thread' }) });
  const registryFile = path.join(home, '.hello-cc', 'projects.json');
  ensureFile(registryFile);
  const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  if (!(registry.projects || []).some((p) => p.root === childDir)) {
    fail(`hook project was not auto-registered:\n${JSON.stringify(registry, null, 2)}`);
  }

  const joinOut = hcc(['join', '--peer', 'join-a', '--kind', 'codex']);
  if (!joinOut.includes('export HCC_PEER=join-a')) fail(`bad join output: ${joinOut}`);
  const envOut = hcc(['env', '--peer', 'env-a']);
  if (!envOut.includes('export HCC_PEER=env-a')) fail(`bad env output: ${envOut}`);
  run('bash', ['-lc', [
    `eval "$(${sh(process.execPath)} ${sh(hccBin)} --root ${sh(root)} join --peer eval-a --kind codex)"`,
    'test "$HCC_PEER" = eval-a',
    `${sh(process.execPath)} ${sh(hccBin)} --root ${sh(root)} msg send --from "$HCC_PEER" --to "$HCC_PEER" --body eval-ok >/dev/null`,
    `${sh(process.execPath)} ${sh(hccBin)} --root ${sh(root)} msg inbox --peer "$HCC_PEER" --all | grep -q eval-ok`
  ].join('; ')]);
}

async function dbWorkflow() {
  log('[3/12] db workflow');
  hcc(['register', '--peer', 'human', '--kind', 'human', '--role', 'operator']);
  const created = hcc(['task', 'create', '--from', 'human', '--to', 'codex-a', '--title', 'full regression task', '--body', 'exercise hcc bus']);
  const taskMatch = created.match(/created task #(\d+):/);
  if (!taskMatch) fail(`cannot parse task id: ${created}`);
  const taskId = taskMatch[1];
  hcc(['task', 'claim', '--peer', 'codex-a', '--id', taskId]);
  hcc(['task', 'update', '--peer', 'codex-a', '--id', taskId, '--status', 'running', '--summary', 'started']);
  const runningTasksForOtherPeer = hccJson(['task', 'list'], { env: { ...env, HCC_PEER: 'claude-a' } });
  if (!hasTask(runningTasksForOtherPeer, taskId)) {
    fail(`running task hidden from default list for another peer: #${taskId}`);
  }
  hcc(['lock', 'acquire', '--peer', 'codex-a', '--task', taskId, '--resource', 'src/router', '--ttl', '60', '--reason', 'regression']);
  hcc(['lock', 'renew', '--peer', 'codex-a', '--resource', 'src/router', '--ttl', '60']);
  hcc(['msg', 'send', '--from', 'codex-a', '--to', 'claude-a', '--task', taskId, '--body', 'please review']);
  const inbox = hcc(['msg', 'inbox', '--peer', 'claude-a', '--wait', '0']);
  if (!inbox.includes('please review')) fail('inbox did not include message');
  const msgMatch = inbox.match(/^#(\d+)/m);
  if (!msgMatch) fail(`cannot parse message id: ${inbox}`);
  const msgId = msgMatch[1];
  const reply = hcc(['msg', 'reply', '--from', 'claude-a', '--id', msgId, '--body', 'review reply']);
  const replyMatch = reply.match(/sent reply #(\d+) to #(\d+)/);
  if (!replyMatch || replyMatch[2] !== msgId) fail(`cannot parse reply output: ${reply}`);
  const thread = hcc(['msg', 'thread', '--id', msgId]);
  if (!thread.includes(`thread #${msgId}`) || !thread.includes('please review') || !thread.includes('review reply')) {
    fail(`thread output missing original or reply:\n${thread}`);
  }
  const replyInbox = hcc(['msg', 'inbox', '--peer', 'codex-a']);
  if (!replyInbox.includes('review reply') || !replyInbox.includes(`#${msgId}`)) {
    fail(`reply did not reach original sender inbox with thread context:\n${replyInbox}`);
  }
  const stateBeforeAck = hccJson(['state', '--peer', 'codex-a', '--resource', 'src/router']);
  if (stateBeforeAck.automation?.schema_version !== 1 || stateBeforeAck.automation.phase !== 'reply_message') {
    fail(`state automation did not prioritize unread reply:\n${JSON.stringify(stateBeforeAck, null, 2)}`);
  }
  if (stateBeforeAck.automation.next_action.kind !== 'msg.reply' || !stateBeforeAck.automation.next_action.argv.includes(replyMatch[1])) {
    fail(`state next action did not target unread reply:\n${JSON.stringify(stateBeforeAck.automation, null, 2)}`);
  }
  const timelineIds = new Set((stateBeforeAck.timeline || []).map((item) => item.id));
  if (!timelineIds.has(`message:${msgId}`) || !timelineIds.has(`message:${replyMatch[1]}`)) {
    fail(`state timeline missing message thread entries:\n${JSON.stringify(stateBeforeAck.timeline, null, 2)}`);
  }
  if ([...(stateBeforeAck.timeline || [])].some((item) => item.kind === 'message.sent' || item.kind === 'message.ack')) {
    fail(`state timeline includes noisy message events:\n${JSON.stringify(stateBeforeAck.timeline, null, 2)}`);
  }
  hcc(['msg', 'ack', '--peer', 'claude-a', '--id', msgId]);
  hcc(['msg', 'ack', '--peer', 'codex-a', '--id', replyMatch[1]]);
  const stateAfterAck = hccJson(['state', '--peer', 'codex-a', '--resource', 'src/new-lock']);
  if (stateAfterAck.automation.next_action.kind !== 'lock.acquire') {
    fail(`state automation did not suggest lock acquire after ack:\n${JSON.stringify(stateAfterAck.automation, null, 2)}`);
  }
  const readOnlyState = hccJson(['state', '--peer', 'codex-a', '--resource', 'src/read-only', '--intent', 'review']);
  if (readOnlyState.automation.next_action.kind === 'lock.acquire' || readOnlyState.automation.phase === 'acquire_lock') {
    fail(`read-only state suggested acquiring a lock:\n${JSON.stringify(readOnlyState.automation, null, 2)}`);
  }
  if (!(readOnlyState.automation.warnings || []).some((warning) => warning.includes('read-only'))) {
    fail(`read-only state did not explain no-lock behavior:\n${JSON.stringify(readOnlyState.automation, null, 2)}`);
  }
  const queuedTask = hcc(['task', 'create', '--from', 'human', '--to', 'codex-a', '--title', 'queued while busy']);
  const queuedTaskMatch = queuedTask.match(/created task #(\d+):/);
  if (!queuedTaskMatch) fail(`cannot parse queued task id: ${queuedTask}`);
  const queuedTaskId = queuedTaskMatch[1];
  const busyState = hccJson(['state', '--peer', 'codex-a']);
  if (String(busyState.automation.current_task?.id) !== String(taskId)) {
    fail(`state did not preserve current task while another task was assigned:\n${JSON.stringify(busyState.automation, null, 2)}`);
  }
  if (['task.claim', 'task.next', 'msg.inbox'].includes(busyState.automation.next_action.kind)) {
    fail(`state let a new assigned task interrupt current work:\n${JSON.stringify(busyState.automation, null, 2)}`);
  }
  const busyHookPayload = JSON.stringify({ session_id: 'codex-busy-session', cwd: root, hook_event_name: 'UserPromptSubmit', prompt: 'new user prompt while busy' });
  const busyHook = hookContext(hcc(['hook', 'userpromptsubmit'], { env: { ...env, HCC_PEER: 'codex-a' }, input: busyHookPayload }), 'UserPromptSubmit');
  if (!busyHook.includes('[hello-cc current task]') || !busyHook.includes(`#${taskId} running`)) {
    fail(`hook did not preserve current task while another task was assigned:\n${busyHook}`);
  }
  if (busyHook.includes(`hcc task claim --peer codex-a --id ${queuedTaskId}`)) {
    fail(`hook suggested claiming a new task while current task was active:\n${busyHook}`);
  }
  const nextAgain = hcc(['task', 'next', '--peer', 'codex-a']);
  if (!nextAgain.includes(`current task #${taskId}`)) {
    fail(`task next did not preserve current task:\n${nextAgain}`);
  }
  const nextAgainJson = hccJson(['task', 'next', '--peer', 'codex-a']);
  if (String(nextAgainJson.id) !== String(taskId) || nextAgainJson.current !== true || nextAgainJson.tasks) {
    fail(`task next --json current task shape changed:\n${JSON.stringify(nextAgainJson, null, 2)}`);
  }
  const batchClaimIds = [];
  for (const title of ['batch claim one', 'batch claim two']) {
    const out = hcc(['task', 'create', '--from', 'human', '--title', title]);
    const match = out.match(/created task #(\d+):/);
    if (!match) fail(`cannot parse batch task id: ${out}`);
    batchClaimIds.push(match[1]);
  }
  const batchClaim = hccJson(['task', 'claim', '--peer', 'batch-a', '--ids', batchClaimIds.join(',')]);
  if (!Array.isArray(batchClaim) || batchClaim.length !== 2 || !batchClaim.every((task) => task.owner === 'batch-a')) {
    fail(`batch claim did not claim both tasks:\n${JSON.stringify(batchClaim, null, 2)}`);
  }
  for (const task of batchClaim) {
    hcc(['task', 'done', '--peer', 'batch-a', '--id', String(task.id), '--summary', 'batch claim cleanup']);
  }
  const batchNextIds = [];
  for (const title of ['batch next one', 'batch next two', 'batch next three']) {
    const out = hcc(['task', 'create', '--from', 'human', '--title', title]);
    const match = out.match(/created task #(\d+):/);
    if (!match) fail(`cannot parse batch next task id: ${out}`);
    batchNextIds.push(match[1]);
  }
  const batchNext = hccJson(['task', 'next', '--peer', 'batch-b', '--force', '--count', '2']);
  if (!batchNext?.tasks || batchNext.tasks.length !== 2 || !batchNext.tasks.every((task) => task.owner === 'batch-b')) {
    fail(`task next --count did not claim two tasks:\n${JSON.stringify(batchNext, null, 2)}`);
  }
  for (const task of batchNext.tasks) {
    hcc(['task', 'done', '--peer', 'batch-b', '--id', String(task.id), '--summary', 'batch next cleanup']);
  }
  hcc(['task', 'update', '--peer', 'human', '--id', batchNextIds[2], '--status', 'abandoned', '--summary', 'batch next leftover cleanup']);
  const takeoverOpen = hcc(['task', 'create', '--from', 'human', '--to', 'takeover-owner', '--title', 'takeover open']);
  const takeoverOpenMatch = takeoverOpen.match(/created task #(\d+):/);
  if (!takeoverOpenMatch) fail(`cannot parse takeover open id: ${takeoverOpen}`);
  const takeoverOpenId = takeoverOpenMatch[1];
  hcc(['task', 'claim', '--peer', 'takeover-owner', '--id', takeoverOpenId]);
  const blockedPolicyReject = hccMaybe(['task', 'takeover', '--peer', 'takeover-a', '--id', takeoverOpenId, '--reason', 'blocked policy smoke', '--policy', 'blocked']);
  if (blockedPolicyReject.status === 0 || !String(blockedPolicyReject.stderr || blockedPolicyReject.stdout).includes('does not match takeover policy blocked')) {
    fail(`takeover --policy blocked accepted non-blocked task:\n${blockedPolicyReject.stdout}\n${blockedPolicyReject.stderr}`);
  }
  hcc(['task', 'update', '--peer', 'takeover-owner', '--id', takeoverOpenId, '--status', 'blocked', '--summary', 'blocked for takeover smoke']);
  const blockedTakeover = hccJson(['task', 'takeover', '--peer', 'takeover-a', '--id', takeoverOpenId, '--reason', 'blocked takeover smoke', '--policy', 'blocked']);
  if (String(blockedTakeover.owner) !== 'takeover-a') {
    fail(`blocked takeover did not transfer owner:\n${JSON.stringify(blockedTakeover, null, 2)}`);
  }
  hcc(['task', 'done', '--peer', 'takeover-a', '--id', takeoverOpenId, '--summary', 'blocked takeover cleanup']);
  const staleOut = hcc(['task', 'create', '--from', 'human', '--to', 'stale-owner', '--title', 'stale takeover']);
  const staleMatch = staleOut.match(/created task #(\d+):/);
  if (!staleMatch) fail(`cannot parse stale takeover id: ${staleOut}`);
  const staleTaskId = staleMatch[1];
  hcc(['task', 'claim', '--peer', 'stale-owner', '--id', staleTaskId]);
  withMeshDb((db) => {
    const staleAt = Math.floor(Date.now() / 1000) - 7200;
    db.prepare('UPDATE peers SET last_seen_at = ? WHERE id = ?').run(staleAt, 'stale-owner');
  });
  const staleTakeover = hccJson(['task', 'takeover', '--peer', 'takeover-b', '--id', staleTaskId, '--reason', 'stale takeover smoke', '--policy', 'stale', '--stale-after', '60']);
  if (String(staleTakeover.owner) !== 'takeover-b') {
    fail(`stale takeover did not transfer owner:\n${JSON.stringify(staleTakeover, null, 2)}`);
  }
  const takeoverInbox = hcc(['msg', 'inbox', '--peer', 'stale-owner', '--all']);
  if (!takeoverInbox.includes(`Task #${staleTaskId} taken over by takeover-b`)) {
    fail(`stale takeover did not notify previous owner:\n${takeoverInbox}`);
  }
  hcc(['task', 'done', '--peer', 'takeover-b', '--id', staleTaskId, '--summary', 'stale takeover cleanup']);
  const staleLivenessOut = hcc(['task', 'create', '--from', 'human', '--to', 'stale-liveness-owner', '--title', 'stale liveness task']);
  const staleLivenessMatch = staleLivenessOut.match(/created task #(\d+):/);
  if (!staleLivenessMatch) fail(`cannot parse stale liveness task id: ${staleLivenessOut}`);
  const staleLivenessTaskId = staleLivenessMatch[1];
  hcc(['task', 'claim', '--peer', 'stale-liveness-owner', '--id', staleLivenessTaskId]);
  withMeshDb((db) => {
    const staleAt = Math.floor(Date.now() / 1000) - 7200;
    db.prepare('UPDATE peers SET last_seen_at = ? WHERE id = ?').run(staleAt, 'stale-liveness-owner');
  });
  const staleLivenessList = hcc(['task', 'list', '--status', 'claimed']);
  if (!staleLivenessList.includes(`#${staleLivenessTaskId}`) || !staleLivenessList.includes('stale/no-lock')) {
    fail(`task list did not surface stale/no-lock owner state:\n${staleLivenessList}`);
  }
  const staleLivenessState = hccJson(['state', '--peer', 'takeover-ready-peer']);
  if (staleLivenessState.automation?.phase !== 'takeover_task' ||
      staleLivenessState.automation?.next_action?.kind !== 'task.takeover' ||
      !staleLivenessState.automation.next_action.argv.includes('--policy') ||
      !staleLivenessState.automation.next_action.argv.includes('stale')) {
    fail(`state automation did not suggest stale takeover:\n${JSON.stringify(staleLivenessState.automation, null, 2)}`);
  }
  hcc(['task', 'update', '--peer', 'human', '--force', '--id', staleLivenessTaskId, '--status', 'abandoned', '--summary', 'stale liveness cleanup']);
  hcc(['task', 'update', '--peer', 'human', '--id', queuedTaskId, '--status', 'abandoned', '--summary', 'queued task cleanup']);
  hcc(['handoff', 'create', '--from', 'codex-a', '--to', 'claude-a', '--task', taskId, '--summary', 'handoff summary', '--tests', 'full script', '--risks', 'none']);
  if (!hcc(['handoff', 'list', '--task', taskId]).includes('handoff summary')) fail('handoff missing');
  const stateAfterHandoff = hccJson(['state', '--peer', 'claude-a']);
  if (!(stateAfterHandoff.timeline || []).some((item) => item.id.startsWith('handoff:') && item.text.includes('handoff summary'))) {
    fail(`state timeline missing handoff item:\n${JSON.stringify(stateAfterHandoff.timeline, null, 2)}`);
  }
  if ((stateAfterHandoff.timeline || []).some((item) => item.kind === 'handoff.created')) {
    fail(`state timeline includes noisy handoff event:\n${JSON.stringify(stateAfterHandoff.timeline, null, 2)}`);
  }
  if (!hcc(['status', '--peer', 'codex-a']).includes('codex-a')) fail('status missing peer');
  hcc(['lock', 'release', '--peer', 'codex-a', '--resource', 'src/router']);
  hcc(['task', 'done', '--peer', 'codex-a', '--id', taskId, '--summary', 'done']);
  const doneDefaultTasks = hccJson(['task', 'list'], { env: { ...env, HCC_PEER: 'claude-a' } });
  if (hasTask(doneDefaultTasks, taskId)) fail(`done task still shown in default list: #${taskId}`);
  if (!hasTask(hccJson(['task', 'list', '--all']), taskId)) fail(`done task missing from --all list: #${taskId}`);
  if (!hasTask(hccJson(['task', 'list', '--status', 'done']), taskId)) fail(`done task missing from --status done list: #${taskId}`);

  const teamParent = hcc([
    'task', 'create',
    '--from', 'human',
    '--to', 'codex-team-captain',
    '--title', 'parallel release cleanup',
    '--body', '- Update docs\n- Add regression\n- Verify migration'
  ]);
  const teamParentMatch = teamParent.match(/created task #(\d+):/);
  if (!teamParentMatch) fail(`cannot parse team parent id: ${teamParent}`);
  const teamParentId = teamParentMatch[1];
  hcc(['task', 'claim', '--peer', 'codex-team-captain', '--id', teamParentId]);
  hcc(['task', 'update', '--peer', 'codex-team-captain', '--id', teamParentId, '--status', 'running', '--summary', 'team captain']);
  const teamState = hccJson(['state', '--peer', 'codex-team-captain']);
  if (teamState.automation.phase !== 'team_plan' || teamState.automation.next_action.kind !== 'team.plan') {
    fail(`state did not suggest team plan for splittable task:\n${JSON.stringify(teamState.automation, null, 2)}`);
  }
  const teamPlan = hcc(['team', 'plan', '--from-task', teamParentId, '--item', 'docs:Update docs', '--item', 'tests:Add regression', '--workers', 'codex-worker-a,claude-worker-a']);
  if (!teamPlan.includes('team plan for task') || !teamPlan.includes('Update docs')) {
    fail(`team plan output wrong:\n${teamPlan}`);
  }
  const kindWorkerPlan = hcc(['team', 'plan', '--from-task', teamParentId, '--item', 'docs:Docs slot', '--item', 'tests:Tests slot', '--workers', 'codex:2']);
  if (!kindWorkerPlan.includes(`codex-team-${teamParentId}-1`) || !kindWorkerPlan.includes(`codex-team-${teamParentId}-2`)) {
    fail(`team workers kind-count syntax was not expanded:\n${kindWorkerPlan}`);
  }
  const childrenBeforeStart = withMeshDb((db) => db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?').get(teamParentId).n);
  if (childrenBeforeStart !== 0) fail(`team plan created children: ${childrenBeforeStart}`);
  const teamStart = hccJson(['team', 'start', '--from', 'codex-team-captain', '--from-task', teamParentId, '--item', 'docs:Update docs', '--item', 'tests:Add regression', '--workers', 'codex-worker-a,claude-worker-a']);
  if (teamStart.children.length !== 2) {
    fail(`team start created wrong child count:\n${JSON.stringify(teamStart, null, 2)}`);
  }
  const teamRows = withMeshDb((db) => db.prepare(`
    SELECT id, title, assignee, parent_id, team_role
    FROM tasks
    WHERE parent_id = ?
    ORDER BY id
  `).all(teamParentId));
  if (teamRows.length !== 2 ||
      teamRows[0].assignee !== 'codex-worker-a' ||
      teamRows[1].assignee !== 'claude-worker-a' ||
      teamRows.some((row) => String(row.parent_id) !== String(teamParentId) || !row.team_role)) {
    fail(`team child rows wrong:\n${JSON.stringify(teamRows, null, 2)}`);
  }
  const duplicateTeamStart = hccMaybe(['team', 'start', '--from-task', teamParentId]);
  if (duplicateTeamStart.status === 0 || !String(duplicateTeamStart.stderr || duplicateTeamStart.stdout).includes('already has')) {
    fail(`duplicate team start was not rejected:\n${duplicateTeamStart.stdout}\n${duplicateTeamStart.stderr}`);
  }
  const teamStatus = hcc(['team', 'status', '--task', teamParentId]);
  if (!teamStatus.includes('subtasks: 2') || !teamStatus.includes('codex-worker-a')) {
    fail(`team status output wrong:\n${teamStatus}`);
  }
  for (const row of teamRows) {
    hcc(['task', 'update', '--peer', 'human', '--force', '--id', String(row.id), '--status', 'abandoned', '--summary', 'team regression cleanup']);
  }
  hcc(['task', 'done', '--peer', 'codex-team-captain', '--id', teamParentId, '--summary', 'team regression done']);

  const scopedA = hcc(['lock', 'acquire', '--peer', 'codex-a', '--resource', 'bin/hcc.mjs', '--scope', 'db-schema', '--ttl', '60', '--reason', 'db split']);
  const scopedB = hcc(['lock', 'acquire', '--peer', 'codex-b', '--resource', 'bin/hcc.mjs', '--scope', 'web-ui', '--ttl', '60', '--reason', 'ui split']);
  if (!scopedA.includes('bin/hcc.mjs [db-schema]') || !scopedB.includes('bin/hcc.mjs [web-ui]')) {
    fail(`scoped lock output missing labels:\n${scopedA}\n${scopedB}`);
  }
  const scopedRows = hccJson(['lock', 'list']);
  if (!scopedRows.some((row) => row.base_resource === 'bin/hcc.mjs' && row.scope === 'db-schema') ||
      !scopedRows.some((row) => row.base_resource === 'bin/hcc.mjs' && row.scope === 'web-ui')) {
    fail(`scoped locks missing from list:\n${JSON.stringify(scopedRows, null, 2)}`);
  }
  const duplicateScope = hccMaybe(['lock', 'acquire', '--peer', 'claude-a', '--resource', 'bin/hcc.mjs', '--scope', 'db-schema', '--ttl', '60', '--reason', 'same scope']);
  if (duplicateScope.status === 0 || !`${duplicateScope.stdout}\n${duplicateScope.stderr}`.includes('conflicts with lock bin/hcc.mjs [db-schema]')) {
    fail(`same-scope lock was not rejected:\n${duplicateScope.stdout}\n${duplicateScope.stderr}`);
  }
  const wholeResource = hccMaybe(['lock', 'acquire', '--peer', 'claude-a', '--resource', 'bin/hcc.mjs', '--ttl', '60', '--reason', 'whole file']);
  if (wholeResource.status === 0 || !`${wholeResource.stdout}\n${wholeResource.stderr}`.includes('conflicts with lock bin/hcc.mjs [db-schema]')) {
    fail(`whole-resource lock did not conflict with scoped locks:\n${wholeResource.stdout}\n${wholeResource.stderr}`);
  }
  hcc(['lock', 'release', '--peer', 'codex-a', '--resource', 'bin/hcc.mjs', '--scope', 'db-schema']);
  hcc(['lock', 'release', '--peer', 'codex-b', '--resource', 'bin/hcc.mjs', '--scope', 'web-ui']);

  const conflictTask = hcc(['task', 'create', '--from', 'human', '--to', 'codex-b', '--title', 'conflict automation task']);
  const conflictTaskMatch = conflictTask.match(/created task #(\d+):/);
  if (!conflictTaskMatch) fail(`cannot parse conflict task id: ${conflictTask}`);
  const conflictTaskId = conflictTaskMatch[1];
  hcc(['task', 'claim', '--peer', 'codex-b', '--id', conflictTaskId]);
  hcc(['lock', 'acquire', '--peer', 'codex-a', '--resource', 'src/conflict', '--ttl', '60', '--reason', 'held by other peer']);
  const conflictState = hccJson(['state', '--peer', 'codex-b', '--resource', 'src/conflict']);
  if (conflictState.automation.phase !== 'coordinate_lock' || conflictState.automation.next_action.kind !== 'msg.send') {
    fail(`state automation did not suggest lock coordination:\n${JSON.stringify(conflictState.automation, null, 2)}`);
  }
  if (conflictState.automation.next_action.argv.includes('--force')) {
    fail(`state automation suggested forcing a lock:\n${JSON.stringify(conflictState.automation, null, 2)}`);
  }
  hcc(['lock', 'release', '--peer', 'codex-a', '--resource', 'src/conflict']);
  hcc(['task', 'done', '--peer', 'codex-b', '--id', conflictTaskId, '--summary', 'conflict done']);

  const takeoverTask = hcc(['task', 'create', '--from', 'human', '--to', 'codex-owner', '--title', 'takeover regression task']);
  const takeoverTaskMatch = takeoverTask.match(/created task #(\d+):/);
  if (!takeoverTaskMatch) fail(`cannot parse takeover task id: ${takeoverTask}`);
  const takeoverTaskId = takeoverTaskMatch[1];
  hcc(['task', 'claim', '--peer', 'codex-owner', '--id', takeoverTaskId]);
  const takeoverOutput = hcc(['task', 'takeover', '--peer', 'codex-taker', '--id', takeoverTaskId, '--reason', 'owner inactive']);
  if (!takeoverOutput.includes(`took over task #${takeoverTaskId}`)) fail(`takeover output wrong:\n${takeoverOutput}`);
  const takeoverRow = hccJson(['task', 'list', '--all']).find((row) => String(row.id) === String(takeoverTaskId));
  if (!takeoverRow || takeoverRow.owner !== 'codex-taker' || takeoverRow.status !== 'claimed') {
    fail(`takeover task row wrong:\n${JSON.stringify(takeoverRow, null, 2)}`);
  }
  const takeoverOwnerInbox = hcc(['msg', 'inbox', '--peer', 'codex-owner']);
  if (!takeoverOwnerInbox.includes(`Task #${takeoverTaskId} taken over by codex-taker`)) {
    fail(`takeover did not notify previous owner:\n${takeoverOwnerInbox}`);
  }
  hcc(['task', 'done', '--peer', 'codex-taker', '--id', takeoverTaskId, '--summary', 'takeover done']);

  const abandoned = hcc(['task', 'create', '--from', 'human', '--title', 'abandoned regression task']);
  const abandonedMatch = abandoned.match(/created task #(\d+):/);
  if (!abandonedMatch) fail(`cannot parse abandoned task id: ${abandoned}`);
  const abandonedTaskId = abandonedMatch[1];
  hcc(['task', 'update', '--peer', 'human', '--id', abandonedTaskId, '--status', 'abandoned', '--summary', 'not needed']);
  if (hasTask(hccJson(['task', 'list']), abandonedTaskId)) {
    fail(`abandoned task still shown in default list: #${abandonedTaskId}`);
  }
  if (!hasTask(hccJson(['task', 'list', '--status', 'abandoned']), abandonedTaskId)) {
    fail(`abandoned task missing from --status abandoned list: #${abandonedTaskId}`);
  }

  const hookTask = hcc(['task', 'create', '--from', 'human', '--to', 'codex-hook', '--title', 'hook visible task']);
  const hookTaskMatch = hookTask.match(/created task #(\d+):/);
  if (!hookTaskMatch) fail(`cannot parse hook task id: ${hookTask}`);
  const hookTaskId = hookTaskMatch[1];
  hcc(['task', 'claim', '--peer', 'codex-hook', '--id', hookTaskId]);
  hcc(['task', 'update', '--peer', 'codex-hook', '--id', hookTaskId, '--status', 'running', '--summary', 'hook visible']);
  hcc(['msg', 'send', '--from', 'human', '--to', 'claude-hook', '--task', hookTaskId, '--body', 'hook-only-message']);
  const hookPayload = JSON.stringify({ session_id: 'claude-hook-session', cwd: root, hook_event_name: 'UserPromptSubmit', prompt: 'status?' });
  const hookEnv = { ...env, HCC_PEER: 'claude-hook' };
  const firstHook = hookContext(hcc(['hook', 'userpromptsubmit'], { env: hookEnv, input: hookPayload }), 'UserPromptSubmit');
  if (!firstHook.includes('[hello-cc coordination]') || !firstHook.includes('[hello-cc open tasks]') || !firstHook.includes(`#${hookTaskId} running`)) {
    fail(`UserPromptSubmit hook did not include open task snapshot:\n${firstHook}`);
  }
  if (!firstHook.includes('[hello-cc known peers]') || !firstHook.includes('do not say sessions are isolated')) {
    fail(`UserPromptSubmit hook missing strong cross-session instruction:\n${firstHook}`);
  }
  if (!firstHook.includes('hcc task list') || !firstHook.includes('hcc msg reply --id <message-id>') || !firstHook.includes('hook-only-message')) {
    fail(`UserPromptSubmit hook missing instructions or unread message:\n${firstHook}`);
  }
  if (!firstHook.includes('[hello-cc next action]') || !firstHook.includes('phase: reply_message') || !firstHook.includes('hcc msg reply')) {
    fail(`UserPromptSubmit hook missing executable next action:\n${firstHook}`);
  }
  const secondHook = hookContext(hcc(['hook', 'userpromptsubmit'], { env: hookEnv, input: hookPayload }), 'UserPromptSubmit');
  if (!secondHook.includes(`#${hookTaskId} running`)) {
    fail(`UserPromptSubmit hook stopped showing open task after first read:\n${secondHook}`);
  }
  if (secondHook.includes('hook-only-message')) {
    fail(`UserPromptSubmit hook repeated acked unread message:\n${secondHook}`);
  }
  if (!secondHook.includes('[hello-cc next action]')) {
    fail(`UserPromptSubmit hook dropped next action after ack:\n${secondHook}`);
  }
  const sessionHookPayload = JSON.stringify({ session_id: 'claude-hook-session', cwd: root, hook_event_name: 'SessionStart', source: 'resume' });
  const sessionHook = hookContext(hcc(['hook', 'sessionstart'], { env: hookEnv, input: sessionHookPayload }), 'SessionStart');
  if (!sessionHook.includes(`#${hookTaskId} running`) || sessionHook.includes('hook-only-message')) {
    fail(`SessionStart hook context wrong:\n${sessionHook}`);
  }
  hcc(['task', 'done', '--peer', 'codex-hook', '--id', hookTaskId, '--summary', 'hook regression done']);
  hcc(['event', 'tail', '--limit', '5']);

  const autoEnv = envWithoutPeer();
  const autoSent = hcc(['msg', 'send', '--to', 'all', '--body', 'auto-join-ok'], { env: autoEnv });
  const autoPeer = parseSentPeer(autoSent);
  const autoPeers = hcc(['peers']);
  if (!autoPeers.includes(autoPeer)) fail(`auto peer missing from peers: ${autoPeer}\n${autoPeers}`);
  const autoInbox = hcc(['msg', 'inbox', '--all'], { env: autoEnv });
  if (!autoInbox.includes('auto-join-ok')) fail(`auto inbox missing message:\n${autoInbox}`);
  const autoTask = hcc(['task', 'create', '--title', 'auto join task', '--body', 'auto workflow'], { env: autoEnv });
  const autoTaskMatch = autoTask.match(/created task #(\d+):/);
  if (!autoTaskMatch) fail(`cannot parse auto task id: ${autoTask}`);
  const autoTaskId = autoTaskMatch[1];
  hcc(['task', 'claim', '--id', autoTaskId], { env: autoEnv });
  hcc(['task', 'update', '--id', autoTaskId, '--status', 'running', '--summary', 'auto running'], { env: autoEnv });
  const autoState = hccJson(['state'], { env: autoEnv });
  if (autoState.automation.peer?.id !== autoPeer) {
    fail(`auto state used wrong peer: ${autoPeer}\n${JSON.stringify(autoState.automation, null, 2)}`);
  }
  if (String(autoState.automation.current_task?.id) !== String(autoTaskId)) {
    fail(`auto state lost current task #${autoTaskId}:\n${JSON.stringify(autoState.automation, null, 2)}`);
  }
  if (autoState.automation.next_action.kind === 'task.next') {
    fail(`auto state suggested task.next while current task was active:\n${JSON.stringify(autoState.automation, null, 2)}`);
  }
  hcc(['lock', 'acquire', '--resource', 'auto/resource', '--task', autoTaskId, '--ttl', '60'], { env: autoEnv });
  hcc(['lock', 'renew', '--resource', 'auto/resource', '--ttl', '60'], { env: autoEnv });
  hcc(['handoff', 'create', '--summary', 'auto handoff', '--tests', 'auto test', '--risks', 'none'], { env: autoEnv });
  hcc(['lock', 'release', '--resource', 'auto/resource'], { env: autoEnv });
  hcc(['task', 'done', '--id', autoTaskId, '--summary', 'auto done'], { env: autoEnv });
  const autoEvents = hcc(['event', 'tail', '--limit', '200']);
  if (!autoEvents.includes('peer.auto_joined') || !autoEvents.includes(autoPeer)) {
    fail(`auto join event missing for ${autoPeer}:\n${autoEvents}`);
  }

  const codexEnv = envAsCodex();
  const codexPeer = parseSentPeer(hcc(['msg', 'send', '--to', 'all', '--body', 'auto-codex-ok'], { env: codexEnv }));
  if (!codexPeer.startsWith('codex-')) fail(`CODEX_THREAD_ID did not produce codex peer: ${codexPeer}`);
  if (!hcc(['msg', 'inbox', '--all'], { env: codexEnv }).includes('auto-codex-ok')) {
    fail('codex auto peer inbox did not include message');
  }
}

async function multiProjectWebWorkflow() {
  log('[4/12] multi-project web');
  const otherRoot = path.join(root, 'second-project');
  fs.mkdirSync(otherRoot, { recursive: true });
  const output = hccFrom(['web', '--local', '--port', String(port), '--no-discover', '--no-guidance'], otherRoot);
  if (!output.includes('web already running in background')) fail(`second project did not reuse global web:\n${output}`);
  if (!output.includes(`project: ${otherRoot}`)) fail(`second project output did not show its root:\n${output}`);
  if (!output.includes(encodeURIComponent(otherRoot))) fail(`second project URL did not include project query:\n${output}`);

  const otherRuntimeFile = path.join(otherRoot, '.hello-cc', 'runtime.json');
  ensureFile(otherRuntimeFile);
  const otherRuntime = JSON.parse(fs.readFileSync(otherRuntimeFile, 'utf8'));
  if (otherRuntime.pid !== runtimePid || otherRuntime.port !== port) {
    fail(`second project runtime did not point at global runtime:\n${JSON.stringify(otherRuntime, null, 2)}`);
  }

  const projectsResponse = await runtimeFetch('/api/projects', {}, { root: otherRoot });
  const projects = await projectsResponse.json();
  if (!projectsResponse.ok) fail(`projects API failed: ${JSON.stringify(projects)}`);
  const roots = new Set((projects.projects || []).map((p) => p.root));
  if (!roots.has(root) || !roots.has(otherRoot)) {
    fail(`projects API did not include both roots:\n${JSON.stringify(projects, null, 2)}`);
  }

  const detectedResponse = await runtimeFetch('/api/detected', {}, { root });
  const detectedJson = await detectedResponse.json();
  if (!detectedResponse.ok || typeof detectedJson.active_peer_ttl !== 'number' || typeof detectedJson.now !== 'number' || !Array.isArray(detectedJson.detected)) {
    fail(`detected API did not return liveness metadata:\n${JSON.stringify(detectedJson, null, 2)}`);
  }

  const htmlResponse = await fetch(currentRuntimeUrl('/'));
  const html = await htmlResponse.text();
  for (const forbidden of ['Alias optional', 'Role tag', 'Command<input', 'Working directory', 'commandbar', 'lineInput', 'Send text to active terminal']) {
    if (html.includes(forbidden)) fail(`web form still exposes ${forbidden}`);
  }
  for (const expected of [
    'id="projectSelect"',
    'id="projectPath"',
    'id="addProjectBtn"',
    'id="startForm"',
    'id="kind"',
    'id="sessionKindFilter"',
    'id="sessions"'
  ]) {
    if (!html.includes(expected)) fail(`web form missing simplified project/session control: ${expected}`);
  }
  for (const expected of [
    'id="langSelect"',
    "localStorage.getItem('hcc.lang')",
    "localStorage.setItem('hcc.lang', lang)",
    "document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'",
    "zh: {",
    "language: '语言'",
    "projectState: '项目状态'",
    "noSessionSelected: '未选择会话'",
    "sendMessage: '发送消息'",
    "peers: '协作方'",
    "noPeers: '没有协作方。'",
    "'status.active': '活跃'",
    "data-i18n=\"language\"",
    "data-i18n-placeholder=\"projectPathPlaceholder\"",
    "data-i18n-title=\"collapseSidebar\"",
    "function applyLanguage()",
    "function tr(key",
    "function statusText(status)",
    "function sessionMetaText(session)",
    "connText('attached')",
    "connText('coordinationOnly')",
    "tr('noActiveSessions')",
    "tr('nextAction')",
    "tr('detectedSession')",
    "tr('messageBodyPlaceholder')",
    "activeType === 'detected' && activeDetected",
    "const draft = document.getElementById('detMsg')?.value || ''",
    "statusText(state.label)",
    "statusText(automation.phase || 'idle')",
    "tr('runtime')"
  ]) {
    if (!html.includes(expected)) fail(`web UI missing i18n support: ${expected}`);
  }
  if (!html.includes('id="startMode"') || !html.includes('id="resumeArg"') || !html.includes('syncStartModeOptions') || !html.includes("mode === 'resume'")) {
    fail('web form missing provider resume controls');
  }
  for (const expected of [
    '--left-width',
    '--right-width',
    'hcc.sidebar.left.width',
    'hcc.sidebar.right.width',
    'class="edge-resizer edge-resizer-left"',
    'class="edge-resizer edge-resizer-right"',
    'id="resizeLeft"',
    'id="resizeRight"',
    'role="separator"',
    'aria-orientation="vertical"',
    'bindSideHandle(resizeLeftHandle',
    'bindSideHandle(resizeRightHandle',
    'bindSideHandle(toggleLeftBtn',
    'bindSideHandle(toggleRightBtn',
    'setPointerCapture',
    'sideIsCollapsed(opposite) ? 0',
    'Math.abs(delta) <= 3',
    "localStorage.setItem('hcc.collapse.' + side, on ? '1' : '0');\n      applySideWidths();",
    'cursor: col-resize'
  ]) {
    if (!html.includes(expected)) fail(`web layout missing resizable sidebar support: ${expected}`);
  }
  if (!html.includes('state-card') || !html.includes('peerStateView') || !html.includes('savedCardScroll') || !html.includes('lastStateRoot') || !html.includes("stateCardHtml('peers'")) {
    fail('web state panel missing scrollable peer state UI');
  }
  for (const expected of [
    'function stateCardCollapsed(section)',
    "localStorage.getItem('hcc.stateCard.' + section + '.collapsed')",
    'function stateCardHtml(section, title, count, bodyHtml)',
    'state-card-toggle',
    'aria-expanded=',
    'state-card-collapsed',
    'function bindStateCardToggles()',
    "localStorage.setItem('hcc.stateCard.' + section + '.collapsed'",
    "stateCardHtml('automation'",
    "stateCardHtml('timeline'",
    "stateCardHtml('messages'",
    "stateCardHtml('peers'",
    "stateCardHtml('tasks'",
    "stateCardHtml('locks'",
    'bindStateCardToggles();'
  ]) {
    if (!html.includes(expected)) fail(`web state panel missing collapsible card support: ${expected}`);
  }
  for (const expected of [
    'id="actionResult"',
    'data-action="state"',
    'data-action="status"',
    'data-action="inbox"',
    'data-action="task-next"',
    'data-action="heartbeat"',
    'data-action="register"',
    'data-terminal-action="status"',
    'function runPeerAction(action)',
    "'/api/peers/' + encodeURIComponent(info.peerId) + '/actions/' + encodeURIComponent(action)",
    'showActionResult(result)'
  ]) {
    if (!html.includes(expected)) fail(`web actions missing API result UI: ${expected}`);
  }
  if (html.includes('data-send=') || html.includes("document.querySelectorAll('[data-send]')")) {
    fail('web actions still use implicit terminal command injection');
  }
  for (const expected of [
    'term.onData((data) => {',
    "ws.send(JSON.stringify({ type: 'input', data }))"
  ]) {
    if (!html.includes(expected)) fail(`web terminal input forwarding missing: ${expected}`);
  }
  if (!html.includes("stateCardHtml('timeline'") || !html.includes('renderTimelineItem') || !html.includes('bodyPinned') || !html.includes('refreshCurrentState')) {
    fail('web state panel missing collaboration timeline or refresh routing');
  }
  if (!html.includes("stateCardHtml('messages'") || !html.includes('messagesData.length')) {
    fail('web state panel missing dedicated messages card');
  }

  if (!tmuxAvailable()) return;
  const started = hccFrom(['peer', 'start', 'other-shell', '--kind', 'shell', '--', 'bash', '--noprofile', '--norc'], otherRoot);
  parsePane(started);
  const rootList = hcc(['peer', 'list']);
  const otherList = hccFrom(['peer', 'list'], otherRoot);
  if (rootList.includes('other-shell')) fail(`root project saw second project session:\n${rootList}`);
  if (!otherList.includes('other-shell')) fail(`second project did not see its session:\n${otherList}`);

  const rootSessions = await (await runtimeFetch('/api/sessions', {}, { root })).json();
  const otherSessions = await (await runtimeFetch('/api/sessions', {}, { root: otherRoot })).json();
  if ((rootSessions.sessions || []).some((s) => s.id === 'other-shell')) {
    fail(`root API saw second project session:\n${JSON.stringify(rootSessions)}`);
  }
  if (!(otherSessions.sessions || []).some((s) => s.id === 'other-shell')) {
    fail(`second project API did not see its session:\n${JSON.stringify(otherSessions)}`);
  }

  hcc(['register', '--peer', 'web-action-peer', '--kind', 'codex', '--role', 'peer']);
  hcc(['msg', 'send', '--from', 'human', '--to', 'web-action-peer', '--body', 'web action inbox ok']);
  const actionStatus = await (await runtimeFetch('/api/peers/web-action-peer/actions/status', {}, { root })).json();
  if (!actionStatus.ok || actionStatus.action !== 'status' || actionStatus.peer !== 'web-action-peer' || !actionStatus.data || typeof actionStatus.data.unread !== 'number') {
    fail(`web status action did not return structured status:\n${JSON.stringify(actionStatus, null, 2)}`);
  }
  const actionInbox = await (await runtimeFetch('/api/peers/web-action-peer/actions/inbox', {}, { root })).json();
  if (!actionInbox.ok || actionInbox.action !== 'inbox' || !(actionInbox.data?.messages || []).some((m) => m.body === 'web action inbox ok')) {
    fail(`web inbox action did not return unread messages:\n${JSON.stringify(actionInbox, null, 2)}`);
  }
  const actionState = await (await runtimeFetch('/api/peers/web-action-peer/actions/state', {}, { root })).json();
  if (!actionState.ok || actionState.action !== 'state' || actionState.data?.automation?.peer?.id !== 'web-action-peer') {
    fail(`web state action did not return peer automation:\n${JSON.stringify(actionState, null, 2)}`);
  }
  const taskOutput = hcc(['task', 'create', '--title', 'web action task', '--body', 'claim through web action']);
  const taskMatch = taskOutput.match(/created task #(\d+):/);
  if (!taskMatch) fail(`cannot parse web action task id:\n${taskOutput}`);
  const actionNext = await (await runtimeFetch('/api/peers/web-action-peer/actions/task-next', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  }, { root })).json();
  if (!actionNext.ok || actionNext.action !== 'task-next' || String(actionNext.data?.task?.id) !== taskMatch[1]) {
    fail(`web task-next action did not claim pending task #${taskMatch[1]}:\n${JSON.stringify(actionNext, null, 2)}`);
  }
  const actionHeartbeat = await (await runtimeFetch('/api/peers/web-action-peer/actions/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ renew_locks: true })
  }, { root })).json();
  if (!actionHeartbeat.ok || actionHeartbeat.action !== 'heartbeat' || actionHeartbeat.data?.peer !== 'web-action-peer') {
    fail(`web heartbeat action did not return structured result:\n${JSON.stringify(actionHeartbeat, null, 2)}`);
  }

  const startProvider = async (payload) => {
    const response = await runtimeFetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        env: {
          HOME: home,
          PATH: env.PATH,
          SHELL: process.env.SHELL || 'bash',
          HCC_FAKE_STAY_ALIVE: '1'
        },
        ...payload
      })
    }, { root });
    const json = await response.json();
    if (!response.ok) fail(`web provider session start failed: ${JSON.stringify(json)}`);
    return json.session;
  };
  const stopSession = async (id) => {
    await runtimeFetch(`/api/sessions/${encodeURIComponent(id)}/stop`, { method: 'POST' }, { root });
  };

  const claudeResumeName = `web-claude-resume-${testId}`;
  const claudeResume = await startProvider({ kind: 'claude', mode: 'resume', resume: claudeResumeName });
  const expectedClaudePeer = `claude-${claudeResumeName.slice(0, 8)}`;
  if (!claudeResume.command.includes(`claude --resume ${claudeResumeName}`)) {
    fail(`web claude resume command wrong:\n${JSON.stringify(claudeResume, null, 2)}`);
  }
  if (claudeResume.id !== expectedClaudePeer || claudeResume.peer_id !== expectedClaudePeer) {
    fail(`web claude resume did not use canonical provider peer id ${expectedClaudePeer}:\n${JSON.stringify(claudeResume, null, 2)}`);
  }
  const claudeRows = providerBindingRows('claude', claudeResumeName);
  if (claudeRows.length !== 1 ||
      claudeRows[0].peer !== claudeResume.peer_id ||
      claudeRows[0].resume_mode !== 'resume' ||
      claudeRows[0].resume_arg !== claudeResumeName ||
      claudeRows[0].transport !== 'tmux' ||
      !claudeRows[0].runtime_target) {
    fail(`web claude resume binding wrong:\n${JSON.stringify(claudeRows, null, 2)}`);
  }
  await stopSession(claudeResume.id);

  const codexResumeName = `web-codex-resume-${testId}`;
  const codexResume = await startProvider({ kind: 'codex', mode: 'resume', resume: codexResumeName });
  const expectedCodexPeer = `codex-${codexResumeName.slice(0, 8)}`;
  if (!codexResume.command.includes(`codex resume ${codexResumeName}`)) {
    fail(`web codex resume command wrong:\n${JSON.stringify(codexResume, null, 2)}`);
  }
  if (codexResume.id !== expectedCodexPeer || codexResume.peer_id !== expectedCodexPeer) {
    fail(`web codex resume did not use canonical provider peer id ${expectedCodexPeer}:\n${JSON.stringify(codexResume, null, 2)}`);
  }
  const codexRows = providerBindingRows('codex', codexResumeName);
  if (codexRows.length !== 1 ||
      codexRows[0].peer !== codexResume.peer_id ||
      codexRows[0].resume_mode !== 'resume' ||
      codexRows[0].resume_arg !== codexResumeName ||
      codexRows[0].transport !== 'tmux' ||
      !codexRows[0].runtime_target) {
    fail(`web codex resume binding wrong:\n${JSON.stringify(codexRows, null, 2)}`);
  }
  await stopSession(codexResume.id);
  const codexRowsAfterStop = providerBindingRows('codex', codexResumeName);
  if (codexRowsAfterStop.length !== 1 || codexRowsAfterStop[0].peer !== expectedCodexPeer) {
    fail(`web codex resume binding was not stable after stop:\n${JSON.stringify(codexRowsAfterStop, null, 2)}`);
  }

  const resumableResponse = await runtimeFetch('/api/resumable', {}, { root });
  const resumableJson = await resumableResponse.json();
  if (!resumableResponse.ok) fail(`resumable API failed: ${JSON.stringify(resumableJson)}`);
  const resumableRows = resumableJson.resumable || [];
  const claudeResumable = resumableRows.find((row) => row.provider === 'claude' && row.resume === claudeResumeName);
  const codexResumable = resumableRows.find((row) => row.provider === 'codex' && row.resume === codexResumeName);
  if (!claudeResumable || claudeResumable.session_name !== claudeResumeName || claudeResumable.session_id !== null) {
    fail(`resumable API omitted named claude resume session:\n${JSON.stringify(resumableRows, null, 2)}`);
  }
  if (!codexResumable || codexResumable.session_name !== codexResumeName || codexResumable.session_id !== null) {
    fail(`resumable API omitted named codex resume session:\n${JSON.stringify(resumableRows, null, 2)}`);
  }

  const codexLast = await startProvider({ kind: 'codex', mode: 'last' });
  if (codexLast.command !== 'codex resume --last') {
    fail(`web codex last command wrong:\n${JSON.stringify(codexLast, null, 2)}`);
  }
  await stopSession(codexLast.id);

  const claudeContinue = await startProvider({ kind: 'claude', mode: 'continue' });
  if (claudeContinue.command !== 'claude --continue') {
    fail(`web claude continue command wrong:\n${JSON.stringify(claudeContinue, null, 2)}`);
  }
  await stopSession(claudeContinue.id);

  const badShellResume = await runtimeFetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'shell', mode: 'resume', resume: 'not-supported' })
  }, { root });
  if (badShellResume.ok) {
    fail('web shell resume was accepted');
  }

  const startAuto = async () => {
    const response = await runtimeFetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'shell', command: 'bash --noprofile --norc' })
    }, { root: otherRoot });
    const json = await response.json();
    if (!response.ok) fail(`auto web session start failed: ${JSON.stringify(json)}`);
    return json.session;
  };
  const autoOne = await startAuto();
  const autoTwo = await startAuto();
  if (!autoOne.id.startsWith('shell-') || !autoTwo.id.startsWith('shell-') || autoOne.id === autoTwo.id) {
    fail(`auto web session ids were not unique: ${autoOne.id}, ${autoTwo.id}`);
  }
  await runtimeFetch(`/api/sessions/${encodeURIComponent(autoOne.id)}/stop`, { method: 'POST' }, { root: otherRoot });
  await runtimeFetch(`/api/sessions/${encodeURIComponent(autoTwo.id)}/stop`, { method: 'POST' }, { root: otherRoot });
  hccFromMaybe(['peer', 'stop', 'other-shell'], otherRoot);
}

async function tmuxBackedStartWorkflow() {
  if (!tmuxAvailable()) {
    log('[5/12] tmux-backed start skipped (tmux not installed)');
    return;
  }

  log('[5/12] tmux-backed start + websocket + restore');
  const file = path.join(outDir, 'pty-ok');
  const started = hcc(['peer', 'start', 'shell-a', '--kind', 'shell', '--', 'bash']);
  const pane = parsePane(started);
  const list = hcc(['peer', 'list']);
  if (!list.includes('shell-a') || !list.includes('tmux')) fail(`tmux-backed peer missing from list:\n${list}`);
  hcc(['inject', 'shell-a', `echo PTY_OK > ${file}`]);
  await waitForFile(file, 'PTY_OK', 'pty injection');
  await expectWebSocketMarker('shell-a', 'WS_PTY_OK');
  await expectResizeReplaceSnapshot('shell-a', 'WS_RESIZE_OK');
  await expectWebSocketInputVisible('shell-a', 'WS_INPUT_VISIBLE_OK');
  await expectBoundedTmuxStream('tmux-backed FIFO stream');

  await stopRuntime();
  run('tmux', ['display-message', '-p', '-t', pane, '#{pane_id}']);
  startRuntime();
  await waitRuntime();
  await waitFor(() => hcc(['peer', 'list']).includes('shell-a'), 'tmux-backed peer restore');
  const restoredFile = path.join(outDir, 'pty-restored-ok');
  hcc(['inject', 'shell-a', `echo PTY_RESTORED_OK > ${restoredFile}`]);
  await waitForFile(restoredFile, 'PTY_RESTORED_OK', 'tmux restore injection');

  const aliasPeer = 'shell-canonical-alias';
  parsePane(hcc(['peer', 'start', 'shell-runtime-alias', '--kind', 'shell', '--', 'bash', '--noprofile', '--norc']));
  moveRuntimeBindingPeer('shell-runtime-alias', aliasPeer);
  const aliasSessions = await (await runtimeFetch('/api/sessions', {}, { root })).json();
  const aliasSession = (aliasSessions.sessions || []).find((session) => session.id === 'shell-runtime-alias');
  if (!aliasSession || aliasSession.peer_id !== aliasPeer) {
    fail(`sessions API did not expose canonical peer id for runtime alias:\n${JSON.stringify(aliasSessions, null, 2)}`);
  }
  const aliasDetected = await (await runtimeFetch('/api/detected', {}, { root })).json();
  if ((aliasDetected.detected || []).some((peer) => peer.id === aliasPeer || peer.id === 'shell-runtime-alias')) {
    fail(`detected API showed managed runtime/canonical duplicate:\n${JSON.stringify(aliasDetected, null, 2)}`);
  }
  const aliasFile = path.join(outDir, 'runtime-alias-ok');
  hcc(['inject', aliasPeer, `echo RUNTIME_ALIAS_OK > ${aliasFile}`]);
  await waitForFile(aliasFile, 'RUNTIME_ALIAS_OK', 'canonical peer injection to runtime alias');
  hcc(['peer', 'stop', aliasPeer]);

  const canonicalSession = 'canonical-session';
  insertStaleProviderBinding('claude-stale-canonical', 'claude', canonicalSession);
  const canonicalStarted = hcc(['peer', 'start', 'claude-live-canonical', '--kind', 'claude', '--resume', canonicalSession], {
    env: { ...env, HCC_FAKE_STAY_ALIVE: '1' }
  });
  const canonicalPane = parsePane(canonicalStarted);
  const canonicalRows = providerBindingRows('claude', canonicalSession);
  if (canonicalRows.length !== 1 ||
      canonicalRows[0].peer !== 'claude-live-canonical' ||
      canonicalRows[0].transport !== 'tmux' ||
      canonicalRows[0].runtime_target !== canonicalPane) {
    fail(`stale provider binding was not migrated to live tmux peer:\n${JSON.stringify(canonicalRows, null, 2)}`);
  }
  hcc(['peer', 'stop', 'claude-live-canonical']);

  const forceSession = 'force-canonical-session';
  const forceFirst = hcc(['peer', 'start', 'claude-force-a', '--kind', 'claude', '--resume', forceSession], {
    env: { ...env, HCC_FAKE_STAY_ALIVE: '1' }
  });
  parsePane(forceFirst);
  const forceConflict = hccMaybe(['peer', 'start', 'claude-force-b', '--kind', 'claude', '--resume', forceSession], {
    env: { ...env, HCC_FAKE_STAY_ALIVE: '1' }
  });
  if (forceConflict.status === 0 || !String(forceConflict.stderr || forceConflict.stdout).includes('already bound to claude-force-a')) {
    fail(`provider session duplicate start was not rejected:\n${forceConflict.stdout}\n${forceConflict.stderr}`);
  }
  const forceSecond = hcc(['peer', 'start', 'claude-force-b', '--kind', 'claude', '--resume', forceSession, '--force'], {
    env: { ...env, HCC_FAKE_STAY_ALIVE: '1' }
  });
  const forcePane = parsePane(forceSecond);
  const forceRows = providerBindingRows('claude', forceSession);
  if (forceRows.length !== 1 ||
      forceRows[0].peer !== 'claude-force-b' ||
      forceRows[0].transport !== 'tmux' ||
      forceRows[0].runtime_target !== forcePane) {
    fail(`--force did not move provider binding to replacement tmux peer:\n${JSON.stringify(forceRows, null, 2)}`);
  }
  hccMaybe(['peer', 'stop', 'claude-force-a']);
  hcc(['peer', 'stop', 'claude-force-b']);

  await stopRuntime();
  startRuntime({ env: envWithoutProvider({ HCC_REG_VALUE: 'runtime-old', ANTHROPIC_BASE_URL: 'runtime-old-url' }) });
  await waitRuntime();
  const envFile = path.join(outDir, 'caller-env-ok');
  parsePane(hcc(['peer', 'start', 'env-a', '--kind', 'shell', '--', 'bash', '--noprofile', '--norc'], {
    env: envWithoutProvider({ HCC_REG_VALUE: 'caller-new' })
  }));
  hcc(['inject', 'env-a', `printf '%s|%s\\n' "$HCC_REG_VALUE" "\${ANTHROPIC_BASE_URL:-}" > ${envFile}`]);
  await waitForFile(envFile, 'caller-new|', 'caller env propagation');
  hcc(['peer', 'stop', 'env-a']);
}

async function shimTmuxWorkflow() {
  if (!tmuxAvailable()) {
    log('[6/12] shim tmux-backed launch skipped (tmux not installed)');
    return;
  }

  log('[6/12] shim tmux-backed launch');
  const shim = path.join(home, '.hcc-shims', 'claude');
  const codexShim = path.join(home, '.hcc-shims', 'codex');
  const claudeVersion = run(shim, ['--version'], { cwd: root, env });
  if (!claudeVersion.includes('fake-claude --version') || claudeVersion.includes('started ')) {
    fail(`claude shim did not pass through --version:\n${claudeVersion}`);
  }
  const claudePrint = run(shim, ['--print', 'hello'], { cwd: root, env });
  if (!claudePrint.includes('fake-claude --print hello') || claudePrint.includes('started ')) {
    fail(`claude shim did not pass through --print:\n${claudePrint}`);
  }
  const codexVersion = run(codexShim, ['--version'], { cwd: root, env });
  if (!codexVersion.includes('fake-codex --version') || codexVersion.includes('started ')) {
    fail(`codex shim did not pass through --version:\n${codexVersion}`);
  }
  const codexExec = run(codexShim, ['exec', 'hello'], { cwd: root, env });
  if (!codexExec.includes('fake-codex exec hello') || codexExec.includes('started ')) {
    fail(`codex shim did not pass through exec:\n${codexExec}`);
  }

  const shimEnv = {
    ...env,
    HCC_SHIM_NO_ATTACH: '1',
    HCC_FAKE_STAY_ALIVE: '1',
    HCC_NO_AUTO_INSTALL_TMUX: '1',
    HCC_REG_VALUE: 'shim-first'
  };
  const output = run(shim, ['--resume', 'shim-regression-session'], { cwd: root, env: shimEnv });
  const peerMatch = output.match(/started\s+(\S+)\s+\(/);
  if (!peerMatch) fail(`shim did not start a peer:\n${output}`);
  const peer = peerMatch[1];
  const pane = parsePane(output);
  const list = hcc(['peer', 'list']);
  if (!list.includes(peer) || !list.includes('tmux') || !list.includes(pane)) {
    fail(`shim peer missing from list:\n${list}`);
  }
  const hookPreservePayload = JSON.stringify({
    session_id: 'hook-preserve-session',
    cwd: root,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'keep tmux binding'
  });
  hcc(['hook', 'userpromptsubmit'], {
    env: { ...env, HCC_PEER: peer, CLAUDE_CODE_SESSION_ID: 'hook-preserve-session' },
    input: hookPreservePayload
  });
  const afterHookRows = hccJson(['peer', 'list']);
  const afterHookPeer = afterHookRows.find((row) => row.id === peer);
  if (!afterHookPeer?.binding || afterHookPeer.binding.transport !== 'tmux' || afterHookPeer.binding.runtime_target !== pane) {
    fail(`Claude hook overwrote tmux binding:\n${JSON.stringify(afterHookPeer, null, 2)}`);
  }
  hcc(['hook', 'userpromptsubmit'], {
    env: envWithoutPeer({ CLAUDE_CODE_SESSION_ID: 'hook-preserve-session' }),
    input: hookPreservePayload
  });
  const hookBindingRows = providerBindingRows('claude', 'hook-preserve-session');
  if (hookBindingRows.length !== 1 ||
      hookBindingRows[0].peer !== peer ||
      hookBindingRows[0].transport !== 'tmux' ||
      hookBindingRows[0].runtime_target !== pane) {
    fail(`Claude hook did not canonicalize provider session to tmux peer:\n${JSON.stringify(hookBindingRows, null, 2)}`);
  }
  const file = path.join(outDir, 'shim-ok');
  hcc(['inject', peer, `echo SHIM_OK > ${file}`]);
  await waitForFile(file, 'SHIM_OK', 'shim tmux injection');
  await expectWebSocketMarker(peer, 'WS_SHIM_OK');
  await expectBoundedTmuxStream('shim tmux FIFO stream');

  const firstEnvFile = path.join(outDir, 'shim-env-first');
  hcc(['inject', peer, `printf '%s\\n' "$HCC_REG_VALUE" > ${firstEnvFile}`]);
  await waitForFile(firstEnvFile, 'shim-first', 'shim first env');

  const restarted = run(shim, ['--resume', 'shim-regression-session'], {
    cwd: root,
    env: { ...shimEnv, HCC_REG_VALUE: 'shim-second' }
  });
  parsePane(restarted);
  const secondEnvFile = path.join(outDir, 'shim-env-second');
  hcc(['inject', peer, `printf '%s\\n' "$HCC_REG_VALUE" > ${secondEnvFile}`]);
  await waitForFile(secondEnvFile, 'shim-second', 'shim env restart');
  const reentryFile = path.join(outDir, 'shim-reentry');
  hcc(['inject', peer, `HCC_FAKE_STAY_ALIVE=0 HCC_REG_VALUE=shim-third ${sh(shim)} --resume shim-regression-session > ${sh(reentryFile)} 2>&1`]);
  await waitForFileContent(reentryFile, 'fake-claude --resume shim-regression-session', 'shim tmux pane re-entry');
  hcc(['peer', 'stop', peer]);

  const exitedResume = 'shim-exited-session';
  const exitedLog = path.join(outDir, 'shim-exited-log');
  const exitedEnv = {
    ...shimEnv,
    HCC_FAKE_STAY_ALIVE: '0',
    HCC_FAKE_LOG: exitedLog
  };
  const exitedFirst = run(shim, ['--resume', exitedResume], { cwd: root, env: exitedEnv });
  const exitedPeerMatch = exitedFirst.match(/started\s+(\S+)\s+\(/);
  if (!exitedPeerMatch) fail(`exited shim did not start a peer:\n${exitedFirst}`);
  const exitedPeer = exitedPeerMatch[1];
  parsePane(exitedFirst);
  await waitForFileLineCount(exitedLog, 1, 'shim exited first provider launch');
  const fallbackFile = path.join(outDir, 'shim-exited-fallback');
  hcc(['inject', exitedPeer, `printf '%s\\n' fallback > ${sh(fallbackFile)}`]);
  await waitForFile(fallbackFile, 'fallback', 'shim exited fallback shell');
  const exitedSecond = run(shim, ['--resume', exitedResume], { cwd: root, env: exitedEnv });
  parsePane(exitedSecond);
  await waitForFileLineCount(exitedLog, 2, 'shim exited resume relaunch');
  hcc(['peer', 'stop', exitedPeer]);
}

async function tmuxWorkflow() {
  const tmuxVersion = runMaybe('tmux', ['-V']);
  if (tmuxVersion.status !== 0) {
    log('[7/12] tmux skipped (tmux not installed)');
    return;
  }

  log('[7/12] tmux attach + websocket + force');
  run('tmux', ['new-session', '-d', '-s', tmuxSession, '-c', os.tmpdir(), 'bash --noprofile --norc']);
  tmuxStarted = true;
  const pane = run('tmux', ['display-message', '-p', '-t', `${tmuxSession}:0.0`, '#{pane_id}']).trim();
  const file = path.join(outDir, 'tmux-ok');
  hcc(['peer', 'attach', 'tmux-a', '--kind', 'shell', '--pane', pane]);
  hcc(['inject', 'tmux-a', `echo TMUX_OK > ${file}`]);
  await waitForFile(file, 'TMUX_OK', 'tmux injection');
  await expectWebSocketMarker('tmux-a', 'WS_TMUX_OK');
  await expectBoundedTmuxStream('attached tmux FIFO stream');
  const conflict = hccMaybe(['peer', 'attach', 'tmux-b', '--kind', 'shell', '--pane', pane]);
  if (conflict.status === 0 || !String(conflict.stderr || conflict.stdout).includes('already attached to tmux-a')) {
    fail('tmux duplicate attach did not fail as expected');
  }
  hcc(['peer', 'attach', 'tmux-b', '--kind', 'shell', '--pane', pane, '--force']);
  if (!hcc(['peer', 'list']).includes('tmux-b')) fail('tmux force attach missing');
  hcc(['peer', 'stop', 'tmux-b']);
  run('tmux', ['display-message', '-p', '-t', pane, '#{pane_id}']);
}

async function askBroadcastWorkflow() {
  if (!tmuxAvailable()) {
    log('[8/12] ask/broadcast injection skipped (tmux not installed)');
    return;
  }

  log('[8/12] ask/broadcast injection');
  const askFile = path.join(outDir, 'ask-ok');
  parsePane(hcc(['peer', 'start', 'shell-b', '--kind', 'shell', '--', 'bash']));
  hcc(['ask', 'shell-b', `echo ASK_OK > ${askFile}`, '--from', 'human', '--inject']);
  await waitForFile(askFile, 'ASK_OK', 'ask injection');
  if (!hcc(['msg', 'inbox', '--peer', 'shell-b', '--all']).includes('ASK_OK')) fail('ask durable message missing');
  const broadcastFile = path.join(outDir, 'broadcast-ok');
  hcc(['broadcast', `echo BROADCAST_OK > ${broadcastFile}`, '--from', 'human', '--inject']);
  await waitForFile(broadcastFile, 'BROADCAST_OK', 'broadcast injection');
}

async function downGcPackWorkflow() {
  log('[9/12] down/gc/pack');
  hccMaybe(['peer', 'stop', 'shell-a']);
  hccMaybe(['peer', 'stop', 'shell-b']);
  await stopRuntime();
  await waitFor(() => !fs.existsSync(path.join(root, '.hello-cc', 'runtime.json')), 'runtime cleanup', 5000);
  hcc(['gc', '--older-than', '0', '--yes']);
  const pack = JSON.parse(run('npm', ['pack', '--dry-run', '--json']));
  const files = new Set(pack[0]?.files?.map((entry) => entry.path) || []);
  for (const file of [
    'assets/logo.svg',
    'CHANGELOG.md',
    'docs/commands.md',
    'docs/commands.zh-CN.md',
    ...libModuleFiles(),
    'scripts/github-release.mjs'
  ]) {
    if (!files.has(file)) fail(`npm package missing ${file}`);
  }
  const packageVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
  const releaseCheck = run('npm', ['run', 'release:check']);
  if (!releaseCheck.includes(`release notes ok: ${packageVersion}`)) fail(`release check output wrong:\n${releaseCheck}`);
  const releaseNotes = run('npm', ['run', 'release:notes']);
  if (!releaseNotes.includes(`## ${packageVersion}`) || !releaseNotes.includes('### Summary')) {
    fail(`release notes output wrong:\n${releaseNotes}`);
  }
  const releaseNotesWithV = run(process.execPath, [path.join(repoRoot, 'scripts', 'release-notes.mjs'), '--version', `v${packageVersion}`]);
  if (!releaseNotesWithV.includes(`## ${packageVersion}`) || releaseNotesWithV.includes(`## v${packageVersion}`)) {
    fail(`release notes v-prefixed version output wrong:\n${releaseNotesWithV}`);
  }
  const githubRelease = JSON.parse(run(process.execPath, [path.join(repoRoot, 'scripts', 'github-release.mjs'), '--dry-run', '--version', packageVersion]));
  if (!githubRelease.ok || !githubRelease.dry_run || githubRelease.repo !== 'Dullne/hello-cc' || githubRelease.tag !== `v${packageVersion}` || githubRelease.body_length < 100) {
    fail(`github release dry run output wrong:\n${JSON.stringify(githubRelease, null, 2)}`);
  }
  const docsIndex = fs.readFileSync(path.join(repoRoot, 'docs', 'README.md'), 'utf8');
  const docsIndexZh = fs.readFileSync(path.join(repoRoot, 'docs', 'README.zh-CN.md'), 'utf8');
  if (!docsIndex.includes('github-release.yml') || !docsIndex.includes('workflow_dispatch') || !docsIndexZh.includes('github-release.yml') || !docsIndexZh.includes('workflow_dispatch')) {
    fail('docs index missing GitHub Release publishing command');
  }
  const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'github-release.yml'), 'utf8');
  for (const expected of [
    'Publish GitHub Release',
    "tags:\n      - 'v*'",
    'workflow_dispatch:',
    'contents: write',
    'actions/checkout@v4',
    'actions/setup-node@v4',
    'node-version: 24',
    'npm run release:check',
    'npm run release:github:dry-run',
    'npm run release:github',
    'GITHUB_TOKEN: ${{ github.token }}'
  ]) {
    if (!workflow.includes(expected)) fail(`github release workflow missing ${expected}`);
  }
}

function oldNameScan() {
  log('[10/12] old-name scan');
  const oldNamePattern = [
    'agent' + 'mesh',
    'Agent' + 'mesh',
    'AGENT' + 'MESH',
    '\\.' + 'agent' + 'mesh',
    'bin/' + 'agent' + 'mesh',
    'HCC_' + 'AGENT',
    'ACTIVE_' + 'AGENT_' + 'TTL',
    '--' + 'agent\\b'
  ].join('|');
  const rg = runMaybe('rg', [
    '-n',
    '--glob', '!node_modules/**',
    '--glob', '!*.tgz',
    '--',
    oldNamePattern,
    '.'
  ]);
  if (rg.status === 0) fail(`old names found:\n${rg.stdout}`);
  if (rg.status !== 1) fail(`rg failed:\n${rg.stderr || rg.stdout}`);
}

async function syntaxAndHelp() {
  log('[11/12] syntax/help');
  run(process.execPath, ['--check', path.join(repoRoot, 'bin', 'hcc.mjs')]);
  for (const file of libModuleFiles()) {
    run(process.execPath, ['--check', path.join(repoRoot, file)]);
  }
  const hccSource = fs.readFileSync(hccBin, 'utf8');
  const webUiTemplateSource = fs.readFileSync(path.join(repoRoot, 'lib', 'web-ui-template.mjs'), 'utf8');
  for (const expected of [
    'function scheduleTmuxInputRefresh(session)',
    "runTmux(['pipe-pane', '-t', session.pane]);",
    'if (session.inputRefreshTimer) return;',
    'session.inputRefreshTimer = setTimeout',
    'scheduleTmuxInputRefresh(session)',
    "if (session.inputRefreshTimer) { clearTimeout(session.inputRefreshTimer); session.inputRefreshTimer = null; }",
    "broadcast(session, { type: 'replace', data: refreshTmuxSnapshot(session) });"
  ]) {
    if (!hccSource.includes(expected)) fail(`web terminal input refresh support missing: ${expected}`);
  }
  for (const expected of [
    'function detectedPeerCanStop(peer)',
    "if (['exited', 'detached'].includes(status)) return false;",
    'const canStop = detectedPeerCanStop(p);',
    '${canStop ?',
    "if (e.target.closest('[data-action]')) return;",
    'id="stopKillLabel" data-i18n="dialog.killTmux"',
    'id="stopCancelBtn" type="button" data-i18n="dialog.cancel"',
    'id="stopConfirmBtn" type="button" data-i18n="stop"'
  ]) {
    if (!webUiTemplateSource.includes(expected)) fail(`web display regression guard missing: ${expected}`);
  }
  if (webUiTemplateSource.includes("p.status === 'running' ?")) {
    fail('detected peer action rendering still depends on status === running instead of liveness');
  }
  for (const expected of [
    'function webPeerAction(projectCtx, peer, action, input = {})',
    'function claimNextTasksForPeer(db, peer, { force = false, count = 1 } = {})',
    'function takeOverTaskForPeer(db, peer, id, { reason, policy = ',
    'function statusSummary(ctx, peer = null, identity = null)',
    'const peerActionMatch = url.pathname.match(/^\\/api\\/peers\\/([^/]+)\\/actions\\/([^/]+)$/)',
    "const readOnly = ['status', 'state', 'inbox'].includes(action)",
    "sendJson(res, 200, webPeerAction(reqCtx, peer, action, input));"
  ]) {
    if (!hccSource.includes(expected)) fail(`web peer action API support missing: ${expected}`);
  }
  const packageVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
  const cliVersion = run(process.execPath, [hccBin, '--version']).trim();
  if (cliVersion !== packageVersion) {
    fail(`CLI version ${cliVersion} does not match package.json ${packageVersion}`);
  }
  if (!hccSource.includes("import { readPackageMeta } from '../lib/package-meta.mjs'") ||
      !hccSource.includes("} from '../lib/cli-args.mjs'") ||
      !hccSource.includes("import { CliError } from '../lib/errors.mjs'") ||
      !hccSource.includes("} from '../lib/db-schema.mjs'") ||
      !hccSource.includes("} from '../lib/format.mjs'") ||
      !hccSource.includes("} from '../lib/runtime-paths.mjs'") ||
      !hccSource.includes("} from '../lib/project-context.mjs'") ||
      !hccSource.includes("} from '../lib/provider-commands.mjs'") ||
      !hccSource.includes("} from '../lib/tmux.mjs'") ||
      !hccSource.includes("} from '../lib/locks.mjs'") ||
      !hccSource.includes("} from '../lib/team-planning.mjs'") ||
      !hccSource.includes("} from '../lib/peer-identity.mjs'") ||
      !hccSource.includes("} from '../lib/project-registry.mjs'") ||
      !hccSource.includes("} from '../lib/web-runtime.mjs'") ||
      !hccSource.includes("} from '../lib/web-http.mjs'") ||
      !hccSource.includes("import { webIndexHtml } from '../lib/web-ui-template.mjs'") ||
      !hccSource.includes('const VERSION = PACKAGE_META.version') ||
      !hccSource.includes('writeGuidanceForRoot(ctx.root)')) {
    fail('CLI still has duplicated package metadata, cli args, DB schema helpers, format helpers, runtime paths, project context helpers, provider command helpers, tmux helpers, lock helpers, team planning helpers, peer identity helpers, project registry helpers, web runtime/HTTP/UI helpers, or guidance wiring');
  }
  if (hccSource.includes('function createBaseSchema') ||
      hccSource.includes('function runSchemaMigrations') ||
      hccSource.includes('function readSchemaVersion')) {
    fail('CLI still embeds DB schema or migration helpers');
  }
  for (const helper of [
    'function runGit',
    'function hasHccRootSync',
    'function detectRoot',
    'function detectBranch'
  ]) {
    if (hccSource.includes(helper)) fail(`CLI still embeds project context helper: ${helper}`);
  }
  const projectContext = await import(path.join(repoRoot, 'lib', 'project-context.mjs'));
  for (const name of [
    'runGit',
    'hasHccRootSync',
    'detectRoot',
    'detectBranch'
  ]) {
    if (typeof projectContext[name] !== 'function') fail(`project context module missing export: ${name}`);
  }
  const gitTop = projectContext.runGit(['rev-parse', '--show-toplevel'], repoRoot);
  if (path.resolve(gitTop || '') !== repoRoot) fail(`project context runGit changed: ${gitTop}`);
  const gitBranch = projectContext.runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot) || '';
  const detectedBranch = projectContext.detectBranch(repoRoot);
  if (detectedBranch !== gitBranch) {
    fail(`project context detectBranch changed: ${detectedBranch} != ${gitBranch}`);
  }
  const savedHccRoot = process.env.HCC_ROOT;
  try {
    delete process.env.HCC_ROOT;
    if (projectContext.detectRoot('/tmp/hcc-a', '') !== path.resolve('/tmp/hcc-a')) {
      fail('project context detectRoot cwd fallback changed');
    }
    process.env.HCC_ROOT = '/tmp/hcc-env-root';
    if (projectContext.detectRoot('/tmp/hcc-a', '') !== path.resolve('/tmp/hcc-env-root') ||
        projectContext.detectRoot('/tmp/hcc-a', '/tmp/hcc-explicit-root') !== path.resolve('/tmp/hcc-explicit-root')) {
      fail('project context detectRoot precedence changed');
    }
  } finally {
    if (savedHccRoot === undefined) delete process.env.HCC_ROOT;
    else process.env.HCC_ROOT = savedHccRoot;
  }
  const contextRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-project-context-'));
  fs.mkdirSync(path.join(contextRoot, '.hello-cc'), { recursive: true });
  if (projectContext.hasHccRootSync(contextRoot)) fail('project context detected root before marker file');
  fs.writeFileSync(path.join(contextRoot, '.hello-cc', 'config.json'), '{}');
  if (!projectContext.hasHccRootSync(contextRoot)) fail('project context did not detect config marker');
  for (const helper of [
    'function runTmux',
    'function tmuxInstallHint',
    'function commandExists',
    'function runInstallCommand',
    'function tryInstallTmux',
    'function ensureTmuxAvailable',
    'function tmuxHasSession',
    'function tmuxSessionHasClients',
    'function tmuxKillSession',
    'function tmuxSessionEnvironmentValue'
  ]) {
    if (hccSource.includes(helper)) fail(`CLI still embeds low-level tmux helper: ${helper}`);
  }
  const tmuxModule = await import(path.join(repoRoot, 'lib', 'tmux.mjs'));
  for (const name of [
    'runTmux',
    'tryInstallTmux',
    'ensureTmuxAvailable',
    'tmuxHasSession',
    'tmuxSessionHasClients',
    'tmuxKillSession',
    'tmuxSessionEnvironmentValue'
  ]) {
    if (typeof tmuxModule[name] !== 'function') fail(`tmux module missing export: ${name}`);
  }
  for (const helper of [
    'function providerSessionPeerId',
    'function providerSessionParts',
    'function inferPeerKind',
    'function hasResumeOpts',
    'function defaultSessionCommand',
    'function buildPeerCommand',
    'function buildCodexCommand',
    'function buildClaudeCommand',
    'function bindingFromRun',
    'function parseClaudeCommandArgs',
    'function parseCodexCommandArgs'
  ]) {
    if (hccSource.includes(helper)) fail(`CLI still embeds provider command helper: ${helper}`);
  }
  const providerCommands = await import(path.join(repoRoot, 'lib', 'provider-commands.mjs'));
  for (const name of [
    'providerSessionPeerId',
    'providerSessionParts',
    'inferPeerKind',
    'hasResumeOpts',
    'defaultSessionCommand',
    'buildPeerCommand',
    'buildCodexCommand',
    'buildClaudeCommand',
    'bindingFromRun',
    'parseClaudeCommandArgs',
    'parseCodexCommandArgs'
  ]) {
    if (typeof providerCommands[name] !== 'function') fail(`provider command module missing export: ${name}`);
  }
  const providerNameSession = providerCommands.providerSessionParts('named-session');
  if (providerNameSession.provider_session_name !== 'named-session' || providerNameSession.provider_session_id !== null) {
    fail(`provider command module misclassified named session: ${JSON.stringify(providerNameSession)}`);
  }
  const providerUuidSession = providerCommands.providerSessionParts('00000000-0000-0000-0000-000000000000');
  if (providerUuidSession.provider_session_id !== '00000000-0000-0000-0000-000000000000' || providerUuidSession.provider_session_name !== null) {
    fail(`provider command module misclassified UUID session: ${JSON.stringify(providerUuidSession)}`);
  }
  const builtClaude = providerCommands.buildPeerCommand('claude-peer', 'claude', { resume: 'named-session' }, []);
  if (builtClaude.command !== 'claude --resume named-session' ||
      builtClaude.binding.resume_mode !== 'resume' ||
      builtClaude.binding.provider_session_name !== 'named-session') {
    fail(`provider command module built wrong Claude resume command: ${JSON.stringify(builtClaude)}`);
  }
  const builtCodex = providerCommands.buildPeerCommand('codex-peer', 'codex', { resume: 'codex-session' }, []);
  if (builtCodex.command !== 'codex resume codex-session' ||
      builtCodex.binding.resume_mode !== 'resume' ||
      builtCodex.binding.provider_session_name !== 'codex-session') {
    fail(`provider command module built wrong Codex resume command: ${JSON.stringify(builtCodex)}`);
  }
  const parsedCodex = providerCommands.parseCodexCommandArgs(['codex', 'resume', '--model', 'gpt-test', 'codex-session']);
  if (parsedCodex.resume_mode !== 'resume' ||
      parsedCodex.resume_arg !== 'codex-session' ||
      parsedCodex.session.provider_session_name !== 'codex-session') {
    fail(`provider command module parsed Codex resume args wrong: ${JSON.stringify(parsedCodex)}`);
  }
  const parsedClaude = providerCommands.parseClaudeCommandArgs(['claude', '--resume', 'claude-session', '--fork-session']);
  if (parsedClaude.resume_mode !== 'fork-resume' ||
      parsedClaude.resume_arg !== 'claude-session' ||
      parsedClaude.session.provider_session_name !== null) {
    fail(`provider command module parsed Claude fork resume args wrong: ${JSON.stringify(parsedClaude)}`);
  }
  for (const helper of [
    'const WHOLE_LOCK_SCOPE',
    'function normalizeLockScope',
    'function scopedLockResource',
    'function lockBaseResource',
    'function lockScope',
    'function lockLabel',
    'function lockArgv',
    'function locksConflict'
  ]) {
    if (hccSource.includes(helper)) fail(`CLI still embeds lock helper: ${helper}`);
  }
  const locksModule = await import(path.join(repoRoot, 'lib', 'locks.mjs'));
  for (const name of [
    'normalizeLockScope',
    'scopedLockResource',
    'lockBaseResource',
    'lockScope',
    'lockLabel',
    'lockArgv',
    'locksConflict'
  ]) {
    if (typeof locksModule[name] !== 'function') fail(`locks module missing export: ${name}`);
  }
  const wholeLock = locksModule.scopedLockResource('bin/hcc.mjs', '');
  const scopedLock = locksModule.scopedLockResource('bin/hcc.mjs', 'provider-commands');
  if (wholeLock.resource !== 'bin/hcc.mjs' ||
      wholeLock.base_resource !== 'bin/hcc.mjs' ||
      wholeLock.scope !== '*') {
    fail(`locks module built wrong whole-resource lock: ${JSON.stringify(wholeLock)}`);
  }
  if (!scopedLock.resource.startsWith('scoped:') ||
      scopedLock.base_resource !== 'bin/hcc.mjs' ||
      scopedLock.scope !== 'provider-commands' ||
      locksModule.lockLabel(scopedLock) !== 'bin/hcc.mjs [provider-commands]') {
    fail(`locks module built wrong scoped lock: ${JSON.stringify(scopedLock)}`);
  }
  if (!locksModule.locksConflict(wholeLock, scopedLock) ||
      locksModule.locksConflict(scopedLock, locksModule.scopedLockResource('bin/hcc.mjs', 'tmux-helpers')) ||
      locksModule.locksConflict(scopedLock, locksModule.scopedLockResource('scripts/regression.mjs', 'provider-commands'))) {
    fail('locks module conflict behavior changed');
  }
  for (const helper of [
    'function splitCsvList',
    'function parseTeamItems',
    'function inferTeamItems',
    'function expandTeamWorkers',
    'function assignTeamWorkers'
  ]) {
    if (hccSource.includes(helper)) fail(`CLI still embeds team planning helper: ${helper}`);
  }
  const teamPlanning = await import(path.join(repoRoot, 'lib', 'team-planning.mjs'));
  for (const name of [
    'splitCsvList',
    'parseTeamItems',
    'inferTeamItems',
    'expandTeamWorkers',
    'assignTeamWorkers'
  ]) {
    if (typeof teamPlanning[name] !== 'function') fail(`team planning module missing export: ${name}`);
  }
  const splitTeam = teamPlanning.splitCsvList(['codex:2, claude-a', ' docs-a ']);
  if (JSON.stringify(splitTeam) !== JSON.stringify(['codex:2', 'claude-a', 'docs-a'])) {
    fail(`team planning splitCsvList changed: ${JSON.stringify(splitTeam)}`);
  }
  const parsedTeam = teamPlanning.parseTeamItems({
    item: ['docs:Update docs', 'codex-a:tests:Add: regression']
  });
  if (parsedTeam.length !== 2 ||
      parsedTeam[0].role !== 'docs' ||
      parsedTeam[0].title !== 'Update docs' ||
      parsedTeam[1].assignee !== 'codex-a' ||
      parsedTeam[1].role !== 'tests' ||
      parsedTeam[1].title !== 'Add:regression') {
    fail(`team planning parseTeamItems changed: ${JSON.stringify(parsedTeam)}`);
  }
  const inferredTeam = teamPlanning.inferTeamItems({ title: 'Parent task' }, { count: '0' });
  if (inferredTeam.length !== 1 || inferredTeam[0].title !== 'Parent task / subtask 1') {
    fail(`team planning count normalization changed: ${JSON.stringify(inferredTeam)}`);
  }
  try {
    teamPlanning.inferTeamItems({ title: 'Parent task' }, { count: 'not-a-number' });
    fail('team planning accepted non-integer count');
  } catch (err) {
    if (err?.code !== 'BAD_ARGS') throw err;
  }
  const expandedWorkers = teamPlanning.expandTeamWorkers(['Codex:2', 'claude-a'], 42);
  if (JSON.stringify(expandedWorkers) !== JSON.stringify(['codex-team-42-1', 'codex-team-42-2', 'claude-a'])) {
    fail(`team planning worker expansion changed: ${JSON.stringify(expandedWorkers)}`);
  }
  const assignedTeam = teamPlanning.assignTeamWorkers(parsedTeam, ['codex:2'], 42);
  if (assignedTeam[0].assignee !== 'codex-team-42-1' || assignedTeam[1].assignee !== 'codex-a') {
    fail(`team planning worker assignment changed: ${JSON.stringify(assignedTeam)}`);
  }
  const peerFormat = await import(path.join(repoRoot, 'lib', 'peer-format.mjs'));
  if (typeof peerFormat.sanitizePeerPart !== 'function' ||
      typeof peerFormat.shortHash !== 'function' ||
      peerFormat.sanitizePeerPart('Bad Peer!', 'fallback') !== 'bad-peer' ||
      peerFormat.sanitizePeerPart('!!!', 'fallback') !== 'fallback' ||
      peerFormat.shortHash('hello') !== 'aaf4c61d') {
    fail('peer format module behavior changed');
  }
  for (const [label, source] of [
    ['provider commands', fs.readFileSync(path.join(repoRoot, 'lib', 'provider-commands.mjs'), 'utf8')],
    ['team planning', fs.readFileSync(path.join(repoRoot, 'lib', 'team-planning.mjs'), 'utf8')],
    ['peer identity', fs.readFileSync(path.join(repoRoot, 'lib', 'peer-identity.mjs'), 'utf8')]
  ]) {
    if (!source.includes("from './peer-format.mjs'")) fail(`${label} module does not import peer format helpers`);
    if (source.includes('function sanitizePeerPart') || source.includes('function shortHash')) {
      fail(`${label} module still embeds peer format helpers`);
    }
  }
  for (const helper of [
    'function sanitizePeerPart',
    'function shortHash',
    'function currentTtyName',
    'function readProcCmdline',
    'function readProcEnv',
    'function readProcParentPid',
    'function argsLookLikeCli',
    'function detectCliKindFromProcess',
    'function readAncestorCliInfo',
    'function resumeIdFromArgs',
    'function autoPeerProviderSession',
    'function autoPeerSessionId',
    'function autoPeerResumeId',
    'function autoPeerKind',
    'function autoPeerBasis',
    'function autoPeerId',
    'function resolveCurrentPeer',
    'function currentPeer'
  ]) {
    if (hccSource.includes(helper)) fail(`CLI still embeds peer identity helper: ${helper}`);
  }
  const peerIdentity = await import(path.join(repoRoot, 'lib', 'peer-identity.mjs'));
  for (const name of [
    'sanitizePeerPart',
    'shortHash',
    'currentTtyName',
    'readAncestorCliInfo',
    'resumeIdFromArgs',
    'autoPeerProviderSession',
    'autoPeerSessionId',
    'autoPeerResumeId',
    'autoPeerKind',
    'autoPeerBasis',
    'autoPeerId',
    'resolveCurrentPeer',
    'currentPeer'
  ]) {
    if (typeof peerIdentity[name] !== 'function') fail(`peer identity module missing export: ${name}`);
  }
  if (peerIdentity.sanitizePeerPart('Bad Peer!', 'fallback') !== 'bad-peer' ||
      peerIdentity.sanitizePeerPart('!!!', 'fallback') !== 'fallback' ||
      peerIdentity.shortHash('hello') !== 'aaf4c61d') {
    fail('peer identity sanitize/hash behavior changed');
  }
  if (peerIdentity.resumeIdFromArgs('claude', ['claude', '--resume', 'named-session']) !== 'named-session' ||
      peerIdentity.resumeIdFromArgs('claude', ['claude', '--resume=inline-session']) !== 'inline-session' ||
      peerIdentity.resumeIdFromArgs('claude', ['claude', '--resume', 'named-session', '--fork-session']) !== null ||
      peerIdentity.resumeIdFromArgs('codex', ['codex', 'resume', 'codex-session']) !== 'codex-session' ||
      peerIdentity.resumeIdFromArgs('codex', ['codex', 'resume', '--last']) !== null) {
    fail('peer identity resume id parsing changed');
  }
  const savedPeerEnv = {
    HCC_PEER: process.env.HCC_PEER,
    CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
    CLAUDECODE: process.env.CLAUDECODE,
    CODEX_SESSION_ID: process.env.CODEX_SESSION_ID,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    CODEX_MANAGED_BY_NPM: process.env.CODEX_MANAGED_BY_NPM,
    CODEX_MANAGED_BY_BUN: process.env.CODEX_MANAGED_BY_BUN
  };
  try {
    process.env.HCC_PEER = 'env-peer';
    if (peerIdentity.resolveCurrentPeer({ root: repoRoot }, {}, 'peer', 'shell').id !== 'env-peer') {
      fail('peer identity resolveCurrentPeer ignored HCC_PEER');
    }
    delete process.env.HCC_PEER;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDECODE;
    process.env.CODEX_SESSION_ID = '0123456789abcdef';
    delete process.env.CODEX_THREAD_ID;
    delete process.env.CODEX_MANAGED_BY_NPM;
    delete process.env.CODEX_MANAGED_BY_BUN;
    const autoPeer = peerIdentity.resolveCurrentPeer({ root: repoRoot }, {}, 'peer', 'shell');
    if (!autoPeer.auto || autoPeer.id !== 'codex-01234567') {
      fail(`peer identity auto peer id changed: ${JSON.stringify(autoPeer)}`);
    }
    const explicitPeer = peerIdentity.resolveCurrentPeer({ root: repoRoot }, { peer: 'manual-peer' }, 'peer', 'shell');
    if (explicitPeer.auto || explicitPeer.id !== 'manual-peer') {
      fail(`peer identity explicit peer resolution changed: ${JSON.stringify(explicitPeer)}`);
    }
  } finally {
    for (const [key, value] of Object.entries(savedPeerEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  for (const helper of [
    'function projectRecord',
    'function readProjectRegistry',
    'function writeProjectRegistry',
    'function registerProject',
    'function registerProjectActivity'
  ]) {
    if (hccSource.includes(helper)) fail(`CLI still embeds project registry helper: ${helper}`);
  }
  const projectRegistry = await import(path.join(repoRoot, 'lib', 'project-registry.mjs'));
  for (const name of [
    'projectRecord',
    'readProjectRegistry',
    'writeProjectRegistry',
    'registerProject',
    'registerProjectActivity'
  ]) {
    if (typeof projectRegistry[name] !== 'function') fail(`project registry module missing export: ${name}`);
  }
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const registryRootA = path.join(root, 'registry-a');
    const registryRootB = path.join(root, 'registry-b');
    const written = projectRegistry.writeProjectRegistry([
      { root: registryRootA, db: '', name: '', last_seen_at: '5' },
      { root: registryRootB, db: path.join(registryRootB, 'custom.db'), name: 'Bee', last_seen_at: '10' },
      { root: registryRootA, db: path.join(registryRootA, 'new.db'), name: 'Aye', last_seen_at: '15' }
    ]);
    if (written.length !== 2 ||
        written[0].root !== path.resolve(registryRootA) ||
        written[0].db !== path.resolve(path.join(registryRootA, 'new.db')) ||
        written[0].name !== 'Aye' ||
        written[0].last_seen_at !== 15 ||
        written[1].root !== path.resolve(registryRootB)) {
      fail(`project registry write/dedupe/sort changed: ${JSON.stringify(written)}`);
    }
    const readBack = projectRegistry.readProjectRegistry();
    if (JSON.stringify(readBack) !== JSON.stringify(written)) {
      fail(`project registry read changed: ${JSON.stringify(readBack)} vs ${JSON.stringify(written)}`);
    }
    const recorded = projectRegistry.projectRecord({
      root: path.resolve(registryRootB),
      dbPath: path.join(registryRootB, 'mesh.db')
    }, () => 123);
    if (recorded.root !== path.resolve(registryRootB) ||
        recorded.db !== path.join(registryRootB, 'mesh.db') ||
        recorded.name !== 'registry-b' ||
        recorded.last_seen_at !== 123) {
      fail(`project registry record changed: ${JSON.stringify(recorded)}`);
    }
    const registered = projectRegistry.registerProject({
      root: path.resolve(registryRootB),
      dbPath: path.join(registryRootB, 'mesh.db')
    });
    if (registered[0].root !== path.resolve(registryRootB) ||
        registered.filter((p) => p.root === path.resolve(registryRootB)).length !== 1) {
      fail(`project registry register changed: ${JSON.stringify(registered)}`);
    }
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
  for (const helper of [
    'function runtimeBaseUrl',
    'function runtimeApiUrl',
    'function requestUrl',
    'function runtimeUrlQuery',
    'function makeWebToken',
    'function validateWebTokenOpts',
    'function expectedWebHost',
    'function webRuntimeMatchesRequest',
    'function publicRuntimeUrl',
    'function localRuntimeUrl'
  ]) {
    if (hccSource.includes(helper)) fail(`CLI still embeds web runtime helper: ${helper}`);
  }
  for (const helper of [
    'function readRequestBody',
    'function readJsonRequest',
    'function sendHttp',
    'function sendJson',
    'function sendFile',
    'function authOk'
  ]) {
    if (hccSource.includes(helper)) fail(`CLI still embeds web HTTP helper: ${helper}`);
  }
  if (hccSource.includes('new URL(req.url')) fail('CLI still embeds raw server request URL parsing');
  if (hccSource.includes('function webIndexHtml()')) fail('CLI still embeds the web UI template');
  const webRuntime = await import(path.join(repoRoot, 'lib', 'web-runtime.mjs'));
  const webHttp = await import(path.join(repoRoot, 'lib', 'web-http.mjs'));
  const webUiTemplate = await import(path.join(repoRoot, 'lib', 'web-ui-template.mjs'));
  const expectEqual = (actual, expected, label) => {
    if (actual !== expected) fail(`${label}: expected ${expected}, got ${actual}`);
  };
  const html = webUiTemplate.webIndexHtml();
  if (!html.includes('<!doctype html>') ||
      !html.includes('<div class="app">') ||
      !html.includes('<script src="/assets/xterm.js"></script>')) {
    fail('web UI template module did not render the expected shell HTML');
  }
  const jsonReq = Readable.from(['{"ok":true}']);
  jsonReq.headers = {};
  const parsedJson = await webHttp.readJsonRequest(jsonReq);
  if (parsedJson.ok !== true) fail(`web HTTP helper failed to parse JSON request: ${JSON.stringify(parsedJson)}`);
  const emptyReq = Readable.from(['']);
  emptyReq.headers = {};
  const parsedEmpty = await webHttp.readJsonRequest(emptyReq);
  if (Object.keys(parsedEmpty).length !== 0) fail(`web HTTP helper failed empty request fallback: ${JSON.stringify(parsedEmpty)}`);
  const mockRes = {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; }
  };
  webHttp.sendJson(mockRes, 202, { ok: true });
  if (mockRes.status !== 202 ||
      mockRes.headers?.['Content-Type'] !== 'application/json; charset=utf-8' ||
      mockRes.headers?.['Cache-Control'] !== 'no-store' ||
      !mockRes.body.includes('"ok": true')) {
    fail(`web HTTP helper failed sendJson response: ${JSON.stringify(mockRes)}`);
  }
  if (!webHttp.authOk(new URL('http://example.test/?token=tok'), { headers: {} }, 'tok') ||
      !webHttp.authOk(new URL('http://example.test/'), { headers: { authorization: 'Bearer tok' } }, 'tok') ||
      webHttp.authOk(new URL('http://example.test/?token=bad'), { headers: {} }, 'tok')) {
    fail('web HTTP helper authOk token checks failed');
  }
  const wildcardRuntime = { host: '0.0.0.0', port: 8787, token: 'tok' };
  const ipv6WildcardRuntime = { host: '::', port: 8788, token: 'tok' };
  const localRuntime = { host: '127.0.0.1', port: 8789, token: 'tok' };
  expectEqual(webRuntime.runtimeBaseUrl('0.0.0.0', 8787), 'http://127.0.0.1:8787', 'runtimeBaseUrl 0.0.0.0');
  expectEqual(webRuntime.runtimeBaseUrl('::', 8788), 'http://127.0.0.1:8788', 'runtimeBaseUrl ::');
  expectEqual(String(webRuntime.runtimeApiUrl({ base_url: 'http://127.0.0.1:8787/base' }, '/api/state?peer=a b')), 'http://127.0.0.1:8787/api/state?peer=a%20b', 'runtimeApiUrl route');
  expectEqual(String(webRuntime.requestUrl({ url: '/api/state?peer=a b', headers: { host: 'example.test:8787' } })), 'http://example.test:8787/api/state?peer=a%20b', 'requestUrl host and query');
  expectEqual(String(webRuntime.requestUrl({ url: '', headers: {} })), 'http://localhost/', 'requestUrl fallback');
  expectEqual(webRuntime.publicRuntimeUrl(wildcardRuntime, '/tmp/hcc project'), 'http://<machine-ip>:8787/?token=tok&project=%2Ftmp%2Fhcc%20project', 'publicRuntimeUrl wildcard');
  expectEqual(webRuntime.localRuntimeUrl(wildcardRuntime, '/tmp/hcc project'), 'http://127.0.0.1:8787/?token=tok&project=%2Ftmp%2Fhcc%20project', 'localRuntimeUrl wildcard');
  expectEqual(webRuntime.publicRuntimeUrl(ipv6WildcardRuntime, '/tmp/hcc project'), 'http://<machine-ip>:8788/?token=tok&project=%2Ftmp%2Fhcc%20project', 'publicRuntimeUrl ipv6 wildcard');
  expectEqual(webRuntime.localRuntimeUrl(localRuntime, null), 'http://127.0.0.1:8789/?token=tok', 'localRuntimeUrl no project');
  const mainHelp = run(process.execPath, [hccBin, '--help']);
  if (mainHelp.includes('setup') || mainHelp.includes('--web-managed')) {
    fail(`public help exposes maintenance or removed commands:\n${mainHelp}`);
  }
  if (!mainHelp.includes('  update                       Update the global npm install of hello-cc')) {
    fail(`main help missing update command:\n${mainHelp}`);
  }
  if (!mainHelp.includes('  state [--peer ID]            Show timeline and next coordination action')) {
    fail(`main help missing state command:\n${mainHelp}`);
  }
  if (!mainHelp.includes('  team <subcommand>            Plan, start, and inspect explicit task teams')) {
    fail(`main help missing team command:\n${mainHelp}`);
  }
  if (!mainHelp.includes('  uninstall                    Remove hooks, shims, and optional project data')) {
    fail(`main help missing uninstall command:\n${mainHelp}`);
  }
  const msgHelp = run(process.execPath, [hccBin, 'msg', '--help']);
  if (!msgHelp.includes('msg reply') || !msgHelp.includes('msg thread')) {
    fail(`msg help missing reply/thread commands:\n${msgHelp}`);
  }
  const taskHelp = run(process.execPath, [hccBin, 'task', '--help']);
  if (!taskHelp.includes('task next [--peer ID] [--force]') ||
      !taskHelp.includes('[--count N]') ||
      !taskHelp.includes('existing claimed/running/review/blocked task') ||
      !taskHelp.includes('task takeover [--peer ID] --id N --reason TEXT') ||
      !taskHelp.includes('[--policy any|blocked|stale|blocked-or-stale]') ||
      !taskHelp.includes('task claim [--peer ID] --id N[,N]') ||
      !taskHelp.includes('task create --title TEXT --parent N')) {
    fail(`task help missing current-task task next semantics:\n${taskHelp}`);
  }
  const teamHelp = run(process.execPath, [hccBin, 'team', '--help']);
  if (!teamHelp.includes('hcc team') || !teamHelp.includes('team plan') || !teamHelp.includes('team start') || !teamHelp.includes('team status')) {
    fail(`team help missing expected content:\n${teamHelp}`);
  }
  const stateHelp = run(process.execPath, [hccBin, 'state', '--help']);
  if (!stateHelp.includes('hcc state') ||
      !stateHelp.includes('--scope SCOPE') ||
      !stateHelp.includes('--intent read|review|work|write|stop|finish') ||
      !stateHelp.includes('automation.next_action.argv') ||
      !stateHelp.includes('automation.current_task') ||
      !stateHelp.includes('hcc team plan')) {
    fail(`state help missing expected content:\n${stateHelp}`);
  }
  const lockHelp = run(process.execPath, [hccBin, 'lock', '--help']);
  if (!lockHelp.includes('--scope SCOPE') || !lockHelp.toLowerCase().includes('different scopes on the same resource')) {
    fail(`lock help missing scoped lock content:\n${lockHelp}`);
  }
  const updateHelp = run(process.execPath, [hccBin, 'update', '--help']);
  if (!updateHelp.includes('hcc update') || !updateHelp.includes('npm install -g @logicseek/hello-cc@TAG')) {
    fail(`update help missing expected content:\n${updateHelp}`);
  }
  const uninstallHelp = run(process.execPath, [hccBin, 'uninstall', '--help']);
  if (!uninstallHelp.includes('hcc uninstall') || !uninstallHelp.includes('hcc uninstall [--purge --yes]')) {
    fail(`uninstall help missing expected content:\n${uninstallHelp}`);
  }
  const updateDryRun = run(process.execPath, [hccBin, 'update', '--dry-run']);
  if (!updateDryRun.includes('would run: npm install -g @logicseek/hello-cc@latest')) {
    fail(`update dry-run output wrong:\n${updateDryRun}`);
  }
  const updateJson = JSON.parse(run(process.execPath, [hccBin, '--json', 'update', '--dry-run', '--tag', '0.1.2']));
  if (!updateJson.ok || updateJson.data.command !== 'npm install -g @logicseek/hello-cc@0.1.2') {
    fail(`update json dry-run output wrong:\n${JSON.stringify(updateJson)}`);
  }
  const updateBuildJson = JSON.parse(run(process.execPath, [hccBin, '--json', 'update', '--dry-run', '--tag', '1.2.3+build.1']));
  if (!updateBuildJson.ok || updateBuildJson.data.command !== 'npm install -g @logicseek/hello-cc@1.2.3+build.1') {
    fail(`update build-metadata dry-run output wrong:\n${JSON.stringify(updateBuildJson)}`);
  }
  const runHelp = run(process.execPath, [hccBin, 'run', '--help']);
  if (runHelp.includes('--web-managed')) fail(`run help exposes removed --web-managed:\n${runHelp}`);
  const subcommandHelpCases = [
    ['task', 'done', 'hcc task done'],
    ['msg', 'reply', 'hcc msg reply'],
    ['peer', 'attach', 'peer attach'],
    ['lock', 'release', 'hcc lock release'],
    ['handoff', 'create', 'hcc handoff create'],
    ['event', 'tail', 'hcc event tail']
  ];
  for (const [group, subcommand, expected] of subcommandHelpCases) {
    const help = run(process.execPath, [hccBin, group, subcommand, '--help']);
    if (!help.includes(expected)) {
      fail(`${group} ${subcommand} help missing expected content:\n${help}`);
    }
  }
  const removed = runMaybe(process.execPath, [hccBin, '--root', root, 'run', '--peer', 'bad', '--kind', 'shell', '--web-managed', '--', 'bash']);
  if (removed.status === 0 || !String(removed.stderr || removed.stdout).includes('unknown option --web-managed')) {
    fail(`run --web-managed was not rejected:\n${removed.stdout}\n${removed.stderr}`);
  }
  run('npm', ['run', 'smoke']);
}

function uninstallWorkflow() {
  log('[12/12] maintenance cleanup');
  const uninstallRoot = path.join(os.tmpdir(), `hcc-reg-uninstall-root-${testId}`);
  const uninstallHome = path.join(os.tmpdir(), `hcc-reg-uninstall-home-${testId}`);
  fs.mkdirSync(uninstallRoot, { recursive: true });
  fs.mkdirSync(uninstallHome, { recursive: true });
  const uninstallEnv = {
    ...env,
    HOME: uninstallHome,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`
  };

  run(process.execPath, [hccBin, '--root', uninstallRoot, 'setup', '--quiet'], { env: uninstallEnv });
  ensureFile(path.join(uninstallRoot, '.hello-cc', 'mesh.db'));
  ensureFile(path.join(uninstallRoot, '.hello-cc', 'HCC.md'));
  ensureFile(path.join(uninstallRoot, 'CLAUDE.md'));
  ensureFile(path.join(uninstallRoot, 'AGENTS.md'));
  assertGuidanceLockPolicy(path.join(uninstallRoot, '.hello-cc', 'HCC.md'));
  assertGuidanceLockPolicy(path.join(uninstallRoot, 'CLAUDE.md'));
  assertGuidanceLockPolicy(path.join(uninstallRoot, 'AGENTS.md'));
  ensureFile(path.join(uninstallHome, '.claude', 'settings.json'));
  ensureFile(path.join(uninstallHome, '.codex', 'hooks.json'));
  ensureFile(path.join(uninstallHome, '.hcc-shims', 'claude'));

  const kept = run(process.execPath, [hccBin, '--root', uninstallRoot, 'uninstall'], { env: uninstallEnv });
  if (!kept.includes('project data kept')) fail(`uninstall did not keep project data by default:\n${kept}`);
  if (!fs.existsSync(path.join(uninstallRoot, '.hello-cc', 'mesh.db'))) fail('default uninstall removed project db');
  if (fs.existsSync(path.join(uninstallHome, '.hcc-shims', 'claude'))) fail('default uninstall did not remove shim');
  if (!run(process.execPath, [hccBin, '--root', uninstallRoot, 'install-hooks', '--status'], { env: uninstallEnv }).includes('claude=no codex=no')) {
    fail('default uninstall did not remove hooks');
  }

  run(process.execPath, [hccBin, '--root', uninstallRoot, 'setup', '--quiet'], { env: uninstallEnv });
  const refused = runMaybe(process.execPath, [hccBin, '--root', uninstallRoot, 'uninstall', '--purge'], { env: uninstallEnv });
  if (refused.status === 0 || !String(refused.stderr || refused.stdout).includes('without --yes')) {
    fail(`purge without --yes was not refused:\n${refused.stdout}\n${refused.stderr}`);
  }
  const purged = run(process.execPath, [hccBin, '--root', uninstallRoot, 'uninstall', '--purge', '--yes'], { env: uninstallEnv });
  if (!purged.includes('project data removed')) fail(`purge output wrong:\n${purged}`);
  if (fs.existsSync(path.join(uninstallRoot, '.hello-cc'))) fail('purge did not remove .hello-cc');
  for (const file of ['CLAUDE.md', 'AGENTS.md']) {
    const p = path.join(uninstallRoot, file);
    const text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    if (text.includes('hello-cc:start')) fail(`${file} still has hello-cc block after purge`);
  }

  try { fs.rmSync(uninstallRoot, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(uninstallHome, { recursive: true, force: true }); } catch {}
}

async function main() {
  process.once('SIGINT', () => { cleanup(); process.exit(130); });
  process.once('SIGTERM', () => { cleanup(); process.exit(143); });

  await setupRegression();
  log('[2/12] runtime');
  startRuntime();
  await waitRuntime();
  hcc(['peer', 'list']);
  await dbWorkflow();
  await multiProjectWebWorkflow();
  await tmuxBackedStartWorkflow();
  await shimTmuxWorkflow();
  await tmuxWorkflow();
  await askBroadcastWorkflow();
  await downGcPackWorkflow();
  oldNameScan();
  await syntaxAndHelp();
  uninstallWorkflow();
  log('FULL_REGRESSION_OK');
}

main().catch((err) => {
  cleanup();
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exit(1);
}).finally(() => {
  cleanup();
});
