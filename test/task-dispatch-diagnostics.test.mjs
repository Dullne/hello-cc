import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createTaskCommands } from '../lib/cli/commands/task.mjs';
import { initSchema, tx } from '../lib/db/schema.mjs';
import { createEventHelpers } from '../lib/db/events.mjs';
import { createMessageStore } from '../lib/core/coordination/messages.mjs';
import * as args from '../lib/cli-args.mjs';
import { CliError } from '../lib/shared/errors.mjs';
import { runtimeRequest } from '../lib/runtime/client.mjs';
import { taskDispatchFailureDiagnostics } from '../.github/scripts/task-dispatch-diagnostics.mjs';

function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  t.after(() => db.close());
  const now = () => 1000;
  const events = createEventHelpers({ now });
  let output, active = 0;
  const calls = { read: 0, list: 0, inject: 0 };
  const boundary = stage => {
    assert.equal(active, 0, 'persistence connections must close before runtime access');
    calls[stage]++;
    if (options.failAt === stage) throw options.error;
  };
  const commands = createTaskCommands({
    ...args, ...events, ...createMessageStore({ now, ...events }), now, tx, CliError,
    connect() {
      active++;
      return { prepare: db.prepare.bind(db), exec: db.exec.bind(db), close() { active--; } };
    },
    touchCurrentPeer() {}, resolveCurrentPeer: () => ({ id: 'PRIVATE_SENDER' }),
    readRuntime() { boundary('read'); return { base_url: 'http://PRIVATE_RUNTIME', token: 'PRIVATE_TOKEN' }; },
    async runtimeRequest(...input) {
      boundary('list');
      if (options.request) return options.request(...input);
      return { sessions: [{ id: 'PRIVATE_PEER', kind: options.kind || 'codex', status: 'running' }] };
    },
    async injectPeer() { boundary('inject'); },
    printResult(_ctx, value) { output = value; }
  });
  return {
    db, calls,
    async dispatch(extra = []) {
      await commands.cmdTask({ root: '/PRIVATE_ROOT', dbPath: '/PRIVATE_DB' }, [
        'dispatch', '--to', 'PRIVATE_PEER', '--title', 'PRIVATE_TITLE', ...extra
      ]);
      assert.equal(active, 0);
      return output;
    }
  };
}

const failure = (code, extra = {}) => new CliError(code, 'PRIVATE_ERROR', {
  runtime: '/PRIVATE_RUNTIME', message: 'PRIVATE_MESSAGE', token: 'PRIVATE_TOKEN',
  path: '/api/sessions/PRIVATE_PEER/input?token=PRIVATE_TOKEN', ...extra
});

for (const [stage, expectedStage, method, path] of [
  ['read', 'runtime_lookup', null, null],
  ['list', 'session_list', 'GET', '/api/sessions'],
  ['inject', 'input', 'POST', '/api/sessions/:peer/input']
]) {
  test(`dispatch retains safe ${stage} failure evidence without replaying delivery`, async t => {
    const code = stage === 'read' ? 'RUNTIME_NOT_RUNNING' : 'RUNTIME_UNREACHABLE';
    const f = fixture(t, { failAt: stage, error: failure(code,
      stage === 'read' ? {} : { elapsedMs: 42, timeoutMs: 40, errorName: 'TimeoutError' }) });
    const result = await f.dispatch();
    assert.equal(result.delivery, 'message-only');
    assert.equal(result.injection_reason, 'runtime_unavailable');
    const diagnostic = result.runtime_failure;
    assert.ok(diagnostic, 'runtime failure detail must survive dispatch');
    assert.deepEqual(diagnostic, {
      stage: expectedStage, code, method, path,
      elapsedMs: stage === 'read' ? diagnostic.elapsedMs : 42,
      timeoutMs: stage === 'read' ? null : 40,
      errorName: stage === 'read' ? null : 'TimeoutError'
    });
    assert.ok(Number.isSafeInteger(diagnostic.elapsedMs) && diagnostic.elapsedMs >= 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
    assert.deepEqual(f.calls, { read: 1, list: stage === 'read' ? 0 : 1, inject: stage === 'inject' ? 1 : 0 });
    const event = JSON.parse(f.db.prepare("SELECT payload FROM events WHERE type='task.dispatched'").get().payload);
    assert.deepEqual(event.runtime_failure, diagnostic);
    const summary = taskDispatchFailureDiagnostics('Error: task dispatch did not inject explicit shell-safe message:\n' + JSON.stringify(result) + '\n');
    assert.deepEqual(summary[0].runtimeFailure, diagnostic);
    assert.doesNotMatch(JSON.stringify([diagnostic, summary]), /PRIVATE/);
  });
}

test('dispatch records a real HTTP deadline and preserves the durable task', async t => {
  let requests = 0;
  const server = http.createServer(() => { requests++; });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const f = fixture(t, { request: (ctx, method, path) => runtimeRequest(ctx, method, path, null,
    { base_url: `http://127.0.0.1:${server.address().port}`, token: 'PRIVATE_TOKEN' }, { timeoutMs: 100 }) });
  const result = await f.dispatch();
  assert.equal(result.runtime_failure?.code, 'RUNTIME_UNREACHABLE');
  assert.equal(result.runtime_failure.timeoutMs, 100);
  assert.ok(result.runtime_failure.elapsedMs >= 0);
  assert.ok(['Error', 'TimeoutError'].includes(result.runtime_failure.errorName));
  assert.ok(requests <= 1, 'a timed out request is never replayed');
  assert.equal(f.calls.inject, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
});

test('successful, disabled and unsupported dispatches do not invent runtime failures', async t => {
  for (const [options, extra, reason] of [
    [{}, [], 'injected'], [{}, ['--no-inject'], 'no_inject'], [{ kind: 'shell' }, [], 'unsupported_session_kind']
  ]) {
    const f = fixture(t, options);
    const result = await f.dispatch(extra);
    assert.equal(result.injection_reason, reason);
    assert.equal(Object.hasOwn(result, 'runtime_failure'), false);
    const event = JSON.parse(f.db.prepare("SELECT payload FROM events WHERE type='task.dispatched'").get().payload);
    assert.equal(Object.hasOwn(event, 'runtime_failure'), false);
    if (reason === 'no_inject') assert.deepEqual(f.calls, { read: 0, list: 0, inject: 0 });
  }
});

test('dispatch reports a real connection failure without retaining the error URL or retrying', async t => {
  let requests = 0;
  const server = http.createServer(req => { requests++; req.socket.destroy(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const f = fixture(t, { request: (ctx, method, path) => runtimeRequest(ctx, method, path, null,
    { base_url: `http://127.0.0.1:${server.address().port}`, token: 'PRIVATE_TOKEN' }, { timeoutMs: 2000 }) });
  const result = await f.dispatch();
  assert.equal(result.runtime_failure?.code, 'RUNTIME_UNREACHABLE');
  assert.equal(result.runtime_failure.errorName, 'TypeError');
  assert.equal(result.runtime_failure.timeoutMs, 2000);
  assert.equal(requests, 1);
  assert.equal(f.calls.inject, 0);
  assert.doesNotMatch(JSON.stringify(result.runtime_failure), /PRIVATE|127\.0\.0\.1/);
});

test('dispatch filters malformed request metadata before result and event persistence', async t => {
  const f = fixture(t, { failAt: 'list', error: failure('RUNTIME_UNREACHABLE', {
    elapsedMs: 'PRIVATE_TIME', timeoutMs: -5, errorName: 'PRIVATE_NAME'
  }) });
  const result = await f.dispatch();
  assert.deepEqual(result.runtime_failure, { stage: 'session_list', code: 'RUNTIME_UNREACHABLE',
    method: 'GET', path: '/api/sessions', elapsedMs: null, timeoutMs: null, errorName: null });
  const event = JSON.parse(f.db.prepare("SELECT payload FROM events WHERE type='task.dispatched'").get().payload);
  assert.deepEqual(event.runtime_failure, result.runtime_failure);
});

test('dispatch keeps unexpected errors visible instead of downgrading them', async t => {
  const error = failure('UNAUTHORIZED');
  const f = fixture(t, { failAt: 'list', error });
  await assert.rejects(f.dispatch(), candidate => candidate === error);
  assert.equal(f.calls.inject, 0);
});
