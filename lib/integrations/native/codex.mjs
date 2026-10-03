import { JsonRpcProcess } from './jsonrpc.mjs';
import { createNativeInteractions } from './interactions.mjs';
import { CODEX_INTERACTION_METHODS, codexInteractionKind, codexInteractionResponse, cancelCodexInteraction, codexInteractiveConfig } from '../codex-interactions.mjs';

const CAPABILITIES = Object.freeze({ create: true, resume: true, send: true, observe: true,
  steer: true, interrupt: true, close: true, fork: false });
const TERMINAL_TURN_STATUSES = new Set(['completed', 'interrupted', 'failed']);

function adapterError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Owns a new app-server process; resume IDs must be ownership-checked by the HCC host. */
export function createCodexAdapter(options = {}) {
  const { binary = 'codex', cwd, env, timeoutMs = 30_000, onEvent = () => {},
    rpcFactory = (config) => new JsonRpcProcess(config) } = options;
  const state = { provider: 'codex', sessionId: null, turnId: null, status: 'new', owned: true };
  const terminalTurns = new Set();
  const interruptedTurns = new Set();
  const turnSubmissions = new Map();
  const finalMessages = new Map();
  let rpc;
  let closed = false;
  let admission = Promise.resolve();
  let pendingSubmissionId;
  let closePromise;
  const capabilities = { ...CAPABILITIES, approvals: Boolean(options.interactive), userInput: Boolean(options.interactive), mcp: Boolean(options.mcpServers) };
  const interactions = createNativeInteractions({ executorId: options.executorId,
    isActive: (sessionId, turnId) => !closed && sessionId === state.sessionId && turnId === state.turnId && !terminalTurns.has(turnId) && !interruptedTurns.has(turnId) && !['error', 'uncertain', 'closed'].includes(state.status),
    onChange: emit });

  function emit(event) {
    // Consumer callbacks must not prevent a permission denial or corrupt protocol admission.
    try {
      const delivery = onEvent({ provider: 'codex', sessionId: state.sessionId, ...event });
      delivery?.catch?.(() => {});
    } catch {}
  }

  function status(value, details = {}) {
    state.status = value;
    emit({ type: 'status', status: value, turnId: state.turnId, ...details });
  }

  function requireOpen() {
    if (closed || !rpc || !state.sessionId || ['new', 'opening', 'error', 'uncertain', 'closed'].includes(state.status)) {
      throw adapterError('NATIVE_SESSION_NOT_OPEN', 'The Codex native session is not open.');
    }
  }

  function serial(operation) {
    const result = admission.then(operation);
    admission = result.catch(() => {});
    return result;
  }

  function notification(method, params = {}) {
    if (closed || !state.sessionId || params.threadId !== state.sessionId) return;
    const turnId = params.turn?.id ?? params.turnId;
    const submissionId = turnSubmissions.get(turnId) ?? pendingSubmissionId;
    if (method === 'turn/started' && turnId && !terminalTurns.has(turnId)) {
      if (submissionId) turnSubmissions.set(turnId, submissionId);
      state.turnId = turnId;
      status('busy');
    } else if (method === 'turn/completed' && turnId) {
      if (terminalTurns.has(turnId)) return;
      terminalTurns.add(turnId);
      interruptedTurns.delete(turnId);
      interactions.expire(turnId);
      if (terminalTurns.size > 128) {
        const oldest = terminalTurns.values().next().value;
        terminalTurns.delete(oldest);
        turnSubmissions.delete(oldest);
        finalMessages.delete(oldest);
      }
      if (!state.turnId || state.turnId === turnId) {
        state.turnId = null;
        status('idle', { completedTurnId: turnId, turnStatus: params.turn?.status });
      }
      emit({ type: 'completed', status: params.turn?.status ?? 'completed', turnId, submissionId,
        text: finalMessages.get(turnId) });
      if (params.turn?.error) emit({ type: 'error', turnId, error: params.turn.error });
    } else if (method === 'item/agentMessage/delta') {
      emit({ type: 'delta', text: params.delta ?? '', turnId, submissionId, itemId: params.itemId });
    } else if (method === 'item/completed' && params.item?.type === 'agentMessage') {
      finalMessages.set(turnId, params.item.text ?? '');
      emit({ type: 'message', text: params.item.text ?? '', turnId, submissionId, itemId: params.item.id });
    } else if (['item/started', 'item/completed'].includes(method) && ['commandExecution', 'fileChange', 'mcpToolCall'].includes(params.item?.type)) {
      emit({ type: 'item', phase: method.split('/')[1], item: params.item, turnId, submissionId });
    } else if (method === 'turn/plan/updated') {
      emit({ type: 'plan', plan: params.plan, explanation: params.explanation, turnId, submissionId });
    } else if (method === 'turn/diff/updated') {
      emit({ type: 'diff', diff: params.diff, turnId, submissionId });
    } else if (method === 'error') {
      emit({ type: 'error', turnId, error: params.error ?? params });
    } else if (method === 'serverRequest/resolved') {
      interactions.resolved(params.requestId);
    } else if (method === 'thread/status/changed' && params.status?.type === 'systemError') {
      interactions.expire();
      status('error');
    }
  }

  function serverRequest(method, params = {}, requestId) {
    if (!CODEX_INTERACTION_METHODS.has(method)) throw adapterError('NATIVE_SERVER_REQUEST_UNSUPPORTED', `Unsupported Codex server request: ${method}`);
    if (options.interactive && params.threadId === state.sessionId && params.turnId && !terminalTurns.has(params.turnId)) {
      // A server request can precede the turn/start admission response.
      if (!state.turnId && pendingSubmissionId) { state.turnId = params.turnId; status('busy'); }
      return interactions.request({ requestId, sessionId: params.threadId, turnId: params.turnId,
        kind: codexInteractionKind(method), method, params,
        validate: codexInteractionResponse, cancelled: cancelCodexInteraction(method) });
    }
    if (method !== 'item/tool/requestUserInput') emit({ type: 'approval', method, turnId: params.turnId,
      itemId: params.itemId, decision: 'decline', reason: params.reason ?? null });
    return method === 'mcpServer/elicitation/request' ? { action: 'decline' }
      : method === 'item/permissions/requestApproval' || method === 'item/tool/requestUserInput'
        ? cancelCodexInteraction(method) : { decision: 'decline' };
  }

  function exited(details = {}) {
    if (closed) return;
    interactions.expire();
    state.turnId = null;
    status('error');
    emit({ type: 'error', code: 'NATIVE_PROCESS_EXITED', text: 'The owned Codex app-server exited.',
      exitCode: details?.code ?? null, signal: details?.signal ?? null });
  }

  function transportError(error) {
    if (closed) return;
    interactions.expire();
    status('error');
    emit({ type: 'error', code: error.code ?? 'NATIVE_TRANSPORT_ERROR', text: error.message,
      turnId: state.turnId, extra: { ...error.extra } });
  }

  async function open({ sessionId, model } = {}) {
    if (closed || state.status !== 'new') {
      throw adapterError('NATIVE_SESSION_ALREADY_OPEN', 'This Codex adapter can open only one owned session.');
    }
    if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId.trim())) {
      throw adapterError('BAD_ARGS', 'A Codex resume sessionId must be a nonempty string.');
    }
    status('opening');
    try {
      rpc = rpcFactory({ binary, args: ['app-server', '--stdio'], cwd, env, timeoutMs,
        onNotification: notification, onRequest: serverRequest, onExit: exited, onError: transportError });
      await rpc.start();
      if (closed) throw adapterError('NATIVE_SESSION_CLOSED', 'The Codex session was closed while opening.');
      await rpc.request('initialize', { clientInfo: { name: 'hello_cc', version: '1.0.1' },
        capabilities: { experimentalApi: Boolean(options.interactive) } });
      if (closed) throw adapterError('NATIVE_SESSION_CLOSED', 'The Codex session was closed while opening.');
      await rpc.notify('initialized', {});
      if (closed) throw adapterError('NATIVE_SESSION_CLOSED', 'The Codex session was closed while opening.');
      const config = codexInteractiveConfig(options.mcpServers ? { mcp_servers: options.mcpServers } : {}, Boolean(options.interactive));
      const params = { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user',
        ...(Object.keys(config).length ? { config } : {}),
        ...(cwd ? { cwd } : {}), ...(model ? { model } : {}), ...(sessionId ? { threadId: sessionId } : {}) };
      const response = await rpc.request(sessionId ? 'thread/resume' : 'thread/start', params);
      if (!response?.thread?.id || (sessionId && response.thread.id !== sessionId)) {
        throw adapterError('NATIVE_PROTOCOL_ERROR', 'Codex returned an invalid native thread identity.');
      }
      if (closed) throw adapterError('NATIVE_SESSION_CLOSED', 'The Codex session was closed while opening.');
      state.sessionId = response.thread.id;
      const activeTurn = response.thread.turns?.findLast((turn) => turn.status === 'inProgress');
      state.turnId = activeTurn?.id ?? null;
      status(state.turnId ? 'busy' : 'idle');
      return snapshot();
    } catch (error) {
      if (!closed) {
        status('error');
        emit({ type: 'error', code: error.code, text: error.message, extra: { ...error.extra } });
      }
      await rpc?.close();
      throw error;
    }
  }

  function send({ text, submissionId, expectedTurnId } = {}) {
    return serial(async () => {
      requireOpen();
      if (typeof text !== 'string' || !text.trim()) throw adapterError('BAD_ARGS', 'A native message needs nonempty text.');
      const turnId = state.turnId;
      if (expectedTurnId !== undefined && expectedTurnId !== turnId) {
        throw adapterError('NATIVE_TURN_MISMATCH', 'The expected Codex turn is no longer active.');
      }
      if (state.status === 'busy' && !turnId) {
        throw adapterError('NATIVE_TURN_UNKNOWN', 'The active Codex turn identity is unavailable.');
      }
      const method = turnId ? 'turn/steer' : 'turn/start';
      const params = { threadId: state.sessionId, input: [{ type: 'text', text }],
        ...(submissionId ? { clientUserMessageId: submissionId } : {}),
        ...(turnId ? { expectedTurnId: expectedTurnId ?? turnId } : {}) };
      try {
        pendingSubmissionId = submissionId;
        const response = await rpc.request(method, params);
        const acceptedTurnId = turnId ? response?.turnId : response?.turn?.id;
        if (!acceptedTurnId || (turnId && acceptedTurnId !== turnId)) {
          throw adapterError('NATIVE_PROTOCOL_ERROR', 'Codex returned an invalid turn admission.');
        }
        if (submissionId && !turnSubmissions.has(acceptedTurnId)) turnSubmissions.set(acceptedTurnId, submissionId);
        if (!closed && !terminalTurns.has(acceptedTurnId)) {
          const turnStatus = response?.turn?.status;
          state.turnId = TERMINAL_TURN_STATUSES.has(turnStatus) ? null : acceptedTurnId;
          status(state.turnId ? 'busy' : 'idle');
        }
        return { sessionId: state.sessionId, turnId: acceptedTurnId, status: 'accepted' };
      } catch (error) {
        if (!closed && error.code === 'NATIVE_REQUEST_TIMEOUT' && error.extra?.uncertain) status('uncertain');
        emit({ type: 'error', code: error.code, text: error.message, turnId, extra: { ...error.extra } });
        // A rejected steer is not retried as a new turn: that would remove its turn precondition.
        throw error;
      } finally {
        pendingSubmissionId = undefined;
      }
    });
  }

  async function interrupt({ turnId = state.turnId } = {}) {
    requireOpen();
    if (!turnId) return { sessionId: state.sessionId, turnId: null, status: 'idle' };
    if (turnId !== state.turnId) throw adapterError('NATIVE_TURN_MISMATCH', 'The requested Codex turn is no longer active.');
    await rpc.request('turn/interrupt', { threadId: state.sessionId, turnId });
    interruptedTurns.add(turnId);
    interactions.expire(turnId, 'interrupted');
    return { sessionId: state.sessionId, turnId, status: 'accepted' };
  }

  function close() {
    if (closePromise) return closePromise;
    closed = true;
    interactions.expire();
    state.turnId = null;
    status('closed');
    closePromise = Promise.resolve().then(() => rpc?.close()).then(() => snapshot());
    return closePromise;
  }

  function snapshot() { return { ...state, executorId: interactions.executorId, capabilities: { ...capabilities }, pendingApprovals: interactions.snapshot() }; }

  return { capabilities, open, send, interrupt, close, snapshot, respond: interactions.respond };
}
