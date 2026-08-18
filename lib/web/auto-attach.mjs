// Auto-attach of detected provider peers, extracted from lib/web/runtime-main.mjs.
// Scans tmux panes once per tick, reconciles DB bindings against live panes,
// and attaches hcc-detected provider sessions to the web runtime.

import { inferPeerKind } from '../integrations/providers.mjs';
import { runTmux } from '../tmux.mjs';
import { inspectProviderProcess } from '../integrations/peers/processes.mjs';

export function createAutoAttach(deps) {
  const {
    ctx, sessions,
    connectWebProject, now, addEvent,
    reconcileRunningPeerBindings,
    redactedLogText, sessionsForProject,
    attachTmuxSession,
    latestHookProviderSession,
    resolveSessionPeerId,
    reAdoptOrphanManagedTmuxSessions, reapDeadPeersForProject
  } = deps;

  function listTmuxPanesOnce() {
    // Use '|' not '\t' as the field separator: older tmux (3.3a) replaces
    // whitespace in -F output with '_'. Path is last and rejoined so a '|'
    // inside a path is safe. tmux-8: session_name is NOT included here — a
    // user-created session name could contain '|', corrupting the parse. Callers
    // that need the session name use tmuxSessionNameForPane(pane.pane) which
    // queries a single field with no separator issue.
    const result = runTmux([
      'list-panes',
      '-a',
      '-F',
      '#{pane_id}|#{pane_pid}|#{pane_current_command}|#{pane_current_path}'
    ]);
    return result.trim().split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = line.split('|');
        return {
          pane: parts[0],
          pid: Number.parseInt(parts[1] || '0', 10) || null,
          command: parts[2] || '',
          sessionName: '',
          cwd: parts.slice(3).join('|') || ''
        };
      })
      .filter((pane) => pane.pane && pane.pid);
  }

  function attachedTmuxState(projectCtx, db) {
    const peers = new Set();
    const panes = new Set();
    for (const session of sessionsForProject(projectCtx)) {
      if (session.status !== 'running') continue;
      peers.add(session.id);
      if (session.peerId) peers.add(session.peerId);
      const resolved = resolveSessionPeerId(db, session);
      if (resolved) peers.add(resolved);
      if (session.type === 'tmux' && session.pane) panes.add(session.pane);
    }
    return { peers, panes };
  }

  function reconcileRunningBindings(projectCtx = ctx, panes = null) {
    const db = connectWebProject(projectCtx);
    try {
      const tmuxPanes = Array.isArray(panes) ? panes : listTmuxPanesOnce();
      return reconcileRunningPeerBindings(db, projectCtx, {
        panes: tmuxPanes,
        inspectProcess: inspectProviderProcess,
        latestProviderSessionForPeer: (peer) => latestHookProviderSession(db, peer),
        addEvent,
        now
      });
    } catch {
      return null;
    } finally {
      db.close();
    }
  }

  let autoAttachScanInFlight = false;

  function scanAndAttachDetectedPeers() {
    if (autoAttachScanInFlight) return;
    autoAttachScanInFlight = true;
    let db = null;
    try {
      db = connectWebProject(ctx);

      // Always-on, TTL-independent hygiene: recover managed tmux sessions left
      // alive (default Stop = detach-without-kill, or across a restart) and reap
      // peers whose process is gone. Sweep first so its live set protects
      // still-alive sessions from being reaped.
      const liveManaged = reAdoptOrphanManagedTmuxSessions(ctx);
      reapDeadPeersForProject(ctx, liveManaged, db);

      const rows = db.prepare(`
        SELECT p.id, p.kind, p.role, p.worktree, p.pid,
               b.peer AS binding_peer, b.provider, b.provider_session_id,
               b.provider_session_name, b.resume_mode, b.resume_arg,
               b.command AS binding_command, b.runtime_session_id,
               b.runtime_target
        FROM peers p
        LEFT JOIN peer_bindings b ON b.peer = p.id
        WHERE p.status IN ('running', 'working', 'busy')
          AND p.pid IS NOT NULL
          AND p.last_seen_at >= ? - ?
        ORDER BY p.last_seen_at DESC
      `).all(now(), ACTIVE_PEER_TTL);
      if (!rows.length) return;

      let panes;
      try {
        panes = listTmuxPanesOnce();
      } catch {
        return;
      }
      if (!panes.length) return;
      const paneByPid = new Map();
      for (const pane of panes) {
        if (!paneByPid.has(pane.pid)) paneByPid.set(pane.pid, pane);
      }
      reconcileRunningPeerBindings(db, ctx, {
        panes,
        inspectProcess: inspectProviderProcess,
        latestProviderSessionForPeer: (peer) => latestHookProviderSession(db, peer),
        addEvent,
        now
      });
      const attached = attachedTmuxState(ctx, db);

      for (const row of rows) {
        if (attached.peers.has(row.id)) continue;
        if (row.binding_peer && attached.peers.has(row.binding_peer)) continue;
        if (row.runtime_session_id && attached.peers.has(row.runtime_session_id)) continue;

        const pane = paneByPid.get(Number(row.pid));
        if (!pane || attached.panes.has(pane.pane)) continue;

        const binding = row.binding_peer ? {
          provider: row.provider,
          provider_session_id: row.provider_session_id,
          provider_session_name: row.provider_session_name,
          resume_mode: row.resume_mode,
          resume_arg: row.resume_arg,
          command: row.binding_command,
          runtime_session_id: row.runtime_session_id || row.id,
          runtime_target: pane.pane
        } : null;
        try {
          const session = attachTmuxSession({
            id: row.id,
            pane: pane.pane,
            kind: row.kind || inferPeerKind(row.id, null, pane.command),
            role: row.role || 'peer',
            cwd: pane.cwd || row.worktree || ctx.root,
            command: row.binding_command || null,
            force: false,
            projectCtx: ctx,
            binding,
            autoAttach: true,
            auditActorPeer: 'web-runtime',
            auditSource: 'runtime'
          });
          attached.peers.add(row.id);
          if (session.peerId) attached.peers.add(session.peerId);
          attached.panes.add(pane.pane);
        } catch {}
      }
    } catch (err) {
      console.error(redactedLogText(`[${new Date().toISOString()}] auto-attach scan failed: ${err?.message || err}`));
    } finally {
      try { db?.close(); } catch {}
      autoAttachScanInFlight = false;
    }
  }

  scanAndAttachDetectedPeers();
  const autoAttachPoller = setInterval(scanAndAttachDetectedPeers, 5000);

  return {
    autoAttachPoller, listTmuxPanesOnce, attachedTmuxState,
    reconcileRunningBindings, scanAndAttachDetectedPeers
  };
}
