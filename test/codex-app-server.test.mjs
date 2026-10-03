import test from 'node:test';
import { codexInteractiveConfig } from '../lib/integrations/codex-interactions.mjs';

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { createCodexAppServer } from '../lib/web/codex-app-server.mjs';

const TEST_CWD = process.cwd();
const thread = (id = 'thread-1', extra = {}) => ({ id, status: { type: 'idle' }, turns: [], cwd: '/project', ...extra });
const turn = (id = 'turn-1', extra = {}) => ({ id, status: 'inProgress', items: [], ...extra });
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeServer(t, { onRequest, ...options } = {}) {
  const process = new EventEmitter();
  const calls = [];
  const changes = [];
  const launches = [];
  process.pid = 32123;
  process.exitCode = null;
  process.signalCode = null;
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.kill = (signal) => {
    process.signalCode = signal;
    process.emit('exit', null, signal);
    return true;
  };
  function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
  function reply(message, result) { send({ id: message.id, result }); }
  let input = '';
  process.stdin = new Writable({
    write(chunk, _encoding, done) {
      input += String(chunk);
      let end;
      while ((end = input.indexOf('\n')) !== -1) {
        const message = JSON.parse(input.slice(0, end));
        input = input.slice(end + 1);
        calls.push(message);
        queueMicrotask(() => {
          if (message.method === 'initialize') {
            reply(message, { userAgent: 'codex/0.153.4', codexHome: '/fake/.codex', platformFamily: 'unix', platformOs: 'linux' });
          } else if (Object.hasOwn(message, 'id') && message.method) {
            if (onRequest?.(message, { send, reply }) === true) return;
            const responses = {
              'thread/start': { thread: thread() },
              'thread/resume': { thread: thread(message.params.threadId) },
              'thread/read': { thread: thread(message.params.threadId) },
              'thread/list': { data: [thread()], nextCursor: null },
              'turn/start': { turn: turn() },
              'turn/steer': { turnId: message.params.expectedTurnId },
              'turn/interrupt': {}
            };
            reply(message, responses[message.method] || {});
          }
        });
      }
      done();
    }
  });
  const adapter = createCodexAppServer({
    cwd: TEST_CWD,
    onChange: (state, event) => changes.push({ state, event }),
    spawnProcess: (...args) => { launches.push(args); return process; },
    ...options
  });
  t.after(() => adapter.close());
  return { adapter, process, calls, changes, launches, send, reply };
}

async function running(server) {
  await server.adapter.startThread();
  await server.adapter.startTurn('thread-1', 'work');
}

function approval(server, id = 'approval-1', extra = {}) {
  server.send({
    id, method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-1', command: 'npm test', cwd: '/project', ...extra }
  });
  return { ...server.adapter.snapshot().pendingApprovals.at(-1) };
}

test('App Server starts lazily, fixes its executable/transport, and handshakes once', async (t) => {
  const suppliedEnv = { PATH: '/fake/bin', HCC_PEER: 'codex-work', CODEX_HOME: '/protected', API_KEY: 'secret' };
  const s = fakeServer(t, { env: suppliedEnv });
  assert.equal(s.launches.length, 0);
  assert.equal(s.adapter.snapshot().status, 'new');
  await Promise.all([s.adapter.initialize(), s.adapter.initialize(), s.adapter.listThreads()]);
  assert.equal(s.launches.length, 1);
  const [executable, args, config] = s.launches[0];
  assert.equal(executable, 'codex');
  assert.deepEqual(args, ['app-server', '--listen', 'stdio://']);
  assert.deepEqual(config.env, suppliedEnv);
  assert.notEqual(config.env, suppliedEnv);
  assert.deepEqual(suppliedEnv, { PATH: '/fake/bin', HCC_PEER: 'codex-work', CODEX_HOME: '/protected', API_KEY: 'secret' });
  const init = s.calls.filter((call) => call.method === 'initialize');
  assert.equal(init.length, 1);
  assert.equal(init[0].params.capabilities.experimentalApi, true);
  assert.deepEqual(s.calls.find((call) => call.method === 'initialized'), { method: 'initialized' });
  assert.ok(s.calls.findIndex((call) => call.method === 'initialized') < s.calls.findIndex((call) => call.method === 'thread/list'));
  assert.equal(s.adapter.snapshot().pid, 32123);
  assert.equal(s.adapter.snapshot().status, 'ready');
  assert.equal(JSON.stringify(s.adapter.snapshot()).includes('secret'), false);
});

test('thread lifecycle keeps official responses and pins requested thread identity', async (t) => {
  const s = fakeServer(t);
  const result = await s.adapter.startThread({ model: 'test-model' });
  assert.equal(result.thread.id, 'thread-1');
  assert.deepEqual(s.calls.find((call) => call.method === 'thread/start').params, {
    cwd: TEST_CWD, sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user', model: 'test-model', config: codexInteractiveConfig()
  });
  await s.adapter.resumeThread('thread-2', { threadId: 'wrong' });
  await s.adapter.readThread('thread-2', { threadId: 'wrong', includeTurns: false });
  await s.adapter.listThreads({ cursor: 'page-2' });
  assert.equal(s.calls.find((call) => call.method === 'thread/resume').params.threadId, 'thread-2');
  assert.equal(s.calls.find((call) => call.method === 'thread/read').params.includeTurns, false);
  assert.equal(s.adapter.snapshot().threadId, 'thread-2');
  assert.equal(s.adapter.snapshot().threads.length, 2);
});

test('App Server refuses thread path handoffs after the selected directory is rebound', async t => {
  for (const method of ['thread/start', 'thread/resume', 'thread/fork']) {
    await t.test(method, async subtest => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-codex-path-'));
      subtest.after(() => fs.rmSync(base, { recursive: true, force: true }));
      const original = path.join(base, 'original');
      const replacement = path.join(base, 'replacement');
      const selected = path.join(base, 'selected');
      fs.mkdirSync(original);
      fs.mkdirSync(replacement);
      fs.symlinkSync(original, selected, 'dir');
      const s = fakeServer(subtest, { cwd: selected });
      try {
        await s.adapter.initialize();
        fs.unlinkSync(selected);
        fs.symlinkSync(replacement, selected, 'dir');
        const submit = method === 'thread/start' ? () => s.adapter.startThread()
          : method === 'thread/resume' ? () => s.adapter.resumeThread('owned-thread')
            : () => s.adapter.forkThread('owned-thread');
        await assert.rejects(submit(), { code: 'PROJECT_PATH_CHANGED' });
        assert.equal(s.calls.some(call => call.method === method), false);
      } finally { await s.adapter.close(); }
    });
  }
});

test('App Server keeps the selected cwd when callers supply a different thread cwd', async t => {
  const s = fakeServer(t);
  await s.adapter.startThread({ cwd: '/different-root' });
  assert.equal(s.calls.find(call => call.method === 'thread/start').params.cwd, TEST_CWD);
  await s.adapter.resumeThread('thread-2', { cwd: '/different-root' });
  assert.equal(s.calls.find(call => call.method === 'thread/resume').params.cwd, TEST_CWD);
});

test('fragmented JSONL and UTF-8 produce item, plan, diff and completion state', async (t) => {
  const s = fakeServer(t);
  await running(s);
  const data = Buffer.from(`${JSON.stringify({ method: 'item/agentMessage/delta', params: {
    threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: '继续测试'
  } })}\n`);
  const cut = data.indexOf(Buffer.from('续')) + 1;
  s.process.stdout.write(data.subarray(0, cut));
  s.process.stdout.write(data.subarray(cut));
  s.send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: '完成' } });
  s.send({ method: 'turn/plan/updated', params: { threadId: 'thread-1', turnId: 'turn-1', explanation: 'two steps', plan: [{ step: 'test', status: 'inProgress' }] } });
  s.send({ method: 'turn/diff/updated', params: { threadId: 'thread-1', turnId: 'turn-1', diff: '+ fixed' } });
  let state = s.adapter.snapshot();
  assert.equal(state.turnId, 'turn-1');
  assert.equal(state.threads[0].turns[0].items[0].text, '继续测试完成');
  assert.equal(state.threads[0].turns[0].diff, '+ fixed');
  assert.equal(state.threads[0].turns[0].plan[0].step, 'test');
  s.send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: turn('turn-1', { status: 'completed' }) } });
  state = s.adapter.snapshot();
  assert.equal(state.turnId, null);
  assert.equal(state.threads[0].status.type, 'idle');
  assert.equal(state.threads[0].turns[0].status, 'completed');
  assert.equal(state.threads[0].turns[0].items[0].text, '继续测试完成');
});

test('turn steer uses expectedTurnId and interrupt does not claim completion', async (t) => {
  const s = fakeServer(t);
  await running(s);
  await s.adapter.steer('thread-1', 'turn-1', 'also check docs');
  await s.adapter.interrupt('thread-1', 'turn-1');
  assert.deepEqual(s.calls.find((call) => call.method === 'turn/steer').params, {
    threadId: 'thread-1', expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'also check docs', text_elements: [] }]
  });
  assert.equal(s.calls.find((call) => call.method === 'turn/interrupt').params.turnId, 'turn-1');
  assert.equal(s.adapter.snapshot().turnId, 'turn-1');
  assert.throws(() => s.adapter.interrupt('thread-1', 'another-turn'), { code: 'CODEX_TURN_MISMATCH' });
});

test('streaming notifications coalesce while direct snapshots retain every text fragment', async (t) => {
  const s = fakeServer(t); await running(s);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  s.changes.length = 0;
  for (let index = 0; index < 100; index++) s.send({ method: 'item/agentMessage/delta', params: {
    threadId: 'thread-1', turnId: 'turn-1', itemId: 'stream', delta: '中' + index + '|'
  } });
  const expected = Array.from({ length: 100 }, (_, index) => '中' + index + '|').join('');
  assert.equal(s.changes.length, 0);
  assert.equal(s.adapter.snapshot().threads[0].turns[0].items[0].text, expected);
  t.mock.timers.tick(49); assert.equal(s.changes.length, 0);
  t.mock.timers.tick(1); assert.equal(s.changes.length, 1);
  assert.equal(s.changes[0].state.threads[0].turns[0].items[0].text, expected);
  assert.equal(s.changes[0].event.params.delta, '中99|');
  t.mock.timers.tick(1000); assert.equal(s.changes.length, 1);
});

test('continuous text updates cannot postpone the bounded publish interval', async (t) => {
  const s = fakeServer(t); await running(s);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  s.changes.length = 0;
  for (let index = 0; index < 20; index++) {
    s.send({ method: 'item/agentMessage/delta', params: {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'stream', delta: 'x'
    } });
    t.mock.timers.tick(10);
  }
  assert.equal(s.changes.length, 4);
  assert.deepEqual(s.changes.map(change => change.state.threads[0].turns[0].items[0].text.length), [5, 10, 15, 20]);
});

test('internal borrowed change views retain history identity and include every dirty text item in a batch', async t => {
  const updates = [];
  const s = fakeServer(t, { changeView: true, onChange: (state, event, metadata) => updates.push({ state, event, metadata }) });
  await running(s); t.mock.timers.enable({ apis: ['setTimeout'] }); updates.length = 0;
  for (const itemId of ['one', 'two']) s.send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId, delta: itemId } });
  const isolated = s.adapter.snapshot(); t.mock.timers.tick(50);
  const first = updates.at(-1); assert.equal(first.metadata.textOnly, true); assert.equal(first.metadata.textItems.length, 2);
  s.send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'one', delta: '-more' } });
  t.mock.timers.tick(50);
  assert.equal(first.state.threads[0], updates.at(-1).state.threads[0], 'internal observations borrow stable history rather than cloning it');
  assert.equal(isolated.threads[0].turns[0].items[0].text, 'one', 'public snapshots stay isolated');
  assert.ok(updates.at(-1).state.updateSequence > isolated.updateSequence);
});

test('provider token usage and runtime metadata are scoped facts and never imply context occupancy', async t => {
  const s = fakeServer(t, { onRequest(message, { reply }) {
    if (message.method === 'thread/start') { reply(message, { thread: thread(), model: 'fixture-model', approvalPolicy: 'on-request' }); return true; }
  } });
  await s.adapter.startThread();
  assert.deepEqual(s.adapter.snapshot().runtimeMetadata, { model: 'fixture-model', permissionMode: 'on-request' });
  assert.equal(Object.hasOwn(s.adapter.snapshot(), 'metrics'), false);
  s.send({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', tokenUsage: { total: { inputTokens: 80, outputTokens: 20, cachedInputTokens: 30, totalTokens: 100 }, modelContextWindow: 200000 } } });
  const usage = s.adapter.snapshot().metrics;
  assert.equal(usage.totalTokens, 100); assert.equal(usage.scope, 'session'); assert.equal(usage.contextWindow, 200000);
  assert.equal(Object.hasOwn(usage, 'contextTokens'), false); assert.equal(Object.hasOwn(usage, 'durationMs'), false);
  s.send({ method: 'thread/tokenUsage/updated', params: { threadId: 'foreign-thread', tokenUsage: { total: { totalTokens: 99999 } } } });
  assert.equal(s.adapter.snapshot().metrics.totalTokens, 100);
});

test('approval and completion publish immediately with pending text and cancel trailing stream updates', async (t) => {
  const s = fakeServer(t); await running(s);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  s.changes.length = 0;
  const delta = text => s.send({ method: 'item/agentMessage/delta', params: {
    threadId: 'thread-1', turnId: 'turn-1', itemId: 'stream', delta: text
  } });
  delta('Before approval'); approval(s, 'stream-approval');
  assert.equal(s.changes.length, 1);
  assert.equal(s.changes[0].event.method, 'approval.requested');
  assert.equal(s.changes[0].state.pendingApprovals[0].requestId, 'stream-approval');
  assert.equal(s.changes[0].state.threads[0].turns[0].items[0].text, 'Before approval');
  delta(' and completion');
  s.send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: turn('turn-1', { status: 'completed' }) } });
  assert.equal(s.changes.length, 2);
  assert.equal(s.changes[1].state.turnId, null);
  assert.equal(s.changes[1].state.pendingApprovals.length, 0);
  assert.equal(s.changes[1].state.threads[0].turns[0].items[0].text, 'Before approval and completion');
  t.mock.timers.tick(1000); assert.equal(s.changes.length, 2);
});

test('closing an executor publishes final state and leaves no delayed observer notification', async (t) => {
  const s = fakeServer(t); await running(s);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  s.changes.length = 0;
  s.send({ method: 'item/agentMessage/delta', params: {
    threadId: 'thread-1', turnId: 'turn-1', itemId: 'stream', delta: 'Retained at shutdown'
  } });
  await s.adapter.close();
  assert.equal(s.changes.at(-1).state.status, 'closed');
  assert.equal(s.changes.at(-1).state.threads[0].turns[0].items[0].text, 'Retained at shutdown');
  const count = s.changes.length;
  t.mock.timers.tick(1000); assert.equal(s.changes.length, count);
});

test('command approvals wait for a decision bound to executor/thread/turn/RPC id', async (t) => {
  const s = fakeServer(t);
  await running(s);
  const request = approval(s, 'approval-1', { approvalId: 'callback-1' });
  assert.equal(request.approvalId, 'callback-1');
  assert.equal(s.calls.some((call) => call.id === 'approval-1'), false);
  for (const invalid of [
    { executorId: 'old-executor' }, { threadId: 'another-thread' }, { turnId: 'another-turn' },
    { requestId: 'another-request' }, { decision: 'acceptForSession' }
  ]) {
    await assert.rejects(s.adapter.approve({ ...request, decision: 'accept', ...invalid }));
  }
  assert.equal(s.calls.some((call) => call.id === 'approval-1'), false);
  await s.adapter.approve({ ...request, decision: 'accept' });
  assert.deepEqual(s.calls.find((call) => call.id === 'approval-1'), { id: 'approval-1', result: { decision: 'accept' } });
  assert.equal(s.adapter.snapshot().pendingApprovals.length, 0);
  await assert.rejects(s.adapter.approve({ ...request, decision: 'accept' }), { code: 'CODEX_APPROVAL_MISMATCH' });
});

test('file approvals support declining, and resolved/completed requests expire', async (t) => {
  const s = fakeServer(t);
  await running(s);
  s.send({ id: 800, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'file-1' } });
  let request = s.adapter.snapshot().pendingApprovals[0];
  await s.adapter.approve({ ...request, decision: 'decline' });
  assert.deepEqual(s.calls.find((call) => call.id === 800), { id: 800, result: { decision: 'decline' } });
  request = approval(s, 801);
  s.send({ method: 'serverRequest/resolved', params: { threadId: 'wrong-thread', requestId: 801 } });
  assert.equal(s.adapter.snapshot().pendingApprovals.length, 1);
  s.send({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 801 } });
  await assert.rejects(s.adapter.approve({ ...request, decision: 'accept' }), { code: 'CODEX_APPROVAL_MISMATCH' });
  request = approval(s, 802);
  s.send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: turn('turn-1', { status: 'interrupted' }) } });
  await assert.rejects(s.adapter.approve({ ...request, decision: 'accept' }), { code: 'CODEX_TURN_MISMATCH' });
  assert.equal(s.adapter.snapshot().pendingApprovals.length, 0);
});

test('unsupported server requests return a protocol error and never grant permissions', async (t) => {
  const s = fakeServer(t);
  await running(s);
  s.send({ id: 'permission-1', method: 'item/unknown/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', permissions: { network: { enabled: true } } } });
  const answer = s.calls.find((call) => call.id === 'permission-1');
  assert.equal(answer.error.code, -32601);
  assert.equal(answer.result, undefined);
  assert.equal(s.adapter.snapshot().pendingApprovals.length, 0);
  assert.equal(s.changes.at(-1).event.method, 'serverRequest.unsupported');
});

test('accepting a truncated approval is rejected while cancelling remains possible', async (t) => {
  const s = fakeServer(t);
  await running(s);
  const request = approval(s, 'large-command', { command: 'x'.repeat(70000) });
  assert.equal(request.truncated, true);
  await assert.rejects(s.adapter.approve({ ...request, decision: 'accept' }), { code: 'CODEX_APPROVAL_TRUNCATED' });
  await s.adapter.approve({ ...request, decision: 'cancel' });
  assert.deepEqual(s.calls.find((call) => call.id === 'large-command'), { id: 'large-command', result: { decision: 'cancel' } });
});

test('active or concurrently submitted turns cannot receive a second start', async (t) => {
  let held;
  const s = fakeServer(t, { onRequest: (message) => {
    if (message.method === 'turn/start') { held = message; return true; }
  } });
  await s.adapter.startThread();
  const first = s.adapter.startTurn('thread-1', 'one');
  await tick();
  await assert.rejects(s.adapter.startTurn('thread-1', 'two'), { code: 'CODEX_THREAD_BUSY' });
  assert.equal(s.calls.filter((call) => call.method === 'turn/start').length, 1);
  s.reply(held, { turn: turn() });
  await first;
  await assert.rejects(s.adapter.startTurn('thread-1', 'three'), { code: 'CODEX_THREAD_BUSY' });
});

test('thread status active remains authoritative when read response contains completed history', async (t) => {
  const s = fakeServer(t, { onRequest: (message, { reply }) => {
    if (message.method === 'thread/resume') {
      reply(message, { thread: thread('thread-1', { status: { type: 'active', activeFlags: [] }, turns: [turn('older', { status: 'completed' })] }) });
      return true;
    }
  } });
  await s.adapter.resumeThread('thread-1');
  await assert.rejects(s.adapter.startTurn('thread-1', 'new work'), { code: 'CODEX_THREAD_BUSY' });
  assert.equal(s.calls.filter((call) => call.method === 'turn/start').length, 0);
});

test('completion before turn/start acknowledgement cannot resurrect the finished turn', async (t) => {
  const s = fakeServer(t, { onRequest: (message, { send, reply }) => {
    if (message.method === 'turn/start') {
      send({ method: 'turn/started', params: { threadId: 'thread-1', turn: turn() } });
      send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: turn('turn-1', { status: 'completed', itemsView: 'notLoaded' }) } });
      reply(message, { turn: turn() });
      return true;
    }
  } });
  await running(s);
  assert.equal(s.adapter.snapshot().turnId, null);
  assert.equal(s.adapter.snapshot().threads[0].turns[0].status, 'completed');
});

test('thread/read response from before an active notification cannot clear live turn state', async (t) => {
  const s = fakeServer(t, { onRequest: (message, { send, reply }) => {
    if (message.method === 'thread/read') {
      send({ method: 'turn/started', params: { threadId: 'thread-1', turn: turn('new-turn') } });
      reply(message, { thread: thread('thread-1') });
      return true;
    }
  } });
  await s.adapter.startThread();
  await s.adapter.readThread('thread-1');
  assert.equal(s.adapter.snapshot().turnId, 'new-turn');
  await assert.rejects(s.adapter.startTurn('thread-1', 'other work'), { code: 'CODEX_THREAD_BUSY' });
});

test('timeout marks a submitted turn uncertain and late acknowledgement reconciles without replay', async (t) => {
  let held;
  const s = fakeServer(t, { requestTimeoutMs: 30, onRequest: (message) => {
    if (message.method === 'turn/start') { held = message; return true; }
  } });
  await s.adapter.startThread();
  await assert.rejects(s.adapter.startTurn('thread-1', 'private prompt'), { code: 'CODEX_SUBMISSION_UNCERTAIN' });
  let state = s.adapter.snapshot();
  assert.equal(state.uncertainSubmissions.length, 1);
  assert.equal(state.uncertainSubmissions[0].threadId, 'thread-1');
  assert.equal(JSON.stringify(state.uncertainSubmissions).includes('private prompt'), false);
  await s.adapter.readThread('thread-1');
  assert.equal(s.adapter.snapshot().uncertainSubmissions.length, 1);
  assert.equal(s.adapter.snapshot().uncertainRecovery, 'stop-executor-and-resume-history');
  await assert.rejects(s.adapter.startTurn('thread-1', 'retry'), { code: 'CODEX_THREAD_BUSY' });
  s.reply(held, { turn: turn('late-turn') });
  state = s.adapter.snapshot();
  assert.equal(state.uncertainSubmissions.length, 0);
  assert.equal(state.turnId, 'late-turn');
  assert.equal(s.calls.filter((call) => call.method === 'turn/start').length, 1);
  assert.equal(s.changes.at(-1).event.method, 'request.reconciled');
});

test('transport loss preserves submission uncertainty and cannot respawn or replay', async (t) => {
  const s = fakeServer(t, { onRequest: (message) => {
    if (message.method === 'turn/start') {
      s.process.exitCode = 1;
      s.process.emit('exit', 1, null);
      return true;
    }
  } });
  await s.adapter.startThread();
  await assert.rejects(s.adapter.startTurn('thread-1', 'work'), { code: 'CODEX_SUBMISSION_UNCERTAIN' });
  assert.equal(s.adapter.snapshot().status, 'disconnected');
  assert.equal(s.adapter.snapshot().uncertainSubmissions.length, 1);
  await assert.rejects(s.adapter.listThreads(), { code: 'CODEX_DISCONNECTED' });
  assert.equal(s.launches.length, 1);
  assert.equal(s.calls.filter((call) => call.method === 'turn/start').length, 1);
});

test('uncertain thread creation is not repeated before thread identity is confirmed', async (t) => {
  const s = fakeServer(t, { requestTimeoutMs: 30, onRequest: (message) => message.method === 'thread/start' });
  await assert.rejects(s.adapter.startThread(), { code: 'CODEX_SUBMISSION_UNCERTAIN' });
  await assert.rejects(s.adapter.startThread(), { code: 'CODEX_SUBMISSION_UNCERTAIN' });
  assert.equal(s.calls.filter((call) => call.method === 'thread/start').length, 1);
  assert.equal(s.adapter.snapshot().threadId, null);
});

test('known RPC failure is reported as failure rather than uncertain submission', async (t) => {
  const s = fakeServer(t, { onRequest: (message, { send }) => {
    if (message.method === 'turn/start') {
      send({ id: message.id, error: { code: -32600, message: 'not allowed' } });
      return true;
    }
  } });
  await s.adapter.startThread();
  await assert.rejects(s.adapter.startTurn('thread-1', 'work'), { code: 'CODEX_RPC_ERROR', message: 'not allowed' });
  assert.equal(s.adapter.snapshot().uncertainSubmissions.length, 0);
});

test('malformed protocol invalidates approval handles and closes the transport', async (t) => {
  const s = fakeServer(t);
  await running(s);
  const request = approval(s);
  s.process.stdout.write('not-json\n');
  assert.equal(s.adapter.snapshot().status, 'disconnected');
  assert.equal(s.adapter.snapshot().pendingApprovals.length, 0);
  await assert.rejects(s.adapter.approve({ ...request, decision: 'accept' }));
  assert.equal(s.process.signalCode, 'SIGTERM');
});

test('snapshot text and event retention are bounded and snapshots cannot mutate state', async (t) => {
  const s = fakeServer(t);
  await running(s);
  s.send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 'x'.repeat(200000) } });
  for (let i = 0; i < 110; i += 1) s.send({ method: 'turn/plan/updated', params: { threadId: 'thread-1', turnId: 'turn-1', plan: [{ step: `step-${i}`, status: 'completed' }] } });
  const state = s.adapter.snapshot();
  assert.equal(state.truncated, true);
  assert.ok(state.events.length <= 100);
  assert.ok(state.threads[0].turns[0].items[0].text.length < 66000);
  state.threads[0].id = 'mutated';
  assert.equal(s.adapter.snapshot().threads[0].id, 'thread-1');
});

test('close is idempotent, terminates only its child, and refuses new work', async (t) => {
  const s = fakeServer(t);
  await s.adapter.startThread();
  await Promise.all([s.adapter.close(), s.adapter.close()]);
  assert.equal(s.adapter.snapshot().status, 'closed');
  assert.equal(s.process.signalCode, 'SIGTERM');
  await assert.rejects(s.adapter.startThread(), { code: 'CODEX_DISCONNECTED' });
  assert.equal(s.launches.length, 1);
});

test('private scoped MCP config waits for the server handshake and is injected into start/resume without exposing it in state', async t => {
  let s, prepared = 0;
  const config = { mcp_servers: { hello_cc_scoped: { command: '/node', args: ['/hcc', 'mcp', 'serve'],
    env: { HCC_MCP_BOOTSTRAP_TOKEN: 'private-scope-token' } } } };
  s = fakeServer(t, { onSpawn: async ({ pid, executorId }) => {
    assert.equal(pid, 32123);
    assert.deepEqual(s.calls.map(call => call.method), ['initialize', 'initialized']);
    assert.ok(executorId); prepared++; return config;
  } });
  await s.adapter.startThread(); await s.adapter.resumeThread('thread-2');
  assert.equal(prepared, 1);
  assert.deepEqual(s.calls.find(call => call.method === 'thread/start').params.config, codexInteractiveConfig(config));
  assert.deepEqual(s.calls.find(call => call.method === 'thread/resume').params.config, codexInteractiveConfig(config));
  assert.equal(JSON.stringify(s.adapter.snapshot()).includes('private-scope-token'), false);
});

test('history peek leaves active thread, turn and approvals unchanged', async t => {
  const s = fakeServer(t); await running(s); approval(s);
  const before = s.adapter.snapshot();
  const history = await s.adapter.peekThread('unmanaged-history');
  assert.equal(history.thread.id, 'unmanaged-history');
  const after = s.adapter.snapshot();
  assert.equal(after.threadId, before.threadId); assert.equal(after.turnId, before.turnId);
  assert.deepEqual(after.threads, before.threads); assert.deepEqual(after.pendingApprovals, before.pendingApprovals);
});

test('transport loss during private configuration never revives the executor or submits a thread', async t => {
  let s;
  s = fakeServer(t, { onSpawn: async () => {
    s.process.exitCode = 1;
    s.process.emit('exit', 1, null);
    return { mcp_servers: {} };
  } });
  await assert.rejects(s.adapter.startThread(), { code: 'CODEX_DISCONNECTED' });
  assert.equal(s.adapter.snapshot().status, 'disconnected');
  assert.equal(s.calls.some(call => call.method === 'thread/start'), false);
});

test('fork rechecks authorization after initialization and an uncertain fork is not automatically repeated', async t => {
  const s = fakeServer(t, { requestTimeoutMs: 10,
    onRequest: message => message.method === 'thread/fork' });
  await assert.rejects(s.adapter.forkThread('source-thread', {}, () => { throw new Error('control changed'); }), /control changed/);
  assert.equal(s.calls.filter(call => call.method === 'thread/fork').length, 0);
  await assert.rejects(s.adapter.forkThread('source-thread'), { code: 'CODEX_SUBMISSION_UNCERTAIN' });
  assert.equal(s.adapter.snapshot().uncertainSubmissions[0].threadId, null);
  await assert.rejects(s.adapter.forkThread('source-thread'), { code: 'CODEX_SUBMISSION_UNCERTAIN' });
  assert.equal(s.calls.filter(call => call.method === 'thread/fork').length, 1);
});

test('permission requests stay pending and grant only an explicit requested subset and duration', async t => {
  const s = fakeServer(t); await running(s);
  s.send({ id: 'permission', method: 'item/permissions/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', permissions: { network: { enabled: true }, fileSystem: { read: ['/project'] } } } });
  const pending = s.adapter.snapshot().pendingApprovals[0];
  assert.equal(pending.kind, 'permissions'); assert.equal(s.calls.some(c => c.id === 'permission'), false);
  await assert.rejects(s.adapter.approve({ ...pending, decision: 'accept', permissions: { fileSystem: { write: ['/'] } }, scope: 'turn' }));
  await s.adapter.approve({ ...pending, decision: 'accept', permissions: { network: { enabled: true } }, scope: 'turn' });
  assert.deepEqual(s.calls.find(c => c.id === 'permission').result, { permissions: { network: { enabled: true } }, scope: 'turn' });
});

test('question responses preserve official answer shape without storing secret answer content', async t => {
  const s = fakeServer(t); await running(s);
  s.send({ id: 500, method: 'item/tool/requestUserInput', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'questions', questions: [{ id: 'choice', header: 'Choice', question: 'Which?', options: [{ label: 'One', description: '' }] }, { id: 'secret', isSecret: true }] } });
  const pending = s.adapter.snapshot().pendingApprovals[0]; assert.equal(pending.kind, 'userInput');
  await assert.rejects(s.adapter.approve({ ...pending, answers: { choice: { answers: ['Other'] } } }));
  await s.adapter.approve({ ...pending, answers: { choice: { answers: ['One'] }, secret: { answers: ['hidden-answer'] } } });
  assert.equal(s.calls.find(c => c.id === 500).result.answers.secret.answers[0], 'hidden-answer');
  assert.equal(JSON.stringify(s.adapter.snapshot()).includes('hidden-answer'), false);
});

test('interrupt expires pending questions and refuses a late human response', async t => {
  const s = fakeServer(t); await running(s);
  s.send({ id: 'question', method: 'item/tool/requestUserInput', params: { threadId: 'thread-1', turnId: 'turn-1', questions: [{ id: 'q' }] } });
  const pending = s.adapter.snapshot().pendingApprovals[0];
  await s.adapter.interrupt('thread-1', 'turn-1');
  assert.deepEqual(s.calls.find(c => c.id === 'question').result, { answers: {} });
  assert.equal(s.adapter.snapshot().pendingApprovals.length, 0);
  await assert.rejects(s.adapter.approve({ ...pending, answers: { q: { answers: ['late'] } } }));
});


test('Web App Server responds to correlated MCP tool approvals with action/content', async (t) => {
  const s = fakeServer(t); await running(s);
  s.send({ id: 'mcp-approval', method: 'mcpServer/elicitation/request', params: {
    threadId: 'thread-1', turnId: 'turn-1', serverName: 'hello_cc_scoped', mode: 'form',
    _meta: { codex_approval_kind: 'mcp_tool_call' }, requestedSchema: { type: 'object', properties: {} } } });
  const request = s.adapter.snapshot().pendingApprovals[0];
  await s.adapter.approve({ ...request, decision: 'accept' });
  assert.deepEqual(s.calls.find(call => call.id === 'mcp-approval').result, { action: 'accept', content: {} });
});

test('Web cancels standalone MCP elicitation without closing its transport or granting permissions', async (t) => {
  const s = fakeServer(t); await running(s);
  s.send({ id: 0, method: 'mcpServer/elicitation/request', params: { threadId: 'thread-1', turnId: null, serverName: 'hello_cc_scoped', mode: 'url' } });
  assert.deepEqual(s.calls.find(call => call.id === 0).result, { action: 'cancel' });
  assert.equal(s.adapter.snapshot().pendingApprovals.length, 0);
  assert.notEqual(s.adapter.snapshot().status, 'failed');
});

test('Web interactive Codex enables request tools without granting permissions', async (t) => {
  const privateConfig = { mcp_servers: { scoped: { command: '/node' } } };
  const s = fakeServer(t, { onSpawn: () => privateConfig });
  const params = { config: { custom_setting: 'kept', 'features.request_permissions_tool': false } };
  await s.adapter.startThread(params);
  await s.adapter.resumeThread('thread-2', params);
  await s.adapter.forkThread('thread-2', params);
  for (const method of ['thread/start', 'thread/resume', 'thread/fork']) {
    const request = s.calls.find(call => call.method === method).params;
    assert.equal(request.config['features.default_mode_request_user_input'], true);
    assert.equal(request.config['features.request_permissions_tool'], true);
    assert.deepEqual(request.config.mcp_servers, privateConfig.mcp_servers);
    assert.equal(request.config.custom_setting, 'kept');
    assert.equal(request.approvalPolicy, 'on-request');
    assert.equal(request.approvalsReviewer, 'user');
    assert.equal(Object.hasOwn(request, 'permissions'), false);
  }
  assert.deepEqual(privateConfig, { mcp_servers: { scoped: { command: '/node' } } });
  assert.equal(params.config['features.request_permissions_tool'], false);
});

test('Web App Server MCP forms retain the exact RPC identity, reject invalid content and avoid response persistence', async (t) => {
  const s = fakeServer(t); await running(s);
  s.send({ id: 0, method: 'mcpServer/elicitation/request', params: { threadId: 'thread-1', turnId: 'turn-1', serverName: 'form-server', mode: 'form',
    message: 'Project settings', requestedSchema: { type: 'object', properties: { note: { type: 'string', minLength: 3 }, enabled: { type: 'boolean' } }, required: ['note', 'enabled'] } } });
  const request = s.adapter.snapshot().pendingApprovals[0];
  assert.deepEqual(s.adapter.snapshot().threads[0].status.activeFlags, ['waitingOnUserInput']);
  await assert.rejects(s.adapter.approve({ ...request, decision: 'accept', content: { note: 'x', enabled: false } }));
  await assert.rejects(s.adapter.approve({ ...request, turnId: 'stale', decision: 'accept', content: { note: 'private-mcp-value', enabled: false } }));
  assert.equal(s.calls.some(call => call.id === 0), false);
  const receipt = await s.adapter.approve({ ...request, decision: 'accept', content: { note: 'private-mcp-value', enabled: false } });
  assert.deepEqual(s.calls.find(call => call.id === 0), { id: 0, result: { action: 'accept', content: { note: 'private-mcp-value', enabled: false } } });
  assert.equal(JSON.stringify({ receipt, state: s.adapter.snapshot(), changes: s.changes }).includes('private-mcp-value'), false);
  await assert.rejects(s.adapter.approve({ ...request, decision: 'accept', content: { note: 'repeated', enabled: true } }), { code: 'CODEX_APPROVAL_MISMATCH' });
});

test('Web-owned URL flow retains RPC zero without persisting its link or confusing acceptance with task completion', async t => {
  const s = fakeServer(t); await running(s);
  s.send({ id: 0, method: 'mcpServer/elicitation/request', params: { threadId: 'thread-1', turnId: 'turn-1', mode: 'url', serverName: 'url-server',
    elicitationId: 'private-flow', url: 'https://auth.example/device?code=private-url-code', message: 'private-device-code', _meta: { flow: 'private-metadata' } } });
  const pending = s.adapter.snapshot().pendingApprovals[0];
  assert.equal(pending.params.url.includes('private-url-code'), true);
  assert.equal(JSON.stringify(s.adapter.snapshot().events).includes('private-url-code'), false);
  assert.equal(JSON.stringify(s.adapter.snapshot().events).includes('private-device-code'), false);
  await assert.rejects(s.adapter.approve({ ...pending, decision: 'accept', content: {} }));
  await assert.rejects(s.adapter.approve({ ...pending, executorId: 'stale-worker', decision: 'accept' }));
  assert.equal(s.calls.some(call => call.id === 0), false);
  const receipt = await s.adapter.approve({ ...pending, decision: 'accept' });
  assert.deepEqual(s.calls.find(call => call.id === 0), { id: 0, result: { action: 'accept' } });
  assert.equal(receipt.status, 'submitted');
  assert.equal(s.adapter.snapshot().turnId, 'turn-1');
  assert.equal(s.adapter.snapshot().pendingApprovals.length, 0);
  const history = JSON.stringify({ receipt, state: s.adapter.snapshot(), events: s.changes.map(change => change.event) });
  for (const secret of ['private-flow', 'private-url-code', 'private-device-code', 'private-metadata']) assert.equal(history.includes(secret), false);
  await assert.rejects(s.adapter.approve({ ...pending, decision: 'accept' }), { code: 'CODEX_APPROVAL_MISMATCH' });
});


test('Web account projection reads the same busy executor without touching its active turn or exposing credentials', async t => {
  const f=fakeServer(t,{onRequest(message,{reply}) {
    if(message.method==='account/read') { reply(message,{requiresOpenaiAuth:true,account:{type:'chatgpt',planType:'plus',email:'private-account@test',accessToken:'private-token'}}); return true; }
    if(message.method==='account/rateLimits/read') { reply(message,{rateLimits:{primary:{usedPercent:42,windowDurationMins:300}}}); return true; }
  }});
  await running(f); const before=f.adapter.snapshot();
  const value=await f.adapter.readAccount(), after=f.adapter.snapshot();
  assert.equal(value.authentication,'authenticated'); assert.equal(value.rateLimits.buckets[0].primary.usedPercent,42);
  assert.equal(after.executorId,before.executorId); assert.equal(after.turnId,before.turnId); assert.equal(f.launches.length,1);
  assert.deepEqual(f.calls.filter(c=>c.method.startsWith('account/')).map(({method,params})=>({method,params})),[
    {method:'account/read',params:{refreshToken:false}},{method:'account/rateLimits/read',params:{}}]);
  assert.doesNotMatch(JSON.stringify(f.changes),/private-account|private-token|accessToken/);
});

test('account notification and RPC error payloads are never retained in Web events or approvals', async t => {
  const f=fakeServer(t,{onRequest(message,{send}) {
    if(message.method==='account/read') { send({id:message.id,error:{code:-32601,message:'secret-auth-error',data:{accessToken:'secret-auth-token'}}}); return true; }
  }});
  await f.adapter.startThread(); await f.adapter.readAccount();
  f.send({method:'account/login/completed',params:{success:true,loginId:'secret-login-id',error:'secret-login-error'}});
  await tick(); await tick();
  const value=f.adapter.snapshot(); assert.equal(value.account.status,'unavailable');
  assert.equal(value.account.reason,'unsupported'); assert.deepEqual(value.pendingApprovals,[]);
  assert.doesNotMatch(JSON.stringify([value,f.changes]),/secret-|accessToken|loginId/);
  assert.equal(f.calls.filter(c=>c.method==='thread/start').length,1);
});
