import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { initSchema, readSchemaVersion } from '../lib/db/schema.mjs';
import { providerSessionPeerId } from '../lib/core/peers/session.mjs';
import { bindingHasRuntime } from '../lib/core/peers/bindings.mjs';
import { resolvePeerEvidence } from '../lib/core/peers/evidence.mjs';
import { validateTmuxGcBindingEvidence } from '../lib/core/peers/tmux-safety.mjs';
import { buildPeerCommand, defaultSessionCommand, inferPeerKind } from '../lib/integrations/providers.mjs';
import { argsLookLikeDsh, findLinuxAncestorCliInfo, findMacAncestorCliInfo } from '../lib/integrations/peers/identity.mjs';
import { inspectProviderProcess } from '../lib/integrations/peers/processes.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hccBin = path.join(repoRoot, 'bin', 'hcc.mjs');

function fixture(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-dsh-hooks-'));
  const root = path.join(sandbox, 'project-a');
  const secondRoot = path.join(sandbox, 'project-b');
  const foreignRoot = path.join(sandbox, 'server-project');
  const home = path.join(sandbox, 'home');
  for (const dir of [root, secondRoot, foreignRoot, home]) fs.mkdirSync(dir, { recursive: true });
  const foreignDb = path.join(foreignRoot, 'foreign.db');
  fs.writeFileSync(foreignDb, 'foreign database must stay untouched');
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const env = {
    ...process.env,
    HOME: home,
    HCC_RUNTIME_URL: '',
    HCC_PEER: 'server-inherited-peer',
    HCC_ROOT: foreignRoot,
    HCC_DB: foreignDb,
    CLAUDE_CODE_SESSION_ID: 'unrelated-claude-session',
    CLAUDECODE: '1',
    CODEX_SESSION_ID: 'unrelated-codex-session',
    CODEX_THREAD_ID: 'unrelated-codex-thread'
  };
  const run = (args, payload) => spawnSync(process.execPath, [hccBin, ...args], {
    cwd: foreignRoot,
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env,
    timeout: 10_000
  });
  return { sandbox, root, secondRoot, foreignRoot, foreignDb, home, env, run };
}

function rows(root, sql, ...args) {
  const db = new DatabaseSync(path.join(root, '.hello-cc', 'mesh.db'), { readOnly: true });
  try { return db.prepare(sql).all(...args).map((row) => ({ ...row })); }
  finally { db.close(); }
}

function seedBindingConflict(f, peer, binding) {
  const dbPath = path.join(f.root, '.hello-cc', 'mesh.db');
  fs.mkdirSync(path.dirname(dbPath));
  const db = new DatabaseSync(dbPath);
  try {
    initSchema(db);
    db.prepare(`
      INSERT INTO peers(id, kind, role, worktree, branch, pid, pid_start_token,
        pid_command_hash, status, capabilities, created_at, last_seen_at)
      VALUES (?, 'dsh', 'original-owner', ?, 'original-branch', 123, 'original-start', ?, 'running', 'original-capability', 1, 1)
    `).run(peer, f.root, 'a'.repeat(64));
    db.prepare(`
      INSERT INTO peer_bindings(peer, provider, provider_session_id, provider_session_name,
        resume_mode, command, transport, runtime_session_id, runtime_target, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'detected', 'original-command', ?, ?, ?, 1, 1)
    `).run(peer, binding.provider || 'dsh', binding.sessionId || null, binding.sessionName || null,
      binding.transport || 'hook', peer, binding.runtimeTarget || null);
    db.prepare("INSERT INTO tasks(title, status, owner, created_by, created_at, updated_at) VALUES ('preserved-task', 'running', ?, ?, 1, 1)").run(peer, peer);
    db.prepare("INSERT INTO locks(resource, base_resource, owner, expires_at, created_at, ttl_sec) VALUES ('preserved-lock', 'preserved-lock', ?, 1, 1, 60)").run(peer);
    db.prepare("INSERT INTO messages(sender, recipient, body, created_at) VALUES ('human', ?, 'unread-preserved-message', 1)").run(peer);
    db.prepare("INSERT INTO events(type, actor, payload, created_at) VALUES ('original-binding-evidence', ?, '{}', 1)").run(peer);
  } finally { db.close(); }
}

function identityRows(root) {
  return Object.fromEntries(['peers', 'peer_bindings', 'tasks', 'locks', 'messages', 'message_reads', 'events']
    .map((table) => [table, rows(root, `SELECT * FROM ${table} ORDER BY rowid`)]));
}

test('two dsh sessions share one service process while routing identity, context, and restoration per workspace', (t) => {
  const f = fixture(t);
  const sessionA = 'session_dsh_opaque_A';
  const sessionB = 'session_dsh_opaque_B';
  const peerA = providerSessionPeerId('dsh', sessionA);
  const peerB = providerSessionPeerId('dsh', sessionB);
  const runtimeEntry = path.join(f.sandbox, 'node_modules', 'dsh', 'lib', 'bin.js');
  fs.mkdirSync(path.dirname(runtimeEntry), { recursive: true });
  fs.writeFileSync(runtimeEntry, `
    const { spawnSync } = require('node:child_process');
    const { DatabaseSync } = require('node:sqlite');
    const [hcc, root, secondRoot, sessionA, sessionB, peerA, peerB] = process.argv.slice(2);
    const outputs = [];
    function hook(event, session, cwd) {
      const result = spawnSync(process.execPath, [hcc, 'hook', event, '--provider', 'dsh'], {
        cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 10000,
        input: JSON.stringify({ session_id: session, cwd, hook_event_name: event })
      });
      if (result.status !== 0) throw new Error(result.stderr || String(result.error));
      outputs.push(JSON.parse(result.stdout));
    }
    hook('SessionStart', sessionA, root);
    hook('SessionStart', sessionB, root);
    const db = new DatabaseSync(root + '/.hello-cc/mesh.db');
    const now = Math.floor(Date.now() / 1000);
    db.prepare("INSERT INTO messages(sender, recipient, kind, body, created_at) VALUES ('human', ?, 'note', 'message-only-for-session-A', ?)").run(peerA, now);
    db.prepare("INSERT INTO tasks(title, status, assignee, owner, created_by, created_at, updated_at) VALUES ('task-for-session-A', 'running', ?, ?, 'human', ?, ?)").run(peerA, peerA, now, now);
    db.prepare("INSERT INTO locks(resource, base_resource, scope, owner, reason, expires_at, created_at, ttl_sec) VALUES ('src/shared.js', 'src/shared.js', '*', ?, 'session-A-owns-lock', ?, ?, 900)").run(peerA, now + 900, now);
    db.close();
    hook('UserPromptSubmit', sessionB, root);
    hook('UserPromptSubmit', sessionA, root);
    hook('SessionStart', sessionA, root);
    hook('SessionStart', sessionA, secondRoot);
    console.log(JSON.stringify({ pid: process.pid, outputs }));
  `);
  const worker = spawnSync(process.execPath, [runtimeEntry, hccBin, f.root, f.secondRoot, sessionA, sessionB, peerA, peerB], {
    cwd: f.foreignRoot, env: f.env, encoding: 'utf8', timeout: 30_000
  });
  assert.equal(worker.status, 0, worker.stderr);
  const { pid, outputs } = JSON.parse(worker.stdout);
  const peers = rows(f.root, 'SELECT id, kind, worktree, pid, pid_start_token, pid_command_hash FROM peers ORDER BY id');
  assert.equal(peers.length, 2);
  assert.deepEqual(peers.map((peer) => peer.id).sort(), [peerA, peerB].sort());
  for (const peer of peers) {
    assert.equal(peer.kind, 'dsh');
    assert.equal(peer.worktree, f.root);
    if (['linux', 'darwin'].includes(process.platform)) {
      assert.equal(peer.pid, pid, 'hook must observe the dsh runtime past inherited Claude/Codex shell env');
      assert.ok(peer.pid_start_token);
      assert.match(peer.pid_command_hash, /^[a-f0-9]{64}$/);
    }
  }
  const bindings = rows(f.root, 'SELECT * FROM peer_bindings ORDER BY peer');
  assert.deepEqual(bindings.map((b) => b.provider_session_id).sort(), [sessionA, sessionB].sort());
  for (const binding of bindings) {
    assert.equal(binding.provider_session_name, null);
    assert.equal(binding.transport, 'hook');
    assert.equal(binding.runtime_target, null);
    assert.equal(bindingHasRuntime(binding), false);
    assert.deepEqual(validateTmuxGcBindingEvidence({ ...binding, owner_evidence: { state: 'live' } }), {
      ok: false, reason: 'tmux_binding_subject_incomplete'
    });
  }
  const text = (index) => outputs[index].hookSpecificOutput.additionalContext;
  assert.match(text(2), new RegExp(peerA));
  assert.match(text(2), /task-for-session-A/);
  assert.match(text(2), /src\/shared\.js/);
  assert.doesNotMatch(text(2), /message-only-for-session-A/);
  assert.match(text(3), /message-only-for-session-A/);
  assert.match(text(3), /task-for-session-A/);
  assert.doesNotMatch(text(4), /message-only-for-session-A/);
  assert.deepEqual(rows(f.root, 'SELECT peer FROM message_reads'), [{ peer: peerA }]);
  assert.deepEqual(rows(f.secondRoot, 'SELECT id, kind, worktree FROM peers'), [{ id: peerA, kind: 'dsh', worktree: f.secondRoot }]);
  assert.equal(fs.existsSync(path.join(f.foreignRoot, '.hello-cc')), false);
  assert.equal(fs.readFileSync(f.foreignDb, 'utf8'), 'foreign database must stay untouched');
});

for (const [name, change] of [
  ['missing session', { session_id: undefined }],
  ['numeric session', { session_id: 42 }],
  ['empty session', { session_id: '' }],
  ['control character session', { session_id: 'bad\nsession' }],
  ['missing cwd', { cwd: undefined }],
  ['relative cwd', { cwd: 'relative-project' }],
  ['numeric cwd', { cwd: 42 }],
  ['missing directory', { cwd: '/hcc-dsh-test-no-such-directory' }],
  ['invalid event', { hook_event_name: { event: 'SessionStart' } }]
]) {
  test(`dsh rejects ${name} before project writes`, (t) => {
    const f = fixture(t);
    const result = f.run(['hook', 'SessionStart', '--provider', 'dsh'], {
      session_id: 'valid-session', cwd: f.root, ...change
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /dsh hook/);
    assert.equal(fs.existsSync(path.join(f.root, '.hello-cc')), false);
    assert.equal(fs.existsSync(path.join(f.foreignRoot, '.hello-cc')), false);
    assert.equal(fs.existsSync(path.join(f.home, '.hello-cc')), false);
    assert.equal(fs.readFileSync(f.foreignDb, 'utf8'), 'foreign database must stay untouched');
  });
}

test('dsh rejects malformed JSON and hook provider options without falling back to inherited identity', (t) => {
  const f = fixture(t);
  for (const [args, payload] of [
    [['hook', 'SessionStart', '--provider', 'dsh'], '{'],
    [['hook', 'SessionStart', '--provider', 'dsh'], 'null'],
    [['hook', 'SessionStart', '--provider', 'dsh'], '[]'],
    [['hook', 'SessionStart', '--provider', 'unknown'], '{}'],
    [['hook', 'SessionStart', '--provider'], '{}'],
    [['hook', 'SessionStart', '--provider', 'dsh', '--unexpected', 'x'], '{}']
  ]) {
    const result = f.run(args, payload);
    assert.equal(result.status, 1, result.stderr);
  }
  assert.equal(fs.existsSync(path.join(f.root, '.hello-cc')), false);
  assert.equal(fs.existsSync(path.join(f.foreignRoot, '.hello-cc')), false);
  assert.equal(fs.existsSync(path.join(f.home, '.hello-cc')), false);
});

test('dsh refuses a workspace state directory or DB symlink before writing the foreign target', (t) => {
  if (process.platform === 'win32') { t.skip('symlink creation requires platform privileges'); return; }
  const f = fixture(t);
  fs.symlinkSync(f.foreignRoot, path.join(f.root, '.hello-cc'), 'dir');
  let result = f.run(['hook', 'SessionStart', '--provider', 'dsh'], { session_id: 'symlink-check', cwd: f.root });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /state directory must be a real directory/);
  assert.equal(fs.existsSync(path.join(f.foreignRoot, 'mesh.db')), false);
  fs.unlinkSync(path.join(f.root, '.hello-cc'));
  fs.mkdirSync(path.join(f.root, '.hello-cc'));
  fs.symlinkSync(f.foreignDb, path.join(f.root, '.hello-cc', 'mesh.db'));
  result = f.run(['hook', 'SessionStart', '--provider', 'dsh'], { session_id: 'symlink-check', cwd: f.root });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /database must be a regular file/);
  assert.equal(fs.readFileSync(f.foreignDb, 'utf8'), 'foreign database must stay untouched');
  assert.equal(fs.existsSync(path.join(f.home, '.hello-cc')), false);
});

test('dsh hooks do not migrate another registered project database', (t) => {
  const f = fixture(t);
  const foreignProjectDb = path.join(f.secondRoot, '.hello-cc', 'mesh.db');
  fs.mkdirSync(path.dirname(foreignProjectDb));
  const db = new DatabaseSync(foreignProjectDb);
  initSchema(db);
  db.prepare("UPDATE meta SET value = '6' WHERE key = 'schema_version'").run();
  db.prepare('DELETE FROM schema_migrations WHERE version > 6').run();
  db.exec('PRAGMA user_version = 6');
  assert.equal(readSchemaVersion(db), 6);
  db.close();
  const original = fs.readFileSync(foreignProjectDb);
  fs.mkdirSync(path.join(f.home, '.hello-cc'));
  fs.writeFileSync(path.join(f.home, '.hello-cc', 'projects.json'), JSON.stringify({ projects: [{
    root: f.secondRoot, db: foreignProjectDb, name: 'project-b', last_seen_at: 1
  }] }));
  const result = f.run(['hook', 'SessionStart', '--provider', 'dsh'], { session_id: 'no-migration', cwd: f.root });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(foreignProjectDb), original);
  assert.deepEqual(fs.readdirSync(path.dirname(foreignProjectDb)), ['mesh.db']);
});

for (const conflict of [
  { name: 'same-peer tmux ownership', transport: 'tmux', runtimeTarget: '%12', reason: 'runtime_binding' },
  { name: 'same-peer non-hook run binding', transport: 'hcc-run', reason: 'runtime_binding' },
  { name: 'same-peer hook with a runtime target', runtimeTarget: '%12', reason: 'runtime_binding' },
  { name: 'same-peer foreign provider', provider: 'claude', reason: 'binding_provider_mismatch' },
  { name: 'session ID bound to another alias', alias: 'dsh-legacy-alias', reason: 'session_bound_to_another_peer' },
  { name: 'session name bound to a tmux alias', alias: 'dsh-legacy-tmux', sessionName: true, transport: 'tmux', runtimeTarget: '%12', reason: 'session_bound_to_another_peer' }
]) {
  test(`dsh hook rejects ${conflict.name} before changing owner, bindings, or coordination rows`, (t) => {
    const f = fixture(t);
    const sessionId = 'dsh-conflicting-session';
    const incomingPeer = providerSessionPeerId('dsh', sessionId);
    const boundPeer = conflict.alias || incomingPeer;
    seedBindingConflict(f, boundPeer, {
      ...conflict,
      sessionId: conflict.sessionName ? null : sessionId,
      sessionName: conflict.sessionName ? sessionId : null
    });
    const before = identityRows(f.root);
    const result = f.run(['--json', 'hook', 'SessionStart', '--provider', 'dsh'], { session_id: sessionId, cwd: f.root });
    assert.equal(result.status, 1, result.stderr);
    const error = JSON.parse(result.stderr).error;
    assert.equal(error.code, 'DSH_PEER_BINDING_CONFLICT');
    assert.equal(error.peer, incomingPeer);
    assert.equal(error.bound_peer, boundPeer);
    assert.equal(error.reason, conflict.reason);
    assert.deepEqual(identityRows(f.root), before);
    assert.equal(fs.readFileSync(f.foreignDb, 'utf8'), 'foreign database must stay untouched');
  });
}

test('dsh hook rejects an actual peer hash collision while preserving the original real session', (t) => {
  const f = fixture(t);
  // These distinct IDs collide under the existing eight-character SHA-1 peer
  // contract. The full provider ID must prevent them from becoming one owner.
  const originalSession = 'dsh-collision-4841';
  const incomingSession = 'dsh-collision-9414';
  const peer = providerSessionPeerId('dsh', originalSession);
  assert.equal(providerSessionPeerId('dsh', incomingSession), peer);
  seedBindingConflict(f, peer, { sessionId: originalSession });
  const before = identityRows(f.root);
  const result = f.run(['--json', 'hook', 'SessionStart', '--provider', 'dsh'], { session_id: incomingSession, cwd: f.root });
  assert.equal(result.status, 1, result.stderr);
  const error = JSON.parse(result.stderr).error;
  assert.equal(error.code, 'DSH_PEER_BINDING_CONFLICT');
  assert.equal(error.reason, 'session_id_mismatch');
  assert.deepEqual(identityRows(f.root), before);
  assert.equal(rows(f.root, 'SELECT provider_session_id FROM peer_bindings WHERE peer = ?', peer)[0].provider_session_id, originalSession);
});

test('ordinary Claude hooks retain explicit HCC_PEER and HCC_ROOT routing', (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [hccBin, 'hook', 'SessionStart'], {
    cwd: f.root, encoding: 'utf8', timeout: 10_000,
    env: { ...f.env, HCC_DB: '' },
    input: JSON.stringify({ session_id: 'claude-hook-session', cwd: f.root, hook_event_name: 'SessionStart' })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /server-inherited-peer/);
  assert.deepEqual(rows(f.foreignRoot, 'SELECT id, kind, worktree FROM peers'), [{
    id: 'server-inherited-peer', kind: 'claude', worktree: f.root
  }]);
  assert.equal(fs.existsSync(path.join(f.root, '.hello-cc')), false);
});

test('dsh process detection recognizes executable positions and ignores shell mentions and inherited sessions', () => {
  for (const args of [
    ['/usr/local/bin/dsh', 'web'],
    ['/opt/node/bin/node', '/pkg/node_modules/dsh/lib/bin.js', 'web'],
    ['/usr/bin/node', '--require', '/tmp/bootstrap.js', '/pkg/dsh/lib/bin.js', 'headless'],
    ['/usr/bin/node', '/usr/local/bin/dsh', 'acp']
  ]) assert.equal(argsLookLikeDsh(args), true, JSON.stringify(args));
  for (const args of [
    ['/bin/sh', '-c', 'dsh web'],
    ['/bin/zsh', '-c', '/pkg/dsh/lib/bin.js'],
    ['/usr/bin/node', '/tmp/unrelated.js', '/pkg/dsh/lib/bin.js'],
    ['/usr/bin/node', '--eval', 'console.log("dsh")', '/pkg/dsh/lib/bin.js'],
    ['/usr/bin/node', '-econsole.log("dsh")', '/pkg/dsh/lib/bin.js'],
    ['/usr/bin/echo', 'dsh'],
    ['/usr/bin/dsh-other', 'web']
  ]) assert.equal(argsLookLikeDsh(args), false, JSON.stringify(args));
  const env = { CLAUDE_CODE_SESSION_ID: 'claude-parent', CODEX_SESSION_ID: 'codex-parent' };
  const read = (pid) => ({
    30: { parent: 20, args: ['/bin/sh', '-c', 'hcc hook SessionStart'], env },
    20: { parent: 1, args: ['/usr/bin/node', '/pkg/dsh/lib/bin.js', 'web'], env }
  })[pid];
  assert.equal(findLinuxAncestorCliInfo(30, { read, kind: 'dsh' }).pid, 20);
  assert.deepEqual(inspectProviderProcess(30, 'dsh', { read }), {
    pid: 20, kind: 'dsh', provider_session: null, source: 'process.argv.dsh'
  });
  assert.equal(findMacAncestorCliInfo(30, {
    kind: 'dsh',
    inspect: (pid) => ({ 30: '20 /bin/zsh -c dsh web', 20: '1 /usr/bin/node /pkg/dsh/lib/bin.js web' })[pid]
  }).pid, 20);
});

test('observed dsh runtime identity supports liveness without granting terminal ownership', () => {
  const identity = { pid: 42, startToken: 'runtime-start', commandHash: 'a'.repeat(64) };
  assert.deepEqual(resolvePeerEvidence({
    processes: [{ storedIdentity: identity, current: { state: 'live', identity } }]
  }), { state: 'live', reason: 'process_identity_match' });
  assert.equal(bindingHasRuntime({ provider: 'dsh', transport: 'hook', runtime_session_id: 'dsh-session' }), false);
});

test('dsh provider is inferred without fabricating terminal resume arguments', () => {
  assert.equal(inferPeerKind('worker', null, 'dsh'), 'dsh');
  assert.equal(inferPeerKind('dsh-abcd', null, null), 'dsh');
  assert.throws(() => defaultSessionCommand('dsh'), (error) =>
    error.code === 'DSH_TUI_UNSUPPORTED' && /hcc dsh web/.test(error.message));
  assert.throws(() => buildPeerCommand('dsh-peer', 'dsh', {}, []), (error) =>
    error.code === 'DSH_TUI_UNSUPPORTED');
  assert.throws(() => buildPeerCommand('dsh-peer', 'dsh', { resume: 'session' }, []), (error) =>
    error.code === 'DSH_TUI_UNSUPPORTED');
  const explicit = buildPeerCommand('dsh-runtime', 'dsh', {}, ['dsh', 'web']);
  assert.equal(explicit.command, 'dsh web');
  assert.equal(explicit.binding.provider_session_id, undefined);
  assert.equal(explicit.binding.resume_mode, 'command');
});
