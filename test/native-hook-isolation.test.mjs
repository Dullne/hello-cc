import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { initSchema } from '../lib/db/schema.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hccBin = path.join(repoRoot, 'bin', 'hcc.mjs');

function fixture(t, provider) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-native-hook-'));
  const root = path.join(dir, 'project');
  const outside = path.join(dir, 'other-cwd');
  const home = path.join(dir, 'home');
  for (const directory of [root, outside, home, path.join(root, '.hello-cc')]) fs.mkdirSync(directory, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(root, '.hello-cc', 'worker-mesh.db');
  const db = new DatabaseSync(dbPath);
  t.after(() => db.close());
  initSchema(db);
  const peer = `${provider}-owned-worker`;
  const owner = `native:test-generation:${peer}`;
  db.prepare(`INSERT INTO peers(id,kind,role,worktree,branch,pid,pid_start_token,pid_command_hash,status,capabilities,created_at,last_seen_at)
    VALUES (?,?,'native-worker',?,'owner-branch',321,'owner-start',?,'working','owner-capabilities',1,1)`)
    .run(peer, provider, root, 'a'.repeat(64));
  db.prepare(`INSERT INTO peer_bindings(peer,provider,provider_session_id,provider_session_name,resume_mode,resume_arg,command,transport,runtime_session_id,runtime_target,created_at,updated_at)
    VALUES (?,?,'owned-provider-session',NULL,'resume','owned-provider-session',NULL,'native',?,?,1,1)`)
    .run(peer, provider, peer, owner);
  db.prepare("INSERT INTO messages(sender,recipient,body,created_at) VALUES ('human',?,'native-inbox-must-stay-unread',1)").run(peer);
  db.prepare("INSERT INTO locks(resource,base_resource,owner,expires_at,created_at,ttl_sec) VALUES ('src/owned.js','src/owned.js',?,1,1,60)").run(peer);
  const env = {
    ...process.env, HOME: home, HCC_RUNTIME_URL: '',
    HCC_ROOT: root, HCC_DB: dbPath, HCC_PEER: peer, HCC_NATIVE_OWNER: owner
  };
  const read = (table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((row) => ({ ...row }));
  const run = (event, overrides = {}) => spawnSync(process.execPath, [hccBin, 'hook', event, '--provider', provider], {
    cwd: outside, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10_000,
    input: JSON.stringify({ session_id: 'hook-child-session', cwd: outside, hook_event_name: event })
  });
  return { root, outside, home, db, dbPath, peer, owner, env, read, run };
}

for (const provider of ['claude', 'codex', 'dsh']) {
  test(`${provider} native hooks only heartbeat their owner and renew locks`, (t) => {
    const f = fixture(t, provider);
    const originalPeer = f.read('peers')[0];
    const originalBinding = f.read('peer_bindings');
    const originalMessages = f.read('messages');
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) {
      const result = f.run(event);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '', `${event} must not inject inbox or block Stop`);
      assert.deepEqual(f.read('peer_bindings'), originalBinding);
      assert.deepEqual(f.read('messages'), originalMessages);
      assert.deepEqual(f.read('message_reads'), []);
      const peer = f.read('peers')[0];
      assert.ok(peer.last_seen_at > 1);
      assert.deepEqual({ ...peer, last_seen_at: originalPeer.last_seen_at }, originalPeer,
        'runtime process identity, working status, role, and capabilities must remain owned by the native host');
      assert.ok(f.read('locks')[0].expires_at > Math.floor(Date.now() / 1000));
    }
    assert.equal(fs.existsSync(path.join(f.root, '.hello-cc', 'mesh.db')), false, 'hook must honor the owned custom database');
    assert.equal(fs.existsSync(path.join(f.outside, '.hello-cc')), false, 'payload cwd must not register a second native worker');
    assert.equal(fs.existsSync(path.join(f.home, '.hello-cc', 'projects.json')), false, 'native heartbeat must not register project activity');
    assert.ok(f.read('events').every((event) => event.type === 'lock.renewed_by_hook'));
  });
}

for (const [name, mutate, env] of [
  ['stale owner marker', () => {}, { HCC_NATIVE_OWNER: 'native:old-generation:claude-owned-worker' }],
  ['terminal transport', (f) => f.db.prepare("UPDATE peer_bindings SET transport='tmux'").run(), {}],
  ['provider mismatch', (f) => f.db.prepare("UPDATE peer_bindings SET provider='codex'").run(), {}],
  ['missing owned peer', () => {}, { HCC_PEER: 'not-registered' }],
  ['missing explicit database', () => {}, { HCC_DB: '' }]
]) {
  test(`native hooks reject ${name} without provider binding, inbox, or lease writes`, (t) => {
    const f = fixture(t, 'claude');
    mutate(f);
    const before = Object.fromEntries(['peers', 'peer_bindings', 'messages', 'message_reads', 'locks', 'events'].map((table) => [table, f.read(table)]));
    const result = f.run('Stop', env);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Native hook/);
    assert.equal(result.stdout, '');
    for (const [table, rows] of Object.entries(before)) assert.deepEqual(f.read(table), rows, table);
  });
}

test('native hook cannot create a database merely from inherited owner markers', (t) => {
  const f = fixture(t, 'claude');
  const missingDb = path.join(f.root, '.hello-cc', 'missing-owned.db');
  const result = f.run('SessionStart', { HCC_DB: missingDb });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(fs.existsSync(missingDb), false);
  assert.equal(f.read('peers')[0].last_seen_at, 1);
});
