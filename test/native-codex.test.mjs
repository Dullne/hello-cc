import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexAdapter } from '../lib/integrations/native/codex.mjs';

function fixture(handler = () => undefined, options = {}) {
  const events = [];
  const calls = [];
  let callbacks;
  let closeCount = 0;
  const rpc = {
    async start() { calls.push(['start']); },
    async request(method, params) {
      calls.push([method, params]);
      const response = await handler(method, params, callbacks);
      if (response !== undefined) return response;
      if (method === 'initialize') return { userAgent: 'fixture' };
      if (method === 'thread/start') return { thread: { id: 'owned-thread', turns: [] } };
      if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [] } };
      if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'inProgress' } };
      if (method === 'turn/steer') return { turnId: params.expectedTurnId };
      return {};
    },
    async notify(method, params) { calls.push([method, params]); },
    async close() { closeCount++; }
  };
  const adapter = createCodexAdapter({ cwd: '/project', env: { PATH: '/bin' },
    ...options, onEvent: (event) => events.push(event), rpcFactory(config) { callbacks = config; return rpc; } });
  return { adapter, calls, events, rpc, get callbacks() { return callbacks; }, get closeCount() { return closeCount; } };
}

test('Codex opens its own stdio app-server with handshake and bounded permissions', async () => {
  const f = fixture();
  assert.equal((await f.adapter.open({ model: 'test-model' })).status, 'idle');
  assert.deepEqual(f.calls, [ ['start'],
    ['initialize', { clientInfo: { name: 'hello_cc', version: '1.0.1' }, capabilities: { experimentalApi: false } }],
    ['initialized', {}], ['thread/start', { cwd: '/project', model: 'test-model',
      sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' }] ]);
  assert.deepEqual(f.callbacks.args, ['app-server', '--stdio']);
  assert.equal(f.callbacks.binary, 'codex');
  assert.equal(f.adapter.capabilities.fork, false);
  await assert.rejects(f.adapter.open(), { code: 'NATIVE_SESSION_ALREADY_OPEN' });
});

test('Codex resumes an explicitly supplied HCC thread through its owned server', async () => {
  const f = fixture();
  const result = await f.adapter.open({ sessionId: 'hcc-saved-thread' });
  assert.equal(result.sessionId, 'hcc-saved-thread');
  assert.equal(f.calls.at(-1)[0], 'thread/resume');
  assert.equal(f.calls.at(-1)[1].threadId, 'hcc-saved-thread');
  await f.adapter.close();
  assert.equal(f.closeCount, 1);
});

test('Codex admits concurrent sends as start then steer with the active turn precondition', async () => {
  const f = fixture();
  await f.adapter.open();
  const receipts = await Promise.all([f.adapter.send({ text: 'first', submissionId: 'message-a' }),
    f.adapter.send({ text: 'follow-up', submissionId: 'message-b' })]);
  assert.deepEqual(receipts.map((r) => r.status), ['accepted', 'accepted']);
  assert.deepEqual(f.calls.slice(-2), [
    ['turn/start', { threadId: 'owned-thread', input: [{ type: 'text', text: 'first' }], clientUserMessageId: 'message-a' }],
    ['turn/steer', { threadId: 'owned-thread', input: [{ type: 'text', text: 'follow-up' }],
      expectedTurnId: 'turn-1', clientUserMessageId: 'message-b' }]
  ]);
  await assert.rejects(f.adapter.send({ text: 'stale', expectedTurnId: 'old-turn' }), { code: 'NATIVE_TURN_MISMATCH' });
});

test('Codex does not convert a raced or protocol-rejected steer into a new turn', async () => {
  const failure = Object.assign(new Error('no active turn to steer'), { code: -32600 });
  const f = fixture((method, params, callbacks) => {
    if (method === 'turn/steer') {
      callbacks.onNotification('turn/completed', { threadId: params.threadId, turn: { id: 'turn-1', status: 'completed' } });
      throw failure;
    }
  });
  await f.adapter.open();
  await f.adapter.send({ text: 'task' });
  await assert.rejects(f.adapter.send({ text: 'race' }), (error) => error === failure);
  assert.equal(f.adapter.snapshot().status, 'idle');
  assert.equal(f.calls.filter(([method]) => method === 'turn/start').length, 1);
});

test('Codex preserves completed state if completion precedes the admission response', async () => {
  const f = fixture((method, params, callbacks) => {
    if (method === 'turn/start') {
      callbacks.onNotification('turn/completed', { threadId: params.threadId, turn: { id: 'turn-1', status: 'completed' } });
      return { turn: { id: 'turn-1', status: 'inProgress' } };
    }
  });
  await f.adapter.open();
  assert.equal((await f.adapter.send({ text: 'quick task', submissionId: 'message-fast' })).status, 'accepted');
  assert.equal(f.adapter.snapshot().status, 'idle');
  assert.equal(f.adapter.snapshot().turnId, null);
  assert.deepEqual(f.events.find((event) => event.type === 'completed'), {
    provider: 'codex', sessionId: 'owned-thread', type: 'completed', status: 'completed',
    turnId: 'turn-1', submissionId: 'message-fast', text: undefined
  });
});

test('Codex forwards only its own thread output and observes completion', async () => {
  const f = fixture();
  await f.adapter.open();
  await f.adapter.send({ text: 'task' });
  const notify = f.callbacks.onNotification;
  notify('item/agentMessage/delta', { threadId: 'other-thread', turnId: 'other', delta: 'foreign' });
  notify('turn/completed', { threadId: 'other-thread', turn: { id: 'turn-1', status: 'completed' } });
  assert.equal(f.adapter.snapshot().status, 'busy');
  notify('item/agentMessage/delta', { threadId: 'owned-thread', turnId: 'turn-1', delta: 'part' });
  notify('item/completed', { threadId: 'owned-thread', turnId: 'turn-1', item: { type: 'agentMessage', id: 'item-1', text: 'answer' } });
  assert.deepEqual(f.events.filter((event) => ['delta', 'message'].includes(event.type)).map((event) => event.text), ['part', 'answer']);
  await f.adapter.interrupt();
  assert.deepEqual(f.calls.at(-1), ['turn/interrupt', { threadId: 'owned-thread', turnId: 'turn-1' }]);
  assert.equal(f.adapter.snapshot().status, 'busy');
  notify('turn/completed', { threadId: 'owned-thread', turn: { id: 'turn-1', status: 'interrupted' } });
  assert.equal(f.adapter.snapshot().status, 'idle');
  assert.equal(f.events.find((event) => event.type === 'completed').status, 'interrupted');
});

test('Codex preserves uncertain admission after a timeout until authoritative turn events arrive', async () => {
  const f = fixture((method) => {
    if (method === 'turn/start') throw Object.assign(new Error('request timed out'), {
      code: 'NATIVE_REQUEST_TIMEOUT', extra: { uncertain: true, method }
    });
  });
  await f.adapter.open();
  await assert.rejects(f.adapter.send({ text: 'maybe running' }), { code: 'NATIVE_REQUEST_TIMEOUT' });
  assert.equal(f.adapter.snapshot().status, 'uncertain');
  await assert.rejects(f.adapter.send({ text: 'unsafe retry' }), { code: 'NATIVE_SESSION_NOT_OPEN' });
  f.callbacks.onNotification('turn/started', { threadId: 'owned-thread', turn: { id: 'late-turn' } });
  assert.equal(f.adapter.snapshot().status, 'busy');
});

test('Codex denies command, file and permission approvals without granting access', async () => {
  const f = fixture();
  await f.adapter.open();
  const params = { threadId: 'owned-thread', turnId: 'turn-1', itemId: 'item-1' };
  for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']) {
    assert.deepEqual(await f.callbacks.onRequest(method, params), { decision: 'decline' });
  }
  assert.deepEqual(await f.callbacks.onRequest('item/permissions/requestApproval', params), { permissions: {}, scope: 'turn' });
  assert.equal(f.events.filter((event) => event.type === 'approval').length, 3);
  assert.throws(() => f.callbacks.onRequest('unknown/requestApproval', params), { code: 'NATIVE_SERVER_REQUEST_UNSUPPORTED' });
});

test('Codex protocol negotiation errors remain visible and clean up only the owned RPC', async () => {
  const f = fixture((method) => {
    if (method === 'thread/start') throw Object.assign(new Error('unsupported sandbox enum'), { code: -32602 });
  });
  await assert.rejects(f.adapter.open(), { code: -32602 });
  assert.equal(f.adapter.snapshot().status, 'error');
  assert.equal(f.closeCount, 1);
  assert.equal(f.events.at(-1).text, 'unsupported sandbox enum');
});

test('Codex process exit invalidates sends, and close is idempotent and owned-only', async () => {
  const f = fixture();
  await f.adapter.open();
  f.callbacks.onExit({ code: 7, signal: null });
  assert.equal(f.adapter.snapshot().status, 'error');
  await assert.rejects(f.adapter.send({ text: 'after exit' }), { code: 'NATIVE_SESSION_NOT_OPEN' });
  await f.adapter.close();
  await f.adapter.close();
  assert.equal(f.closeCount, 1);
  assert.equal(f.adapter.snapshot().status, 'closed');
  const count = f.events.length;
  f.callbacks.onNotification('turn/started', { threadId: 'owned-thread', turn: { id: 'late-turn' } });
  f.callbacks.onExit({ code: 0 });
  assert.equal(f.events.length, count);
});

test('Codex forwards transport protocol and cleanup uncertainty without claiming exit', async () => {
  const f = fixture();
  await f.adapter.open();
  await f.adapter.send({ text: 'running task', submissionId: 'message-protocol' });
  f.callbacks.onError(Object.assign(new Error('invalid frame'), {
    code: 'NATIVE_PROTOCOL_ERROR', extra: { uncertain: true }
  }));
  f.callbacks.onError(Object.assign(new Error('cannot confirm termination'), {
    code: 'NATIVE_CLOSE_FAILED', extra: { pid: 1234, uncertain: true, cause: 'EPERM' }
  }));
  assert.equal(f.adapter.snapshot().status, 'error');
  assert.equal(f.adapter.snapshot().turnId, 'turn-1');
  assert.deepEqual(f.events.filter((event) => event.type === 'error'), [
    { provider: 'codex', sessionId: 'owned-thread', type: 'error', code: 'NATIVE_PROTOCOL_ERROR',
      text: 'invalid frame', turnId: 'turn-1', extra: { uncertain: true } },
    { provider: 'codex', sessionId: 'owned-thread', type: 'error', code: 'NATIVE_CLOSE_FAILED',
      text: 'cannot confirm termination', turnId: 'turn-1', extra: { pid: 1234, uncertain: true, cause: 'EPERM' } }
  ]);
  assert.equal(f.events.some((event) => event.code === 'NATIVE_PROCESS_EXITED'), false);
  await assert.rejects(f.adapter.send({ text: 'unsafe retry' }), { code: 'NATIVE_SESSION_NOT_OPEN' });
  await f.adapter.close();
});

test('concurrent Codex adapter close calls wait for the same owned transport teardown', async () => {
  const f = fixture();
  await f.adapter.open();
  let release;
  let closes = 0;
  f.rpc.close = () => { closes++; return new Promise((resolve) => { release = resolve; }); };
  const first = f.adapter.close();
  const second = f.adapter.close();
  assert.equal(first, second);
  let finished = false;
  second.then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(closes, 1);
  release();
  await first;
  assert.equal(finished, true);
});

test('hosted Codex keeps human approvals pending on the original turn with exact request fencing', async () => {
  const f = fixture(undefined, { interactive: true, executorId: 'native-owner' });
  await f.adapter.open(); await f.adapter.send({ text: 'work' });
  const reply = f.callbacks.onRequest('item/commandExecution/requestApproval', { threadId: 'owned-thread', turnId: 'turn-1', command: 'npm test' }, 42);
  const request = f.adapter.snapshot().pendingApprovals[0];
  assert.equal(request.executorId, 'native-owner'); assert.equal(f.adapter.capabilities.approvals, true);
  assert.throws(() => f.adapter.respond({ ...request, executorId: 'stale-owner', decision: 'accept' }));
  f.adapter.respond({ ...request, decision: 'accept' }); assert.deepEqual(await reply, { decision: 'accept' });
  assert.throws(() => f.adapter.respond({ ...request, decision: 'accept' }));
  await f.adapter.close();
});

test('native Codex permissions and userInput use official response shapes, and close cancels remaining requests', async () => {
  const f = fixture(undefined, { interactive: true }); await f.adapter.open(); await f.adapter.send({ text: 'work' });
  const params = { threadId: 'owned-thread', turnId: 'turn-1', permissions: { network: { enabled: true } } };
  const permission = f.callbacks.onRequest('item/permissions/requestApproval', params, 'permission');
  f.adapter.respond({ ...f.adapter.snapshot().pendingApprovals[0], decision: 'accept', permissions: { network: { enabled: true } }, scope: 'turn' });
  assert.deepEqual(await permission, { permissions: { network: { enabled: true } }, scope: 'turn' });
  const question = f.callbacks.onRequest('item/tool/requestUserInput', { ...params, questions: [{ id: 'q' }] }, 'question');
  const pending = f.adapter.snapshot().pendingApprovals[0];
  await f.adapter.close(); assert.deepEqual(await question, { answers: {} });
  assert.throws(() => f.adapter.respond({ ...pending, answers: { q: { answers: ['late'] } } }));
});

test('native provider-resolved and interrupted request handles cannot be approved later', async () => {
  const f = fixture(undefined, { interactive: true }); await f.adapter.open(); await f.adapter.send({ text: 'work' });
  const params = { threadId: 'owned-thread', turnId: 'turn-1', command: 'echo test' };
  const response = f.callbacks.onRequest('item/commandExecution/requestApproval', params, 'resolved');
  const pending = f.adapter.snapshot().pendingApprovals[0];
  f.callbacks.onNotification('serverRequest/resolved', { threadId: 'owned-thread', requestId: 'resolved' });
  assert.deepEqual(await response, { decision: 'cancel' }); assert.throws(() => f.adapter.respond({ ...pending, decision: 'accept' }));
  await f.adapter.interrupt();
  assert.deepEqual(await f.callbacks.onRequest('item/commandExecution/requestApproval', params, 'late'), { decision: 'cancel' });
  await f.adapter.close();
});

test('native Codex MCP is injected only in thread config and never exposed in snapshots', async () => {
  const mcpServers = { hello_cc_scoped: { command: '/node', args: ['/hcc'], env: { HCC_MCP_BOOTSTRAP_TOKEN: 'private-capability' } } };
  const f = fixture(undefined, { mcpServers }); await f.adapter.open();
  assert.deepEqual(f.calls.find(c => c[0] === 'thread/start')[1].config, { mcp_servers: mcpServers });
  assert.equal(f.adapter.capabilities.mcp, true); assert.equal(JSON.stringify(f.adapter.snapshot()).includes('private-capability'), false);
  await f.adapter.close();
});


test('native Codex retains MCP elicitation id zero and submits one explicit tool approval', async () => {
  const f = fixture(undefined, { interactive: true }); await f.adapter.open(); await f.adapter.send({ text: 'send' });
  const params = { threadId: 'owned-thread', turnId: 'turn-1', serverName: 'hello_cc_scoped', mode: 'form',
    _meta: { codex_approval_kind: 'mcp_tool_call' }, requestedSchema: { type: 'object', properties: {} } };
  const response = f.callbacks.onRequest('mcpServer/elicitation/request', params, 0);
  const request = f.adapter.snapshot().pendingApprovals[0];
  assert.equal(request.requestId, 0); assert.equal(request.kind, 'mcp');
  f.adapter.respond({ ...request, decision: 'accept' });
  assert.deepEqual(await response, { action: 'accept', content: {} });
  assert.throws(() => f.adapter.respond({ ...request, decision: 'accept' }));
  await f.adapter.close();
});

test('unattended and uncorrelated native MCP approvals are declined with official protocol shape', async () => {
  const f = fixture(); await f.adapter.open();
  assert.deepEqual(await f.callbacks.onRequest('mcpServer/elicitation/request', { threadId: 'owned-thread', turnId: null }, 0), { action: 'decline' });
  await f.adapter.close();
});

test('native interactive Codex enables request tools without granting permissions', async (t) => {
  const f = fixture(undefined, { interactive: true });
  await f.adapter.open();
  const request = f.calls.find(call => call[0] === 'thread/start')[1];
  assert.equal(request.config['features.default_mode_request_user_input'], true);
  assert.equal(request.config['features.request_permissions_tool'], true);
  assert.equal(request.sandbox, 'workspace-write');
  assert.equal(request.approvalPolicy, 'on-request');
  assert.equal(request.approvalsReviewer, 'user');
  assert.equal(Object.hasOwn(request, 'permissions'), false);
  await f.adapter.close();
});
