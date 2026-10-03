import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createClaudeAdapter } from '../lib/integrations/native/claude.mjs';

function outputQueue() {
  const items = [];
  let waiter;
  let ended = false;
  return {
    push(value) {
      if (waiter) { const resolve = waiter; waiter = null; resolve({ value, done: false }); }
      else items.push(value);
    },
    end() {
      ended = true;
      if (waiter) waiter({ done: true });
      waiter = null;
    },
    [Symbol.asyncIterator]() { return this; },
    next() {
      if (items.length) return Promise.resolve({ value: items.shift(), done: false });
      if (ended) return Promise.resolve({ done: true });
      return new Promise((resolve) => { waiter = resolve; });
    }
  };
}

async function until(predicate) {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for fake SDK');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function fakeSdk({ pauseInput = false, initialize = true, closeGate } = {}) {
  const output = outputQueue();
  const received = [];
  let args;
  let inputReader;
  let calls = 0;
  let closes = 0;
  let interrupts = 0;
  let receipt;
  const readInputs = () => {
    if (inputReader) return;
    inputReader = (async () => {
      for await (const input of args.prompt) {
        received.push(input);
        if (initialize && received.length === 1) output.push({
          type: 'system', subtype: 'init', session_id: 'claude-session'
        });
      }
    })();
  };
  output.interrupt = async () => { interrupts += 1; return receipt; };
  output.close = async () => {
    closes += 1;
    if (closeGate) await closeGate;
    await args.prompt.return();
    output.end();
  };
  return {
    received,
    query(request) {
      calls += 1;
      args = request;
      if (!pauseInput) readInputs();
      return output;
    },
    readInputs,
    emit: (message) => output.push(message),
    finish: () => output.end(),
    setReceipt: (value) => { receipt = value; },
    get args() { return args; },
    get calls() { return calls; },
    get closes() { return closes; },
    get interrupts() { return interrupts; }
  };
}

function result(input, fields = {}) {
  return {
    type: 'result', subtype: 'success', is_error: false,
    session_id: 'claude-session', user_message_uuid: input.uuid,
    result: 'Done', ...fields
  };
}

test('native Claude forwards usage only for the owned result and keeps absent totals unknown', async () => {
  const sdk=fakeSdk(), events=[];
  const adapter=createClaudeAdapter({query:sdk.query,cwd:process.cwd(),onEvent:event=>events.push(event)});
  try {
    await adapter.open();await adapter.send({text:'task'});await until(()=>sdk.received.length===1 && adapter.snapshot().sessionId);
    sdk.emit(result(sdk.received[0],{parent_tool_use_id:'child',usage:{input_tokens:999},duration_ms:999}));
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(adapter.snapshot().metrics,null);
    const turnId=adapter.snapshot().turnId;
    sdk.emit(result(sdk.received[0],{usage:{input_tokens:12,output_tokens:4,cache_read_input_tokens:2},duration_ms:30}));
    await until(()=>adapter.snapshot().metrics);
    assert.equal(adapter.snapshot().metrics.turnId,turnId);
    assert.equal(adapter.snapshot().metrics.inputTokens,12);
    assert.equal(adapter.snapshot().metrics.totalTokens,undefined);
    assert.equal(adapter.snapshot().metrics.durationMs,30);
    assert.equal(events.filter(event=>event.type==='usage').length,1);
  } finally {await adapter.close();}
});

test('Claude refuses SDK query creation when its selected directory was rebound after open', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-claude-path-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const original = path.join(base, 'original');
  const replacement = path.join(base, 'replacement');
  const selected = path.join(base, 'selected');
  fs.mkdirSync(original);
  fs.mkdirSync(replacement);
  fs.symlinkSync(original, selected, 'dir');
  const sdk = fakeSdk();
  const adapter = createClaudeAdapter({ cwd: selected, query: sdk.query });
  try {
    await adapter.open();
    fs.unlinkSync(selected);
    fs.symlinkSync(replacement, selected, 'dir');
    await assert.rejects(adapter.send({ text: 'do not submit' }), { code: 'PROJECT_PATH_CHANGED' });
    assert.equal(sdk.calls, 0);
  } finally { await adapter.close(); }
});

test('Claude adapter keeps one SDK stream across asynchronous turns and waits for init', async () => {
  const sdk = fakeSdk({ pauseInput: true });
  const events = [];
  const adapter = createClaudeAdapter({ query: sdk.query, cwd: process.cwd(), onEvent: (event) => events.push(event) });
  assert.equal(adapter.capabilities.steer, false);
  const opened = await adapter.open({ sessionId: 'claude-session', model: 'claude-test' });
  assert.equal(opened.sessionId, null);
  assert.equal(sdk.calls, 0);
  const first = await adapter.send({ text: '/exit is text from another agent', submissionId: 'submission-1' });
  assert.equal(first.status, 'queued');
  assert.equal(first.sessionId, null);
  assert.equal(sdk.args.options.resume, 'claude-session');
  assert.equal(sdk.args.options.model, 'claude-test');
  await assert.rejects(adapter.send({ text: 'competing prompt' }), { code: 'NATIVE_BUSY' });
  sdk.readInputs();
  await until(() => adapter.snapshot().sessionId === 'claude-session');
  assert.equal(Object.hasOwn(sdk.received[0], 'client_composed'), false,
    'normal SDK repository instructions and turn-start attachments must not be skipped');
  assert.equal(sdk.received[0].message.content, '/exit is text from another agent');
  sdk.emit({ type: 'stream_event', parent_tool_use_id: null,
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } } });
  sdk.emit({ type: 'assistant', parent_tool_use_id: null,
    user_message_uuid: sdk.received[0].uuid,
    message: { content: [{ type: 'text', text: 'Done' }] } });
  sdk.emit(result(sdk.received[0]));
  await until(() => adapter.snapshot().status === 'completed');
  assert.equal(events.filter((event) => event.type === 'message').length, 1, 'result must not duplicate final assistant text');
  const completion = events.find((event) => event.type === 'completed');
  assert.equal(completion.turnId, first.turnId);
  assert.equal(completion.submissionId, 'submission-1');
  assert.equal(completion.status, 'completed');
  assert.equal(events.find((event) => event.type === 'delta').turnId, first.turnId);
  assert.ok(events.some((event) => event.type === 'status' && event.initialized && event.sessionId === 'claude-session'));
  const second = await adapter.send({ text: 'follow up', submissionId: 'submission-2' });
  await until(() => sdk.received.length === 2);
  sdk.emit(result(sdk.received[1], { result: 'Second' }));
  await until(() => events.some((event) => event.type === 'completed' && event.turnId === second.turnId));
  assert.equal(sdk.calls, 1);
  assert.notEqual(second.turnId, first.turnId);
  assert.equal(sdk.received[1].session_id, 'claude-session');
  await adapter.close();
});

test('Claude SDK input consumption never becomes a provider acceptance or completion receipt', async () => {
  const sdk = fakeSdk();
  const events = [];
  const adapter = createClaudeAdapter({ query: sdk.query, onEvent: (event) => events.push(event) });
  const sent = await adapter.send({ text: 'task', submissionId: 'submission-1' });
  await until(() => sdk.received.length === 1);
  assert.equal(sent.status, 'queued');
  assert.equal(adapter.snapshot().status, 'running');
  assert.equal(events.some((event) => event.status === 'accepted' || event.type === 'completed'), false);
  assert.ok(events.some((event) => event.status === 'running' && event.submissionId === 'submission-1'));
  await adapter.close();
});

test('Claude resume rejects missing, invalid, or replacement initialization IDs without adopting later output', async () => {
  for (const initializedId of [undefined, '', 'bad\nidentity', 'replacement-session']) {
    const sdk = fakeSdk({ initialize: false });
    const events = [];
    const adapter = createClaudeAdapter({ query: sdk.query, onEvent: (event) => events.push(event) });
    await adapter.open({ sessionId: 'saved-owned-session' });
    await adapter.send({ text: 'continue owned work' });
    await until(() => sdk.received.length === 1);
    sdk.emit({ type: 'system', subtype: 'init', session_id: initializedId });
    sdk.emit({ type: 'system', subtype: 'init', session_id: 'saved-owned-session' });
    sdk.emit({ type: 'assistant', user_message_uuid: sdk.received[0].uuid,
      message: { content: [{ type: 'text', text: 'unowned output' }] } });
    sdk.emit(result(sdk.received[0]));
    await until(() => sdk.closes === 1);
    assert.equal(adapter.snapshot().sessionId, null);
    assert.equal(adapter.snapshot().status, 'error');
    assert.ok(events.some((event) => event.code === 'NATIVE_SESSION_MISMATCH'));
    assert.equal(events.some((event) => event.type === 'message' || event.type === 'completed'), false);
    await assert.rejects(adapter.send({ text: 'do not replace the session' }), { code: 'NATIVE_SDK_ENDED' });
    assert.equal(sdk.calls, 1);
    await adapter.close();
    assert.equal(sdk.closes, 1);
  }
});

test('Claude result failures remain failed and are not confused with unrelated or child results', async () => {
  const sdk = fakeSdk();
  const events = [];
  const adapter = createClaudeAdapter({ query: sdk.query, onEvent: (event) => events.push(event) });
  const sent = await adapter.send({ text: 'task' });
  await until(() => sdk.received.length === 1);
  sdk.emit(result(sdk.received[0], { parent_tool_use_id: 'child-tool' }));
  sdk.emit(result(sdk.received[0], { user_message_uuid: 'different-input' }));
  sdk.emit({ type: 'result', subtype: 'success', origin: { kind: 'task-notification' }, result: 'Background done' });
  sdk.emit(result(sdk.received[0], {
    subtype: 'error_max_turns', is_error: true, result: undefined, errors: ['turn budget exceeded']
  }));
  await until(() => adapter.snapshot().status === 'error');
  assert.equal(events.filter((event) => event.type === 'completed').length, 1);
  assert.equal(events.find((event) => event.type === 'completed').status, 'failed');
  assert.equal(events.find((event) => event.type === 'completed').turnId, sent.turnId);
  assert.match(events.find((event) => event.type === 'error').message, /budget exceeded/);
  await adapter.close();
});

test('Claude permission callback denies, emits approval evidence, and preserves auth environment', async () => {
  const sdk = fakeSdk();
  const events = [];
  const sourceEnv = {
    PATH: '/bin', HOME: '/home/test', ANTHROPIC_API_KEY: 'test-only-key',
    ANTHROPIC_BASE_URL: 'https://example.invalid', CLAUDE_CONFIG_DIR: '/config',
    CODEX_HOME: '/codex-config', HCC_PEER: 'parent', HCC_ROOT: '/parent',
    CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'parent-session',
    CLAUDE_CODE_MESSAGING_SOCKET: '/parent/socket', CLAUDE_CODE_MESSAGING_TOKEN: 'parent-token',
    CODEX_THREAD_ID: 'parent-thread', TMUX_PANE: '%9'
  };
  const adapter = createClaudeAdapter({ query: sdk.query, env: sourceEnv, onEvent: (event) => events.push(event) });
  await adapter.send({ text: 'task' });
  const config = sdk.args.options;
  assert.equal(config.permissionMode, 'default');
  assert.equal(config.allowDangerouslySkipPermissions, false);
  const denied = await config.canUseTool('Bash', { command: 'touch reviewed' }, { requestId: 'permission-1', toolUseID: 'tool-1' });
  assert.equal(denied.behavior, 'deny');
  assert.equal(denied.toolUseID, 'tool-1');
  assert.equal(events.find((event) => event.type === 'approval').decision, 'deny');
  assert.equal(events.find((event) => event.type === 'approval').requestId, 'permission-1');
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HOME']) {
    assert.equal(config.env[key], sourceEnv[key]);
  }
  for (const key of ['HCC_PEER', 'HCC_ROOT', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CODEX_THREAD_ID', 'TMUX_PANE']) {
    assert.equal(config.env[key], undefined);
  }
  assert.equal(sourceEnv.HCC_PEER, 'parent', 'source environment must not be mutated');
  await adapter.close();
});

test('Claude SDK receives only the complete owned-worker coordination environment', async () => {
  const sdk = fakeSdk();
  const worker = {
    HCC_ROOT: '/project', HCC_DB: '/project/.hello-cc/native-mesh.db',
    HCC_PEER: 'owned-claude', HCC_NATIVE_OWNER: 'native:generation:owned-claude'
  };
  const adapter = createClaudeAdapter({ query: sdk.query, env: {
    ...worker, HCC_WEB_TOKEN: 'parent-token', HCC_RUNTIME_URL: 'parent-url',
    CLAUDE_CODE_SESSION_ID: 'parent-provider-session', ANTHROPIC_API_KEY: 'test-only-key'
  } });
  await adapter.send({ text: 'task' });
  for (const [key, value] of Object.entries(worker)) assert.equal(sdk.args.options.env[key], value);
  assert.equal(sdk.args.options.env.HCC_WEB_TOKEN, undefined);
  assert.equal(sdk.args.options.env.HCC_RUNTIME_URL, undefined);
  assert.equal(sdk.args.options.env.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(sdk.args.options.env.ANTHROPIC_API_KEY, 'test-only-key');
  await adapter.close();
  const explicitSdk = fakeSdk();
  const explicitAdapter = createClaudeAdapter({ query: explicitSdk.query,
    env: { HCC_PEER: 'parent', HCC_NATIVE_OWNER: 'parent-owner', PATH: '/bin' }, coordinationEnv: worker });
  await explicitAdapter.send({ text: 'task' });
  assert.equal(explicitSdk.args.options.env.HCC_PEER, 'owned-claude');
  assert.equal(explicitSdk.args.options.env.HCC_NATIVE_OWNER, worker.HCC_NATIVE_OWNER);
  await explicitAdapter.close();
});

test('Claude interrupt does not release an unconsumed queued prompt or mislabel a later completion', async () => {
  const sdk = fakeSdk({ pauseInput: true });
  const events = [];
  const adapter = createClaudeAdapter({ query: sdk.query, onEvent: (event) => events.push(event) });
  const sent = await adapter.send({ text: 'task' });
  await assert.rejects(adapter.interrupt({ turnId: 'wrong' }), { code: 'NATIVE_STALE_TURN' });
  sdk.setReceipt({ still_queued: [] });
  await adapter.interrupt({ turnId: sent.turnId });
  assert.equal(adapter.snapshot().turnId, sent.turnId);
  await assert.rejects(adapter.send({ text: 'second' }), { code: 'NATIVE_BUSY' });
  assert.equal(events.some((event) => event.type === 'completed'), false);
  sdk.readInputs();
  await until(() => sdk.received.length === 1);
  sdk.emit(result(sdk.received[0], { terminal_reason: 'completed' }));
  await until(() => adapter.snapshot().status === 'completed');
  assert.equal(events.find((event) => event.type === 'completed').status, 'completed');
  await adapter.close();
});

test('Claude interrupt reports interrupted only after the matching main result', async () => {
  const sdk = fakeSdk();
  const events = [];
  const adapter = createClaudeAdapter({ query: sdk.query, onEvent: (event) => events.push(event) });
  const sent = await adapter.send({ text: 'task' });
  await until(() => sdk.received.length === 1);
  sdk.setReceipt({ still_queued: [sdk.received[0].uuid] });
  await adapter.interrupt({ turnId: sent.turnId });
  assert.equal(adapter.snapshot().turnId, sent.turnId);
  assert.equal(events.some((event) => event.type === 'completed'), false);
  sdk.emit(result(sdk.received[0], { terminal_reason: 'aborted_tools', result: '' }));
  await until(() => adapter.snapshot().status === 'interrupted');
  assert.equal(events.find((event) => event.type === 'completed').status, 'interrupted');
  await adapter.close();
});

test('Claude SDK startup failure and premature exit do not claim successful completion', async () => {
  const sdk = fakeSdk({ pauseInput: true, initialize: false });
  const events = [];
  const adapter = createClaudeAdapter({ query: sdk.query, onEvent: (event) => events.push(event) });
  await adapter.send({ text: 'task' });
  sdk.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Authentication missing'] });
  await until(() => adapter.snapshot().status === 'error');
  assert.equal(events.find((event) => event.type === 'completed').status, 'failed');
  await adapter.close();
  const endedSdk = fakeSdk();
  const endedEvents = [];
  const endedAdapter = createClaudeAdapter({ query: endedSdk.query, onEvent: (event) => endedEvents.push(event) });
  await endedAdapter.send({ text: 'task' });
  endedSdk.finish();
  await until(() => endedEvents.some((event) => event.type === 'error'));
  assert.equal(endedEvents.some((event) => event.type === 'completed'), false);
  await assert.rejects(endedAdapter.send({ text: 'retry' }), { code: 'NATIVE_SDK_ENDED' });
  await endedAdapter.close();
});

test('Claude close affects only its owned SDK query and is idempotent', async () => {
  const ownedSdk = fakeSdk();
  const otherSdk = fakeSdk();
  const owned = createClaudeAdapter({ query: ownedSdk.query });
  const other = createClaudeAdapter({ query: otherSdk.query });
  await owned.send({ text: 'owned' });
  await other.send({ text: 'other' });
  await owned.close();
  await owned.close();
  assert.equal(ownedSdk.closes, 1);
  assert.equal(otherSdk.closes, 0);
  assert.equal(other.snapshot().status, 'running');
  await assert.rejects(owned.send({ text: 'after close' }), { code: 'NATIVE_CLOSED' });
  await other.close();
});

test('Claude concurrent sends reserve one turn before asynchronous SDK startup', async () => {
  const sdk = fakeSdk();
  const adapter = createClaudeAdapter({ query: async (request) => sdk.query(request) });
  const sends = await Promise.allSettled([
    adapter.send({ text: 'first' }), adapter.send({ text: 'second' })
  ]);
  assert.equal(sends.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(sends.find((outcome) => outcome.status === 'rejected').reason.code, 'NATIVE_BUSY');
  assert.equal(sdk.calls, 1);
  await until(() => sdk.received.length === 1);
  await adapter.close();
});

test('Claude concurrent close calls share and await their owned asynchronous teardown', async () => {
  let releaseClose;
  const closeGate = new Promise((resolve) => { releaseClose = resolve; });
  const sdk = fakeSdk({ closeGate });
  const adapter = createClaudeAdapter({ query: sdk.query });
  await adapter.send({ text: 'task' });
  const closing = adapter.close();
  assert.equal(adapter.close(), closing);
  let closed = false;
  closing.then(() => { closed = true; });
  await until(() => sdk.closes === 1);
  assert.equal(closed, false);
  assert.equal(adapter.snapshot().status, 'closing');
  releaseClose();
  await closing;
  assert.equal(closed, true);
  assert.equal(adapter.snapshot().status, 'closed');
  assert.equal(adapter.close(), closing);
  assert.equal(sdk.closes, 1);
});

test('Claude close awaits asynchronous SDK startup and teardown without submitting the late prompt', async () => {
  let releaseClose;
  const closeGate = new Promise((resolve) => { releaseClose = resolve; });
  const sdk = fakeSdk({ closeGate });
  let releaseQuery;
  let creating = false;
  const adapter = createClaudeAdapter({
    query: async (request) => {
      creating = true;
      await new Promise((resolve) => { releaseQuery = resolve; });
      return sdk.query(request);
    }
  });
  const sendFailure = assert.rejects(adapter.send({ text: 'first' }), { code: 'NATIVE_SDK_ENDED' });
  await until(() => creating);
  const closing = adapter.close();
  let closed = false;
  closing.then(() => { closed = true; });
  assert.equal(adapter.close(), closing);
  assert.equal(sdk.calls, 0);
  assert.equal(closed, false);
  releaseQuery();
  await until(() => sdk.closes === 1);
  assert.equal(closed, false);
  assert.equal(adapter.snapshot().status, 'closing');
  releaseClose();
  await closing;
  await sendFailure;
  assert.equal(sdk.closes, 1);
  assert.equal(sdk.received.length, 0);
  assert.equal(adapter.snapshot().status, 'closed');
});

test('Claude close timeout remains uncertain while continuing to clean up a late SDK query', async () => {
  let releaseClose;
  const closeGate = new Promise((resolve) => { releaseClose = resolve; });
  const sdk = fakeSdk({ closeGate });
  let releaseQuery;
  let creating = false;
  const events = [];
  const adapter = createClaudeAdapter({
    timeoutMs: 30, onEvent: (event) => events.push(event),
    query: async (request) => {
      creating = true;
      await new Promise((resolve) => { releaseQuery = resolve; });
      return sdk.query(request);
    }
  });
  const sendFailure = assert.rejects(adapter.send({ text: 'first' }), { code: 'NATIVE_SDK_ENDED' });
  await until(() => creating);
  const closing = adapter.close();
  await assert.rejects(closing, (error) => {
    assert.equal(error.code, 'NATIVE_TIMEOUT');
    assert.equal(error.extra.uncertain, true);
    return true;
  });
  assert.equal(adapter.snapshot().status, 'error');
  assert.equal(sdk.calls, 0);
  assert.ok(events.some((event) => event.status === 'error' && event.uncertain === true));
  assert.equal(events.some((event) => event.status === 'closed'), false);
  releaseQuery();
  await until(() => sdk.closes === 1);
  assert.equal(adapter.snapshot().status, 'error');
  const retry = adapter.close();
  assert.notEqual(retry, closing);
  assert.equal(adapter.close(), retry);
  releaseClose();
  await sendFailure;
  await retry;
  await until(() => adapter.snapshot().status === 'closed');
  assert.equal(sdk.closes, 1);
  assert.equal(sdk.received.length, 0);
});

test('Claude SDK close rejection never claims shutdown completed and permits explicit teardown retry', async () => {
  const sdk = fakeSdk();
  const events = [];
  let closeCalls = 0;
  const query = (request) => {
    const stream = sdk.query(request);
    const close = stream.close;
    stream.close = async () => {
      closeCalls += 1;
      if (closeCalls === 1) throw new Error('owned teardown failed');
      await close();
    };
    return stream;
  };
  const adapter = createClaudeAdapter({ query, onEvent: (event) => events.push(event) });
  await adapter.send({ text: 'task' });
  const closing = adapter.close();
  await assert.rejects(closing, /owned teardown failed/);
  assert.equal(adapter.snapshot().status, 'error');
  assert.equal(events.some((event) => event.status === 'closed'), false);
  assert.ok(events.some((event) => event.status === 'error' && event.uncertain === true));
  assert.equal(closeCalls, 1);
  const retry = adapter.close();
  assert.notEqual(retry, closing);
  assert.equal(adapter.close(), retry);
  await retry;
  assert.equal(closeCalls, 2);
  assert.equal(adapter.snapshot().status, 'closed');
});

test('Claude missing optional SDK gives installation guidance without installing it', async (t) => {
  try { await import('@anthropic-ai/claude-agent-sdk'); }
  catch (error) {
    assert.equal(error.code, 'ERR_MODULE_NOT_FOUND');
    const adapter = createClaudeAdapter();
    await assert.rejects(adapter.open(), (failure) => {
      assert.equal(failure.code, 'NATIVE_SDK_MISSING');
      assert.match(failure.message, /npm install @anthropic-ai\/claude-agent-sdk/);
      return true;
    });
    assert.equal(adapter.snapshot().status, 'created');
    await adapter.close();
    return;
  }
  t.skip('Optional SDK is installed in this environment');
});

test('hosted Claude awaits human approval without mutating requested input or auto-granting on interrupt', async () => {
  const sdk = fakeSdk(), events = [];
  const mcpServers = { hello_cc_scoped: { command: '/node', args: ['/hcc'], env: { HCC_MCP_BOOTSTRAP_TOKEN: 'private-mcp' } } };
  const adapter = createClaudeAdapter({ query: sdk.query, interactive: true, executorId: 'owned-claude', mcpServers, onEvent: e => events.push(e) });
  await adapter.send({ text: 'task' }); await until(() => adapter.snapshot().sessionId === 'claude-session');
  assert.deepEqual(sdk.args.options.mcpServers, mcpServers);
  const input = { command: 'touch file' }, result = sdk.args.options.canUseTool('Bash', input, { requestId: 'approval' });
  const request = adapter.snapshot().pendingApprovals[0];
  assert.equal(request.executorId, 'owned-claude'); assert.equal(JSON.stringify(adapter.snapshot()).includes('private-mcp'), false);
  assert.throws(() => adapter.respond({ ...request, turnId: 'old-turn', decision: 'accept' }));
  adapter.respond({ ...request, decision: 'accept' }); assert.deepEqual(await result, { behavior: 'allow', updatedInput: input });
  const cancelled = sdk.args.options.canUseTool('Bash', input, { requestId: 'cancel' }); await adapter.interrupt();
  assert.equal((await cancelled).behavior, 'deny'); assert.equal(adapter.snapshot().pendingApprovals.length, 0);
  await adapter.close(); assert.equal(events.filter(e => e.type === 'approval').length, 2);
});


test('hosted Claude keeps late permission requests cancelled after interrupt and enables them for the next turn', async () => {
  const sdk = fakeSdk();
  const events = [];
  const adapter = createClaudeAdapter({ query: sdk.query, interactive: true, onEvent: event => events.push(event) });
  try {
    await adapter.send({ text: 'first task' });
    await until(() => adapter.snapshot().sessionId === 'claude-session');
    await adapter.interrupt();
    const approvalsBefore = events.filter(event => event.type === 'approval').length;
    const late = await sdk.args.options.canUseTool('Bash', { command: 'touch late' }, { requestId: 'late-request' });
    assert.equal(late.behavior, 'deny');
    assert.equal(adapter.snapshot().pendingApprovals.length, 0);
    assert.equal(events.filter(event => event.type === 'approval').length, approvalsBefore);
    sdk.emit(result(sdk.received[0], { terminal_reason: 'aborted_by_user' }));
    await until(() => adapter.snapshot().turnId === null);
    await adapter.send({ text: 'next task' });
    await until(() => sdk.received.length === 2);
    const next = sdk.args.options.canUseTool('Bash', { command: 'touch next' }, { requestId: 'next-request' });
    const request = adapter.snapshot().pendingApprovals[0];
    assert.equal(request.requestId, 'next-request');
    adapter.respond({ ...request, decision: 'accept' });
    assert.equal((await next).behavior, 'allow');
  } finally {
    await adapter.close();
  }
});

async function isolatedDefaultSdk(t, moduleSource) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-claude-resolution-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const installed = path.join(directory, 'hcc'), project = path.join(directory, 'project');
  const base = fileURLToPath(new URL('../lib/', import.meta.url));
  for (const name of ['integrations/native/claude.mjs', 'integrations/native/interactions.mjs', 'integrations/native/telemetry.mjs', 'integrations/mcp-url-elicitation.mjs', 'process/selected-cwd-identity.mjs']) {
    const target = path.join(installed, 'lib', name); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(base, name), target);
  }
  fs.cpSync(path.join(base, 'shared'), path.join(installed, 'lib/shared'), { recursive: true });
  const sdk = path.join(project, 'node_modules/@anthropic-ai/claude-agent-sdk');
  fs.mkdirSync(sdk, { recursive: true });
  fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', type: 'module', exports: './sdk.mjs' }));
  fs.writeFileSync(path.join(sdk, 'sdk.mjs'), moduleSource);
  return { project, adapter: (await import(pathToFileURL(path.join(installed, 'lib/integrations/native/claude.mjs')))).createClaudeAdapter({ cwd: project }) };
}

test('default Claude loader finds the optional SDK in the worker project from a separate HCC installation', async t => {
  const { adapter, project } = await isolatedDefaultSdk(t, `export function query({ prompt, options }) {
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'project-sdk-session' };
      for await (const input of prompt) yield { type: 'result', subtype: 'success', session_id: 'project-sdk-session', user_message_uuid: input.uuid, result: options.cwd };
    })();
  }`);
  await adapter.open(); await adapter.send({ text: 'bounded project SDK check', submissionId: 'sdk-resolution' });
  await until(() => adapter.snapshot().status === 'completed');
  assert.equal(adapter.snapshot().sessionId, 'project-sdk-session');
  assert.equal(adapter.snapshot().capabilities.send, true);
  assert.equal(fs.existsSync(path.join(project, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs')), true);
  await adapter.close();
});

test('default Claude loader keeps an installed SDK dependency error instead of reporting the SDK missing', async t => {
  const { adapter } = await isolatedDefaultSdk(t, "import './required-dependency.mjs'; export function query() {};");
  await assert.rejects(adapter.open(), error => {
    assert.equal(error.code, 'ERR_MODULE_NOT_FOUND');
    assert.match(error.message, /required-dependency/);
    return true;
  });
  await adapter.close();
});
