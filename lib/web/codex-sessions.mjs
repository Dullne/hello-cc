import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CliError } from '../shared/errors.mjs';
import { tx } from '../db/schema.mjs';
import { childSessionEnv } from '../core/sessions/launch.mjs';
import { createCodexAppServer } from './codex-app-server.mjs';
import { waitForLiveProcessIdentity } from '../process/identity.mjs';
import { createScopedMcpConfig } from '../mcp/scope.mjs';
import { sameSelectedCwdIdentity } from '../process/selected-cwd-identity.mjs';

// Each structured session owns one executor. Existing TUI sessions are never
// silently resumed here: provider identity and live-owner evidence fence that.
export function createCodexSessions({ sessions, sessionKey, nextProjectSessionId,
  connectWebProject, upsertPeer, upsertCanonicalPeerBinding, observePeerEvidence,
  broadcast, closeSessionClients, now, addEvent, adapterFactory = createCodexAppServer,
  waitForOwnerIdentity = waitForLiveProcessIdentity, mcpConfigFactory = createScopedMcpConfig }) {
  const startingThreads = new Set();

  function assertSelectedProject(pctx) {
    pctx.rootIdentity?.assertUnchanged();
  }

  function managedSessionMatchesProject(session, pctx) {
    if (session.root !== pctx.root ||
        (session.ctx?.dbPath && pctx.dbPath && path.resolve(session.ctx.dbPath) !== path.resolve(pctx.dbPath))) return false;
    const owner = session.ctx?.rootIdentity;
    const requested = pctx.rootIdentity;
    return owner || requested
      ? Boolean(owner && requested && sameSelectedCwdIdentity(owner, requested))
      : true;
  }

  function event(session, type, payload) {
    const db = connectWebProject(session.ctx);
    try { addEvent(db, type, session.peerId, null, payload); } finally { db.close(); }
  }

  async function startCodexSession(input) {
    if (input.kind !== 'codex') throw new CliError('BAD_REQUEST', 'App Server supports Codex sessions only');
    if (input.command || input.env || input.binding || input.force || input.providerForce) {
      throw new CliError('BAD_REQUEST', 'App Server uses the local Codex executable and runtime environment');
    }
    const pctx = input.projectCtx;
    assertSelectedProject(pctx);
    const cwd = pctx.root;
    const mode = input.mode || 'new';
    if (!['new', 'resume'].includes(mode)) throw new CliError('BAD_REQUEST', 'App Server supports new or explicit resume');
    const threadId = mode === 'resume' ? String(input.resume || '').trim() : null;
    if (mode === 'resume' && (!threadId || input.handoffConfirmed !== true)) {
      throw new CliError('HANDOFF_REQUIRED', 'Finish the old executor and explicitly confirm history handoff before resuming');
    }
    const reservation = threadId ? `codex:${threadId}` : `${pctx.root}\0${randomUUID()}`;
    if (startingThreads.has(reservation)) throw new CliError('THREAD_IN_USE', 'This thread is already being opened');
    const db = connectWebProject(pctx);
    let previousPeer = null;
    try {
      if (threadId) {
        for (const s of sessions.values()) {
          const ownsExecutor = s.status === 'running' || (s.type === 'app-server' &&
            !s.executorReleased && !s.adapter.snapshot().processExited);
          if (ownsExecutor && s.binding?.provider_session_id === threadId) {
            throw new CliError('THREAD_IN_USE', 'Open the existing managed session before resuming this thread');
          }
        }
        const bindings = db.prepare(`SELECT p.*, b.transport, b.runtime_target FROM peer_bindings b
          JOIN peers p ON p.id = b.peer WHERE b.provider = 'codex' AND b.provider_session_id = ?`).all(threadId);
        for (const owner of bindings) {
          if (observePeerEvidence(pctx, owner, owner).state !== 'dead') {
            throw new CliError('THREAD_IN_USE', 'The old executor has not been confirmed stopped; open its existing terminal');
          }
          previousPeer = owner.id;
        }
        if (bindings.length > 1) throw new CliError('THREAD_IN_USE', 'Provider thread has ambiguous peer ownership');
      }
    } finally { db.close(); }
    startingThreads.add(reservation);
    const id = previousPeer || nextProjectSessionId(pctx, 'codex');
    const session = { id, peerId: id, root: pctx.root, ctx: pctx, cwd, kind: 'codex', role: 'peer',
      type: 'app-server', command: 'codex app-server --listen stdio://', status: 'starting',
      createdAt: now(), clients: new Set(), actionTokens: new Set(), buffer: '' };
    const key = sessionKey(pctx, id);
    sessions.set(key, session);
    let registered = false;
    let closeScheduled = false;
    let adapter;
    let ownerIdentity = null;
    try { adapter = adapterFactory({ cwd, expectedCwdIdentity: pctx.rootIdentity || pctx.initialRootIdentity,
      changeView: true, env: childSessionEnv({
      HCC_PEER: id, HCC_ROOT: pctx.root, HCC_DB: pctx.dbPath, HCC_SHIM_NO_ATTACH: '1'
    }, process.env, { rootIdentity: pctx.rootIdentity || pctx.initialRootIdentity }), async onSpawn({ pid, executorId }) {
      const owner = await waitForOwnerIdentity(pid);
      if (owner.state !== 'live' || !owner.identity) throw new CliError('CODEX_OWNER_IDENTITY_UNKNOWN', 'Executor ownership could not be verified');
      assertSelectedProject(pctx);
      ownerIdentity = owner.identity;
      session.mcpCapability = mcpConfigFactory({ root: pctx.root, dbPath: pctx.dbPath,
        peer: id, executorId, ownerIdentity,
        binding: { transport: 'app-server', runtimeSessionId: id } });
      return { mcp_servers: { hello_cc_scoped: session.mcpCapability.config } };
    }, onChange(state, event, metadata) {
      session.executorId ||= state.executorId;
      broadcast(session, { type: 'codex_state', state }, event, metadata);
      if (state.status === 'disconnected' && !closeScheduled) {
        closeScheduled = true;
        queueMicrotask(() => { if (adapter) void adapter.close(); });
      }
      if (!registered) return;
      const ended = ['disconnected', 'closed'].includes(state.status);
      if (ended) { session.status = 'exited'; session.exitedAt = now(); session.mcpCapability?.dispose(); }
      if (!ended && session.lastHeartbeatWrite === now()) return;
      session.lastHeartbeatWrite = now();
      const update = connectWebProject(pctx);
      try {
        if (ended) update.prepare("UPDATE peers SET status = 'exited' WHERE id = ?").run(session.peerId);
        else update.prepare('UPDATE peers SET last_seen_at = ? WHERE id = ?').run(now(), session.peerId);
      } finally { update.close(); }
      if (ended) broadcast(session, { type: 'exit', event: { reason: state.status } });
    } }); } catch (error) {
      sessions.delete(key); startingThreads.delete(reservation); throw error;
    }
    session.adapter = adapter;
    try {
      const params = { cwd, approvalPolicy: 'on-request', sandbox: 'workspace-write' };
      if (threadId) {
        const source = await adapter.peekThread(threadId);
        assertProjectThread(pctx, source.thread, threadId);
      }
      assertSelectedProject(pctx);
      const response = threadId ? await adapter.resumeThread(threadId, params) : await adapter.startThread(params);
      assertSelectedProject(pctx);
      const thread = response.thread;
      if (!thread?.id) throw new CliError('CODEX_PROTOCOL_ERROR', 'App Server returned no thread identity');
      if (threadId && thread.id !== threadId) throw new CliError('CODEX_PROTOCOL_ERROR', 'Resumed thread identity changed');
      const executorState = adapter.snapshot();
      if (executorState.status !== 'ready' || executorState.processExited) {
        throw new CliError('CODEX_DISCONNECTED', 'Executor disconnected while opening its thread; no session was registered');
      }
      session.pid = executorState.pid || null;
      session.executorId = executorState.executorId;
      const save = connectWebProject(pctx);
      try {
        assertSelectedProject(pctx);
        tx(save, () => {
          const owners = save.prepare(`SELECT p.*, b.transport, b.runtime_target FROM peer_bindings b
            JOIN peers p ON p.id = b.peer WHERE b.provider = 'codex' AND b.provider_session_id = ?`).all(thread.id);
          for (const owner of owners) {
            if (observePeerEvidence(pctx, owner, owner).state !== 'dead') {
              throw new CliError('THREAD_IN_USE', 'Thread ownership changed while its executor was opening');
            }
          }
          upsertPeer(save, { id, kind: 'codex', role: 'peer', worktree: cwd, pid: session.pid,
            ...(ownerIdentity ? { processIdentity: ownerIdentity } : {}),
            status: 'running', capabilities: 'codex-app-server' });
          const canonical = upsertCanonicalPeerBinding(save, { peer: id, provider: 'codex',
            provider_session_id: thread.id, resume_mode: mode, resume_arg: threadId,
            command: session.command, transport: 'app-server', runtime_session_id: id }, false, { override: Boolean(threadId) });
          session.peerId = canonical.peer;
          session.binding = { ...canonical.binding };
          addEvent(save, 'codex.executor.started', session.peerId, null, {
            executor_id: adapter.snapshot().executorId, thread_id: thread.id, mode, cwd
          });
        });
      } finally { save.close(); }
      session.status = 'running';
      registered = true;
      return session;
    } catch (error) {
      await adapter.close();
      session.mcpCapability?.dispose();
      if (sessions.get(key) === session) sessions.delete(key);
      throw error;
    } finally { startingThreads.delete(reservation); }
  }

  async function codexAction(session, action, input) {
    if (session.type !== 'app-server' || session.status !== 'running') {
      throw new CliError('SESSION_NOT_RUNNING', 'A running App Server session is required');
    }
    assertSelectedProject(session.ctx);
    const adapter = session.adapter;
    const threadId = session.binding.provider_session_id;
    if (action === 'read') return adapter.readThread(threadId, { includeTurns: true });
    if (action === 'account') {
      if (input.executorId !== adapter.snapshot().executorId) throw new CliError('CODEX_EXECUTOR_MISMATCH', 'Account view belongs to another executor');
      return adapter.readAccount();
    }
    if (action === 'interrupt') return adapter.interrupt(threadId, String(input.turnId || ''));
    if (action === 'approve') return adapter.approve({ executorId: input.executorId,
      threadId, turnId: input.turnId, requestId: input.requestId, decision: input.decision,
      permissions: input.permissions, scope: input.scope, answers: input.answers, content: input.content });
    if (!['turn', 'steer'].includes(action)) throw new CliError('BAD_REQUEST', 'Unsupported Codex action');
    const text = String(input.text || '').trim();
    if (!text || text.length > 100000) throw new CliError('BAD_REQUEST', 'A message of 1 to 100000 characters is required');
    const submissionId = String(input.submissionId || '');
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(submissionId)) throw new CliError('BAD_REQUEST', 'A unique submissionId is required');
    const submission = { submission_id: submissionId, executor_id: adapter.snapshot().executorId,
      thread_id: threadId, action };
    const db = connectWebProject(session.ctx);
    try {
      if (db.prepare(`SELECT id FROM events WHERE type = 'codex.submission.pending'
        AND json_extract(payload, '$.submission_id') = ? LIMIT 1`).get(submissionId)) {
        throw new CliError('SUBMISSION_EXISTS', 'This submission was already attempted; read state before sending again');
      }
      // Commit receipt before calling the executor. A crashed request remains
      // pending and will never be replayed automatically by this runtime.
      addEvent(db, 'codex.submission.pending', session.peerId, null, submission);
    } finally { db.close(); }
    try {
      const content = [{ type: 'text', text }];
      const result = action === 'turn' ? await adapter.startTurn(threadId, content)
        : await adapter.steer(threadId, String(input.turnId || ''), content);
      event(session, 'codex.submission.confirmed', { ...submission, turn_id: result.turn?.id || input.turnId });
      return { ...result, submissionId };
    } catch (error) {
      event(session, 'codex.submission.unconfirmed', { ...submission, code: error.code || 'UNKNOWN' });
      throw error;
    }
  }

  async function stopCodexSession(session) {
    session.mcpCapability?.dispose();
    await session.adapter.close();
    session.executorReleased = true;
    session.status = 'exited'; session.exitedAt = now();
    const db = connectWebProject(session.ctx);
    try {
      db.prepare("UPDATE peers SET status = 'exited' WHERE id = ?").run(session.peerId);
      addEvent(db, 'codex.executor.stopped', session.peerId, null, { executor_id: session.adapter.snapshot().executorId });
    } finally { db.close(); }
    broadcast(session, { type: 'exit', event: { reason: 'executor stopped' } });
    closeSessionClients(session);
  }
  function assertProjectThread(pctx, thread, expectedId = null) {
    assertSelectedProject(pctx);
    let matches = false;
    try { matches = typeof thread?.cwd === 'string' && fs.realpathSync(thread.cwd) === fs.realpathSync(pctx.root); } catch {}
    assertSelectedProject(pctx);
    if (!matches || typeof thread?.id !== 'string' || (expectedId && thread.id !== expectedId)) {
      throw new CliError('PROJECT_PATH_FORBIDDEN', 'Codex thread does not belong to this project');
    }
    return thread;
  }

  function threadIdentifier(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\r\n\0]/.test(value)) {
      throw new CliError('BAD_REQUEST', 'A bounded thread identity is required');
    }
    return value;
  }

  async function withHistoryAdapter(pctx, action, fresh = false) {
    assertSelectedProject(pctx);
    const managed = !fresh && [...sessions.values()].find(session => session.type === 'app-server' &&
      managedSessionMatchesProject(session, pctx) && session.status === 'running' && session.adapter.snapshot().status === 'ready');
    if (managed) {
      const result = await action(managed.adapter);
      assertSelectedProject(pctx);
      return result;
    }
    const adapter = adapterFactory({ cwd: pctx.root,
      env: childSessionEnv({ HCC_ROOT: pctx.root, HCC_DB: pctx.dbPath, HCC_SHIM_NO_ATTACH: '1' },
        process.env, { rootIdentity: pctx.rootIdentity || pctx.initialRootIdentity }) });
    try {
      const result = await action(adapter);
      assertSelectedProject(pctx);
      return result;
    } finally {
      await adapter.close();
      const state = adapter.snapshot();
      if (state.pid && !state.processExited) {
        throw new CliError('CODEX_EXECUTOR_CLOSE_UNCONFIRMED', 'History executor exit could not be confirmed; no second executor was started');
      }
    }
  }

  async function listCodexThreads(pctx, { cursor = null, limit = 50 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
        (cursor !== null && (typeof cursor !== 'string' || cursor.length > 2048))) {
      throw new CliError('BAD_REQUEST', 'History limit must be 1 to 100 and cursor must be bounded text');
    }
    const result = await withHistoryAdapter(pctx, adapter => adapter.listThreads({ cwd: pctx.root, limit, cursor }));
    assertSelectedProject(pctx);
    const threads = (result.data || []).filter(thread => {
      try { assertProjectThread(pctx, thread); return true; }
      catch (error) {
        if (error?.code === 'PROJECT_PATH_CHANGED') throw error;
        return false;
      }
    }).map(thread => {
      const managed = [...sessions.values()].find(session => managedSessionMatchesProject(session, pctx) &&
        session.binding?.provider_session_id === thread.id && session.status === 'running');
      return { ...thread, managedSessionId: managed?.id || null };
    });
    assertSelectedProject(pctx);
    return { threads, nextCursor: result.nextCursor || null };
  }

  async function readCodexThread(pctx, threadId) {
    threadIdentifier(threadId);
    const result = await withHistoryAdapter(pctx, adapter => adapter.peekThread(threadId));
    return { thread: assertProjectThread(pctx, result.thread, threadId) };
  }

  async function forkCodexThread(pctx, threadId, input = {}) {
    threadIdentifier(threadId);
    if (!input || typeof input !== 'object' || Array.isArray(input) || input.confirmed !== true) {
      throw new CliError('HANDOFF_REQUIRED', 'Explicitly confirm creating a new thread and executor from this history');
    }
    for (const key of Object.keys(input)) {
      if (!['confirmed', 'lastTurnId', 'action_token', 'actionToken', 'epoch', 'authorizeMutation'].includes(key)) throw new CliError('BAD_REQUEST', `Unsupported history fork option: ${key}`);
    }
    if (input.lastTurnId !== undefined) threadIdentifier(input.lastTurnId);
    // Fork on a temporary executor and close it before resume. A live source
    // keeps its process and active turn; the new thread has one managed owner.
    const result = await withHistoryAdapter(pctx, async adapter => {
      const source = await adapter.peekThread(threadId);
      assertProjectThread(pctx, source.thread, threadId);
      assertSelectedProject(pctx);
      const forked = await adapter.forkThread(threadId, input.lastTurnId ? { lastTurnId: input.lastTurnId } : {}, input.authorizeMutation);
      assertProjectThread(pctx, forked.thread);
      if (forked.thread.id === threadId) throw new CliError('CODEX_PROTOCOL_ERROR', 'Fork did not create a new thread');
      return forked;
    }, true);
    try {
      const session = await startCodexSession({ projectCtx: pctx, kind: 'codex', mode: 'resume',
        resume: result.thread.id, handoffConfirmed: true });
      return { thread: result.thread, session, sourceThreadId: threadId };
    } catch (error) {
      throw new CliError(error.code || 'CODEX_START_FAILED', 'The forked history was saved but its executor could not open; inspect history before retrying',
        { forkedThreadId: result.thread.id });
    }
  }
  return { startCodexSession, codexAction, stopCodexSession,
    listCodexThreads, readCodexThread, forkCodexThread };
}
