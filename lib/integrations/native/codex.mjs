import { JsonRpcProcess } from './jsonrpc.mjs';
import { createCodexAccountState } from '../codex-account.mjs';
import { createNativeInteractions } from './interactions.mjs';
import { codexUsage } from './telemetry.mjs';
import { captureSelectedCwdIdentity } from '../../process/selected-cwd-identity.mjs';
import { CODEX_INTERACTION_METHODS, codexInteractionKind, codexInteractionResponse, cancelCodexInteraction, codexInteractiveConfig } from '../codex-interactions.mjs';

const CAPABILITIES = Object.freeze({ create: true, resume: true, send: true, observe: true,
  steer: true, interrupt: true, close: true, fork: true, accountRead: true });
const TERMINAL_TURN_STATUSES = new Set(['completed', 'interrupted', 'failed']);

function adapterError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Owns a new app-server process; resume IDs must be ownership-checked by the HCC host. */
export function createCodexAdapter(options = {}) {
  const { binary = 'codex', cwd, env, timeoutMs = 30_000, onEvent = () => {},
    rpcFactory = (config) => new JsonRpcProcess(config) } = options;
  const cwdBinding = cwd ? captureSelectedCwdIdentity(cwd, options.expectedCwdIdentity) : null;
  const state = { provider: 'codex', sessionId: null, turnId: null, status: 'new', owned: true,
    sandbox: null, sandboxVerified: false };
  const terminalTurns = new Set();
  const interruptedTurns = new Set();
  const turnSubmissions = new Map();
  const finalMessages = new Map();
  let rpc;
  let closed = false;
  let admission = Promise.resolve();
  let pendingSubmissionId;
  let closePromise;
  const account = createCodexAccountState({ request: (method, params) => rpc.request(method, params),
    onChange: value => emit({ type: 'account', account: value }) });
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
    if (closed || account.notification(method, params) || !state.sessionId || params.threadId !== state.sessionId) return;
    const turnId = params.turn?.id ?? params.turnId;
    const submissionId = turnSubmissions.get(turnId) ?? pendingSubmissionId;
    if (method === 'thread/tokenUsage/updated') {
      const metrics = codexUsage(params);
      if (metrics) { state.metrics = metrics; emit({ type: 'usage', metrics, turnId }); }
    } else if (method === 'turn/started' && turnId && !terminalTurns.has(turnId)) {
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
    // A read-only session can answer questions, but no human response can grant
    // command/file/permission or MCP approval outside its requested policy.
    const canInteract = state.sandbox !== 'read-only' || method === 'item/tool/requestUserInput';
    if (canInteract && options.interactive && params.threadId === state.sessionId && params.turnId && !terminalTurns.has(params.turnId)) {
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
    cwdBinding?.release();
    account.close();
    interactions.expire();
    state.turnId = null;
    status('error');
    emit({ type: 'error', code: 'NATIVE_PROCESS_EXITED', text: 'The owned Codex app-server exited.',
      exitCode: details?.code ?? null, signal: details?.signal ?? null });
  }

  function transportError(error) {
    if (closed) return;
    account.close();
    interactions.expire();
    status('error');
    emit({ type: 'error', code: error.code ?? 'NATIVE_TRANSPORT_ERROR', text: error.message,
      turnId: state.turnId, extra: { ...error.extra } });
  }

  async function open({ sessionId, forkSessionId, model, sandbox = 'workspace-write' } = {}) {
    if (closed || state.status !== 'new') {
      throw adapterError('NATIVE_SESSION_ALREADY_OPEN', 'This Codex adapter can open only one owned session.');
    }
    if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId.trim())) {
      throw adapterError('BAD_ARGS', 'A Codex resume sessionId must be a nonempty string.');
    }
    if (forkSessionId !== undefined && (typeof forkSessionId !== 'string' || !forkSessionId.trim() || sessionId !== undefined)) {
      throw adapterError('BAD_ARGS', 'A fork needs one nonempty source session ID and cannot also resume.');
    }
    if (sandbox !== 'read-only' && sandbox !== 'workspace-write') {
      throw adapterError('BAD_ARGS', 'A Codex sandbox must be read-only or workspace-write.');
    }
    state.sandbox = sandbox;
    const readOnly = sandbox === 'read-only';
    capabilities.approvals = Boolean(options.interactive) && !readOnly;
    status('opening');
    try {
      cwdBinding?.assertUnchanged();
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
      if (readOnly) config['features.request_permissions_tool'] = false;
      const params = { sandbox, approvalPolicy: readOnly ? 'never' : 'on-request', approvalsReviewer: 'user',
        ...(Object.keys(config).length ? { config } : {}),
        ...(cwd ? { cwd } : {}), ...(model ? { model } : {}), ...(sessionId || forkSessionId ? { threadId: sessionId || forkSessionId } : {}) };
      cwdBinding?.assertUnchanged();
      const response = await rpc.request(forkSessionId ? 'thread/fork' : sessionId ? 'thread/resume' : 'thread/start', params);
      if (typeof response?.thread?.id !== 'string' || !response.thread.id.trim() ||
          (sessionId && response.thread.id !== sessionId) || (forkSessionId && response.thread.id === forkSessionId)) {
        throw adapterError('NATIVE_PROTOCOL_ERROR', 'Codex returned an invalid native thread identity.');
      }
      if (closed) throw adapterError('NATIVE_SESSION_CLOSED', 'The Codex session was closed while opening.');
      const activeTurn = response.thread.turns?.findLast((turn) => turn.status === 'inProgress');
      // Readback must confirm policy before exposing a resumed or forked thread.
      if (readOnly && (response.sandbox?.type !== 'readOnly' ||
          (response.sandbox.networkAccess !== undefined && response.sandbox.networkAccess !== false) ||
          response.approvalPolicy !== 'never')) {
        throw adapterError('NATIVE_SANDBOX_UNVERIFIED', 'Codex did not confirm the requested read-only sandbox and never-approve policy.');
      }
      if (readOnly && (activeTurn || response.thread.status?.type === 'active')) {
        throw adapterError('NATIVE_READ_ONLY_BUSY', 'An existing active Codex turn cannot be resumed or forked as verified read-only. Wait for it to finish first.');
      }
      state.sandboxVerified = readOnly || (response.sandbox?.type === 'workspaceWrite' && response.approvalPolicy === 'on-request');
      state.sessionId = response.thread.id;
      state.runtimeMetadata = { ...(typeof response.model === 'string' ? { model: response.model } : {}),
        ...(typeof response.approvalPolicy === 'string' ? { permissionMode: response.approvalPolicy } : {}) };
      emit({ type: 'metadata', runtimeMetadata: state.runtimeMetadata });
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
      cwdBinding?.assertUnchanged();
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
        ...(!turnId && state.sandbox === 'read-only' ? {
          sandboxPolicy: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never'
        } : {}),
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
    account.close();
    interactions.expire();
    state.turnId = null;
    status('closing');
    closePromise = Promise.resolve().then(() => rpc?.close()).then(() => {
      cwdBinding?.release();
      status('closed');
      return snapshot();
    }).catch((error) => {
      cwdBinding?.release();
      // Keep admissions revoked while allowing owned-process cleanup to retry.
      status('uncertain');
      closePromise = null;
      throw error;
    });
    return closePromise;
  }

  function snapshot() { return { ...state, executorId: interactions.executorId, capabilities: { ...capabilities },
    account: account.snapshot(), pendingApprovals: interactions.snapshot() }; }

  async function readAccount() { requireOpen(); await account.refresh(); requireOpen(); return account.snapshot(); }

  return { capabilities, open, send, interrupt, close, snapshot, readAccount, respond: interactions.respond };
}
