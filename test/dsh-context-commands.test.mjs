import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { initSchema } from '../lib/db/schema.mjs';
import { providerSessionPeerId } from '../lib/core/peers/session.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hccBin = path.join(repoRoot, 'bin', 'hcc.mjs');

function fixture(t, projectName = 'project') {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-dsh-prefix-'));
  const root = path.join(sandbox, projectName);
  const foreignRoot = path.join(sandbox, 'foreign-project');
  const home = path.join(sandbox, 'home');
  for (const directory of [root, foreignRoot, home]) fs.mkdirSync(directory, { recursive: true });
  const dbPath = path.join(root, '.hello-cc', 'mesh.db');
  const foreignDbPath = path.join(foreignRoot, '.hello-cc', 'mesh.db');
  fs.mkdirSync(path.dirname(foreignDbPath));
  const foreignDb = new DatabaseSync(foreignDbPath);
  initSchema(foreignDb);
  foreignDb.prepare("INSERT INTO peers(id, kind, status, created_at, last_seen_at) VALUES ('server-inherited-peer', 'claude', 'working', 1, 1)").run();
  foreignDb.prepare("INSERT INTO messages(sender, recipient, body, created_at) VALUES ('foreign-user', 'server-inherited-peer', 'foreign-message-preserve', 1)").run();
  foreignDb.close();
  const foreignBytes = fs.readFileSync(foreignDbPath);
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const env = {
    ...process.env,
    NODE_NO_WARNINGS: '1',
    HOME: home,
    PATH: '/usr/bin:/bin',
    HCC_RUNTIME_URL: '',
    HCC_PEER: 'server-inherited-peer',
    HCC_ROOT: foreignRoot,
    HCC_DB: foreignDbPath,
    CLAUDE_CODE_SESSION_ID: 'foreign-claude-session',
    CLAUDECODE: '1',
    CODEX_SESSION_ID: 'foreign-codex-session',
    CODEX_THREAD_ID: 'foreign-codex-thread',
    HCC_PREFIX_CANARY: 'expanded-directory'
  };
  const hook = (sessionId, event = 'SessionStart') => {
    const result = spawnSync(process.execPath, [hccBin, 'hook', event, '--provider', 'dsh'], {
      cwd: foreignRoot, env, encoding: 'utf8', timeout: 10_000,
      input: JSON.stringify({ session_id: sessionId, cwd: root, hook_event_name: event })
    });
    assert.equal(result.status, 0, result.stderr);
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    const lines = context.split('\n');
    const section = lines.indexOf('[hello-cc dsh session commands]');
    assert.ok(section >= 0, 'hook must deliver an executable dsh session command prefix');
    const prefix = lines[section + 2];
    assert.ok(prefix, 'session command prefix must occupy its own line');
    return { context, prefix, peer: providerSessionPeerId('dsh', sessionId) };
  };
  const run = (prefix, suffix, expectedStatus = 0) => {
    const result = spawnSync('/bin/sh', ['-c', `${prefix} --json ${suffix}`], {
      cwd: foreignRoot, env, encoding: 'utf8', timeout: 10_000
    });
    assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
    return JSON.parse(expectedStatus === 0 ? result.stdout : result.stderr);
  };
  const withDb = (callback) => {
    const db = new DatabaseSync(dbPath);
    try { return callback(db); } finally { db.close(); }
  };
  const assertForeignUnchanged = () => {
    assert.deepEqual(fs.readFileSync(foreignDbPath), foreignBytes);
    assert.deepEqual(fs.readdirSync(path.dirname(foreignDbPath)), ['mesh.db']);
    assert.equal(fs.existsSync(path.join(foreignRoot, 'prefix-injection')), false);
    assert.equal(fs.existsSync(path.join(sandbox, 'expanded-directory')), false);
  };
  return { sandbox, root, dbPath, foreignRoot, env, hook, run, withDb, assertForeignUnchanged };
}

function seedAssignedWork(f, peer, title = 'assigned dsh task') {
  return f.withDb((db) => {
    const now = Math.floor(Date.now() / 1000);
    const task = db.prepare("INSERT INTO tasks(title, status, assignee, created_by, created_at, updated_at) VALUES (?, 'pending', ?, 'human', ?, ?)")
      .run(title, peer, now, now);
    const message = db.prepare("INSERT INTO messages(sender, recipient, kind, body, created_at) VALUES ('claude-support', ?, 'note', 'please-reply-in-thread', ?)")
      .run(peer, now);
    return { taskId: Number(task.lastInsertRowid), messageId: Number(message.lastInsertRowid) };
  });
}

for (const projectName of ['project', "project space ' quote $HCC_PREFIX_CANARY $(touch prefix-injection)"]) {
  test(`emitted dsh prefix routes reply, send, task claim, and lock in ${projectName === 'project' ? 'a normal' : 'a shell-special'} workspace`, (t) => {
    if (process.platform === 'win32') { t.skip('dsh shell tool commands use POSIX env'); return; }
    const f = fixture(t, projectName);
    const initial = f.hook('dsh-context-session');
    const { taskId, messageId } = seedAssignedWork(f, initial.peer);
    const { context, prefix, peer } = f.hook('dsh-context-session', 'UserPromptSubmit');
    assert.match(context, /please-reply-in-thread/);
    assert.match(context, /assigned dsh task/);

    // Execute the provider-facing text exactly as delivered. PATH contains
    // system tools, so the prefix must select its own Node and package CLI.
    const reply = f.run(prefix, `msg reply --id ${messageId} --body 'reply-from-dsh'`);
    assert.equal(reply.data.sender, peer);
    assert.equal(reply.data.recipient, 'claude-support');
    assert.equal(reply.data.reply_to, messageId);
    assert.equal(reply.data.thread_id, messageId);
    const sent = f.run(prefix, "msg send --to codex-reviewer --body 'send-from-dsh'");
    assert.equal(sent.data.sender, peer);
    assert.equal(sent.data.recipient, 'codex-reviewer');
    const claimed = f.run(prefix, `task claim --id ${taskId}`);
    assert.equal(claimed.data.owner, peer);
    const lock = f.run(prefix, `lock acquire --resource src/context.js --task ${taskId} --ttl 60`);
    assert.equal(lock.data.owner, peer);
    assert.equal(lock.data.task_id, taskId);

    f.withDb((db) => {
      const messages = db.prepare('SELECT sender, recipient, reply_to, thread_id FROM messages WHERE sender = ? ORDER BY id').all(peer);
      assert.deepEqual(messages.map((row) => ({ ...row })), [
        { sender: peer, recipient: 'claude-support', reply_to: messageId, thread_id: messageId },
        { sender: peer, recipient: 'codex-reviewer', reply_to: null, thread_id: sent.data.id }
      ]);
      assert.equal(db.prepare('SELECT owner FROM tasks WHERE id = ?').get(taskId).owner, peer);
      assert.equal(db.prepare("SELECT owner FROM locks WHERE resource = 'src/context.js'").get().owner, peer);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM peers WHERE id = 'server-inherited-peer'").get().n, 0);
      assert.equal(db.prepare('SELECT kind FROM peers WHERE id = ?').get(peer).kind, 'dsh');
    });
    f.assertForeignUnchanged();
  });
}

test('two emitted dsh prefixes keep session ownership and message threads separate in the same service environment', (t) => {
  if (process.platform === 'win32') { t.skip('dsh shell tool commands use POSIX env'); return; }
  const f = fixture(t);
  const sessionA = f.hook('dsh-prefix-session-a');
  const sessionB = f.hook('dsh-prefix-session-b');
  const workA = seedAssignedWork(f, sessionA.peer, 'task-a');
  const workB = seedAssignedWork(f, sessionB.peer, 'task-b');
  f.run(sessionA.prefix, `task claim --id ${workA.taskId}`);
  f.run(sessionB.prefix, `task claim --id ${workB.taskId}`);
  const sent = f.run(sessionA.prefix, `msg send --to ${sessionB.peer} --body 'session-a-to-b'`);
  const replied = f.run(sessionB.prefix, `msg reply --id ${sent.data.id} --body 'session-b-reply'`);
  assert.equal(sent.data.sender, sessionA.peer);
  assert.equal(replied.data.sender, sessionB.peer);
  assert.equal(replied.data.recipient, sessionA.peer);
  assert.equal(replied.data.thread_id, sent.data.id);
  f.run(sessionA.prefix, `lock acquire --resource src/shared.js --task ${workA.taskId} --ttl 60`);
  const conflict = f.run(sessionB.prefix, `lock acquire --resource src/shared.js --task ${workB.taskId} --ttl 60`, 1);
  assert.equal(conflict.error.code, 'LOCK_HELD');
  assert.equal(conflict.error.owner, sessionA.peer);
  f.withDb((db) => {
    assert.deepEqual(db.prepare('SELECT owner FROM tasks ORDER BY id').all().map((row) => row.owner), [sessionA.peer, sessionB.peer]);
    assert.equal(db.prepare("SELECT owner FROM locks WHERE resource = 'src/shared.js'").get().owner, sessionA.peer);
  });
  f.assertForeignUnchanged();
});
