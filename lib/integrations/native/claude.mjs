import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNativeInteractions } from './interactions.mjs';
import { CliError } from '../../shared/errors.mjs';

const SESSION_MARKERS = new Set([
  'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_PARENT_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_AGENT_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_PARENT_THREAD_ID',
  'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED', 'TMUX', 'TMUX_PANE'
]);
const COORDINATION_KEYS = ['HCC_ROOT', 'HCC_DB', 'HCC_PEER', 'HCC_NATIVE_OWNER'];

function isolatedEnv(source, coordinationEnv = source) {
  const clean = Object.fromEntries(Object.entries(source).filter((entry) =>
    !entry[0].startsWith('HCC_') && !SESSION_MARKERS.has(entry[0])));
  // Only a complete, explicitly owned worker identity can reach its hooks.
  // An inherited terminal's partial HCC markers must not identify the worker.
  if (COORDINATION_KEYS.every((key) => typeof coordinationEnv[key] === 'string' && coordinationEnv[key])) {
    for (const key of COORDINATION_KEYS) clean[key] = coordinationEnv[key];
  }
  return clean;
}

function inputQueue(onConsume) {
  const values = [];
  let waiting = null;
  let ended = false;
  function push(value) {
    if (ended) throw new CliError('NATIVE_CLOSED', 'Claude native session is closed');
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      onConsume(value);
      resolve({ value, done: false });
    } else values.push(value);
  }
  function end() {
    ended = true;
    values.length = 0;
    if (waiting) waiting({ done: true });
    waiting = null;
  }
  return {
    push, end,
    [Symbol.asyncIterator]() { return this; },
    next() {
      if (values.length) {
        const value = values.shift();
        onConsume(value);
        return Promise.resolve({ value, done: false });
      }
      if (ended) return Promise.resolve({ done: true });
      return new Promise((resolve) => { waiting = resolve; });
    },
    return() {
      this.end();
      return Promise.resolve({ done: true });
    }
  };
}

function textContent(content) {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text || '').join('');
}

function withTimeout(promise, timeoutMs, operation) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new CliError('NATIVE_TIMEOUT',
        `Claude native ${operation} timed out`, { uncertain: true })), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

// This adapter owns an SDK subprocess. It does not attach to a running TUI.
export function createClaudeAdapter(options = {}) {
  const capabilities = Object.freeze({
    create: true, resume: true, send: true, observe: true,
    interrupt: true, close: true, steer: false, fork: false, approvals: Boolean(options.interactive), mcp: Boolean(options.mcpServers)
  });
  const timeoutMs = options.timeoutMs ?? 10_000;
  const env = isolatedEnv(options.env || process.env, options.coordinationEnv || options.env || {});
  let status = 'created';
  let sessionId = null;
  let requestedSessionId = null;
  let model;
  let queryFunction = options.query;
  let sdkQuery = null;
  let pump = null;
  let activeTurn = null;
  let opening = null;
  let closed = false;
  let queryEnded = false;
  let startupPromise = null;
  let teardownPromise = null;
  let closePromise = null;
  const interactions = createNativeInteractions({ executorId: options.executorId,
    isActive: (id, turnId) => !closed && id === sessionId && turnId === activeTurn?.id && !activeTurn?.interrupted && !queryEnded,
    onChange: event => emit(event.type, event) });

  function snapshot() {
    return {
      provider: 'claude', status, sessionId,
      turnId: activeTurn?.id || null,
      submissionId: activeTurn?.submissionId || null,
      capabilities, executorId: interactions.executorId, pendingApprovals: interactions.snapshot()
    };
  }

  function emit(type, fields = {}, turn = activeTurn) {
    const event = {
      type, provider: 'claude', sessionId,
      turnId: turn?.id || null, submissionId: turn?.submissionId || null,
      ...fields
    };
    // An event consumer must not break the SDK transport or permission reply.
    try {
      const delivery = options.onEvent?.(event);
      delivery?.catch?.(() => {});
    } catch {}
  }

  function setStatus(next, fields = {}, turn = activeTurn) {
    status = next;
    emit('status', { status: next, ...fields }, turn);
  }

  const inputs = inputQueue((input) => {
    if (activeTurn?.inputId === input.uuid && !closed) {
      activeTurn.consumed = true;
      setStatus('running');
    }
  });

  function ownsMessage(message, turn) {
    if (!turn || message.parent_tool_use_id) return false;
    const ids = [message.user_message_uuid, ...(message.user_message_uuids || [])]
      .filter(Boolean);
    if (ids.length) return ids.includes(turn.inputId);
    // Background task / peer turns cannot complete our pending submission.
    if (message.origin?.kind === 'task-notification' || message.origin?.kind === 'peer') return false;
    return turn.consumed;
  }

  function failTurn(error, turn = activeTurn) {
    interactions.expire(turn?.id);
    emit('error', {
      code: error.code || 'NATIVE_SDK_ERROR', message: error.message
    }, turn);
    if (turn && activeTurn === turn) {
      activeTurn = null;
      setStatus('error', { error: error.message }, turn);
    } else if (!closed) setStatus('error', { error: error.message }, turn);
  }

  function handleMessage(message) {
    if (closed || queryEnded) return;
    if (message.type === 'system' && message.subtype === 'init') {
      const initializedId = message.session_id;
      if (typeof initializedId !== 'string' || !initializedId.trim() ||
          /[\x00-\x1f\x7f]/.test(initializedId) ||
          (requestedSessionId && initializedId !== requestedSessionId)) {
        queryEnded = true;
        inputs.end();
        failTurn(new CliError('NATIVE_SESSION_MISMATCH',
          'Claude initialization did not confirm the requested valid session; refusing replacement session'));
        void teardownQuery().catch((error) => emit('error', {
          code: error.code || 'NATIVE_SDK_ERROR', message: error.message
        }));
        return;
      }
      sessionId = initializedId;
      emit('status', { status, initialized: Boolean(sessionId) });
      return;
    }
    const turn = activeTurn;
    const belongs = ownsMessage(message, turn);
    if (message.type === 'assistant') {
      const text = textContent(message.message?.content);
      if (text) {
        if (belongs) turn.lastText = text;
        emit('message', {
          text, role: 'assistant', messageId: message.uuid || message.message?.id,
          parentToolUseId: message.parent_tool_use_id || null
        }, belongs ? turn : null);
      }
      if (message.error && belongs) emit('error', {
        code: message.error, message: text || `Claude SDK assistant error: ${message.error}`
      }, turn);
      return;
    }
    if (message.type === 'stream_event') {
      const delta = message.event?.delta;
      if (delta?.type === 'text_delta' && delta.text) emit('delta', {
        text: delta.text, parentToolUseId: message.parent_tool_use_id || null
      }, belongs ? turn : null);
      return;
    }
    if (message.type !== 'result') return;
    if (belongs) interactions.expire(turn.id);
    if (!belongs) {
      // Startup errors may precede input consumption and have no UUID echo.
      if (turn && !message.parent_tool_use_id && !message.user_message_uuid &&
          !message.origin && (message.is_error || message.subtype !== 'success')) {
        queryEnded = true;
        inputs.end();
        emit('completed', { status: 'failed', text:
          (message.errors || []).join('; ') || message.result || message.subtype }, turn);
        failTurn(new CliError('NATIVE_SDK_RESULT_ERROR',
          (message.errors || []).join('; ') || message.result || message.subtype), turn);
      }
      return;
    }
    if (message.is_error || message.subtype !== 'success') {
      emit('completed', { status: 'failed', text:
        (message.errors || []).join('; ') || message.result || message.subtype }, turn);
      failTurn(new CliError('NATIVE_SDK_RESULT_ERROR',
        (message.errors || []).join('; ') || message.result || message.subtype), turn);
      return;
    }
    if (message.result && message.result !== turn.lastText) emit('message', {
      text: message.result, role: 'assistant', final: true
    }, turn);
    activeTurn = null;
    const completion = /^aborted_/.test(message.terminal_reason || '')
      ? 'interrupted' : 'completed';
    setStatus(completion, {}, turn);
    emit('completed', { status: completion, text: message.result || turn.lastText || '' }, turn);
  }

  async function open(request = {}) {
    const resumeId = request.sessionId;
    const selectedModel = request.model;
    if (closed) throw new CliError('NATIVE_CLOSED', 'Claude native session is closed');
    if (opening) return opening;
    if (status !== 'created') {
      if ((resumeId && resumeId !== requestedSessionId) ||
          (selectedModel && selectedModel !== model)) {
        throw new CliError('NATIVE_ALREADY_OPEN', 'Claude adapter already owns a different session');
      }
      return snapshot();
    }
    opening = (async () => {
      if (queryFunction === undefined) {
        try {
          let entry;
          try { entry = import.meta.resolve('@anthropic-ai/claude-agent-sdk'); }
          catch (error) {
            if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
            // A globally installed HCC can use the optional SDK installed in
            // this worker's project. Resolve it without changing global state.
            const projectRequire = createRequire(path.join(path.resolve(options.cwd || process.cwd()), 'package.json'));
            try { entry = pathToFileURL(projectRequire.resolve('@anthropic-ai/claude-agent-sdk')).href; }
            catch (projectError) {
              if (projectError.code !== 'MODULE_NOT_FOUND') throw projectError;
              throw new CliError('NATIVE_SDK_MISSING',
                'Claude native mode requires @anthropic-ai/claude-agent-sdk. In the worker project, run npm install @anthropic-ai/claude-agent-sdk; no package was installed automatically.');
            }
          }
          const sdk = await import(entry);
          queryFunction = sdk.query;
        } catch (error) {
          // A found SDK with broken exports/dependencies is not a missing SDK.
          throw error;
        }
      }
      if (typeof queryFunction !== 'function') {
        throw new CliError('NATIVE_SDK_INVALID', 'Claude Agent SDK must expose a query function');
      }
      if (closed) throw new CliError('NATIVE_CLOSED', 'Claude native session is closed');
      requestedSessionId = resumeId || null;
      model = selectedModel;
      // The SDK initializes after the first prompt. A requested resume ID is
      // not reported as an initialized session before the init event arrives.
      setStatus('ready', { initialized: false });
      return snapshot();
    })();
    try { return await opening; } finally { opening = null; }
  }

  function teardownQuery() {
    if (!sdkQuery) return Promise.resolve();
    if (!teardownPromise) {
      const teardown = Promise.resolve().then(() => sdkQuery.close?.());
      teardownPromise = teardown;
      // Share an in-flight teardown, but allow an explicit retry after failure.
      void teardown.catch(() => {
        if (teardownPromise === teardown) teardownPromise = null;
      });
    }
    return teardownPromise;
  }

  function startQuery() {
    if (closed) return Promise.reject(new CliError('NATIVE_CLOSED', 'Claude native session is closed'));
    if (startupPromise) return startupPromise;
    // Assign before invoking the factory so close() can observe and await any
    // in-progress resource creation, including factories that resolve late.
    startupPromise = Promise.resolve().then(async () => {
      sdkQuery = await queryFunction({
        prompt: inputs,
        options: {
          cwd: options.cwd, env, model,
          ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
          ...(requestedSessionId ? { resume: requestedSessionId } : {}),
          permissionMode: 'default',
          allowDangerouslySkipPermissions: false,
          includePartialMessages: true,
          canUseTool: async (tool, input, permission = {}) => {
            if (options.interactive && activeTurn && sessionId && !permission.parentToolUseID) {
              return interactions.request({ requestId: permission.requestId || permission.toolUseID || randomUUID(),
                sessionId, turnId: activeTurn.id, method: 'claude/canUseTool', params: { tool, input }, signal: permission.signal,
                cancelled: { behavior: 'deny', message: 'Request expired or cancelled' },
                validate: (request, response) => {
                  if (!['accept', 'decline', 'cancel'].includes(response.decision) || (request.truncated && response.decision === 'accept')) throw new CliError('INTERACTION_RESPONSE_INVALID', 'Invalid or truncated Claude approval');
                  return response.decision === 'accept' ? { behavior: 'allow', updatedInput: input }
                    : { behavior: 'deny', message: 'User declined this operation' };
                } });
            }
            emit('approval', {
              requestId: permission.requestId || permission.toolUseID || randomUUID(),
              tool, input, status: 'denied', decision: 'deny',
              message: 'HCC native mode does not approve permission requests automatically.'
            });
            return {
              behavior: 'deny',
              message: 'Approval is required; HCC native mode has no approval responder.',
              ...(permission.toolUseID ? { toolUseID: permission.toolUseID } : {})
            };
          }
        }
      });
      if (!sdkQuery?.[Symbol.asyncIterator]) {
        queryEnded = true;
        throw new CliError('NATIVE_SDK_INVALID', 'Claude query must return an asynchronous message stream');
      }
      // close() already owns the cleanup and awaits this startup promise.
      if (closed) return;
      pump = (async () => {
        try {
          for await (const message of sdkQuery) handleMessage(message);
          queryEnded = true;
          if (!closed && activeTurn) failTurn(new CliError('NATIVE_SDK_ENDED',
            'Claude SDK stream ended before the active submission completed'));
          else if (!closed && status !== 'error') setStatus('stopped');
        } catch (error) {
          queryEnded = true;
          if (!closed) failTurn(error);
        }
      })();
    });
    return startupPromise;
  }

  async function send({ text, submissionId, expectedTurnId } = {}) {
    if (typeof text !== 'string' || !text.trim()) {
      throw new CliError('BAD_ARGS', 'Claude native send requires non-empty text');
    }
    if (status === 'created') await open();
    if (closed) throw new CliError('NATIVE_CLOSED', 'Claude native session is closed');
    if (activeTurn) throw new CliError('NATIVE_BUSY',
      'Claude native session is busy; steering is unsupported. Wait for completion or interrupt it.');
    if (expectedTurnId) throw new CliError('NATIVE_STALE_TURN', 'Claude native session has no active turn to steer');
    if (queryEnded) throw new CliError('NATIVE_SDK_ENDED', 'Claude SDK stream has ended; open a new adapter to resume');
    const turn = {
      id: randomUUID(), inputId: randomUUID(),
      submissionId: submissionId || randomUUID(), consumed: false,
      lastText: null
    };
    activeTurn = turn;
    setStatus('queued');
    try {
      await startQuery();
      if (closed || queryEnded || activeTurn !== turn) {
        throw new CliError('NATIVE_SDK_ENDED', 'Claude SDK ended before accepting the submission');
      }
      inputs.push({
        type: 'user', uuid: turn.inputId,
        ...(sessionId ? { session_id: sessionId } : {}),
        parent_tool_use_id: null,
        message: { role: 'user', content: text }
      });
      return {
        sessionId, turnId: turn.id, submissionId: turn.submissionId,
        // Consuming the iterator is a local SDK handoff, not provider admission.
        status: 'queued'
      };
    } catch (error) {
      if (activeTurn === turn) failTurn(error, turn);
      throw error;
    }
  }

  async function interrupt(request = {}) {
    const turnId = request.turnId;
    if (closed) throw new CliError('NATIVE_CLOSED', 'Claude native session is closed');
    const turn = activeTurn;
    if (!turn || (turnId && turn.id !== turnId)) {
      throw new CliError('NATIVE_STALE_TURN', 'Claude native interrupt requires the active turn');
    }
    if (!sdkQuery?.interrupt) throw new CliError('NATIVE_UNSUPPORTED', 'Claude SDK does not support interruption');
    // interrupt() does not cancel queued SDK input. Keep the reservation until
    // a result arrives; never mark an unconsumed queued submission completed.
    const receipt = await withTimeout(Promise.resolve(sdkQuery.interrupt()), timeoutMs, 'interrupt');
    // Keep the turn reserved until its result arrives, but never reopen a
    // human approval after the provider accepted this interruption.
    turn.interrupted = true;
    interactions.expire(turn.id, 'interrupted');
    if (activeTurn === turn) emit('status', { status: 'interrupt_requested' }, turn);
    return { sessionId, turnId: turn.id, status: 'interrupt_requested', receipt };
  }

  function close() {
    if (closePromise) return closePromise;
    closed = true;
    interactions.expire();
    const turn = activeTurn;
    activeTurn = null;
    inputs.end();
    setStatus('closing', {}, turn);
    // A deadline bounds callers, while the cleanup keeps waiting for a late
    // factory and tears down its resource even if the caller already timed out.
    const cleanup = (async () => {
      if (opening) await opening.catch(() => {});
      if (startupPromise) await startupPromise.catch(() => {});
      await teardownQuery();
      if (pump) await pump;
      setStatus('closed', turn ? { cancelled: true } : {}, turn);
      return snapshot();
    })();
    closePromise = withTimeout(cleanup, timeoutMs, 'close').catch((error) => {
      // A caller may retry shutdown after the deadline or a teardown failure.
      closePromise = null;
      setStatus('error', { error: error.message, uncertain: true }, turn);
      throw error;
    });
    return closePromise;
  }

  return { capabilities, open, send, interrupt, close, snapshot, respond: interactions.respond };
}
