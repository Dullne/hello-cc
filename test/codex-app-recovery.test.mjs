import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CliError } from '../lib/shared/errors.mjs';
import { createCodexAppCooperation } from '../lib/integrations/codex-app-cooperation.mjs';
import { createCodexAppDelivery, codexAppDeliveryStatus } from '../lib/integrations/codex-app-delivery.mjs';
import { configureCodexAppRecovery, codexAppRecoveryStatus, createCodexAppRecoveryManager } from '../lib/integrations/codex-app-recovery.mjs';
import { discoverCodexAppRuntime } from '../lib/integrations/codex-app-queue.mjs';
import { createMessageStore } from '../lib/core/coordination/messages.mjs';

const thread = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-app-recovery-')));
  const root = path.join(directory, 'project'); fs.mkdirSync(root, { mode: 0o700 });
  const service = createCodexAppCooperation({ root }); service.enable();
  const session = service.issueSession({ sessionId: thread, cwd: root });
  const db = new DatabaseSync(service.ctx.dbPath), managers = [], submissions = [], transports = [];
  const runtime = { cli: path.join(directory, 'App.app/Contents/codex'), sqliteHome: path.join(directory, 'codex-home'),
    appExecutable: path.join(directory, 'App.app/Contents/MacOS/App'), appServerPid: 123 };
  const configure = (enabled = true, sessionId = thread, extra = {}) => configureCodexAppRecovery({ root, sessionId, enabled, runtime, ...extra });
  const status = (sessionId = thread) => codexAppRecoveryStatus({ root, sessionId });
  const createTransport = async options => {
    transports.push(options);
    return { assertValid() {}, async enqueue(value) {
      submissions.push(value); return { queued: true, queueId: 'fixture-' + submissions.length };
    } };
  };
  const manager = (extra = {}) => {
    const value = createCodexAppRecoveryManager({ root, discover: () => runtime, createTransport,
      schedule: () => null, unschedule() {}, ...extra });
    managers.push(value); return value;
  };
  const send = () => createMessageStore({ now: () => 1000 }).sendMessage(db, 'reviewer', session.peer, null, 'note', 'fixture only');
  t.after(async () => {
    for (const value of managers.reverse()) await value.close();
    db.close(); fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, root, service, session, db, runtime, configure, status, manager, transports, submissions, send };
}

test('a project MCP starts only explicitly opted-in exact threads and a new MCP restores their delivery lease', async t => {
  const f = fixture(t);
  let discoveries = 0;
  const first = f.manager({ discover: () => { discoveries++; return f.runtime; } });
  await first.tick(); assert.equal(discoveries, 0);
  f.service.issueSession({ sessionId: other, cwd: f.root });
  f.configure(); await first.tick();
  assert.deepEqual(f.transports.map(item => item.threadId), [thread]);
  assert.equal(f.status().status, 'active');
  assert.equal(f.status(other).enabled, false);
  assert.equal(codexAppDeliveryStatus({ root: f.root, sessionId: thread }).ready, true);
  await first.close();
  assert.equal(codexAppDeliveryStatus({ root: f.root, sessionId: thread }).running, false);
  assert.equal(f.status().status, 'pending');
  assert.equal(f.status().activeHostPid, null);
  const next = f.manager(); await next.tick();
  assert.deepEqual(f.transports.map(item => item.threadId), [thread, thread]);
  assert.equal(codexAppDeliveryStatus({ root: f.root, sessionId: thread }).ready, true);
  const persisted = JSON.stringify(f.service.recoverySettings());
  assert.ok(!persisted.includes(f.session.session_token));
  assert.doesNotMatch(persisted, /session_token|fixture only/);
});

test('an ambiguous queue call is never replayed after MCP reconnection', async t => {
  const f = fixture(t); f.configure(); const messageId = f.send();
  let submitted = 0;
  const transport = { assertValid() {}, async enqueue() { submitted++; throw new CliError('CODEX_APP_QUEUE_UNCERTAIN', 'unknown outcome'); } };
  const first = f.manager({ createTransport: async () => transport });
  await first.tick(); await first.close();
  const second = f.manager({ createTransport: async () => transport });
  await second.tick(); await second.tick();
  assert.equal(submitted, 1);
  const row = f.db.prepare("SELECT value FROM meta WHERE key LIKE 'codex-app.dispatch.message.%'").get();
  assert.equal(JSON.parse(row.value).status, 'uncertain');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM message_reads WHERE message_id=?').get(messageId).n, 0);
});

test('a different App installation or queue home cannot recover a saved thread', async t => {
  const f = fixture(t); f.configure();
  for (const name of ['cli', 'sqliteHome', 'appExecutable']) {
    const manager = f.manager({ discover: () => ({ ...f.runtime, [name]: path.join(f.directory, 'different') }) });
    await manager.tick(); await manager.close();
    assert.equal(f.status().error, 'CODEX_APP_RECOVERY_RUNTIME_CHANGED');
  }
  assert.equal(f.transports.length, 0);
});

test('unreviewed CLI versions block automatic recovery without breaking scoped MCP calls', async t => {
  const f = fixture(t); f.configure();
  const manager = f.manager({ createTransport: async () => { throw new CliError('CODEX_APP_QUEUE_VERSION_UNVERIFIED', 'review required'); } });
  await manager.tick();
  assert.equal(f.status().status, 'blocked');
  assert.equal(f.status().error, 'CODEX_APP_QUEUE_VERSION_UNVERIFIED');
  const state = await f.service.call('hcc_state', { session_token: f.session.session_token }, { meta: { threadId: thread } });
  assert.equal(state.structuredContent.ok, true);
  assert.equal(f.submissions.length, 0);
});

test('disabling one thread stops its managed listener and leaves the other opted-in thread running', async t => {
  const f = fixture(t); f.configure(); f.service.issueSession({ sessionId: other, cwd: f.root }); f.configure(true, other);
  const manager = f.manager(); await manager.tick();
  f.configure(false); await manager.tick();
  assert.equal(f.status().status, 'disabled');
  assert.equal(codexAppDeliveryStatus({ root: f.root, sessionId: thread }).running, false);
  assert.equal(codexAppDeliveryStatus({ root: f.root, sessionId: other }).ready, true);
});

test('a revoked cooperation epoch does not silently recover with a new owner', async t => {
  const f = fixture(t); f.configure(); const manager = f.manager(); await manager.tick();
  f.service.disable(); await manager.tick();
  f.service.enable(); f.service.issueSession({ sessionId: thread, cwd: f.root });
  await manager.tick();
  assert.equal(f.transports.length, 1);
  assert.deepEqual(f.status(), { enabled: false, status: 'revoked', error: 'CODEX_APP_SCOPE_INVALID' });
});

test('a live manual watcher is preserved and recovery waits for it to release its lease', async t => {
  const f = fixture(t); f.configure();
  const manual = createCodexAppDelivery({ root: f.root, sessionId: thread,
    transport: { assertValid() {}, enqueue: async () => ({ queued: true, queueId: 'manual' }) },
    schedule: () => null, unschedule() {} });
  t.after(() => manual.close());
  const manager = f.manager(); await manager.tick();
  assert.equal(f.status().error, 'CODEX_APP_DISPATCH_CONFLICT');
  assert.equal(manual.status().running, true);
  await manual.close(); await manager.tick();
  assert.equal(f.status().status, 'active');
});

test('concurrent enable/disable and re-enable in the same second replace the configuration generation', async t => {
  const f = fixture(t), now = () => 1000; f.configure(true, thread, { now });
  const manager = f.manager(); await manager.tick();
  const previous = f.service.recoverySettings()[0].policyId;
  f.configure(false, thread, { now }); f.configure(true, thread, { now });
  await Promise.all([manager.tick(), manager.tick(), manager.tick()]);
  assert.notEqual(f.service.recoverySettings()[0].policyId, previous);
  assert.equal(f.transports.length, 2);
  assert.equal(f.status().status, 'active');
});

test('multiple project MCP connections reuse one managed listener without overwriting its healthy status', async t => {
  const f = fixture(t); f.configure();
  const first = f.manager(); await first.tick();
  const owner = codexAppDeliveryStatus({ root: f.root, sessionId: thread });
  const second = f.manager(); await second.tick();
  assert.equal(f.transports.length, 1);
  assert.equal(f.status().status, 'active');
  assert.equal(f.status().error, null);
  assert.equal(codexAppDeliveryStatus({ root: f.root, sessionId: thread }).recoveryPolicyId, owner.recoveryPolicyId);
  await second.close();
  assert.equal(codexAppDeliveryStatus({ root: f.root, sessionId: thread }).ready, true);
  await first.close();
  const replacement = f.manager(); await replacement.tick();
  assert.equal(f.transports.length, 2);
  assert.equal(f.status().status, 'active');
});

test('runtime discovery walks only the current ancestry and requires one unique shared queue', () => {
  const app = '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT', cli = '/Applications/ChatGPT.app/Contents/Resources/codex';
  const calls = [];
  const sync = (command, args) => {
    calls.push({ command, args });
    if (command.endsWith('lsof')) return 'p20\nn/private/queue-home/queue_1.sqlite\nn/private/queue-home/queue_1.sqlite\nn/private/other.sqlite';
    if (!args.includes('ppid=')) return app;
    return args[1] === '30' ? '20 /usr/bin/node' : '10 ' + cli;
  };
  assert.deepEqual(discoverCodexAppRuntime({ pid: 30, sync, realpath: value => value, platform: 'darwin' }),
    { cli, appServerPid: 20, sqliteHome: '/private/queue-home', appExecutable: app });
  assert.ok(calls.every(item => item.args.includes('-p')));
  assert.throws(() => discoverCodexAppRuntime({ pid: 30, sync: (command, args) => command.endsWith('lsof')
    ? 'n/first/queue_1.sqlite\nn/second/queue_1.sqlite' : sync(command, args), realpath: value => value, platform: 'darwin' }),
  { code: 'CODEX_APP_QUEUE_IDENTITY_CHANGED' });
  assert.throws(() => discoverCodexAppRuntime({ platform: 'win32' }), { code: 'CODEX_APP_QUEUE_UNSUPPORTED' });
});
