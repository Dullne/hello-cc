import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CliError } from '../shared/errors.mjs';
import { redactSecrets } from '../shared/redact.mjs';
import { tx } from '../db/schema.mjs';
import { createEventHelpers } from '../db/events.mjs';
import { nativeRequest } from '../runtime/native/client.mjs';
import { ensureNativeRuntime } from '../runtime/native/launcher.mjs';
import { readNativeHistory, readNativeWorkerHistory } from '../runtime/native/history.mjs';
import { parseNativeCwdIdentity } from '../runtime/native/store.mjs';
import { captureSelectedCwdSnapshot, sameSelectedCwdIdentity } from '../process/selected-cwd-identity.mjs';
import { assertPinnedSessionLaunchAllowed } from '../process/pinned-cwd.mjs';
import { createAgentDefaults } from './agent-defaults.mjs';

const PROVIDERS = new Set(['codex', 'claude', 'dsh']);
const CLOSED = new Set(['closed', 'exited', 'stopped']);
const HISTORY_LIMIT = 200;

// A Web view of a worker already owned by the independent native service.
// New workers are delegated to that same service; Web never owns their process.
export function createNativeSessions({ sessions, sessionKey, connectWebProject,
  broadcast = () => {}, closeSessionClients = () => {},
  now = () => Math.floor(Date.now() / 1000), nativeApi = nativeRequest,
  ensureRuntime = ensureNativeRuntime,
  addEvent = createEventHelpers({ now }).addEvent } = {}) {
  const projects = new Map();
  const scans = new Map();
  const creating = new Set();
  const { resolveNativeDefaults } = createAgentDefaults({ connectWebProject });
  let stopped = false;

  function projectKey(ctx) { return `${ctx.root}\0${path.resolve(ctx.dbPath)}`; }

  function sandboxRuntimeOptions(ctx, provider, runtime) {
    if (provider !== 'codex') return undefined;
    if (runtime?.sandboxPolicyVersion !== 1) {
      throw new CliError('NATIVE_SANDBOX_RUNTIME_UNSUPPORTED',
        'This native runtime cannot preserve Codex sandbox policies. Stop it after its work has finished, then start it with this HCC version. No worker was created.');
    }
    assertProject(ctx, runtime);
    if (!runtime.generation.trim()) throw new CliError('NATIVE_SCOPE_CHANGED', 'Native runtime has no verifiable generation');
    return { expectedGeneration: runtime.generation };
  }

  function workerCwd(ctx, value) {
    if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value))) {
      throw new CliError('BAD_REQUEST', 'Native worker cwd must be a nonempty directory path');
    }
    let root, cwd;
    try {
      root = fs.realpathSync(ctx.root);
      cwd = fs.realpathSync(path.resolve(root, value === undefined ? '.' : value));
      if (!fs.statSync(cwd).isDirectory()) throw new Error('not a directory');
    } catch { throw new CliError('BAD_REQUEST', 'Native worker cwd must be an existing directory'); }
    const relative = path.relative(root, cwd);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new CliError('PROJECT_PATH_FORBIDDEN', 'Native worker cwd must be inside the selected project; register an external directory as a separate project first');
    }
    return cwd;
  }

  function hasSavedPeer(ctx, peer) {
    const db = connectWebProject(ctx);
    try {
      return Boolean(db.prepare('SELECT id FROM peers WHERE id=?').get(peer) ||
        db.prepare('SELECT peer FROM peer_bindings WHERE peer=?').get(peer));
    } finally { db.close(); }
  }

  function assertNewPeer(ctx, peer) {
    if (sessions.has(sessionKey(ctx, peer))) throw new CliError('NATIVE_PEER_IN_USE', 'This name already identifies a session; choose a new worker name');
    if (hasSavedPeer(ctx, peer)) throw new CliError('NATIVE_PEER_IN_USE', 'This peer already has an owner or saved session; choose a new worker name');
  }

  async function historyRuntime(ctx) {
    try {
      const status = await nativeApi(ctx, 'GET', '/status', null, { timeoutMs: 2000 });
      assertProject(ctx, status);
      if (!Array.isArray(status.workers)) throw new CliError('NATIVE_RESPONSE_INVALID', 'Native worker list is invalid');
      return status;
    } catch (error) {
      if (['NATIVE_RUNTIME_OFFLINE', 'NATIVE_CLIENT_TIMEOUT'].includes(error.code)) return null;
      throw error;
    }
  }
  function historyWorker(ctx, row, runtime, lookupDb = null) {
    const db = lookupDb || connectWebProject(ctx);
    let binding, peer;
    try {
      binding = db.prepare('SELECT * FROM peer_bindings WHERE peer=?').get(row.peer);
      peer = db.prepare('SELECT capabilities FROM peers WHERE id=?').get(row.peer);
    } finally { if (!lookupDb) db.close(); }
    let capabilities = {};
    try { capabilities = JSON.parse(peer?.capabilities || '{}'); } catch {}
    if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) capabilities = {};
    const live = runtime?.workers.find(worker => worker.peer === row.peer);
    const owned = live?.owned === true;
    const identityMatches = binding?.transport === 'native' && binding.provider === row.provider &&
      binding.runtime_session_id === row.peer && binding.provider_session_id === row.session_id && Boolean(binding.runtime_target);
    let resumeReason = null, resumeDetail = null;
    if (owned) { resumeReason = 'active'; resumeDetail = 'Open the existing worker. Explicitly close its executor before restoring it.'; }
    else if (row.status !== 'closed') { resumeReason = 'not_closed'; resumeDetail = 'The previous executor is not confirmed closed; inspect native status and finish its explicit close first.'; }
    else if (!row.session_id) { resumeReason = 'no_session'; resumeDetail = 'No provider session identity was recorded for this worker.'; }
    else if (!identityMatches) { resumeReason = 'owner_changed'; resumeDetail = 'The saved worker binding changed; refresh or inspect its current owner.'; }
    else if (!PROVIDERS.has(row.provider) || capabilities.resume === false) { resumeReason = 'provider_unsupported'; resumeDetail = 'This worker did not advertise provider session restore support.'; }
    else if (row.provider === 'dsh' && capabilities.resume !== true) { resumeReason = 'capability_unknown'; resumeDetail = 'No dsh ACP resume capability was recorded for this worker.'; }
    else {
      const savedCwd = parseNativeCwdIdentity(row.cwd_identity, row.cwd);
      if (!savedCwd) {
        resumeReason = 'history_unverified';
        resumeDetail = 'This legacy worker has no trusted working-directory identity and cannot be restored automatically.';
      } else {
        try {
          workerCwd(ctx, row.cwd);
          if (!sameSelectedCwdIdentity(savedCwd, captureSelectedCwdSnapshot(row.cwd))) {
            resumeReason = 'cwd_changed';
            resumeDetail = 'The saved working directory has changed identity; choose a new worker.';
          }
        } catch {
          resumeReason = 'cwd_unavailable';
          resumeDetail = 'The saved working directory is unavailable or outside the selected project.';
        }
      }
    }
    return { peer: row.peer, provider: row.provider, sessionId: row.session_id || null, cwd: row.cwd,
      status: live?.status || row.status, updatedAt: row.updated_at, owned, owner: binding?.runtime_target || null,
      capabilities: { resume: capabilities.resume === true || (row.provider !== 'dsh' && capabilities.resume !== false) },
      resumable: !resumeReason, resumeReason, resumeDetail };
  }
  const retention = { scope: 'retained-project-events', maxEvents: 2001, complete: false };
  async function listNativeHistory(ctx) {
    const saved = readNativeHistory(ctx), runtime = await historyRuntime(ctx);
    const db = saved.workers.length ? connectWebProject(ctx) : null;
    try {
      return { workers: saved.workers.map(row => historyWorker(ctx, row, runtime, db)), truncated: saved.truncated,
        runtimeAvailable: Boolean(runtime), retention };
    } finally { db?.close(); }
  }
  async function nativeWorkerHistory(ctx, peer, options = {}) {
    const saved = readNativeWorkerHistory(ctx, peer, options), runtime = await historyRuntime(ctx);
    return { ...saved, worker: historyWorker(ctx, saved.worker, runtime), runtimeAvailable: Boolean(runtime), retention };
  }
  async function resumeNativeSession(ctx, peer, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !['owner', 'sessionId', 'confirmed'].includes(key)) || input.confirmed !== true ||
        typeof input.owner !== 'string' || !input.owner || input.owner.length > 512 ||
        typeof input.sessionId !== 'string' || !input.sessionId || input.sessionId.length > 512) {
      throw new CliError('BAD_REQUEST', 'Restore requires confirmed:true and the saved owner and sessionId');
    }
    assertPinnedSessionLaunchAllowed();
    const key = sessionKey(ctx, peer);
    if (stopped) throw new CliError('NATIVE_WEB_DISCONNECTED', 'Web is stopping');
    if (creating.has(key)) throw new CliError('NATIVE_WORKER_EXISTS', 'This worker is already being opened', { peer });
    creating.add(key);
    let receipt;
    try {
      const saved = readNativeWorkerHistory(ctx, peer).worker;
      let entry = historyWorker(ctx, saved, await historyRuntime(ctx));
      if (entry.owner !== input.owner || entry.sessionId !== input.sessionId) throw new CliError('NATIVE_OWNER_CHANGED', 'Saved worker identity changed; refresh history');
      if (!entry.resumable) throw new CliError('NATIVE_RESUME_NOT_READY', entry.resumeDetail);
      const existing = sessions.get(key);
      if (existing && existing.type !== 'native') throw new CliError('NATIVE_PEER_IN_USE', 'Another session owns this peer');
      const runtime = await ensureRuntime(ctx);
      if (stopped) throw new CliError('NATIVE_WEB_DISCONNECTED', 'Web stopped before worker restore');
      const requestOptions = sandboxRuntimeOptions(ctx, saved.provider, runtime);
      entry = historyWorker(ctx, readNativeWorkerHistory(ctx, peer).worker, await historyRuntime(ctx));
      if (entry.owner !== input.owner || entry.sessionId !== input.sessionId) throw new CliError('NATIVE_OWNER_CHANGED', 'Saved worker identity changed; refresh history');
      if (!entry.resumable) throw new CliError('NATIVE_RESUME_NOT_READY', entry.resumeDetail);
      try {
        receipt = await nativeApi(ctx, 'POST', '/workers', { peer, provider: saved.provider, cwd: workerCwd(ctx, saved.cwd),
          resume: 'last', resumeFence: { owner: input.owner, sessionId: input.sessionId } }, requestOptions);
      } catch (error) {
        let ownerChanged = true;
        try { ownerChanged = historyWorker(ctx, saved, null).owner !== input.owner; } catch {}
        if (error.extra?.uncertain || ownerChanged) throw new CliError('NATIVE_RESUME_UNCONFIRMED',
          'Restore of ' + peer + ' needs inspection: ' + (error.message || 'Native request failed') +
          '. Refresh this worker and inspect native status before another restore; do not create a replacement.',
          { peer, provider: saved.provider, uncertain: true, cause: error.code || 'UNKNOWN' });
        throw error;
      }
      try {
        if (stopped) throw new CliError('NATIVE_WEB_DISCONNECTED', 'Web stopped after worker restore');
        if (receipt?.peer !== peer || receipt.provider !== saved.provider || typeof receipt.executorId !== 'string' ||
            !receipt.executorId || receipt.executorId === input.owner) throw new CliError('NATIVE_RESPONSE_INVALID', 'Native restore receipt has no new matching executor');
        let value = await nativeApi(ctx, 'GET', '/workers/' + encodeURIComponent(peer) + '/state');
        const checked = await validateObservedState(ctx, peer, value);
        if (stopped) throw new CliError('NATIVE_WEB_DISCONNECTED', 'Web stopped while validating the restored worker');
        value = checked.value;
        if (value.owner !== receipt.executorId || checked.binding.provider_session_id !== input.sessionId) throw new CliError('NATIVE_OWNER_CHANGED', 'Restored worker identity changed');
        const currentView = sessions.get(key);
        if (currentView && currentView.type !== 'native') throw new CliError('NATIVE_PEER_IN_USE', 'Another session owns the worker view');
        if (currentView && !currentView.nativeRetired && sameIdentity(currentView, value)) { applyState(currentView, checked); return currentView; }
        if (currentView && !currentView.nativeRetired) disconnect(currentView, new CliError('NATIVE_OWNER_CHANGED', 'Worker restored into a new executor'), true);
        projects.set(projectKey(ctx), ctx);
        return makeSession(ctx, checked);
      } catch (error) {
        throw new CliError('NATIVE_WORKER_DISCOVERY_FAILED', 'Worker ' + peer + ' was restored, but its Web view could not open. Refresh the Agent list; do not create a replacement.',
          { peer, provider: saved.provider, created: true, executorId: receipt?.executorId, cause: error.code || 'UNKNOWN' });
      }
    } finally { creating.delete(key); }
  }

  async function startNativeSession(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !['projectCtx', 'transport', 'kind', 'id', 'cwd', 'model'].includes(key)) ||
        input.transport !== 'native' || (input.kind !== undefined && !PROVIDERS.has(input.kind))) {
      throw new CliError('BAD_REQUEST', 'Native creation accepts only transport, kind, id, cwd and model; use provider codex, claude or dsh');
    }
    assertPinnedSessionLaunchAllowed();
    const ctx = input.projectCtx;
    // Resolve before asynchronous daemon startup; explicit null clears a saved model.
    input = resolveNativeDefaults(ctx, input);
    const peer = input.id === undefined ? `native-${input.kind}-${randomUUID()}` : input.id;
    if (typeof peer !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(peer) || peer === 'all') {
      throw new CliError('BAD_REQUEST', 'Native worker name must contain 1 to 128 letters, digits, dots, underscores or hyphens, start with a letter or digit, and cannot be all');
    }
    if (input.model !== undefined && (typeof input.model !== 'string' || !input.model.trim() ||
        input.model.length > 256 || /[\x00-\x1f\x7f]/.test(input.model))) {
      throw new CliError('BAD_REQUEST', 'Native model must be a nonempty name of at most 256 characters');
    }
    const cwd = workerCwd(ctx, input.cwd);
    const key = sessionKey(ctx, peer);
    if (stopped) throw new CliError('NATIVE_WEB_DISCONNECTED', 'Web is stopping');
    if (creating.has(key)) throw new CliError('NATIVE_WORKER_EXISTS', 'This worker is already being created', { peer });
    assertNewPeer(ctx, peer);
    creating.add(key);
    try {
      const runtime = await ensureRuntime(ctx);
      if (stopped) throw new CliError('NATIVE_WEB_DISCONNECTED', 'Web stopped before worker creation');
      assertNewPeer(ctx, peer);
      workerCwd(ctx, cwd);
      const requestOptions = sandboxRuntimeOptions(ctx, input.kind, runtime);
      let receipt;
      try {
        // Exactly one create attempt. A lost response is not safe to replay.
        receipt = await nativeApi(ctx, 'POST', '/workers', { peer, provider: input.kind, cwd,
          ...(input.model === undefined ? {} : { model: input.model }) }, requestOptions);
      } catch (error) {
        if (error.extra?.uncertain) throw new CliError('NATIVE_CREATE_UNCONFIRMED',
          `Creation of ${peer} is unconfirmed. Refresh the Agent list or inspect native status before creating another worker`,
          { peer, provider: input.kind, uncertain: true, cause: error.code || 'UNKNOWN' });
        // Initialization can fail after the daemon reserves this peer. Keep
        // its ownership records and original failure, but make retry guidance
        // actionable even when the caller let the server generate the name.
        let retained = null;
        try { retained = hasSavedPeer(ctx, peer); } catch { /* Preserve the provider error if the read fails. */ }
        const guidance = retained === false ? '' :
          ' Peer ' + peer + (retained ? ' is still' : ' may still be') +
          ' reserved in the selected project. Run hcc native status there to inspect it; after correcting the reported error, choose a new Agent name to retry.';
        throw new CliError(error.code || 'NATIVE_REQUEST_FAILED', (error.message || 'Native creation failed') + guidance,
          { ...error.extra, peer, provider: input.kind });
      }
      try {
        if (stopped) throw new CliError('NATIVE_WEB_DISCONNECTED', 'Web stopped after worker creation');
        if (receipt?.peer !== peer || receipt.provider !== input.kind || typeof receipt.executorId !== 'string' || !receipt.executorId) {
          throw new CliError('NATIVE_RESPONSE_INVALID', 'Native create receipt has no matching worker identity');
        }
        let value = await nativeApi(ctx, 'GET', `/workers/${encodeURIComponent(peer)}/state`);
        if (stopped) throw new CliError('NATIVE_WEB_DISCONNECTED', 'Web stopped while opening the worker view');
        const checked = await validateObservedState(ctx, peer, value);
        if (stopped) throw new CliError('NATIVE_WEB_DISCONNECTED', 'Web stopped while validating the worker view');
        value = checked.value;
        if (value.owner !== receipt.executorId || (receipt.sessionId && value.snapshot.sessionId !== receipt.sessionId)) {
          throw new CliError('NATIVE_OWNER_CHANGED', 'Worker identity changed after creation');
        }
        const existing = sessions.get(key);
        if (existing) {
          if (existing.type !== 'native' || existing.nativeRetired || !sameIdentity(existing, value)) {
            throw new CliError('NATIVE_OWNER_CHANGED', 'Another session owns the worker view');
          }
          applyState(existing, checked);
          return existing;
        }
        projects.set(projectKey(ctx), ctx);
        return makeSession(ctx, checked);
      } catch (error) {
        // The daemon keeps the created worker even if Web closes or its first
        // read fails. Its stable peer lets the next view recover that worker.
        throw new CliError('NATIVE_WORKER_DISCOVERY_FAILED',
          `Worker ${peer} was created, but its Web view could not open. Refresh the Agent list or inspect native status; do not create a replacement`,
          { peer, provider: input.kind, created: true, cause: error.code || 'UNKNOWN' });
      }
    } finally { creating.delete(key); }
  }
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
    // broadcast is synchronous and serializes/retains changed fields itself.
    if (changed) broadcast(session, { type: 'native_state', state });
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
  function validateState(ctx, peer, value, { allowPendingInit = false } = {}) {
    assertProject(ctx, value);
    if (value.peer !== peer || !PROVIDERS.has(value.provider) ||
        typeof value.owner !== 'string' || !value.owner || value.owner.length > 512 ||
        !value.snapshot || value.snapshot.provider !== value.provider ||
        typeof value.snapshot.status !== 'string' ||
        (value.snapshot.sessionId != null && typeof value.snapshot.sessionId !== 'string') ||
        (value.snapshot.sandbox != null && !['read-only', 'workspace-write'].includes(value.snapshot.sandbox)) ||
        (value.snapshot.sandboxVerified !== undefined && typeof value.snapshot.sandboxVerified !== 'boolean') ||
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
      // Observation may have captured initialization before the shared binding
      // acquired its session ID. The caller must confirm that ID with a fresh,
      // fenced read before applying this otherwise valid same-owner snapshot.
      const pendingInit = allowPendingInit && value.snapshot.sessionId == null &&
        (value.provider !== 'claude' || ['ready', 'queued', 'running'].includes(value.snapshot.status));
      if (!binding || binding.transport !== 'native' || binding.provider !== value.provider ||
          binding.runtime_target !== value.owner ||
          ((binding.provider_session_id || null) !== (value.snapshot.sessionId || null) && !lazyClaudeResume && !pendingInit)) {
        throw new CliError('NATIVE_OWNER_CHANGED', 'Native worker binding changed; refresh the current worker');
      }
      return { value, binding: { ...binding } };
    } finally { db.close(); }
  }
  async function validateObservedState(ctx, peer, value) {
    const checked = validateState(ctx, peer, value, { allowPendingInit: true });
    const existing = sessions.get(sessionKey(ctx, peer));
    const confirmedId = checked.binding.provider_session_id;
    const sameExecutor = existing?.nativeIdentity?.generation === value.generation &&
      existing.nativeIdentity.owner === value.owner && existing.nativeIdentity.provider === value.provider;
    // A restored executor keeps the saved binding before its first SDK init,
    // including while that first input is queued/running. Only this executor's
    // view can establish that pending restore; the previous owner's UUID cannot.
    const pendingResume = sameExecutor && !existing.nativeIdentity.sessionId &&
      existing.binding?.provider_session_id === confirmedId;
    if (value.snapshot.sessionId != null || !confirmedId) return checked;
    if (value.provider === 'claude' &&
        (pendingResume || (value.snapshot.status === 'ready' && (!sameExecutor || !existing.nativeIdentity.sessionId)))) return checked;
    // The HTTP snapshot can precede SDK init while the shared binding already
    // contains its confirmed UUID. Never apply that older null snapshot: read
    // once more under the same service/worker identity, then validate strictly.
    const params = new URLSearchParams({ after: String(sameExecutor ? existing.nativeState?.eventCursor || 0 : 0),
      generation: value.generation, owner: value.owner });
    const refreshed = await nativeApi(ctx, 'GET', `/workers/${encodeURIComponent(peer)}/state?${params}`, null, { timeoutMs: 2000 });
    const current = validateState(ctx, peer, refreshed);
    if (refreshed.generation !== value.generation || refreshed.owner !== value.owner ||
        refreshed.provider !== value.provider || refreshed.snapshot.sessionId !== confirmedId) {
      throw new CliError('NATIVE_OWNER_CHANGED', 'Native worker identity changed while confirming provider initialization');
    }
    return current;
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
      status: value.snapshot.status, cwd: value.cwd, capabilities: value.snapshot.capabilities || {},
      metrics: value.snapshot.metrics || null, runtimeMetadata: value.snapshot.runtimeMetadata || null,
      account: value.snapshot.account || null, pendingApprovals: value.snapshot.pendingApprovals || [],
      sandbox: value.snapshot.sandbox || null, sandboxVerified: value.snapshot.sandboxVerified === true,
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
    const checked = await validateObservedState(session.ctx, session.peerId, value);
    current(session);
    return applyState(session, checked);
  }
  async function scan(ctx) {
    // A status response can predate a worker created while the read was in
    // flight. Only retire views that this scan already knew when it started.
    const observed = new Set(sessions.values());
    let status;
    try {
      status = await nativeApi(ctx, 'GET', '/status', null, { timeoutMs: 2000 });
      assertProject(ctx, status);
      if (!Array.isArray(status.workers)) throw new CliError('NATIVE_RESPONSE_INVALID', 'Native worker list is invalid');
    } catch (error) {
      if (!stopped) for (const session of projectSessions(ctx).filter(session => observed.has(session))) disconnect(session, error,
        ['NATIVE_SCOPE_CHANGED', 'NATIVE_OWNER_CHANGED'].includes(error.code));
      return projectSessions(ctx);
    }
    if (stopped) return [];
    const owned = status.workers.filter((worker) => worker.owned === true && PROVIDERS.has(worker.provider) &&
      typeof worker.peer === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(worker.peer));
    const present = new Set(owned.map((worker) => worker.peer));
    for (const session of projectSessions(ctx).filter(session => observed.has(session))) {
      if (session.nativeIdentity.generation !== status.generation || !present.has(session.peerId)) {
        disconnect(session, new CliError('NATIVE_OWNER_CHANGED', 'Native worker is no longer owned by this service'), true);
      }
    }
    await Promise.allSettled(owned.map(async (worker) => {
      const key = sessionKey(ctx, worker.peer);
      const existing = sessions.get(key);
      if (existing && existing.type !== 'native') return;
      // The list itself may also predate a newly installed view. Do not use
      // its old owner to read or disconnect that newer view.
      if (existing && !observed.has(existing)) return;
      const wasRetired = Boolean(existing?.nativeRetired);
      const wasExited = existing?.status === 'exited';
      try {
        const sameOwner = existing && !existing.nativeRetired && existing.nativeIdentity.owner === worker.owner &&
          existing.nativeIdentity.generation === status.generation;
        const after = sameOwner ? existing.nativeState?.eventCursor || 0 : 0;
        const params = new URLSearchParams({ after: String(after), generation: status.generation, owner: worker.owner });
        let value = await nativeApi(ctx, 'GET', `/workers/${encodeURIComponent(worker.peer)}/state?${params}`, null, { timeoutMs: 2000 });
        if (stopped) return;
        const checked = await validateObservedState(ctx, worker.peer, value);
        if (stopped) return;
        // Creation or restore can install a view while these reads await the
        // daemon. This scan must not replace that view and orphan its clients
        // or control tokens, nor revive a view closed or retired during the read.
        if (sessions.get(key) !== existing || Boolean(existing?.nativeRetired) !== wasRetired ||
            (existing?.status === 'exited') !== wasExited) return;
        value = checked.value;
        if (existing && !existing.nativeRetired && sameIdentity(existing, value)) applyState(existing, checked);
        else {
          if (existing && !existing.nativeRetired) disconnect(existing,
            new CliError('NATIVE_OWNER_CHANGED', 'Native worker ownership changed'), true);
          makeSession(ctx, checked);
        }
      } catch (error) {
        if (!stopped && existing && sessions.get(key) === existing && !existing.nativeRetired) disconnect(existing, error,
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
    if (!['read', 'account', 'send', 'interrupt', 'close', 'respond'].includes(action)) throw new CliError('BAD_REQUEST', 'Unsupported native worker action');
    let text, submissionId;
    if (action === 'send') {
      text = typeof input.text === 'string' ? input.text.trim() : typeof input.body === 'string' ? input.body.trim() : '';
      submissionId = input.submissionId;
      if (!text || text.length > 100000 || typeof submissionId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(submissionId)) {
        throw new CliError('BAD_REQUEST', 'A message and a unique submissionId are required');
      }
      if (input.retry !== undefined && typeof input.retry !== 'boolean') {
        throw new CliError('BAD_REQUEST', 'Native submission retry must be explicit');
      }
    }
    try { await readState(session); }
    catch (error) {
      if (!session.nativeRetired) disconnect(session, error,
        ['NATIVE_OWNER_CHANGED', 'NATIVE_SCOPE_CHANGED', 'NATIVE_WORKER_NOT_FOUND'].includes(error.code));
      throw error;
    }
    if (action === 'read') return session.nativeSnapshot();
    if (action === 'account') {
      if (input.generation !== session.nativeIdentity.generation || input.owner !== session.nativeIdentity.owner ||
          input.sessionId !== session.nativeIdentity.sessionId) throw new CliError('NATIVE_OWNER_CHANGED', 'Account view belongs to another native executor');
      if (!session.nativeState.capabilities.accountRead) throw new CliError('NATIVE_CAPABILITY_UNSUPPORTED', 'Provider does not expose account status');
      const params = new URLSearchParams({ after: String(session.nativeState.eventCursor || 0),
        generation: session.nativeIdentity.generation, owner: session.nativeIdentity.owner, sessionId: session.nativeIdentity.sessionId });
      const value = await nativeApi(session.ctx, 'GET', `/workers/${encodeURIComponent(session.peerId)}/account?${params}`);
      current(session);
      return applyState(session, validateState(session.ctx, session.peerId, value));
    }
    if (session.status !== 'running') throw new CliError('NATIVE_WORKER_NOT_FOUND', 'Native worker is not open');
    if (session.kind === 'codex' && ['send', 'respond'].includes(action)) {
      if (!['read-only', 'workspace-write'].includes(session.nativeState.sandbox)) {
        throw new CliError('NATIVE_SANDBOX_RUNTIME_UNSUPPORTED',
          'This native worker does not report its Codex sandbox policy. Finish its work and restart the native runtime with this HCC version before sending or responding.');
      }
      if (session.nativeState.sandbox === 'read-only' && !session.nativeState.sandboxVerified) {
        throw new CliError('NATIVE_SANDBOX_UNVERIFIED', 'The Codex provider has not confirmed this read-only worker policy');
      }
    }
    if (typeof input.authorizeMutation === 'function') input.authorizeMutation();
    const identity = { peer: session.peerId, generation: session.nativeIdentity.generation,
      owner: session.nativeIdentity.owner, provider: session.kind, sessionId: session.nativeIdentity.sessionId };
    if (action === 'respond' && (input.executorId !== session.nativeState.executorId || input.sessionId !== session.nativeState.sessionId)) {
      throw new CliError('NATIVE_APPROVAL_MISMATCH', 'Interaction belongs to another executor or provider session');
    }
    if (action === 'interrupt' && !session.nativeState.capabilities.interrupt) {
      throw new CliError('NATIVE_CAPABILITY_UNSUPPORTED', 'Provider does not support interrupt');
    }
    const pending = { submission_id: submissionId, peer: identity.peer,
      owner: identity.owner, generation: identity.generation,
      provider: identity.provider, provider_session_id: identity.sessionId,
      ...(action === 'send' ? { body_hash: createHash('sha256').update(text).digest('hex') } : {}) };
    if (action === 'send') {
      const db = connectWebProject(session.ctx);
      try {
        tx(db, () => {
          const previous = db.prepare(`SELECT payload FROM events WHERE type='native.web.submission.pending'
            AND json_extract(payload, '$.submission_id')=? ORDER BY id DESC LIMIT 1`).get(submissionId);
          if (previous) {
            if (input.retry !== true) {
              throw new CliError('SUBMISSION_EXISTS', 'This submission was already attempted; inspect native deliveries before sending again');
            }
            let saved;
            try { saved = JSON.parse(previous.payload); } catch { /* Reject below. */ }
            if (!saved || Object.keys(pending).some(key => saved[key] !== pending[key])) {
              throw new CliError('NATIVE_SUBMISSION_MISMATCH', 'Retry must keep the original worker, executor and message');
            }
          } else {
            if (input.retry === true) throw new CliError('NATIVE_SUBMISSION_UNVERIFIED', 'No durable pending submission exists for this retry');
            addEvent(db, 'native.web.submission.pending', session.peerId, null, pending);
          }
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
      }, { expectedGeneration: identity.generation });
      if (action === 'send') {
        if (!Number.isSafeInteger(result?.message_id) || result.submission_id !== submissionId || typeof result.state !== 'string') {
          throw new CliError('NATIVE_RESPONSE_INVALID', 'Native queue receipt is invalid', { uncertain: true });
        }
        receiptEvent(session, 'native.web.submission.queued', { ...pending, message_id: result.message_id, state: result.state, ...(input.retry === true ? { retry: true } : {}) });
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
  return { startNativeSession, listNativeHistory, nativeWorkerHistory, resumeNativeSession,
    discoverNativeSessions, pollNativeSessions, nativeAction, closeNativeBridge };
}
