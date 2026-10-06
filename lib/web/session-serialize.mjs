// Session serialization, broadcast, and client management helpers extracted from cmdWeb.
// These operate on the shared sessions Map and WS clients.
import path from 'node:path';
import { selectCurrentTask } from '../core/coordination/automation.mjs';
import { sameSelectedCwdIdentity } from '../process/selected-cwd-identity.mjs';
import { createSessionStateStream, sendStructuredFrame } from './session-state-sync.mjs';

export function createSessionSerialize({
  sessions,
  cookieSocketValid,
  ctx,
  sameResolvedPath,
  localClientObservation = () => null
}) {
  function sessionKey(projectCtx, id) {
    const owner = projectCtx.rootIdentity || projectCtx.initialRootIdentity;
    const identity = owner?.identity;
    const binding = identity
      ? `${owner.canonical}\0${identity.dev}\0${identity.ino}\0${identity.birthtimeNs}`
      : projectCtx.root;
    return `${binding}\0${projectCtx.dbPath || ''}\0${id}`;
  }

  function sessionIdentityMatches(session, projectCtx) {
    if (session.ctx?.dbPath && projectCtx.dbPath &&
        path.resolve(session.ctx.dbPath) !== path.resolve(projectCtx.dbPath)) return false;
    const owner = session.ctx?.rootIdentity || session.rootIdentity;
    const requested = projectCtx.rootIdentity;
    // Legacy contexts without a captured identity retain their old path
    // behavior; newly managed sessions cannot appear under a rebound root.
    return owner || requested
      ? Boolean(owner && requested && sameSelectedCwdIdentity(owner, requested))
      : true;
  }

  function sessionsForProject(projectCtx) {
    return [...sessions.values()].filter((session) =>
      sameResolvedPath(session.root, projectCtx.root) && sessionIdentityMatches(session, projectCtx));
  }

  function resolveSessionPeerId(db, session) {
    if (!session) return null;
    if (!db) return session.peerId || session.id || null;

    if (session.type === 'tmux' && session.pane) {
      const byTarget = db.prepare(`
        SELECT peer FROM peer_bindings WHERE runtime_target = ?
        ORDER BY updated_at DESC, created_at DESC LIMIT 1
      `).get(session.pane);
      if (byTarget?.peer) { session.peerId = byTarget.peer; return byTarget.peer; }
    }
    if (session.id) {
      const byRuntime = db.prepare(`
        SELECT peer FROM peer_bindings WHERE runtime_session_id = ?
        ORDER BY updated_at DESC, created_at DESC LIMIT 1
      `).get(session.id);
      if (byRuntime?.peer) { session.peerId = byRuntime.peer; return byRuntime.peer; }
      const byPeer = db.prepare(`SELECT peer FROM peer_bindings WHERE peer = ? LIMIT 1`).get(session.id);
      if (byPeer?.peer) { session.peerId = byPeer.peer; return byPeer.peer; }
    }
    session.peerId = session.peerId || session.id || null;
    return session.peerId;
  }

  function sessionBindingForSerialize(db, session, peerId) {
    if (!session) return null;
    if (!db) return session.binding || null;

    if (session.type === 'tmux' && session.pane) {
      const byTarget = db.prepare(`SELECT * FROM peer_bindings WHERE runtime_target = ? ORDER BY updated_at DESC, created_at DESC LIMIT 1`).get(session.pane);
      if (byTarget) return byTarget;
    }
    for (const peer of [peerId, session.peerId, session.id]) {
      if (!peer) continue;
      const byPeer = db.prepare(`SELECT * FROM peer_bindings WHERE peer = ? ORDER BY updated_at DESC, created_at DESC LIMIT 1`).get(peer);
      if (byPeer) return byPeer;
    }
    if (session.id) {
      const byRuntime = db.prepare(`SELECT * FROM peer_bindings WHERE runtime_session_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT 1`).get(session.id);
      if (byRuntime) return byRuntime;
    }
    return session.binding || null;
  }

  function serializeBindingSummary(binding, session) {
    if (!binding) return null;
    return {
      peer: binding.peer || session?.peerId || session?.id || null,
      provider: binding.provider || session?.kind || 'other',
      provider_session_id: binding.provider_session_id || null,
      provider_session_name: binding.provider_session_name || null,
      resume_mode: binding.resume_mode || null,
      resume_arg: binding.resume_arg || null,
      command: binding.command || null,
      transport: binding.transport || session?.type || null,
      runtime_session_id: binding.runtime_session_id || session?.id || null,
      runtime_target: binding.runtime_target || session?.pane || null,
      created_at: binding.created_at || null,
      updated_at: binding.updated_at || null
    };
  }

  function serializeSession(session, db = null) {
    const peerId = resolveSessionPeerId(db, session);
    const binding = serializeBindingSummary(sessionBindingForSerialize(db, session, peerId), session);
    const providerSessionLabel = binding?.provider_session_id || binding?.provider_session_name || null;
    const currentTask = db && peerId ? selectCurrentTask(db.prepare(`SELECT id, title, status, owner, priority
      FROM tasks WHERE owner = ? AND status NOT IN ('done','abandoned')`).all(peerId), peerId) : null;
    const task = currentTask ? { id: currentTask.id, title: currentTask.title, status: currentTask.status } : null;
    return {
      id: session.id,
      peer_id: peerId,
      kind: session.kind,
      role: session.role,
      command: session.command,
      cwd: session.cwd,
      pid: session.pid,
      pane: session.pane || null,
      root: session.root || session.ctx?.root || ctx.root,
      status: session.status,
      type: session.type || 'pty',
      task,
      capabilities: session.type === 'app-server'
        ? ['chat', 'turn-control', 'approval', 'diff', 'plan', 'results', 'history', 'account-read']
        : session.type === 'native' ? ['chat', 'delivery-receipts', 'results',
          ...(session.nativeState?.capabilities?.interrupt ? ['turn-control'] : []),
          ...(session.nativeState?.capabilities?.accountRead ? ['account-read'] : [])] : ['terminal', 'results'],
      local_clients: session.type === 'tmux' ? localClientObservation(session) : null,
      executor_id: session.executorId || session.adapter?.snapshot().executorId || session.nativeState?.executorId || null,
      native_connected: session.type === 'native' ? Boolean(session.nativeState?.connected) : null,
      created_at: session.createdAt,
      exited_at: session.exitedAt || null,
      binding,
      provider_session_known: Boolean(providerSessionLabel),
      provider_session_label: providerSessionLabel,
      warning: session.warning || null
    };
  }

  function stateStream(session, channel, state, connectingClient = null) {
    if (!session.stateSync || session.stateSync.executorId !== String(state.executorId || state.owner || '')) {
      if (session.stateSync) for (const client of session.clients) {
        if (client.hccStateSync && client !== connectingClient) { client.hccStateClosing = true; client.close(1012, 'executor changed'); }
      }
      session.stateSync = createSessionStateStream({ root: session.root || session.ctx?.root || ctx.root,
        sessionId: session.id, channel, state });
      return { stream: session.stateSync, initial: true };
    }
    return { stream: session.stateSync, initial: false };
  }

  function sendStateSnapshot(session, client, requestId) {
    if (!sessionProjectStillSelected(session)) return false;
    if (!client.hccStateSync || client.hccStateClosing) return false;
    const channel = session.type === 'native' ? 'native' : session.adapter ? 'codex' : null;
    if (!channel) return false;
    const state = channel === 'native' ? session.nativeSnapshot() : session.adapter.snapshot();
    const { stream, initial } = stateStream(session, channel, state, client.hccStateInitialized ? null : client);
    if (!initial) {
      const frame = stream.update(state);
      // A snapshot can observe deltas waiting in the adapter's 50ms batch.
      // Advance existing observers too, so their next baseRevision still fits.
      if (frame) {
        const encoded = JSON.stringify(frame);
        for (const observer of session.clients) if (observer !== client && observer.hccStateSync && cookieSocketValid(observer)) sendStructuredFrame(observer, encoded);
      }
    }
    const sent = sendStructuredFrame(client, JSON.stringify(stream.snapshot(requestId)));
    if (sent) client.hccStateInitialized = true;
    return sent;
  }

  function sessionProjectStillSelected(session) {
    try {
      (session.ctx?.rootIdentity || session.rootIdentity)?.assertUnchanged();
      return true;
    } catch {
      // Rebinding a selected pathname invalidates Web clients, not the tmux
      // pane or native worker that still belongs to the original directory.
      for (const client of session.clients || []) {
        try { client.close(1008, 'project changed'); } catch {}
      }
      return false;
    }
  }

  function broadcast(session, payload, metadata) {
    if (!sessionProjectStillSelected(session)) return;
    const structured = ['codex_state', 'native_state'].includes(payload.type);
    const clients = [...session.clients].filter(client => {
      if (!cookieSocketValid(client)) { session.clients.delete(client); return false; }
      return client.readyState === client.OPEN && !client.hccStateClosing;
    });
    if (!clients.length) return;
    let synchronizedText = null;
    if (structured && clients.some(client => client.hccStateSync)) {
      const { stream, initial } = stateStream(session, payload.type === 'codex_state' ? 'codex' : 'native', payload.state);
      const frame = initial ? stream.snapshot() : stream.update(payload.state, metadata);
      if (frame) synchronizedText = JSON.stringify(frame);
    }
    const text = !structured || clients.some(client => !client.hccStateSync) ? JSON.stringify(payload) : null;
    for (const client of clients) {
      if (structured) {
        const encoded = client.hccStateSync ? synchronizedText : text;
        if (encoded) sendStructuredFrame(client, encoded);
      } else client.send(text);
    }
  }

  function hasOpenClients(session) {
    if (!session?.clients?.size) return false;
    let open = false;
    for (const client of [...session.clients]) {
      if (!cookieSocketValid(client)) { session.clients.delete(client); continue; }
      if (client.readyState === client.OPEN || client.readyState === 1) open = true;
      else session.clients.delete(client);
    }
    return open;
  }

  function closeSessionClients(session) {
    if (!session) return;
    session.actionTokens?.clear();
    if (!session.clients?.size) return;
    for (const client of [...session.clients]) {
      try {
        if (client.readyState === client.OPEN || client.readyState === 1) client.close(1001, 'runtime stopping');
        else if (typeof client.terminate === 'function') client.terminate();
      } catch {
        try { if (typeof client.terminate === 'function') client.terminate(); } catch {}
      }
    }
  }

  return {
    sessionKey,
    sessionsForProject,
    resolveSessionPeerId,
    sessionBindingForSerialize,
    serializeBindingSummary,
    serializeSession,
    broadcast,
    sendStateSnapshot,
    hasOpenClients,
    closeSessionClients
  };
}
