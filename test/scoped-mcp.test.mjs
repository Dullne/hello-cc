import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { initSchema } from '../lib/db/schema.mjs';
import { inspectProcessIdentity } from '../lib/process/identity.mjs';
import { createScopedMcpConfig, loadScopedMcpBootstrap } from '../lib/mcp/scope.mjs';
import { serveMcpStdio } from '../lib/mcp/stdio.mjs';

const cliPath = fileURLToPath(new URL('../bin/hcc.mjs', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-mcp-test-'));
  fs.mkdirSync(path.join(root, '.hello-cc'));
  const dbPath = path.join(root, '.hello-cc', 'mesh.db');
  const db = new DatabaseSync(dbPath); initSchema(db);
  const ownerIdentity = inspectProcessIdentity(process.pid).identity;
  assert.ok(ownerIdentity);
  const peer = 'mcp-worker', executorId = 'executor-scoped-test';
  db.prepare(`INSERT INTO peers(id,kind,role,worktree,pid,pid_start_token,pid_command_hash,status,created_at,last_seen_at)
    VALUES(?, 'codex','peer',?,?,?,?, 'running',1,1)`).run(peer, root, ownerIdentity.pid, ownerIdentity.startToken, ownerIdentity.commandHash);
  db.prepare(`INSERT INTO peer_bindings(peer,provider,provider_session_id,transport,runtime_session_id,created_at,updated_at)
    VALUES(?,'codex','thread-scoped','app-server',?,1,1)`).run(peer, peer);
  db.prepare("INSERT INTO events(type,actor,payload,created_at) VALUES('codex.executor.started',?,?,1)")
    .run(peer, JSON.stringify({ executor_id: executorId }));
  const capability = createScopedMcpConfig({ root, dbPath, peer, executorId, ownerIdentity });
  assert.equal(capability.config.args[0], fs.realpathSync(cliPath));
  t.after(() => { capability.dispose(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, dbPath, db, peer, executorId, capability, ownerIdentity };
}

async function client(t, f) {
  const config = f.capability.config;
  const child = spawn(config.command, config.args, { cwd: f.root,
    env: { ...process.env, HOME: f.root, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '', nextId = 0;
  const requests = new Map();
  child.stderr.on('data', bytes => { errors += bytes; });
  child.stdout.on('data', bytes => {
    output += bytes;
    let newline;
    while ((newline = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, newline); output = output.slice(newline + 1);
      let message;
      try { message = JSON.parse(line); } catch { for (const entry of requests.values()) entry.reject(new Error('MCP stdout contained non-protocol text')); return; }
      const entry = requests.get(message.id);
      if (entry) { requests.delete(message.id); clearTimeout(entry.timer); entry.resolve(message); }
    }
  });
  child.once('exit', code => {
    for (const entry of requests.values()) { clearTimeout(entry.timer); entry.reject(new Error(`MCP exited ${code}: ${errors}`)); }
    requests.clear();
  });
  t.after(async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.stdin.end(); await exited; }
  });
  async function rpc(method, params = {}) {
    const id = ++nextId;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { requests.delete(id); reject(new Error(`MCP request timeout: ${method}: ${errors}`)); }, 10000);
      requests.set(id, { resolve, reject, timer });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return result;
  }
  const initialize = await rpc('initialize', { protocolVersion: '2025-11-25',
    capabilities: {}, clientInfo: { name: 'actual-sqlite-test', version: '1' } });
  assert.equal(initialize.result.protocolVersion, '2025-11-25');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  return { rpc, call: async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result, child };
}

test('real stdio initialize/tools/list/tools/call reads SQLite without changing peer owner or user configuration', async t => {
  const f = fixture(t), c = await client(t, f);
  const original = { ...f.db.prepare('SELECT * FROM peers WHERE id = ?').get(f.peer) };
  const listed = await c.rpc('tools/list');
  assert.equal(listed.result.tools.length, 10);
  for (const tool of listed.result.tools) assert.equal(tool.inputSchema.additionalProperties, false);
  const state = await c.call('hcc_state');
  assert.equal(state.isError, false); assert.equal(state.structuredContent.peer, f.peer);
  assert.ok(state.structuredContent.data);
  assert.deepEqual({ ...f.db.prepare('SELECT * FROM peers WHERE id = ?').get(f.peer) }, original);
  assert.equal(fs.existsSync(path.join(f.root, '.codex')), false);
});

test('coordination writes use the fixed actor and preserve task/lock ownership and task completion state', async t => {
  const f = fixture(t), c = await client(t, f);
  f.db.prepare("INSERT INTO tasks(title,body,status,priority,created_at,updated_at) VALUES('first','','pending',1,1,1)").run();
  const task = await c.call('hcc_task_next');
  assert.equal(task.isError, false); assert.equal(task.structuredContent.data.owner, f.peer);
  const taskId = task.structuredContent.data.id;
  const again = await c.call('hcc_task_next');
  assert.equal(again.structuredContent.data.id, taskId); assert.equal(again.structuredContent.data.current, true);
  const sent = await c.call('hcc_message_send', { to: 'reviewer', body: '--help literal message', task_id: taskId });
  assert.equal(sent.isError, false); assert.equal(sent.structuredContent.data.sender, f.peer);
  const acquired = await c.call('hcc_lock_acquire', { resource: 'src/shared', task_id: taskId, ttl: 60 });
  assert.equal(acquired.isError, false); assert.equal(acquired.structuredContent.data.owner, f.peer);
  const handoff = await c.call('hcc_handoff', { task_id: taskId, summary: 'local work ready', tests: ['node --test'], risks: ['business acceptance pending'] });
  assert.equal(handoff.isError, false);
  const result = await c.call('hcc_result_record', { task_id: taskId, title: 'Local tests', status: 'passed', evidence: ['test receipt'], result_key: 'receipt-1' });
  assert.equal(result.isError, false); assert.equal(result.structuredContent.data.stage, 'local');
  assert.equal(result.structuredContent.data.source, 'executor');
  const repeated = await c.call('hcc_result_record', { task_id: taskId, title: 'Local tests', status: 'passed', evidence: ['test receipt'], result_key: 'receipt-1' });
  assert.equal(repeated.structuredContent.data.id, result.structuredContent.data.id);
  assert.equal(f.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId).status, 'claimed');
  const released = await c.call('hcc_lock_release', { resource: 'src/shared' });
  assert.equal(released.isError, false); assert.equal(released.structuredContent.data.released, true);
  f.db.prepare("INSERT INTO locks(resource,base_resource,scope,owner,expires_at,created_at,ttl_sec) VALUES('foreign','foreign','*','other',9999999999,1,60)").run();
  assert.equal((await c.call('hcc_lock_release', { resource: 'foreign' })).isError, true);
  f.db.prepare('UPDATE tasks SET owner = ? WHERE id = ?').run('other', taskId);
  assert.equal((await c.call('hcc_handoff', { task_id: taskId, summary: 'cannot handoff foreign task' })).isError, true);
  assert.equal((await c.call('hcc_lock_acquire', { task_id: taskId, resource: 'foreign-task' })).isError, true);
});

test('unknown, missing, wrong typed and scope override arguments are visible tool errors and leave RPC alive', async t => {
  const f = fixture(t), c = await client(t, f);
  for (const [name, args] of [
    ['hcc_state', { project: '/other' }], ['hcc_task_next', { force: true }],
    ['hcc_message_send', { body: 'missing recipient' }],
    ['hcc_message_send', { to: 'other', body: 1 }],
    ['hcc_message_send', { to: 'other', body: 'spoof', actor: 'admin' }],
    ['hcc_lock_release', { resource: 'x', admin: true }],
    ['hcc_result_record', { task_id: 1, title: 'fake publication', status: 'passed', stage: 'publication' }]
  ]) {
    const response = await c.call(name, args); assert.equal(response.isError, true);
    assert.equal(response.structuredContent.error.code, 'BAD_ARGS');
  }
  assert.equal((await c.rpc('ping')).error, undefined);
  assert.equal((await c.call('hcc_inbox')).isError, false);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
});

test('peer generation changes and revoked capabilities deny subsequent business calls', async t => {
  const f = fixture(t), c = await client(t, f);
  f.db.prepare("INSERT INTO events(type,actor,payload,created_at) VALUES('codex.executor.started',?,?,2)")
    .run(f.peer, JSON.stringify({ executor_id: 'replacement' }));
  const stale = await c.call('hcc_message_send', { to: 'other', body: 'must not execute' });
  assert.equal(stale.isError, true); assert.equal(stale.structuredContent.error.code, 'MCP_SCOPE_INVALID');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
  f.capability.dispose();
  assert.equal((await c.call('hcc_state')).structuredContent.error.code, 'MCP_SCOPE_INVALID');
});

test('a bare peer string, foreign root, tampered token and permissive bootstrap file do not grant a scope', t => {
  const f = fixture(t), ctx = { root: f.root, dbPath: f.dbPath };
  assert.throws(() => loadScopedMcpBootstrap(ctx, f.peer, {}), { code: 'MCP_SCOPE_INVALID' });
  const env = f.capability.config.env;
  assert.throws(() => loadScopedMcpBootstrap(ctx, 'other', env), { code: 'MCP_SCOPE_INVALID' });
  assert.throws(() => loadScopedMcpBootstrap(ctx, f.peer, { ...env, HCC_MCP_BOOTSTRAP_TOKEN: 'a'.repeat(43) }), { code: 'MCP_SCOPE_INVALID' });
  fs.chmodSync(env.HCC_MCP_BOOTSTRAP_PATH, 0o644);
  assert.throws(() => loadScopedMcpBootstrap(ctx, f.peer, env), { code: 'MCP_SCOPE_INVALID' });
});

test('JSONL malformed/oversized frames flush errors and the next valid request succeeds', async () => {
  const replies = [];
  const output = new Writable({ write(bytes, _encoding, done) { replies.push(JSON.parse(String(bytes))); done(); } });
  const toolset = { list: () => [], has: () => false };
  const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: 'unknown-version', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  await serveMcpStdio({ tools: toolset, maxLineBytes: 512,
    input: Readable.from(['invalid json\n', 'x'.repeat(600) + '\n', initialize + '\n',
      '{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
      '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n']), output });
  assert.equal(replies[0].error.code, -32700); assert.equal(replies[1].error.code, -32600);
  assert.equal(replies[2].result.protocolVersion, '2025-11-25'); assert.deepEqual(replies[3].result.tools, []);
});

test('native scoped MCP requires the unique worker binding and is revoked by worker replacement or close', t => {
  const f = fixture(t), binding = { transport: 'native', runtimeSessionId: f.peer, runtimeTarget: 'native-owner' };
  const original = loadScopedMcpBootstrap({ root: f.root, dbPath: f.dbPath }, f.peer, f.capability.config.env);
  const identity = inspectProcessIdentity(process.pid).identity;
  f.db.prepare("UPDATE peer_bindings SET transport='native',runtime_target=? WHERE peer=?").run('native-owner', f.peer);
  const capability = createScopedMcpConfig({ ...{ root: f.root, dbPath: f.dbPath }, peer: f.peer, executorId: 'native-owner', ownerIdentity: identity, binding });
  t.after(() => capability.dispose());
  const authority = loadScopedMcpBootstrap({ root: f.root, dbPath: f.dbPath }, f.peer, capability.config.env);
  authority.assertOwnership(f.db); assert.throws(() => original.assertOwnership(f.db));
  f.db.prepare('UPDATE peer_bindings SET runtime_target=? WHERE peer=?').run('replacement-owner', f.peer);
  assert.throws(() => authority.assertOwnership(f.db), { code: 'MCP_SCOPE_INVALID' });
  f.db.prepare('UPDATE peer_bindings SET runtime_target=? WHERE peer=?').run('native-owner', f.peer);
  capability.dispose(); assert.throws(() => authority.assertOwnership(f.db), { code: 'MCP_SCOPE_INVALID' });
  assert.throws(() => createScopedMcpConfig({ ...{ root: f.root, dbPath: f.dbPath }, peer: f.peer, executorId: 'native-owner', ownerIdentity: identity, binding: { transport: 'native', runtimeSessionId: f.peer } }), { code: 'MCP_SCOPE_INVALID' });
});
