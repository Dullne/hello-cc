import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { CliError } from '../shared/errors.mjs';
import { redactSecrets } from '../shared/redact.mjs';
import { tx } from '../db/schema.mjs';
import { createEventHelpers } from '../db/events.mjs';
import { nativeRequest } from '../runtime/native/client.mjs';

const PROVIDERS = new Set(['codex', 'claude', 'dsh']);
const CLOSED = new Set(['closed', 'exited', 'stopped']);
const HISTORY_LIMIT = 200;

// A Web view of a worker already owned by the independent native service.
// This module never starts a service, provider process, or foreign TUI session.
export function createNativeSessions({ sessions, sessionKey, connectWebProject,
  broadcast = () => {}, closeSessionClients = () => {},
  now = () => Math.floor(Date.now() / 1000), nativeApi = nativeRequest,
  addEvent = createEventHelpers({ now }).addEvent } = {}) {
  const projects = new Map();
  const scans = new Map();
  let stopped = false;

  function projectKey(ctx) { return `${ctx.root}\0${path.resolve(ctx.dbPath)}`; }
  function projectSessions(ctx) {
    return [...sessions.values()].filter((session) => session.type === 'native' &&
      projectKey(session.ctx) === projectKey(ctx) && !session.nativeRetired);
  }
  function errorInfo(error) {
    return redactSecrets({ code: error.code || 'NATIVE_RUNTIME_OFFLINE',
      message: error.message || 'Native runtime is disconnected' });
  }
  function publishState(session, state) {
    // Event cursors do not cover approvals, delivery receipts or capabilities.
    // Compare the complete normalized state; validation and lease revocation
    // still run on every read, including reads that need no new UI frame.
    const changed = !isDeepStrictEqual(session.nativeState, state);
    session.nativeState = state;
    if (changed) broadcast(session, { type: 'native_state', state: session.nativeSnapshot() });
  }
  function disconnect(session, error, retire = false) {
    session.status = 'disconnected';
    publishState(session, { ...session.nativeState, connected: false, status: 'disconnected', error: errorInfo(error) });
    if (retire && !session.nativeRetired) {
      session.nativeRetired = true;
      closeSessionClients(session);
      session.actionTokens.clear();
      session.actionTokenSockets?.clear();
    }
  }
  function assertProject(ctx, value) {
    if (!value || value.root !== fs.realpathSync(ctx.root) || value.meshDb !== path.resolve(ctx.dbPath) ||
        typeof value.generation !== 'string' || !value.generation || value.generation.length > 128) {
      throw new CliError('NATIVE_SCOPE_CHANGED', 'Native runtime does not match this project');
    }
  }
  function validateState(ctx, peer, value) {
    assertProject(ctx, value);
    if (value.peer !== peer || !PROVIDERS.has(value.provider) ||
        typeof value.owner !== 'string' || !value.owner || value.owner.length > 512 ||
        !value.snapshot || value.snapshot.provider !== value.provider ||
        typeof value.snapshot.status !== 'string' ||
        (value.snapshot.sessionId != null && typeof value.snapshot.sessionId !== 'string') ||
        !Array.isArray(value.events) || !Array.isArray(value.deliveries) ||
        value.events.some((event) => event.peer !== peer || !Number.isSafeInteger(event.id) || event.id < 1) ||
        value.deliveries.some((delivery) => delivery.peer !== peer)) {
      throw new CliError('NATIVE_RESPONSE_INVALID', 'Native state is not scoped to the requested worker');
    }
    const db = connectWebProject(ctx);
    try {
      const binding = db.prepare('SELECT * FROM peer_bindings WHERE peer=?').get(peer);
      // A resumed Claude SDK query initializes lazily on its first input. The
      // service retains its saved binding while the owned adapter is ready
      // with no confirmed session ID; its init event must confirm that ID.
      const lazyClaudeResume = value.provider === 'claude' && value.snapshot.status === 'ready' &&
        value.snapshot.sessionId == null;
      if (!binding || binding.transport !== 'native' || binding.provider !== value.provider ||
          binding.runtime_target !== value.owner ||
          ((binding.provider_session_id || null) !== (value.snapshot.sessionId || null) && !lazyClaudeResume)) {
        throw new CliError('NATIVE_OWNER_CHANGED', 'Native worker binding changed; refresh the current worker');
      }
      return { value, binding: { ...binding } };
    } finally { db.close(); }
  }
  function sameIdentity(session, value) {
    const identity = session.nativeIdentity;
    return identity.generation === value.generation && identity.owner === value.owner &&
      identity.provider === value.provider &&
      (!identity.sessionId || identity.sessionId === (value.snapshot.sessionId || null));
  }
  function current(session) {
    if (stopped || session.nativeRetired || sessions.get(sessionKey(session.ctx, session.id)) !== session) {
      throw new CliError('NATIVE_OWNER_CHANGED', 'This Web view no longer owns the current native worker');
    }
  }
  function applyState(session, { value, binding }) {
    current(session);
    if (!sameIdentity(session, value)) {
      const error = new CliError('NATIVE_OWNER_CHANGED', 'Native worker ownership changed');
      disconnect(session, error, true);
      throw error;
    }
    if (value.snapshot.sessionId) session.nativeIdentity.sessionId = value.snapshot.sessionId;
    const events = new Map((session.nativeState?.events || []).map((event) => [event.id, event]));
    for (const event of value.events) events.set(event.id, event);
    const history = [...events.values()].sort((a, b) => a.id - b.id);
    const cursor = Math.max(session.nativeState?.eventCursor || 0, ...value.events.map((event) => event.id));
    const turnId = value.snapshot.turnId || value.snapshot.activeTurnId || value.active_delivery?.turn_id || null;
    session.binding = binding;
    session.cwd = value.cwd;
    const state = redactSecrets({ backend: 'native', connected: true, root: value.root,
      peer: value.peer, provider: value.provider, generation: value.generation, owner: value.owner,
      executorId: value.owner, sessionId: value.snapshot.sessionId || null, turnId,
      status: value.snapshot.status, cwd: value.cwd, capabilities: value.snapshot.capabilities || {}, pendingApprovals: value.snapshot.pendingApprovals || [],
      quarantined: Boolean(value.quarantined), closing: Boolean(value.closing),
      activeDelivery: value.active_delivery || null, events: history.slice(-HISTORY_LIMIT),
      deliveries: value.deliveries.slice(0, 100), eventCursor: cursor,
      truncated: Boolean(session.nativeState?.truncated || history.length > HISTORY_LIMIT) });
    session.status = CLOSED.has(value.snapshot.status) ? 'exited'
      : value.snapshot.status === 'disconnected' ? 'disconnected' : 'running';
    if (session.status === 'exited') session.exitedAt = now();
    publishState(session, state);
    return session.nativeSnapshot();
  }
  function makeSession(ctx, checked) {
    const { value, binding } = checked;
    const session = { id: value.peer, peerId: value.peer, root: ctx.root, ctx,
      kind: value.provider, role: 'native-worker', type: 'native', command: null,
      cwd: value.cwd, pid: null, status: 'running', createdAt: now(),
      clients: new Set(), actionTokens: new Set(), buffer: '', binding,
      nativeIdentity: { generation: value.generation, owner: value.owner,
        provider: value.provider, sessionId: value.snapshot.sessionId || null }, nativeState: null };
    session.nativeSnapshot = () => structuredClone(session.nativeState);
    sessions.set(sessionKey(ctx, session.id), session);
    applyState(session, checked);
    return session;
  }
  async function readState(session) {
    current(session);
    const params = new URLSearchParams({ after: String(session.nativeState?.eventCursor || 0),
      generation: session.nativeIdentity.generation, owner: session.nativeIdentity.owner });
    const value = await nativeApi(session.ctx, 'GET', `/workers/${encodeURIComponent(session.peerId)}/state?${params}`);
    current(session);
    return applyState(session, validateState(session.ctx, session.peerId, value));
  }
  async function scan(ctx) {
    let status;
    try {
      status = await nativeApi(ctx, 'GET', '/status', null, { timeoutMs: 2000 });
      assertProject(ctx, status);
      if (!Array.isArray(status.workers)) throw new CliError('NATIVE_RESPONSE_INVALID', 'Native worker list is invalid');
    } catch (error) {
      if (!stopped) for (const session of projectSessions(ctx)) disconnect(session, error,
        ['NATIVE_SCOPE_CHANGED', 'NATIVE_OWNER_CHANGED'].includes(error.code));
      return projectSessions(ctx);
    }
    if (stopped) return [];
    const owned = status.workers.filter((worker) => worker.owned === true && PROVIDERS.has(worker.provider) &&
      typeof worker.peer === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(worker.peer));
    const present = new Set(owned.map((worker) => worker.peer));
    for (const session of projectSessions(ctx)) {
      if (session.nativeIdentity.generation !== status.generation || !present.has(session.peerId)) {
        disconnect(session, new CliError('NATIVE_OWNER_CHANGED', 'Native worker is no longer owned by this service'), true);
      }
    }
    await Promise.allSettled(owned.map(async (worker) => {
      const key = sessionKey(ctx, worker.peer);
      const existing = sessions.get(key);
      if (existing && existing.type !== 'native') return;
      try {
        const sameOwner = existing && !existing.nativeRetired && existing.nativeIdentity.owner === worker.owner &&
          existing.nativeIdentity.generation === status.generation;
        const after = sameOwner ? existing.nativeState?.eventCursor || 0 : 0;
        const params = new URLSearchParams({ after: String(after), generation: status.generation, owner: worker.owner });
        const value = await nativeApi(ctx, 'GET', `/workers/${encodeURIComponent(worker.peer)}/state?${params}`, null, { timeoutMs: 2000 });
        if (stopped) return;
        const checked = validateState(ctx, worker.peer, value);
        if (existing && !existing.nativeRetired && sameIdentity(existing, value)) applyState(existing, checked);
        else {
          if (existing && !existing.nativeRetired) disconnect(existing,
            new CliError('NATIVE_OWNER_CHANGED', 'Native worker ownership changed'), true);
          makeSession(ctx, checked);
        }
      } catch (error) {
        if (!stopped && existing && !existing.nativeRetired) disconnect(existing, error,
          ['NATIVE_SCOPE_CHANGED', 'NATIVE_OWNER_CHANGED', 'NATIVE_WORKER_NOT_FOUND'].includes(error.code));
      }
    }));
    return projectSessions(ctx);
  }
  function discoverNativeSessions(ctx) {
    if (stopped) return Promise.resolve([]);
    const key = projectKey(ctx);
    projects.set(key, ctx);
    if (scans.has(key)) return scans.get(key);
    const operation = scan(ctx).finally(() => { if (scans.get(key) === operation) scans.delete(key); });
    scans.set(key, operation);
    return operation;
  }
  async function pollNativeSessions(ctx) {
    if (ctx) return discoverNativeSessions(ctx);
    const results = await Promise.allSettled([...projects.values()].map(discoverNativeSessions));
    return results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
  }
  function receiptEvent(session, type, payload) {
    const db = connectWebProject(session.ctx);
    try { addEvent(db, type, session.peerId, null, payload); } finally { db.close(); }
  }
  async function nativeAction(session, action, input = {}) {
    if (session?.type !== 'native') throw new CliError('BAD_REQUEST', 'A native worker view is required');
    current(session);
    if (action === 'state') return session.nativeSnapshot();
    if (!['read', 'send', 'interrupt', 'close', 'respond'].includes(action)) throw new CliError('BAD_REQUEST', 'Unsupported native worker action');
    let text, submissionId;
    if (action === 'send') {
      text = typeof input.text === 'string' ? input.text.trim() : typeof input.body === 'string' ? input.body.trim() : '';
      submissionId = input.submissionId;
      if (!text || text.length > 100000 || typeof submissionId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(submissionId)) {
        throw new CliError('BAD_REQUEST', 'A message and a unique submissionId are required');
      }
    }
    try { await readState(session); }
    catch (error) {
      if (!session.nativeRetired) disconnect(session, error,
        ['NATIVE_OWNER_CHANGED', 'NATIVE_SCOPE_CHANGED', 'NATIVE_WORKER_NOT_FOUND'].includes(error.code));
      throw error;
    }
    if (action === 'read') return session.nativeSnapshot();
    if (session.status !== 'running') throw new CliError('NATIVE_WORKER_NOT_FOUND', 'Native worker is not open');
    if (typeof input.authorizeMutation === 'function') input.authorizeMutation();
    const identity = { peer: session.peerId, generation: session.nativeIdentity.generation,
      owner: session.nativeIdentity.owner, provider: session.kind, sessionId: session.nativeIdentity.sessionId };
    if (action === 'respond' && (input.executorId !== session.nativeState.executorId || input.sessionId !== session.nativeState.sessionId)) {
      throw new CliError('NATIVE_APPROVAL_MISMATCH', 'Interaction belongs to another executor or provider session');
    }
    if (action === 'interrupt' && !session.nativeState.capabilities.interrupt) {
      throw new CliError('NATIVE_CAPABILITY_UNSUPPORTED', 'Provider does not support interrupt');
    }
    const pending = { submission_id: submissionId, owner: identity.owner, generation: identity.generation,
      provider: identity.provider, provider_session_id: identity.sessionId };
    if (action === 'send') {
      const db = connectWebProject(session.ctx);
      try {
        tx(db, () => {
          if (db.prepare(`SELECT id FROM events WHERE type='native.web.submission.pending'
            AND json_extract(payload, '$.submission_id')=? LIMIT 1`).get(submissionId)) {
            throw new CliError('SUBMISSION_EXISTS', 'This submission was already attempted; inspect native deliveries before sending again');
          }
          addEvent(db, 'native.web.submission.pending', session.peerId, null, pending);
        });
      } finally { db.close(); }
    }
    current(session);
    if (typeof input.authorizeMutation === 'function') input.authorizeMutation();
    try {
      const result = await nativeApi(session.ctx, 'POST', `/${action === 'send' ? 'send' : action}`, {
        ...identity, ...(action === 'send' ? { from: 'web', body: text, submissionId }
          : action === 'interrupt' ? { turnId: input.turnId || session.nativeState.turnId || undefined }
          : action === 'respond' ? { executorId: input.executorId, requestId: input.requestId, turnId: input.turnId,
            decision: input.decision, permissions: input.permissions, scope: input.scope, answers: input.answers, content: input.content } : {})
      });
      if (action === 'send') {
        if (!Number.isSafeInteger(result?.message_id) || result.submission_id !== submissionId || typeof result.state !== 'string') {
          throw new CliError('NATIVE_RESPONSE_INVALID', 'Native queue receipt is invalid', { uncertain: true });
        }
        receiptEvent(session, 'native.web.submission.queued', { ...pending, message_id: result.message_id, state: result.state });
      }
      current(session);
      if (action === 'respond') { await readState(session); current(session); }
      if (action === 'close') {
        session.status = 'exited'; session.exitedAt = now();
        publishState(session, { ...session.nativeState, connected: false, status: 'closed', closing: false });
        closeSessionClients(session);
        session.actionTokens.clear();
      }
      return result;
    } catch (error) {
      if (action === 'send') receiptEvent(session, 'native.web.submission.unconfirmed', { ...pending, code: error.code || 'UNKNOWN' });
      if (['NATIVE_OWNER_CHANGED', 'NATIVE_SCOPE_CHANGED'].includes(error.code) && !session.nativeRetired) disconnect(session, error, true);
      throw error;
    }
  }
  function closeNativeBridge() {
    stopped = true;
    for (const session of sessions.values()) {
      if (session.type === 'native' && !session.nativeRetired) disconnect(session,
        new CliError('NATIVE_WEB_DISCONNECTED', 'Web disconnected; the independent native worker keeps running'));
      if (session.type === 'native') closeSessionClients(session);
    }
    projects.clear();
  }
  return { discoverNativeSessions, pollNativeSessions, nativeAction, closeNativeBridge };
}
