import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createNativeInteractions } from './interactions.mjs';
import { JsonRpcProcess } from './jsonrpc.mjs';
import { acpUsage } from './telemetry.mjs';
import { captureSelectedCwdIdentity } from '../../process/selected-cwd-identity.mjs';

export const DSH_ACP_BASELINE_VERSION = '0.2.0-rc.2';

// Contract verified against the official @deepseek-ai/dsh-acp baseline above.
// ACP v1 uses session/prompt requests and session/cancel notifications. Resume
// and close are advertised session extensions; resume restores the Agent, but
// does not replay its transcript. turnId identifies this adapter's submission,
// not a native ACP turn. Updates are committed semantic events, not raw tokens.
// model, when supplied, is an advertised model configuration option value.
// This adapter owns a dedicated dsh --profile acp process, never an existing
// dsh Web service. Its close operation may dispose only that owned process.
export function createDshAcpAdapter(options = {}) {
  const cwd = options.cwd || process.cwd();
  if (!path.isAbsolute(cwd)) throw failure('NATIVE_BAD_CWD', 'ACP requires an absolute workspace directory');
  const cwdBinding = captureSelectedCwdIdentity(cwd, options.expectedCwdIdentity);
  const capabilities = {
    create: true, resume: false, send: true, observe: true,
    steer: false, interrupt: true, close: false, fork: false, approvals: Boolean(options.interactive), mcp: Boolean(options.mcpServers)
  };
  let rpc = null;
  let sessionId = null;
  let status = 'new';
  let active = null;
  let opening = null;
  let openingIdentity = null;
  let closing = false;
  let closePromise = null;
  let runtimeDisposalStarted = false;
  let runtimeExited = false;
  let runtimeDisposed = false;
  let lastError = null;
  let metrics = null, runtimeMetadata = {};
  const receipts = new Map();
  const toolCalls = new Map(), toolContextWaiters = new Set();
  const interactions = createNativeInteractions({ executorId: options.executorId,
    isActive: (id, turnId) => !closing && !runtimeDisposed && id === sessionId && turnId === active?.turnId && !active?.interrupted, onChange: emit });

  function emit(event) {
    // A consumer failure must not break ACP parsing or turn a permission
    // rejection into a transport failure.
    try {
      const delivery = options.onEvent?.({ provider: 'dsh', sessionId, ...event });
      delivery?.catch?.(() => {});
    } catch {}
  }

  function snapshot() {
    return {
      provider: 'dsh', transport: 'acp', protocolVersion: 1,
      baselineVersion: DSH_ACP_BASELINE_VERSION,
      cwd, sessionId, status,
      turnId: active?.turnId || null,
      submissionId: active?.submissionId || null,
      metrics, runtimeMetadata: { ...runtimeMetadata },
      capabilities: { ...capabilities }, executorId: interactions.executorId, pendingApprovals: interactions.snapshot(),
      error: lastError ? { ...lastError } : null
    };
  }

  function clearToolContext() {
    toolCalls.clear();
    for (const waiter of [...toolContextWaiters]) waiter.finish(null);
  }

  function rememberToolCall(update) {
    if (!active || active.interrupted || !['tool_call', 'tool_call_update'].includes(update.sessionUpdate) ||
        typeof update.toolCallId !== 'string' || !update.toolCallId || update.toolCallId.length > 256) return;
    const detail = { ...(toolCalls.get(update.toolCallId) || {}), toolCallId: update.toolCallId };
    for (const key of ['title', 'kind', 'rawInput', 'locations']) if (Object.hasOwn(update, key)) detail[key] = update[key];
    if (Object.hasOwn(update, 'rawInput')) delete detail.contextTruncated;
    const bounded = JSON.stringify(detail).length > 60000
      ? { toolCallId: update.toolCallId, title: typeof detail.title === 'string' ? detail.title.slice(0, 1024) : undefined, contextTruncated: true }
      : structuredClone(detail);
    toolCalls.set(update.toolCallId, bounded);
    if (toolCalls.size > 128) toolCalls.delete(toolCalls.keys().next().value);
    if (Object.hasOwn(bounded, 'rawInput') || bounded.contextTruncated) {
      for (const waiter of [...toolContextWaiters]) if (waiter.toolCallId === update.toolCallId) waiter.finish(bounded);
    }
  }

  function waitForToolContext(toolCallId) {
    if (toolContextWaiters.size >= 64) throw failure('NATIVE_PROTOCOL_ERROR', 'Excessive ACP permission context requests');
    return new Promise(resolve => {
      const waiter = { toolCallId, finish(detail) { clearTimeout(timer); toolContextWaiters.delete(waiter); resolve(detail); } };
      const timer = setTimeout(() => waiter.finish(null), 1000);
      toolContextWaiters.add(waiter);
    });
  }

  function onNotification(method, params) {
    if (closing || ['closed', 'failed', 'exited'].includes(status) || method !== 'session/update' || params?.sessionId !== sessionId) return;
    const update = params.update;
    if (!update || typeof update !== 'object') return;
    const reported = acpUsage(update);
    if (reported) { metrics = reported; emit({ type: 'usage', metrics, turnId: active?.turnId || null }); }
    if (update.sessionUpdate === 'available_commands_update' && Array.isArray(update.availableCommands)) {
      runtimeMetadata = { ...runtimeMetadata, commands: update.availableCommands.filter(command => typeof command?.name === 'string').map(command => ({ name: command.name, description: command.description })) };
      emit({ type: 'metadata', runtimeMetadata: { ...runtimeMetadata } });
    }
    rememberToolCall(update);
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && typeof update.content.text === 'string') {
      if (active) active.text += update.content.text;
      emit({ type: 'output', turnId: active?.turnId || null, submissionId: active?.submissionId || null, text: update.content.text });
    }
    emit({ type: 'session.update', turnId: active?.turnId || null, submissionId: active?.submissionId || null, update });
  }

  function onRequest(method, params, requestId) {
    if (method !== 'session/request_permission') throw failure(-32601, `Unsupported ACP client request: ${method}`);
    if (closing || params?.sessionId !== sessionId) return { outcome: { outcome: 'cancelled' } };
    const choices = Array.isArray(params.options) ? params.options : [];
    const reject = choices.find((option) => option?.kind === 'reject_once')
      || choices.find((option) => option?.kind === 'reject_always');
    if (options.interactive && active) {
      const turn = active, toolCallId = params.toolCall?.toolCallId;
      if (turn.interrupted) return { outcome: { outcome: 'cancelled' } };
      const publish = detail => {
        if (closing || active !== turn || turn.interrupted) return { outcome: { outcome: 'cancelled' } };
        const toolCall = { ...detail, ...params.toolCall };
        if (toolCallId && !Object.hasOwn(toolCall, 'rawInput') && !toolCall.contextTruncated) toolCall.contextPending = true;
        return interactions.request({ requestId, sessionId, turnId: turn.turnId,
          method, params: { toolCall, options: choices }, cancelled: { outcome: { outcome: 'cancelled' } },
          validate: (request, response) => {
            if (!['accept', 'decline', 'cancel'].includes(response.decision) || (request.truncated && response.decision === 'accept')) throw failure('INTERACTION_RESPONSE_INVALID', 'Invalid or truncated ACP permission');
            if (response.decision === 'accept' && (request.params.toolCall?.contextPending || request.params.toolCall?.contextTruncated)) throw failure('NATIVE_APPROVAL_CONTEXT_MISSING', 'ACP tool input is missing or truncated; only rejection is available');
            const selected = choices.find(option => option.kind === (response.decision === 'accept' ? 'allow_once' : 'reject_once'));
            if (response.decision === 'accept' && !selected) throw failure('INTERACTION_RESPONSE_INVALID', 'ACP did not offer approval for this operation');
            return response.decision === 'cancel' || !selected ? { outcome: { outcome: 'cancelled' } }
              : { outcome: { outcome: 'selected', optionId: selected.optionId } };
          } });
      };
      const detail = toolCalls.get(toolCallId);
      if (toolCallId && !Object.hasOwn(params.toolCall, 'rawInput') && !Object.hasOwn(detail || {}, 'rawInput') && !detail?.contextTruncated) {
        // rc.2 can ask with only an id before publishing the matching tool update.
        return waitForToolContext(toolCallId).then(value => publish(value || detail));
      }
      return publish(detail);
    }
    emit({ type: 'permission', decision: 'reject', toolCall: params.toolCall });
    return reject && typeof reject.optionId === 'string'
      ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
      : { outcome: { outcome: 'cancelled' } };
  }

  function onExit(info) {
    runtimeExited = true;
    cwdBinding.release();
    if (closing || runtimeDisposed || status === 'closed') return;
    const turn = active;
    interactions.expire();
    clearToolContext();
    active = null;
    status = 'exited';
    lastError = { code: 'NATIVE_RUNTIME_EXITED', message: 'The owned dsh ACP runtime exited', uncertain: Boolean(turn) };
    emit({ type: 'error', status: 'unknown', turnId: turn?.turnId || null, submissionId: turn?.submissionId || null, error: lastError, exit: info });
  }

  function onTransportError(error) {
    if (closing || status === 'closed') return;
    const turn = active;
    interactions.expire();
    clearToolContext();
    active = null;
    status = 'failed';
    lastError = { ...describe(error), uncertain: true };
    emit({ type: 'error', status: 'unknown', turnId: turn?.turnId || null,
      submissionId: turn?.submissionId || null, error: lastError });
  }

  async function open(input = {}) {
    if (input.sessionId !== undefined && (typeof input.sessionId !== 'string' || !input.sessionId.trim())) {
      throw failure('NATIVE_BAD_SESSION', 'Session identity must be a nonempty string');
    }
    if (closing || status === 'closed') throw failure('NATIVE_ADAPTER_CLOSED', 'The dsh ACP adapter is closed');
    if (['failed', 'exited'].includes(status)) throw failure('NATIVE_NOT_OPEN', 'The dsh ACP runtime cannot be reused after a failed open');
    if (sessionId) {
      if (input.sessionId && input.sessionId !== sessionId) throw failure('NATIVE_SESSION_MISMATCH', 'This adapter already owns a different session');
      return snapshot();
    }
    if (opening) {
      if ((input.sessionId || null) !== openingIdentity) throw failure('NATIVE_SESSION_MISMATCH', 'This adapter is opening a different session');
      return opening;
    }
    if (status !== 'new') throw failure('NATIVE_NOT_OPEN', 'The dsh ACP runtime cannot be reused after a failed open');
    status = 'opening';
    openingIdentity = input.sessionId || null;
    opening = (async () => {
      try {
        cwdBinding.assertUnchanged();
        const config = {
          binary: options.binary || 'dsh', args: ['--profile', 'acp'],
          cwd, env: options.env, timeoutMs: options.timeoutMs,
          onNotification, onRequest, onExit, onError: onTransportError
        };
        rpc = options.rpcFactory ? options.rpcFactory(config) : new JsonRpcProcess(config);
        await rpc.start();
        const initialized = await rpc.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'hello-cc', version: '1.0.1' }
        });
        if (initialized?.protocolVersion !== 1) throw failure('NATIVE_PROTOCOL_MISMATCH', 'The dsh runtime did not negotiate ACP v1');
        const extensions = initialized.agentCapabilities?.sessionCapabilities || {};
        capabilities.resume = extensions.resume !== undefined && extensions.resume !== null && extensions.resume !== false;
        capabilities.close = extensions.close !== undefined && extensions.close !== null && extensions.close !== false;
        if (input.sessionId && !capabilities.resume) throw failure('NATIVE_UNSUPPORTED', 'This ACP runtime does not advertise session resume');
        cwdBinding.assertUnchanged();
        const result = await rpc.request(input.sessionId ? 'session/resume' : 'session/new', {
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          cwd, mcpServers: Object.entries(options.mcpServers || {}).map(([name, config]) => ({ name, command: config.command, args: config.args,
            env: Object.entries(config.env || {}).map(([name, value]) => ({ name, value })) }))
        });
        const resolvedId = input.sessionId || result?.sessionId;
        if (typeof resolvedId !== 'string' || !resolvedId.trim() || (input.sessionId && result?.sessionId && result.sessionId !== input.sessionId)) {
          throw failure('NATIVE_PROTOCOL_ERROR', 'ACP returned an invalid session identity');
        }
        sessionId = resolvedId;
        const reportedModel = result?.configOptions?.find(option => option?.id === 'model')?.currentValue || result?.models?.currentModelId;
        runtimeMetadata = typeof reportedModel === 'string' ? { model: reportedModel } : {};
        if (input.model !== undefined) {
          const model = result?.configOptions?.find((option) => option?.id === 'model');
          if (!model || !advertisesValue(model.options, input.model)) throw failure('NATIVE_UNSUPPORTED_MODEL', 'Model must match an advertised ACP model option value');
          const configured = await rpc.request('session/set_config_option', { sessionId, configId: 'model', value: input.model });
          const confirmed = configured?.configOptions?.find(option => option?.id === 'model')?.currentValue;
          runtimeMetadata = typeof confirmed === 'string' ? { model: confirmed } : {};
        }
        if (closing || status === 'exited') throw failure('NATIVE_ADAPTER_CLOSED', 'The dsh ACP runtime closed during session initialization');
        status = 'idle';
        emit({ type: 'metadata', runtimeMetadata: { ...runtimeMetadata } });
        emit({ type: 'opened', resumed: Boolean(input.sessionId), status });
        return snapshot();
      } catch (error) {
        status = closing ? 'closing' : 'failed';
        lastError = describe(error);
        try { await disposeRuntime(); } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'ACP initialization and owned runtime cleanup failed');
        }
        throw error;
      }
    })();
    return opening;
  }

  async function send(input = {}) {
    if (closing || status === 'closed') throw failure('NATIVE_ADAPTER_CLOSED', 'The dsh ACP adapter is closed');
    if (!sessionId || !['idle', 'running', 'interrupting'].includes(status)) throw failure('NATIVE_NOT_OPEN', 'Open a dsh ACP session before sending a prompt');
    if (typeof input.text !== 'string' || !input.text.trim()) throw failure('NATIVE_BAD_PROMPT', 'Prompt text must be a nonempty string');
    if (input.submissionId !== undefined && (typeof input.submissionId !== 'string' || !input.submissionId.trim())) {
      throw failure('NATIVE_BAD_SUBMISSION', 'Submission identity must be a nonempty string');
    }
    const submissionId = input.submissionId || randomUUID();
    const previous = receipts.get(submissionId);
    if (previous) {
      if (previous.text !== input.text) throw failure('NATIVE_SUBMISSION_CONFLICT', 'A submission identity cannot be reused with different text');
      return { ...previous.receipt };
    }
    if (input.expectedTurnId && input.expectedTurnId !== active?.turnId) throw failure('NATIVE_STALE_TURN', 'The expected ACP submission is no longer active');
    if (active) throw failure('NATIVE_BUSY', 'ACP permits one in-flight prompt per session and does not support steering');
    cwdBinding.assertUnchanged();
    clearToolContext();
    const turn = { turnId: randomUUID(), submissionId, text: '' };
    active = turn;
    status = 'running';
    lastError = null;
    const receipt = { sessionId, turnId: turn.turnId, submissionId, status: 'queued' };
    receipts.set(submissionId, { text: input.text, receipt });
    if (receipts.size > 256) receipts.delete(receipts.keys().next().value);
    emit({ type: 'queued', ...receipt });
    // prompt settles only after Agent idle. Return the local queue receipt now;
    // only the real RPC response constitutes a completed submission.
    void Promise.resolve().then(() => {
      if (closing) throw failure('NATIVE_ADAPTER_CLOSED', 'The adapter closed before prompt submission');
      cwdBinding.assertUnchanged();
      return rpc.request('session/prompt', {
        sessionId, prompt: [{ type: 'text', text: input.text }]
      }, { timeoutMs: 0 });
    }).then((result) => {
      if (active !== turn || closing) return;
      if (!['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'].includes(result?.stopReason)) {
        throw failure('NATIVE_PROTOCOL_ERROR', 'ACP prompt returned an invalid stop reason');
      }
      interactions.expire(turn.turnId);
      clearToolContext();
      active = null;
      status = closing ? 'closing' : 'idle';
      emit({ type: 'completed', status: result.stopReason === 'cancelled' ? 'interrupted' : 'completed',
        sessionId, turnId: turn.turnId, submissionId, text: turn.text, stopReason: result.stopReason });
    }).catch((error) => {
      if (active !== turn || closing) return;
      interactions.expire(turn.turnId);
      clearToolContext();
      active = null;
      lastError = describe(error);
      const wireFailure = typeof error?.code === 'number' ||
        (error?.code === 'NATIVE_RPC_ERROR' && typeof error?.extra?.rpc_code === 'number');
      status = closing ? 'closing' : wireFailure ? 'idle' : 'failed';
      emit({ type: wireFailure ? 'completed' : 'error', status: wireFailure ? 'failed' : 'unknown',
        sessionId, turnId: turn.turnId, submissionId, text: turn.text,
        error: { ...lastError, uncertain: !wireFailure } });
    });
    return receipt;
  }

  async function interrupt(input = {}) {
    if (closing || status === 'closed') throw failure('NATIVE_ADAPTER_CLOSED', 'The dsh ACP adapter is closed');
    if (input.turnId && input.turnId !== active?.turnId) throw failure('NATIVE_STALE_TURN', 'The requested ACP submission is no longer active');
    if (!active) return { sessionId, turnId: null, status };
    const turn = active;
    await rpc.notify('session/cancel', { sessionId });
    // The prompt remains in flight until its terminal RPC response; late
    // permission requests must stay cancelled throughout that interval.
    turn.interrupted = true;
    interactions.expire(turn.turnId, 'interrupted');
    clearToolContext();
    if (active === turn) status = 'interrupting';
    const receipt = { sessionId, turnId: turn.turnId, submissionId: turn.submissionId, status: 'interrupting' };
    emit({ type: 'interrupt.requested', ...receipt });
    return receipt;
  }

  function close() {
    if (closePromise) return closePromise;
    if (runtimeDisposed && status === 'closed') return Promise.resolve(snapshot());
    // Once closure is requested, failed cleanup must never reopen this worker.
    // Only the in-flight cleanup promise is retryable.
    closing = true;
    const operation = (async () => {
      try {
        status = 'closing';
        interactions.expire();
        clearToolContext();
        const errors = [];
        if (opening) { try { await opening; } catch {} }
        if (rpc && !runtimeDisposed && !runtimeExited && !runtimeDisposalStarted && sessionId && capabilities.close) {
          try { await rpc.request('session/close', { sessionId }); } catch (error) { errors.push(error); }
        }
        try { await disposeRuntime(); } catch (error) { errors.push(error); }
        if (errors.length) lastError = { ...describe(errors.at(-1)), ...(!runtimeDisposed ? { uncertain: true } : {}) };
        status = runtimeDisposed ? 'closed' : 'failed';
        if (runtimeDisposed) {
          active = null;
          emit({ type: 'closed', status });
        }
        if (errors.length) throw new AggregateError(errors, 'ACP session or owned runtime cleanup failed');
        return snapshot();
      } finally { cwdBinding.release(); }
    })();
    closePromise = operation;
    void operation.catch(() => { if (closePromise === operation) closePromise = null; });
    return operation;
  }

  async function disposeRuntime() {
    if (runtimeDisposed || runtimeExited) { runtimeDisposed = true; return; }
    runtimeDisposalStarted = true;
    try {
      await rpc?.close();
      runtimeDisposed = true;
    } finally {
      // The transport may report its own cleanup failure after observing exit.
      // Preserve that error while retaining the independent exit receipt.
      if (runtimeExited) runtimeDisposed = true;
    }
  }

  return { capabilities, open, send, interrupt, close, snapshot, respond: interactions.respond };
}

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function describe(error) {
  return { code: error?.code || 'NATIVE_ERROR', message: String(error?.message || error),
    ...(error?.extra?.uncertain ? { uncertain: true } : {}) };
}

function advertisesValue(options, value) {
  return Array.isArray(options) && options.some((option) => option?.value === value || advertisesValue(option?.options, value));
}
