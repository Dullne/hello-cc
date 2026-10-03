import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshAcpAdapter, DSH_ACP_BASELINE_VERSION } from '../lib/integrations/native/dsh-acp.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(overrides = {}) {
  const events = [];
  const calls = [];
  const prompt = deferred();
  let callbacks;
  const rpc = {
    async start() { calls.push({ method: '$start' }); },
    request(method, params, options) {
      calls.push({ method, params, options });
      if (overrides.request) {
        const custom = overrides.request(method, params, options);
        if (custom !== undefined) return Promise.resolve(custom);
      }
      if (method === 'initialize') return Promise.resolve({ protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } });
      if (method === 'session/new') return Promise.resolve({ sessionId: 'session-own', configOptions: [
        { id: 'model', options: [{ group: 'deepseek', options: [{ value: 'opaque-model-choice', name: 'Advertised model' }] }] }
      ] });
      if (method === 'session/resume') return Promise.resolve({ configOptions: [] });
      if (method === 'session/prompt') return prompt.promise;
      if (method === 'session/close') { prompt.resolve({ stopReason: 'cancelled' }); return Promise.resolve({}); }
      if (method === 'session/set_config_option') return Promise.resolve({ configOptions: [] });
      throw new Error(`Unexpected RPC ${method}`);
    },
    notify(method, params) { calls.push({ method, params, notification: true }); },
    async close() { calls.push({ method: '$close' }); }
  };
  const adapter = createDshAcpAdapter({ binary: '/test/bin/dsh', cwd: '/workspace/one',
    ...overrides.adapterOptions, env: { PATH: '/test/bin' }, onEvent: (event) => events.push(event),
    rpcFactory(config) { callbacks = config; return rpc; }
  });
  return { adapter, calls, events, prompt, rpc, get callbacks() { return callbacks; } };
}

async function flush() { await new Promise((resolve) => setImmediate(resolve)); }

test('ACP opens an owned runtime and independent workspace/session identities with capability negotiation', async () => {
  const f = fixture();
  assert.equal(f.adapter.capabilities.resume, false);
  const snapshot = await f.adapter.open();
  assert.equal(DSH_ACP_BASELINE_VERSION, '0.2.0-rc.2');
  assert.deepEqual(f.callbacks.args, ['--profile', 'acp']);
  assert.equal(f.callbacks.cwd, '/workspace/one');
  assert.equal(snapshot.sessionId, 'session-own');
  assert.equal(snapshot.status, 'idle');
  assert.deepEqual(snapshot.capabilities, {
    create: true, resume: true, send: true, observe: true,
    steer: false, interrupt: true, close: true, fork: false, approvals: false, mcp: false
  });
  assert.deepEqual(f.calls.find((call) => call.method === 'session/new').params, { cwd: '/workspace/one', mcpServers: [] });
  assert.equal(f.events.filter((event) => event.type === 'completed').length, 0, 'an idle opened session is not task completion');
  await assert.rejects(f.adapter.open({ sessionId: 'another' }), { code: 'NATIVE_SESSION_MISMATCH' });
  await f.adapter.close();
});

test('ACP resume is capability gated and does not silently create a replacement session', async () => {
  const absent = fixture({ request(method) {
    if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
  } });
  await assert.rejects(absent.adapter.open({ sessionId: 'persisted-id' }), { code: 'NATIVE_UNSUPPORTED' });
  assert.equal(absent.calls.some((call) => call.method === 'session/new' || call.method === 'session/resume'), false);
  assert.equal(absent.calls.filter((call) => call.method === '$close').length, 1);
  await absent.adapter.close();
  assert.equal(absent.calls.filter((call) => call.method === '$close').length, 1, 'failed initialization does not dispose twice');
  const f = fixture();
  const state = await f.adapter.open({ sessionId: 'persisted-id' });
  assert.equal(state.sessionId, 'persisted-id');
  assert.deepEqual(f.calls.find((call) => call.method === 'session/resume').params,
    { sessionId: 'persisted-id', cwd: '/workspace/one', mcpServers: [] });
  await f.adapter.close();
});

test('ACP model selection uses advertised configuration values and rejects guessed model identifiers', async () => {
  const f = fixture();
  await f.adapter.open({ model: 'opaque-model-choice' });
  assert.deepEqual(f.calls.find((call) => call.method === 'session/set_config_option').params,
    { sessionId: 'session-own', configId: 'model', value: 'opaque-model-choice' });
  await f.adapter.close();
  const wrong = fixture();
  await assert.rejects(wrong.adapter.open({ model: 'guessed-model' }), { code: 'NATIVE_UNSUPPORTED_MODEL' });
  assert.equal(wrong.calls.some((call) => call.method === 'session/set_config_option'), false);
});

test('ACP returns a queue receipt before completion, filters foreign events and preserves final output', async () => {
  const f = fixture();
  await f.adapter.open();
  const receipt = await f.adapter.send({ text: 'do the job', submissionId: 'message-42' });
  assert.equal(receipt.status, 'queued');
  assert.equal(f.adapter.snapshot().status, 'running');
  const request = f.calls.find((call) => call.method === 'session/prompt');
  assert.deepEqual(request.params, { sessionId: 'session-own', prompt: [{ type: 'text', text: 'do the job' }] });
  assert.deepEqual(request.options, { timeoutMs: 0 }, 'a prompt is not truncated by the short control-request timeout');
  f.callbacks.onNotification('session/update', { sessionId: 'foreign', update: {
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'foreign secret' }
  } });
  f.callbacks.onNotification('session/update', { sessionId: 'session-own', update: {
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'finished' }
  } });
  assert.equal(f.events.filter((event) => event.type === 'output').length, 1);
  assert.equal(f.events.some((event) => event.type === 'completed'), false);
  await assert.rejects(f.adapter.send({ text: 'another task' }), { code: 'NATIVE_BUSY' });
  assert.deepEqual(await f.adapter.send({ text: 'do the job', submissionId: 'message-42' }), receipt);
  await assert.rejects(f.adapter.send({ text: 'changed text', submissionId: 'message-42' }), { code: 'NATIVE_SUBMISSION_CONFLICT' });
  f.prompt.resolve({ stopReason: 'end_turn' });
  await flush();
  assert.equal(f.adapter.snapshot().status, 'idle');
  const done = f.events.find((event) => event.type === 'completed');
  assert.equal(done.status, 'completed');
  assert.equal(done.text, 'finished');
  assert.equal(done.turnId, receipt.turnId);
  assert.equal(done.submissionId, 'message-42');
  await f.adapter.close();
});

test('ACP interrupt validates the active submission and notifies session/cancel without claiming completion', async () => {
  const f = fixture();
  await f.adapter.open();
  const receipt = await f.adapter.send({ text: 'long task' });
  await assert.rejects(f.adapter.interrupt({ turnId: 'stale' }), { code: 'NATIVE_STALE_TURN' });
  assert.equal(f.calls.some((call) => call.method === 'session/cancel'), false);
  await f.adapter.interrupt({ turnId: receipt.turnId });
  assert.deepEqual(f.calls.find((call) => call.method === 'session/cancel'),
    { method: 'session/cancel', params: { sessionId: 'session-own' }, notification: true });
  assert.equal(f.adapter.snapshot().status, 'interrupting');
  assert.equal(f.events.some((event) => event.type === 'completed'), false);
  f.prompt.resolve({ stopReason: 'cancelled' });
  await flush();
  assert.equal(f.events.find((event) => event.type === 'completed').status, 'interrupted');
  await f.adapter.close();
});

test('ACP permissions default to rejection and never select an allow-only or foreign-session option', async () => {
  const f = fixture();
  await f.adapter.open();
  const options = [{ optionId: 'approve', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }];
  assert.deepEqual(f.callbacks.onRequest('session/request_permission', { sessionId: 'session-own', options }),
    { outcome: { outcome: 'selected', optionId: 'deny' } });
  assert.deepEqual(f.callbacks.onRequest('session/request_permission', { sessionId: 'session-own', options: options.slice(0, 1) }),
    { outcome: { outcome: 'cancelled' } });
  assert.deepEqual(f.callbacks.onRequest('session/request_permission', { sessionId: 'foreign', options }),
    { outcome: { outcome: 'cancelled' } });
  assert.deepEqual(f.callbacks.onRequest('session/request_permission', { sessionId: 'session-own', options: {} }),
    { outcome: { outcome: 'cancelled' } });
  assert.throws(() => f.callbacks.onRequest('fs/write_text_file', {}), { code: -32601 });
  await f.adapter.close();
});

test('ACP transport uncertainty is not converted to successful or definitively failed task completion', async () => {
  const f = fixture();
  await f.adapter.open();
  const receipt = await f.adapter.send({ text: 'might still run' });
  f.prompt.reject(Object.assign(new Error('wire timed out'), { code: 'NATIVE_REQUEST_TIMEOUT', extra: { uncertain: true } }));
  await flush();
  assert.equal(f.adapter.snapshot().status, 'failed');
  assert.equal(f.events.some((event) => event.type === 'completed'), false);
  const error = f.events.find((event) => event.type === 'error');
  assert.equal(error.status, 'unknown');
  assert.equal(error.error.uncertain, true);
  assert.equal(error.turnId, receipt.turnId);
  await f.adapter.close();
});

test('ACP known RPC rejection produces a failed completion and runtime exits do not fabricate one', async () => {
  const f = fixture();
  await f.adapter.open();
  await f.adapter.send({ text: 'rejected prompt' });
  f.prompt.reject(Object.assign(new Error('invalid prompt'), { code: 'NATIVE_RPC_ERROR', extra: { rpc_code: -32602 } }));
  await flush();
  assert.equal(f.events.find((event) => event.type === 'completed').status, 'failed');
  assert.equal(f.adapter.snapshot().status, 'idle');
  await f.adapter.close();
  const crashed = fixture();
  await crashed.adapter.open();
  await crashed.adapter.send({ text: 'interrupted by crash' });
  crashed.callbacks.onExit({ code: 1 });
  crashed.prompt.reject(new Error('transport closed'));
  await flush();
  assert.equal(crashed.adapter.snapshot().status, 'exited');
  assert.equal(crashed.events.some((event) => event.type === 'completed'), false);
});

test('ACP close disposes only its addressed session and owned runtime, is idempotent and rejects late writes', async () => {
  const f = fixture();
  const other = fixture();
  await f.adapter.open();
  await other.adapter.open();
  await f.adapter.send({ text: 'running task' });
  const first = f.adapter.close();
  const second = f.adapter.close();
  assert.equal(first, second);
  await first;
  assert.equal(f.adapter.snapshot().status, 'closed');
  assert.deepEqual(f.calls.find((call) => call.method === 'session/close').params, { sessionId: 'session-own' });
  assert.equal(f.calls.filter((call) => call.method === '$close').length, 1);
  assert.equal(other.calls.some((call) => call.method === 'session/close' || call.method === '$close'), false);
  await assert.rejects(f.adapter.send({ text: 'late' }), { code: 'NATIVE_ADAPTER_CLOSED' });
  const length = f.events.length;
  f.callbacks.onNotification('session/update', { sessionId: 'session-own', update: { sessionUpdate: 'tool_call' } });
  assert.equal(f.events.length, length);
  await other.adapter.close();
});

test('ACP concurrent initialization cannot alias two requested session identities and close drains initialization', async () => {
  const initialize = deferred();
  const f = fixture({ request(method) { if (method === 'initialize') return initialize.promise; } });
  const open = f.adapter.open({ sessionId: 'persisted-one' });
  await assert.rejects(f.adapter.open({ sessionId: 'persisted-two' }), { code: 'NATIVE_SESSION_MISMATCH' });
  const close = f.adapter.close();
  const rejectedOpen = assert.rejects(open, { code: 'NATIVE_ADAPTER_CLOSED' });
  initialize.resolve({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } });
  await rejectedOpen;
  await close;
  assert.equal(f.calls.filter((call) => call.method === '$close').length, 1);
  assert.equal(f.calls.some((call) => call.method === 'session/close'), false, 'the disposed runtime is not reused');
  assert.equal(f.adapter.snapshot().status, 'closed');
});

test('ACP validates protocol identities and stop reasons before declaring completion', async () => {
  const f = fixture();
  await assert.rejects(f.adapter.open({ sessionId: '' }), { code: 'NATIVE_BAD_SESSION' });
  assert.equal(f.calls.length, 0);
  await f.adapter.open();
  await assert.rejects(f.adapter.send({ text: 'prompt', submissionId: {} }), { code: 'NATIVE_BAD_SUBMISSION' });
  await f.adapter.send({ text: 'prompt' });
  f.prompt.resolve({ stopReason: 'invented-success' });
  await flush();
  assert.equal(f.events.some((event) => event.type === 'completed'), false);
  assert.equal(f.events.find((event) => event.type === 'error').error.code, 'NATIVE_PROTOCOL_ERROR');
  await f.adapter.close();
});

test('hosted ACP injects worker MCP and selects only allow_once after an exact human response', async () => {
  const mcpServers = { hello_cc_scoped: { command: '/node', args: ['/hcc'], env: { TOKEN: 'scoped' } } };
  const f = fixture({ adapterOptions: { interactive: true, executorId: 'owned-acp', mcpServers } });
  await f.adapter.open(); await f.adapter.send({ text: 'task' });
  assert.deepEqual(f.calls.find(call => call.method === 'session/new').params.mcpServers,
    [{ name: 'hello_cc_scoped', command: '/node', args: ['/hcc'], env: [{ name: 'TOKEN', value: 'scoped' }] }]);
  const choices = [{ optionId: 'once', kind: 'allow_once' }, { optionId: 'always', kind: 'allow_always' }, { optionId: 'no', kind: 'reject_once' }];
  const result = f.callbacks.onRequest('session/request_permission', { sessionId: 'session-own', toolCall: { title: 'tool' }, options: choices }, 400);
  const request = f.adapter.snapshot().pendingApprovals[0];
  assert.throws(() => f.adapter.respond({ ...request, executorId: 'other', decision: 'accept' }));
  f.adapter.respond({ ...request, decision: 'accept' }); assert.deepEqual(await result, { outcome: { outcome: 'selected', optionId: 'once' } });
  assert.equal(JSON.stringify(f.adapter.snapshot()).includes('scoped'), false);
  const cancelled = f.callbacks.onRequest('session/request_permission', { sessionId: 'session-own', options: choices }, 401);
  await f.adapter.interrupt(); assert.deepEqual(await cancelled, { outcome: { outcome: 'cancelled' } });
  await f.adapter.close();
});


test('hosted ACP cancels late permissions after interruption and restores interaction for a new prompt', async () => {
  const prompts = [deferred(), deferred()];
  let promptIndex = 0;
  const f = fixture({ adapterOptions: { interactive: true }, request(method) {
    if (method === 'session/prompt') return prompts[promptIndex++].promise;
  } });
  const choices = [{ optionId: 'once', kind: 'allow_once' }];
  try {
    await f.adapter.open();
    await f.adapter.send({ text: 'first task' });
    await flush();
    await f.adapter.interrupt();
    const approvalsBefore = f.events.filter(event => event.type === 'approval').length;
    const late = f.callbacks.onRequest('session/request_permission', { sessionId: 'session-own', options: choices }, 402);
    assert.deepEqual(await late, { outcome: { outcome: 'cancelled' } });
    assert.equal(f.adapter.snapshot().pendingApprovals.length, 0);
    assert.equal(f.events.filter(event => event.type === 'approval').length, approvalsBefore);
    prompts[0].resolve({ stopReason: 'cancelled' });
    await flush();
    await f.adapter.send({ text: 'next task' });
    await flush();
    const next = f.callbacks.onRequest('session/request_permission', { sessionId: 'session-own', options: choices }, 403);
    const request = f.adapter.snapshot().pendingApprovals[0];
    assert.equal(request.requestId, 403);
    f.adapter.respond({ ...request, decision: 'accept' });
    assert.deepEqual(await next, { outcome: { outcome: 'selected', optionId: 'once' } });
    prompts[1].resolve({ stopReason: 'end_turn' });
    await flush();
  } finally {
    await f.adapter.close();
  }
});

for (const arrivesFirst of ['permission', 'tool']) {
  test(`ACP id-only permission retains same-session tool input when ${arrivesFirst} arrives first`, async () => {
    const f = fixture({ adapterOptions: { interactive: true } });
    const choices = [{ optionId: 'once', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }];
    try {
      await f.adapter.open(); await f.adapter.send({ text: 'write a report' });
      const notify = sessionId => f.callbacks.onNotification('session/update', { sessionId, update: {
        sessionUpdate: 'tool_call', toolCallId: 'write-1', title: 'write', rawInput: { file_path: sessionId === 'session-own' ? '/workspace/one/report.json' : '/foreign/secret' }
      } });
      notify('foreign');
      if (arrivesFirst === 'tool') notify('session-own');
      const permission = f.callbacks.onRequest('session/request_permission', { sessionId: 'session-own', toolCall: { toolCallId: 'write-1' }, options: choices }, 500);
      if (arrivesFirst === 'permission') {
        assert.equal(f.adapter.snapshot().pendingApprovals.length, 0, 'wait for the separately delivered tool context');
        notify('session-own'); await flush();
      }
      const request = f.adapter.snapshot().pendingApprovals[0];
      assert.equal(request.params.toolCall.title, 'write');
      assert.equal(request.params.toolCall.rawInput.file_path, '/workspace/one/report.json');
      assert.equal(JSON.stringify(request).includes('/foreign/secret'), false);
      f.adapter.respond({ ...request, decision: 'accept' });
      assert.deepEqual(await permission, { outcome: { outcome: 'selected', optionId: 'once' } });
    } finally { await f.adapter.close(); }
  });
}

test('ACP permission waiting for tool input is cancelled by interruption without creating a late approval', async () => {
  const f = fixture({ adapterOptions: { interactive: true } });
  try {
    await f.adapter.open(); await f.adapter.send({ text: 'first task' });
    const permission = f.callbacks.onRequest('session/request_permission', { sessionId: 'session-own', toolCall: { toolCallId: 'waiting-1' }, options: [{ optionId: 'once', kind: 'allow_once' }] }, 501);
    await f.adapter.interrupt();
    assert.deepEqual(await permission, { outcome: { outcome: 'cancelled' } });
    f.callbacks.onNotification('session/update', { sessionId: 'session-own', update: {
      sessionUpdate: 'tool_call', toolCallId: 'waiting-1', rawInput: { file_path: '/workspace/one/late.json' }
    } });
    assert.equal(f.adapter.snapshot().pendingApprovals.length, 0);
    assert.equal(f.events.some(event => event.type === 'approval'), false);
  } finally { await f.adapter.close(); }
});

test('ACP missing tool input permits rejection but never acceptance after bounded context waiting', async () => {
  const f = fixture({ adapterOptions: { interactive: true } });
  try {
    await f.adapter.open(); await f.adapter.send({ text: 'task' });
    const permission = f.callbacks.onRequest('session/request_permission', { sessionId: 'session-own', toolCall: { toolCallId: 'missing-1' }, options: [{ optionId: 'once', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] }, 502);
    await new Promise(resolve => setTimeout(resolve, 1100));
    const request = f.adapter.snapshot().pendingApprovals[0];
    assert.equal(request.params.toolCall.contextPending, true);
    assert.throws(() => f.adapter.respond({ ...request, decision: 'accept' }), { code: 'NATIVE_APPROVAL_CONTEXT_MISSING' });
    f.adapter.respond({ ...request, decision: 'decline' });
    assert.deepEqual(await permission, { outcome: { outcome: 'selected', optionId: 'no' } });
  } finally { await f.adapter.close(); }
});

test('ACP oversized tool input stays bounded and cannot authorize a hidden write', async () => {
  const f = fixture({ adapterOptions: { interactive: true } });
  try {
    await f.adapter.open(); await f.adapter.send({ text: 'task' });
    f.callbacks.onNotification('session/update', { sessionId: 'session-own', update: {
      sessionUpdate: 'tool_call', toolCallId: 'large-1', title: 'write', rawInput: { content: 'x'.repeat(70000) }
    } });
    const permission = f.callbacks.onRequest('session/request_permission', { sessionId: 'session-own', toolCall: { toolCallId: 'large-1' }, options: [{ optionId: 'once', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] }, 503);
    const request = f.adapter.snapshot().pendingApprovals[0];
    assert.equal(request.params.toolCall.contextTruncated, true);
    assert.ok(JSON.stringify(request).length < 2048);
    assert.throws(() => f.adapter.respond({ ...request, decision: 'accept' }), { code: 'NATIVE_APPROVAL_CONTEXT_MISSING' });
    f.adapter.respond({ ...request, decision: 'decline' });
    assert.deepEqual(await permission, { outcome: { outcome: 'selected', optionId: 'no' } });
  } finally { await f.adapter.close(); }
});
