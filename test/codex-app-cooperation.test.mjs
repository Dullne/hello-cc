import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough, Readable, Writable } from 'node:stream';
import { createCodexAppCooperation, codexShellSession, codexCooperationHook } from '../lib/integrations/codex-app-cooperation.mjs';
import { writeCodexCooperationPlugin } from '../lib/integrations/codex-app-install.mjs';
import { createMessageStore } from '../lib/core/coordination/messages.mjs';
import { serveMcpStdio } from '../lib/mcp/stdio.mjs';
import { captureSelectedCwdSnapshot } from '../lib/process/selected-cwd-identity.mjs';

const cli = new URL('../bin/hcc.mjs', import.meta.url).pathname;
function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-codex-cooperate-')));
  const root = path.join(directory, 'project'); fs.mkdirSync(root, { mode: 0o700 });
  let timestamp = 1000;
  const service = createCodexAppCooperation({ root, now: () => timestamp });
  service.enable();
  const db = new DatabaseSync(service.ctx.dbPath);
  const messages = createMessageStore({ now: () => timestamp });
  const issue = id => service.issueSession({ sessionId: id, cwd: root, source: 'codex-shell-environment' });
  const a = issue('thread-a'), b = issue('thread-b');
  const call = (session, name, args = {}, threadId = session.sessionId) => service.call(name,
    { ...args, session_token: session.session_token }, { meta: { threadId, sessionId: 'shared-root-session' } });
  const send = (to, body, sender = 'reviewer', kind = 'note') => messages.sendMessage(db, sender, to, null, kind, body);
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, root, service, db, a, b, call, send, issue, advance: amount => { timestamp += amount; } };
}

test('per-call thread identity separates shared parent session metadata and cannot be replaced by model arguments', async t => {
  const f = fixture(t);
  f.send(f.a.peer, 'private A'); f.send(f.b.peer, 'private B');
  assert.deepEqual((await f.call(f.a, 'hcc_inbox')).structuredContent.data.map(x => x.body), ['private A']);
  assert.deepEqual((await f.call(f.b, 'hcc_inbox')).structuredContent.data.map(x => x.body), ['private B']);
  assert.equal((await f.call(f.a, 'hcc_inbox', {}, 'thread-b')).structuredContent.error.code, 'CODEX_APP_SCOPE_INVALID');
  assert.equal((await f.service.call('hcc_inbox', { session_token: f.a.session_token })).isError, true);
  assert.equal((await f.call(f.a, 'hcc_message_send', { to: 'reviewer', body: 'bad', peer: f.b.peer })).isError, true);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM message_reads').get().n, 0);
  const list = f.service.list();
  assert.equal(list.length, 13);
  assert.ok(list.every(x => x.inputSchema.required.includes('session_token')));
});

test('self-sent and self-broadcast backlog is excluded before LIMIT; wait/read retain unread mail', async t => {
  const f = fixture(t);
  for (let i = 0; i < 50; i++) f.send(i % 2 ? 'all' : f.a.peer, `self-${i}`, f.a.peer);
  const id = f.send(f.a.peer, 'external');
  const inbox = await f.call(f.a, 'hcc_inbox', { limit: 1 });
  assert.equal(inbox.structuredContent.data[0].id, id);
  const waited = await f.call(f.a, 'hcc_inbox_wait', { timeout_ms: 0, limit: 1 });
  assert.equal(waited.structuredContent.data.messages[0].id, id);
  assert.equal(waited.structuredContent.data.acknowledged, false);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM message_reads').get().n, 0);
});

test('bounded active wait sees a later arrival and stops when the capability expires', async t => {
  const f = fixture(t);
  const timer = setTimeout(() => f.send(f.a.peer, 'later'), 30);
  t.after(() => clearTimeout(timer));
  const waited = await f.call(f.a, 'hcc_inbox_wait', { timeout_ms: 1000 });
  assert.equal(waited.structuredContent.data.messages[0].body, 'later');
  const expiring = f.call(f.b, 'hcc_inbox_wait', { timeout_ms: 1000 });
  f.advance(3601);
  assert.equal((await expiring).structuredContent.error.code, 'CODEX_APP_SCOPE_INVALID');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM message_reads').get().n, 0);
});

test('ACK requires the exact received message; reply and ACK commit together and retry is idempotent', async t => {
  const f = fixture(t);
  const id = f.send(f.a.peer, 'please review');
  const item = (await f.call(f.a, 'hcc_inbox')).structuredContent.data[0];
  assert.equal((await f.call(f.b, 'hcc_message_ack', { message_id: id, receipt: item.receipt })).isError, true);
  f.db.prepare('UPDATE messages SET body=? WHERE id=?').run('modified', id);
  assert.equal((await f.call(f.a, 'hcc_message_ack', { message_id: id, receipt: item.receipt })).isError, true);
  const exact = (await f.call(f.a, 'hcc_inbox')).structuredContent.data[0];
  const args = { message_id: id, receipt: exact.receipt, body: 'review complete, local checks only' };
  const first = await f.call(f.a, 'hcc_message_reply', args), second = await f.call(f.a, 'hcc_message_reply', args);
  assert.equal(first.isError, false);
  assert.equal(first.structuredContent.data.replyId, second.structuredContent.data.replyId);
  assert.equal(first.structuredContent.data.taskCompleted, false);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE reply_to=?').get(id).n, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM message_reads WHERE message_id=?').get(id).n, 1);
  assert.equal((await f.call(f.a, 'hcc_message_reply', { ...args, body: 'different retry' })).structuredContent.error.code, 'CODEX_APP_REPLY_CONFLICT');
});

test('disable, explicit detach, expiry, and another transport revoke authority without taking over sessions', async t => {
  const f = fixture(t);
  f.db.prepare("UPDATE peers SET status='detached' WHERE id=?").run(f.a.peer);
  assert.throws(() => f.issue('thread-a'), { code: 'CODEX_APP_SCOPE_INVALID' });
  f.db.prepare("UPDATE peer_bindings SET transport='hook',runtime_target=NULL WHERE peer=?").run(f.a.peer);
  assert.throws(() => f.issue('thread-a'), { code: 'CODEX_APP_SCOPE_INVALID' });
  assert.equal(f.db.prepare('SELECT transport FROM peer_bindings WHERE peer=?').get(f.a.peer).transport, 'hook');
  f.db.prepare("UPDATE peer_bindings SET transport='native',runtime_target='worker' WHERE peer=?").run(f.b.peer);
  assert.throws(() => f.issue('thread-b'), { code: 'CODEX_APP_SCOPE_INVALID' });
  assert.equal((await f.call(f.b, 'hcc_state')).isError, true);
  const c = f.issue('thread-c');
  f.service.disable();
  assert.equal((await f.call(c, 'hcc_message_send', { to: 'reviewer', body: 'revoked' })).isError, true);
  f.service.enable();
  assert.equal((await f.call(c, 'hcc_inbox')).isError, true);
  const renewed = f.issue('thread-c');
  assert.equal(renewed.peer, c.peer);
  assert.equal((await f.call(renewed, 'hcc_inbox')).isError, false);
  assert.equal(f.db.prepare('SELECT transport FROM peer_bindings WHERE peer=?').get(f.b.peer).transport, 'native');
});

test('directory replacement and foreign-project tokens are rejected', async t => {
  const f = fixture(t);
  const initial = captureSelectedCwdSnapshot(f.root);
  const other = path.join(f.directory, 'other'); fs.mkdirSync(other);
  const different = createCodexAppCooperation({ root: other }); different.enable();
  assert.equal((await different.call('hcc_inbox', { session_token: f.a.session_token }, { meta: { threadId: f.a.sessionId } })).isError, true);
  fs.renameSync(f.root, f.root + '-moved'); fs.mkdirSync(f.root);
  assert.equal((await f.call(f.a, 'hcc_inbox')).isError, true);
  assert.throws(() => writeCodexCooperationPlugin({ root: f.root, directory: path.join(f.directory, 'replacement-plugin'), initialRootIdentity: initial }), { code: 'PROJECT_PATH_CHANGED' });
  assert.equal(fs.existsSync(path.join(f.directory, 'replacement-plugin')), false);
});

test('enrollment and receipts preserve task working state; claiming a task still marks working', async t => {
  const f = fixture(t);
  f.db.prepare("INSERT INTO tasks(title,body,status,priority,created_at,updated_at) VALUES('work','','pending',1,1,1)").run();
  assert.equal((await f.call(f.a, 'hcc_task_next')).isError, false);
  assert.equal(f.db.prepare('SELECT status FROM peers WHERE id=?').get(f.a.peer).status, 'working');
  const renewed = f.issue(f.a.sessionId);
  await f.call(renewed, 'hcc_inbox');
  f.send(f.a.peer, 'read this');
  const message = (await f.call(renewed, 'hcc_inbox')).structuredContent.data[0];
  assert.equal((await f.call(renewed, 'hcc_message_ack', { message_id: message.id, receipt: message.receipt })).isError, false);
  assert.equal(f.db.prepare('SELECT status FROM peers WHERE id=?').get(f.a.peer).status, 'working');
});

test('session-wide hooks prompt current-thread enrollment without reading or registering a parent inbox', async t => {
  const f = fixture(t);
  f.send(f.a.peer, 'A only');
  const child = await codexCooperationHook({ root: f.root, payload: { hook_event_name: 'UserPromptSubmit',
    session_id: 'thread-a', agent_id: 'thread-child', cwd: f.root }, env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop' } });
  assert.match(child.hookSpecificOutput.additionalContext, /current CODEX_THREAD_ID/);
  assert.doesNotMatch(child.hookSpecificOutput.additionalContext, /A only/);
  assert.equal(f.db.prepare("SELECT 1 FROM peer_bindings WHERE provider_session_id='thread-child'").get(), undefined);
  assert.deepEqual(await codexCooperationHook({ root: f.root, payload: { hook_event_name: 'Stop', session_id: 'thread-a', cwd: f.root }, env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop' } }), {});
  assert.equal(await codexCooperationHook({ root: f.root, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'thread-a', cwd: f.root }, env: {} }), null);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM message_reads').get().n, 0);
});

test('stdio forwards host request metadata separately from model arguments', async () => {
  let actual;
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'test', arguments: { value: 'model' }, _meta: { threadId: 'actual-thread', sessionId: 'shared-root' } } }
  ];
  await serveMcpStdio({ input: Readable.from(requests.map(item => JSON.stringify(item) + '\n')),
    output: new Writable({ write(_chunk, _encoding, done) { done(); } }),
    tools: { has: () => true, async call(...args) { actual = args; return { content: [] }; } } });
  assert.deepEqual(actual, ['test', { value: 'model' }, { meta: { threadId: 'actual-thread', sessionId: 'shared-root' }, signal: undefined }]);
});

test('one persistent MCP connection can wait for A while B sends, and cancellation releases a wait', { timeout: 5000 }, async t => {
  const f = fixture(t), input = new PassThrough(), responses = new Map(), waiting = new Map();
  const output = new Writable({ write(bytes, _encoding, done) {
    const message = JSON.parse(String(bytes)); responses.set(message.id, message);
    waiting.get(message.id)?.(message); done();
  } });
  const served = serveMcpStdio({ tools: f.service, input, output, concurrentToolCalls: true });
  t.after(async () => { input.end(); await served; });
  const write = request => input.write(JSON.stringify({ jsonrpc: '2.0', ...request }) + '\n');
  const received = id => responses.has(id) ? Promise.resolve(responses.get(id)) : new Promise(resolve => waiting.set(id, resolve));
  write({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'shared-client', version: '1' } } });
  await received(1); write({ method: 'notifications/initialized' });
  const call = (id, session, name, args) => write({ id, method: 'tools/call', params: { name,
    arguments: { ...args, session_token: session.session_token }, _meta: { sessionId: 'shared-root', threadId: session.sessionId } } });
  call(2, f.a, 'hcc_inbox_wait', { timeout_ms: 2000 });
  call(3, f.b, 'hcc_message_send', { to: f.a.peer, body: 'same-connection delivery' });
  assert.equal((await received(3)).result.isError, false);
  const waited = (await received(2)).result;
  assert.equal(waited.structuredContent.data.timedOut, false);
  assert.equal(waited.structuredContent.data.messages[0].body, 'same-connection delivery');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM message_reads').get().n, 0);
  call(4, f.b, 'hcc_inbox_wait', { timeout_ms: 45000 });
  write({ method: 'notifications/cancelled', params: { requestId: 4, reason: 'current turn interrupted' } });
  assert.equal((await received(4)).result.isError, true);
});

test('input transport errors abort and join pending cooperative waits before rejecting', { timeout: 3000 }, async () => {
  const input = new PassThrough();
  let started, signal, finished = false, rejected = false, responseAfterReject = false;
  const active = new Promise(resolve => { started = resolve; });
  const output = new Writable({ write(bytes, _encoding, done) {
    if (JSON.parse(String(bytes)).id === 2 && rejected) responseAfterReject = true;
    done();
  } });
  const served = serveMcpStdio({ input, output, concurrentToolCalls: true, tools: { has: () => true,
    async call(_name, _args, context) {
      signal = context.signal; started();
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      finished = true; return { isError: true, content: [] };
    } } });
  const outcome = served.catch(error => { rejected = true; return error; });
  for (const request of [
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    { method: 'notifications/initialized' }, { id: 2, method: 'tools/call', params: { name: 'wait' } }
  ]) input.write(JSON.stringify({ jsonrpc: '2.0', ...request }) + '\n');
  await active; input.destroy(new Error('synthetic stream failure'));
  assert.equal((await outcome).message, 'synthetic stream failure');
  assert.equal(signal.aborted, true); assert.equal(finished, true); assert.equal(responseAfterReject, false);
});

test('generated plugin uses official public layout and CLI keeps the current child thread instead of parent', t => {
  const f = fixture(t);
  const plugin = writeCodexCooperationPlugin({ root: f.root, directory: path.join(f.directory, 'plugin') });
  const otherPlugin = writeCodexCooperationPlugin({ root: f.root, directory: path.join(f.directory, 'plugin-again') });
  assert.notEqual(otherPlugin.pluginName, plugin.pluginName); assert.notEqual(otherPlugin.marketplaceName, plugin.marketplaceName);
  assert.equal(plugin.installedInApp, false); assert.equal(plugin.automaticIdleWakeup, false);
  const config = JSON.parse(fs.readFileSync(path.join(plugin.pluginDirectory, '.mcp.json')));
  assert.ok(config.mcpServers.hcc_cooperation.args.includes('mcp'));
  const hooks = JSON.parse(fs.readFileSync(path.join(plugin.pluginDirectory, 'hooks/hooks.json')));
  assert.deepEqual(Object.keys(hooks.hooks), ['UserPromptSubmit']);
  const env = { ...process.env, CODEX_THREAD_ID: 'thread-cli-child', CODEX_SESSION_ID: 'thread-cli-parent', CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop' };
  assert.equal(codexShellSession(env), 'thread-cli-child');
  assert.throws(() => codexShellSession({ CODEX_THREAD_ID: 'thread-cli-child' }), { code: 'CODEX_APP_SCOPE_INVALID' });
  const child = spawnSync(process.execPath, [cli, '--root', f.root, '--json', 'app', 'codex', 'call', '--tool', 'hcc_inbox'], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  assert.doesNotMatch(child.stdout, /session_token/);
  const binding = f.db.prepare("SELECT * FROM peer_bindings WHERE provider_session_id='thread-cli-child'").get();
  assert.equal(binding.transport, 'codex-cooperate');
  assert.equal(f.db.prepare('SELECT status FROM peers WHERE id=?').get(binding.peer).status, 'idle');
});
