import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { CODEX_INTERACTION_METHODS, codexInteractionKind, codexInteractionResponse, cancelCodexInteraction, codexInteractiveConfig } from '../integrations/codex-interactions.mjs';

// stdio v2 protocol, checked against openai/codex 14a477ea89712071944244022e8a10142845456e.
// This adapter is created only by an explicitly selected App Server backend.
// Transport loss never reconnects or resubmits a mutating request.
const APPROVAL_METHODS = CODEX_INTERACTION_METHODS;
const TERMINAL_TURNS = new Set(['completed', 'interrupted', 'failed']);
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT = 65536;
const STREAM_UPDATE_MS = 50;

export class CodexAppServerError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'CodexAppServerError';
    this.code = code;
    this.extra = extra;
  }
}

function requiredId(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) {
    throw new CodexAppServerError('BAD_REQUEST', `${name} is required`);
  }
  return value;
}

function objectParams(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CodexAppServerError('BAD_REQUEST', 'parameters must be an object');
  }
  return value;
}

function normalizeInput(input) {
  if (typeof input === 'string' && input.trim()) {
    return [{ type: 'text', text: input, text_elements: [] }];
  }
  if (Array.isArray(input) && input.length && input.every((item) => item && typeof item === 'object')) {
    return input.map((item) => item.type === 'text' ? { ...item, text_elements: item.text_elements || [] } : { ...item });
  }
  throw new CodexAppServerError('BAD_REQUEST', 'non-empty input is required');
}

function rpcKey(id) {
  return `${typeof id}:${id}`;
}

export function createCodexAppServer({
  cwd, env = process.env, onChange = () => {},
  onSpawn = async () => null,
  requestTimeoutMs = 30000, closeTimeoutMs = 1000, clientVersion = '1.0.1',
  // Test seam. The production command and its arguments are always fixed below.
  spawnProcess = spawn
} = {}) {
  const root = path.resolve(cwd || process.cwd());
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) throw new TypeError('requestTimeoutMs must be positive');
  const executorId = randomUUID();
  let status = 'new';
  let child = null;
  let initialization = null;
  let metadata = null;
  let threadConfig = null;
  let sequence = 0;
  let notificationSequence = 0;
  let currentThreadId = null;
  let buffer = '';
  let truncated = false;
  let closePromise = null;
  let streamTimer = null;
  let streamEvent = null;
  const threads = new Map();
  const pending = new Map();
  const approvals = new Map();
  const uncertain = new Map();
  const submittingThreads = new Set();
  const threadNotificationSequences = new Map();
  const events = [];

  function bounded(value, limit = MAX_TEXT, depth = 0) {
    if (typeof value === 'string') {
      if (value.length <= limit) return value;
      truncated = true;
      return `${value.slice(0, limit)}\n[truncated]`;
    }
    if (depth > 12) { truncated = true; return '[truncated]'; }
    if (Array.isArray(value)) {
      if (value.length > 100) truncated = true;
      return value.slice(-100).map((entry) => bounded(entry, limit, depth + 1));
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value);
      if (entries.length > 100) truncated = true;
      return Object.fromEntries(entries.slice(0, 100).map(([key, entry]) => [key, bounded(entry, limit, depth + 1)]));
    }
    return value;
  }

  function snapshot() {
    const current = threads.get(currentThreadId);
    return structuredClone({
      executorId, backend: 'codex-app-server', status, cwd: root, pid: child?.pid || null,
      processExited: Boolean(child && (child.exitCode != null || child.signalCode != null)),
      metadata, currentThreadId, threadId: currentThreadId, turnId: current?.activeTurnId || null,
      threads: [...threads.values()],
      pendingApprovals: [...approvals.values()].filter((approval) => approval.status === 'pending'),
      uncertainSubmissions: [...uncertain.values()].map(({ params, ...entry }) => entry),
      uncertainRecovery: uncertain.size ? 'stop-executor-and-resume-history' : null,
      events, truncated
    });
  }

  function publishChange(event) {
    clearTimeout(streamTimer); streamTimer = null; streamEvent = null;
    try { onChange(snapshot(), structuredClone(event)); } catch { /* UI observers do not own transport. */ }
  }

  function changed(method, params = {}) {
    const event = { method, params: bounded(params, 8192), at: Date.now() };
    events.push(event);
    if (events.length > 100) events.shift();
    // Keep protocol state current on every token, but copy/broadcast its complete
    // retained history at most once per interval during a text-only burst.
    // Approval, completion, error and connection changes publish immediately;
    // their snapshot includes all pending text and cancels the trailing timer.
    if (method === 'item/agentMessage/delta') {
      streamEvent = event;
      if (!streamTimer) {
        streamTimer = setTimeout(() => publishChange(streamEvent), STREAM_UPDATE_MS);
        streamTimer.unref?.();
      }
    } else publishChange(event);
  }

  function ensureThread(id) {
    requiredId(id, 'threadId');
    if (!threads.has(id)) {
      if (threads.size >= 10) {
        const evictable = [...threads.values()].find((thread) => !thread.activeTurnId &&
          ![...approvals.values()].some((approval) => approval.threadId === thread.id));
        if (!evictable) throw new CodexAppServerError('CODEX_THREAD_LIMIT', 'too many active threads');
        threads.delete(evictable.id);
        truncated = true;
      }
      threads.set(id, { id, status: { type: 'notLoaded' }, activeTurnId: null, turns: [] });
    }
    return threads.get(id);
  }

  function ensureTurn(threadId, turnId) {
    const thread = ensureThread(threadId);
    requiredId(turnId, 'turnId');
    let turn = thread.turns.find((entry) => entry.id === turnId);
    if (!turn) {
      turn = { id: turnId, status: 'inProgress', items: [], diff: '', plan: [] };
      thread.turns.push(turn);
      if (thread.turns.length > 10) { thread.turns.shift(); truncated = true; }
    }
    return turn;
  }

  function expireApprovals(threadId, turnId = null) {
    for (const [key, approval] of approvals) {
      if (approval.threadId === threadId && (!turnId || approval.turnId === turnId)) {
        approvals.delete(key);
        if (approval.status === 'pending' && status === 'ready') write({ id: approval.requestId, result: cancelCodexInteraction(approval.method) });
      }
    }
  }

  function boundItems(turn) {
    while (turn.items.length > 100 || JSON.stringify(turn.items).length > 1024 * 1024) {
      turn.items.shift(); truncated = true;
    }
  }

  function absorbThread(value, requestSequence = null) {
    if (!value?.id) throw new CodexAppServerError('CODEX_PROTOCOL_ERROR', 'thread response has no id');
    const thread = ensureThread(value.id);
    const previousStatus = thread.status;
    const previousActiveTurnId = thread.activeTurnId;
    const newerNotification = requestSequence !== null &&
      (threadNotificationSequences.get(value.id) || 0) > requestSequence;
    const oldTurns = thread.turns;
    Object.assign(thread, bounded(value));
    thread.turns = oldTurns;
    for (const turn of value.turns || []) absorbTurn(value.id, turn);
    if (newerNotification) {
      thread.status = previousStatus;
      thread.activeTurnId = previousActiveTurnId;
    } else if (value.status) thread.status = bounded(value.status);
    if (['idle', 'notLoaded', 'systemError'].includes(thread.status?.type)) {
      thread.activeTurnId = null;
      expireApprovals(value.id);
    }
    currentThreadId = value.id;
    return thread;
  }

  function absorbTurn(threadId, value) {
    if (!value?.id) throw new CodexAppServerError('CODEX_PROTOCOL_ERROR', 'turn response has no id');
    const thread = ensureThread(threadId);
    const turn = ensureTurn(threadId, value.id);
    const previousStatus = turn.status;
    const previousItems = turn.items;
    const previousError = turn.error;
    const previousCompletedAt = turn.completedAt;
    Object.assign(turn, bounded(value));
    // Notifications can complete before the turn/start response arrives.
    // A stale response/read must not resurrect that same terminal turn.
    if (TERMINAL_TURNS.has(previousStatus) && !TERMINAL_TURNS.has(value.status)) {
      turn.status = previousStatus;
      turn.error = previousError;
      turn.completedAt = previousCompletedAt;
    }
    // Completion/start envelopes often omit items (itemsView=notLoaded).
    if (value.itemsView === 'notLoaded' || (value.items?.length === 0 && previousItems.length)) {
      turn.items = previousItems;
    }
    turn.items ||= [];
    boundItems(turn);
    if (TERMINAL_TURNS.has(turn.status)) {
      if (thread.activeTurnId === turn.id) thread.activeTurnId = null;
      if (!thread.activeTurnId) thread.status = { type: 'idle' };
      expireApprovals(threadId, turn.id);
    } else {
      thread.activeTurnId = turn.id;
      thread.status = { type: 'active', activeFlags: [] };
    }
    return turn;
  }

  function applyResult(method, params, result, requestSequence) {
    if (['thread/start', 'thread/resume', 'thread/read'].includes(method)) absorbThread(result?.thread, requestSequence);
    if (method === 'turn/start') absorbTurn(params.threadId, result?.turn);
  }

  function markUncertain(entry, reason) {
    uncertain.set(rpcKey(entry.requestId), {
      requestId: entry.requestId, method: entry.method,
      threadId: entry.method === 'thread/fork' ? null : entry.params.threadId || null, turnId: entry.params.turnId || entry.params.expectedTurnId || null,
      createdAt: entry.createdAt, reason, status: 'uncertain', params: entry.params,
      notificationSequence: entry.notificationSequence, absorb: entry.absorb
    });
  }

  function disconnect(code, message) {
    if (status === 'disconnected' || status === 'closed') return;
    status = 'disconnected';
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      const isUncertain = entry.mutation && entry.sent;
      if (isUncertain) markUncertain(entry, code);
      entry.reject(new CodexAppServerError(isUncertain ? 'CODEX_SUBMISSION_UNCERTAIN' : code,
        message, { executorId, requestId: entry.requestId, method: entry.method, uncertain: isUncertain }));
    }
    pending.clear();
    approvals.clear();
    changed('transport.disconnected', { code, message });
  }

  function write(message) {
    if (!child?.stdin || child.stdin.destroyed || ['disconnected', 'closed'].includes(status)) {
      throw new CodexAppServerError('CODEX_DISCONNECTED', 'Codex App Server is disconnected');
    }
    const frame = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(frame) > MAX_LINE_BYTES) throw new CodexAppServerError('BAD_REQUEST', 'protocol input is too large');
    child.stdin.write(frame, (error) => {
      if (error) disconnect('CODEX_DISCONNECTED', 'Codex App Server input closed');
    });
  }

  function request(method, params, mutation = false, absorb = true) {
    if (['disconnected', 'closed'].includes(status)) {
      return Promise.reject(new CodexAppServerError('CODEX_DISCONNECTED', 'Create a new executor to reconnect; requests are never replayed'));
    }
    if (pending.size >= 128 || (mutation && uncertain.size >= 32)) {
      return Promise.reject(new CodexAppServerError('CODEX_REQUEST_LIMIT', 'too many pending or uncertain requests; recover this executor before submitting more work'));
    }
    if (mutation && [...uncertain.values()].some((entry) => !entry.threadId)) {
      return Promise.reject(new CodexAppServerError('CODEX_SUBMISSION_UNCERTAIN', 'an earlier submission has no confirmed thread identity; stop this executor and inspect history before submitting more work'));
    }
    const requestId = ++sequence;
    return new Promise((resolve, reject) => {
      const entry = { requestId, method, params, mutation, absorb, resolve, reject, sent: false, createdAt: Date.now(), notificationSequence };
      entry.timer = setTimeout(() => {
        pending.delete(rpcKey(requestId));
        if (mutation && entry.sent) markUncertain(entry, 'timeout');
        reject(new CodexAppServerError(mutation && entry.sent ? 'CODEX_SUBMISSION_UNCERTAIN' : 'CODEX_REQUEST_TIMEOUT',
          `${method} timed out; it will not be replayed`, { executorId, requestId, method, uncertain: mutation && entry.sent }));
        changed('request.timeout', { requestId, method, uncertain: mutation && entry.sent });
      }, requestTimeoutMs);
      pending.set(rpcKey(requestId), entry);
      try {
        entry.sent = true;
        write({ id: requestId, method, params });
      } catch (error) {
        clearTimeout(entry.timer);
        pending.delete(rpcKey(requestId));
        reject(error);
      }
    });
  }

  function serverRequest(message) {
    const params = objectParams(message.params);
    if (!APPROVAL_METHODS.has(message.method)) {
      write({ id: message.id, error: { code: -32601, message: 'This hello-cc adapter does not support this server request' } });
      changed('serverRequest.unsupported', { requestId: message.id, method: message.method, threadId: params.threadId, turnId: params.turnId });
      return;
    }
    const threadId = requiredId(params.threadId, 'threadId');
    // Standalone MCP elicitations can lack turn correlation. They cannot be
    // approved as work belonging to the visible turn.
    if (message.method === 'mcpServer/elicitation/request' && !params.turnId) {
      write({ id: message.id, result: cancelCodexInteraction(message.method) });
      changed('approval.expired', { requestId: message.id, threadId, turnId: null });
      return;
    }
    const turnId = requiredId(params.turnId, 'turnId');
    const thread = ensureThread(threadId);
    const turn = ensureTurn(threadId, turnId);
    if (TERMINAL_TURNS.has(turn.status) || (thread.activeTurnId && thread.activeTurnId !== turnId)) {
      write({ id: message.id, result: cancelCodexInteraction(message.method) });
      changed('approval.expired', { requestId: message.id, threadId, turnId });
      return;
    }
    const key = rpcKey(message.id);
    if (approvals.has(key)) throw new CodexAppServerError('CODEX_PROTOCOL_ERROR', 'server reused an unresolved request id');
    if (approvals.size >= 64) throw new CodexAppServerError('CODEX_PROTOCOL_ERROR', 'too many unresolved approvals');
    thread.activeTurnId = turnId;
    thread.status = { type: 'active', activeFlags: [codexInteractionKind(message.method) === 'userInput' ? 'waitingOnUserInput' : 'waitingOnApproval'] };
    const preview = bounded(params);
    approvals.set(key, {
      executorId, requestId: message.id, threadId, turnId, itemId: params.itemId || null,
      approvalId: params.approvalId || null, method: message.method, kind: codexInteractionKind(message.method), params: preview,
      truncated: JSON.stringify(preview) !== JSON.stringify(params),
      status: 'pending', createdAt: Date.now()
    });
    changed('approval.requested', approvals.get(key));
  }

  function notification(method, params) {
    notificationSequence += 1;
    const notifiedThread = params.threadId || params.thread?.id;
    if (notifiedThread) threadNotificationSequences.set(notifiedThread, notificationSequence);
    if (method === 'thread/started') absorbThread(params.thread);
    if (method === 'thread/status/changed') {
      const thread = ensureThread(params.threadId);
      thread.status = bounded(params.status);
      if (['idle', 'notLoaded', 'systemError'].includes(params.status?.type)) {
        thread.activeTurnId = null;
        expireApprovals(params.threadId);
      }
    }
    if (method === 'turn/started' || method === 'turn/completed') absorbTurn(params.threadId, params.turn);
    if (method === 'serverRequest/resolved') {
      const approval = approvals.get(rpcKey(params.requestId));
      if (approval?.threadId === params.threadId) approvals.delete(rpcKey(params.requestId));
    }
    if (method === 'turn/diff/updated') ensureTurn(params.threadId, params.turnId).diff = bounded(params.diff || '');
    if (method === 'turn/plan/updated') {
      Object.assign(ensureTurn(params.threadId, params.turnId), { plan: bounded(params.plan || []), explanation: bounded(params.explanation) });
    }
    if (['item/started', 'item/completed', 'item/agentMessage/delta'].includes(method)) {
      const turn = ensureTurn(params.threadId, params.turnId);
      const itemId = params.item?.id || params.itemId;
      requiredId(itemId, 'itemId');
      let item = turn.items.find((entry) => entry.id === itemId);
      if (!item) { item = { id: itemId, type: 'agentMessage', text: '' }; turn.items.push(item); }
      if (params.item) Object.assign(item, bounded(params.item));
      else item.text = bounded((item.text || '') + (params.delta || ''));
      boundItems(turn);
    }
    changed(method, params);
  }

  function receive(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new CodexAppServerError('CODEX_PROTOCOL_ERROR', 'expected a protocol object');
    }
    if (message.method) {
      if (Object.hasOwn(message, 'id')) {
        if (!['string', 'number'].includes(typeof message.id)) throw new CodexAppServerError('CODEX_PROTOCOL_ERROR', 'invalid request id');
        serverRequest(message);
      } else notification(message.method, objectParams(message.params));
      return;
    }
    if (!Object.hasOwn(message, 'id') || (!Object.hasOwn(message, 'result') && !message.error)) {
      throw new CodexAppServerError('CODEX_PROTOCOL_ERROR', 'invalid response envelope');
    }
    const key = rpcKey(message.id);
    const entry = pending.get(key);
    const late = uncertain.get(key);
    if (!entry && !late) return;
    if (entry) { clearTimeout(entry.timer); pending.delete(key); }
    const operation = entry || late;
    if (message.error) {
      const error = new CodexAppServerError('CODEX_RPC_ERROR', message.error.message || 'Codex request failed', { rpcCode: message.error.code, data: bounded(message.error.data), method: operation.method });
      entry?.reject(error);
    } else {
      try { if (operation.absorb !== false) applyResult(operation.method, operation.params, message.result, operation.notificationSequence); }
      catch (error) { entry?.reject(error); throw error; }
      entry?.resolve(message.result);
    }
    uncertain.delete(key);
    changed(late ? 'request.reconciled' : 'request.completed', { requestId: message.id, method: operation.method, error: message.error || null });
  }

  function initialize() {
    if (initialization) return initialization;
    if (status !== 'new') return Promise.reject(new CodexAppServerError('CODEX_DISCONNECTED', 'executor cannot restart'));
    initialization = (async () => {
      status = 'connecting';
      try {
        child = spawnProcess('codex', ['app-server', '--listen', 'stdio://'], {
          cwd: root, env: { ...env }, stdio: ['pipe', 'pipe', 'pipe']
        });
        if (!child?.stdin || !child.stdout) throw new CodexAppServerError('CODEX_START_FAILED', 'Codex process has no stdio transport');
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (data) => {
          if (['disconnected', 'closed'].includes(status)) return;
          try {
            buffer += data;
            let end;
            while ((end = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
              if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new CodexAppServerError('CODEX_PROTOCOL_ERROR', 'protocol frame is too large');
              if (line) receive(JSON.parse(line));
            }
            if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) throw new CodexAppServerError('CODEX_PROTOCOL_ERROR', 'protocol frame is too large');
          } catch (error) {
            disconnect('CODEX_PROTOCOL_ERROR', error.message);
            child.kill('SIGTERM');
          }
        });
        child.stdout.on('error', () => disconnect('CODEX_DISCONNECTED', 'Codex output closed'));
        child.stdin.on('error', () => disconnect('CODEX_DISCONNECTED', 'Codex input closed'));
        // Drain diagnostics, but never publish environment/auth data or stderr in UI state.
        child.stderr?.on('data', () => {});
        child.on('error', () => disconnect('CODEX_START_FAILED', 'Could not start the installed codex executable'));
        child.on('exit', () => disconnect('CODEX_DISCONNECTED', 'Codex App Server exited'));
        child.stdout.on('end', () => disconnect('CODEX_DISCONNECTED', 'Codex App Server output ended'));
        changed('transport.connecting');
        metadata = bounded(await request('initialize', {
          clientInfo: { name: 'hello_cc', title: 'hello-cc', version: clientVersion },
          capabilities: { experimentalApi: true }
        }));
        write({ method: 'initialized' });
        // The handshake proves that launcher shims have exec'd the actual
        // server before the manager fingerprints its owner. Private thread
        // configuration stays outside snapshots/events and exists before any
        // thread/start or thread/resume can use it.
        threadConfig = await onSpawn({ pid: child.pid, executorId });
        if (status !== 'connecting' || child.exitCode != null || child.signalCode != null || child.stdin.destroyed) {
          throw new CodexAppServerError('CODEX_DISCONNECTED', 'Executor disconnected while preparing its private thread configuration');
        }
        status = 'ready';
        changed('transport.ready', metadata);
        return metadata;
      } catch (error) {
        disconnect(error.code || 'CODEX_START_FAILED', error.message);
        try { child?.kill('SIGTERM'); } catch {}
        throw error;
      }
    })();
    return initialization;
  }

  async function call(method, params, mutation = false, absorb = true) {
    await initialize();
    return request(method, params, mutation, absorb);
  }

  function assertActiveTurn(threadId, turnId) {
    requiredId(threadId, 'threadId'); requiredId(turnId, 'turnId');
    if (threads.get(threadId)?.activeTurnId !== turnId) {
      throw new CodexAppServerError('CODEX_TURN_MISMATCH', 'turn is no longer active on this executor');
    }
  }

  async function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      disconnect('CODEX_CLOSED', 'Codex App Server was closed');
      status = 'closed'; approvals.clear();
      changed('transport.closed');
      if (!child || child.exitCode != null || child.signalCode != null) return;
      await new Promise((resolve) => {
        let timer;
        const done = () => { clearTimeout(timer); child.removeListener('exit', done); resolve(); };
        child.once('exit', done);
        timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} done(); }, closeTimeoutMs);
        try { child.stdin?.end(); child.kill('SIGTERM'); } catch { done(); }
      });
    })();
    return closePromise;
  }

  return {
    initialize, snapshot, close,
    async startThread(params = {}) {
      await initialize();
      return request('thread/start', { cwd: root, sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user',
        ...objectParams(params), config: codexInteractiveConfig({ ...objectParams(params).config, ...threadConfig }) }, true);
    },
    async resumeThread(threadId, params = {}) {
      await initialize();
      return request('thread/resume', { cwd: root, approvalPolicy: 'on-request', approvalsReviewer: 'user',
        ...objectParams(params), config: codexInteractiveConfig({ ...objectParams(params).config, ...threadConfig }),
        threadId: requiredId(threadId, 'threadId') }, true);
    },
    readThread(threadId, params = {}) {
      return call('thread/read', { includeTurns: true, ...objectParams(params), threadId: requiredId(threadId, 'threadId') });
    },
    peekThread(threadId) {
      return call('thread/read', { includeTurns: true, threadId: requiredId(threadId, 'threadId') }, false, false);
    },
    async forkThread(threadId, params = {}, beforeSubmit = () => {}) {
      await initialize();
      beforeSubmit();
      return request('thread/fork', { cwd: root, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write',
        ...objectParams(params), config: codexInteractiveConfig({ ...objectParams(params).config, ...threadConfig }),
        threadId: requiredId(threadId, 'threadId') }, true, false);
    },
    listThreads(params = {}) { return call('thread/list', { limit: 50, cwd: root, ...objectParams(params) }); },
    async startTurn(threadId, input, params = {}) {
      requiredId(threadId, 'threadId');
      const normalized = normalizeInput(input);
      await initialize();
      const thread = threads.get(threadId);
      if (!thread || thread.status?.type === 'notLoaded') throw new CodexAppServerError('CODEX_THREAD_NOT_LOADED', 'start or resume the thread on this executor first');
      if (thread.activeTurnId || thread.status?.type === 'active' || submittingThreads.has(threadId) ||
          [...uncertain.values()].some((entry) => entry.threadId === threadId)) {
        throw new CodexAppServerError('CODEX_THREAD_BUSY', 'thread has an active or uncertain turn; no input was submitted');
      }
      currentThreadId = threadId; submittingThreads.add(threadId);
      try {
        return await request('turn/start', { ...objectParams(params), threadId, input: normalized }, true);
      } finally { submittingThreads.delete(threadId); }
    },
    steer(threadId, turnId, input) {
      assertActiveTurn(threadId, turnId);
      return call('turn/steer', { threadId, expectedTurnId: turnId, input: normalizeInput(input) }, true);
    },
    interrupt(threadId, turnId) {
      assertActiveTurn(threadId, turnId);
      return call('turn/interrupt', { threadId, turnId }, true).then(result => { expireApprovals(threadId, turnId); changed('approval.expired', { threadId, turnId }); return result; });
    },
    async approve({ executorId: submittedExecutorId, threadId, turnId, requestId, decision, permissions, scope, answers } = {}) {
      if (submittedExecutorId !== executorId) throw new CodexAppServerError('CODEX_APPROVAL_MISMATCH', 'approval identity or decision is invalid');
      assertActiveTurn(threadId, turnId);
      const approval = approvals.get(rpcKey(requestId));
      if (!approval || approval.status !== 'pending' || approval.threadId !== threadId || approval.turnId !== turnId) {
        throw new CodexAppServerError('CODEX_APPROVAL_MISMATCH', 'approval is expired or belongs to another turn');
      }
      if (approval.truncated && decision === 'accept') {
        throw new CodexAppServerError('CODEX_APPROVAL_TRUNCATED', 'approval details exceed the preview limit; decline or cancel instead');
      }
      const result = codexInteractionResponse({ ...approval, kind: approval.kind || codexInteractionKind(approval.method) }, { decision, permissions, scope, answers });
      await initialize();
      // No await between checking a live request and replying to its exact RPC id.
      assertActiveTurn(threadId, turnId);
      if (approvals.get(rpcKey(requestId)) !== approval) throw new CodexAppServerError('CODEX_APPROVAL_MISMATCH', 'approval was resolved');
      write({ id: requestId, result });
      approval.status = 'submitted';
      changed('approval.submitted', { executorId, threadId, turnId, requestId, decision });
      return { executorId, threadId, turnId, requestId, decision, status: 'submitted' };
    }
  };
}
