// Peer upsert/touch helpers extracted from bin/hcc.mjs.
// Factory pattern: callers inject the functions that remain in bin/hcc.mjs.

export function createPeerHelpers({
  now,
  addEvent,
  liveProcessIdentity,
  detectBranch,
  registerProjectActivity,
  upsertCanonicalPeerBinding,
  autoPeerKind,
  autoPeerSessionId,
  autoPeerResumeId,
  autoPeerDefaults,
  autoPeerBasis,
  providerSessionParts
}) {
  function upsertPeer(db, peer) {
    const t = now();
    const identity = Object.hasOwn(peer, 'processIdentity')
      ? peer.processIdentity
      : liveProcessIdentity(peer.pid);
    db.prepare(`
      INSERT INTO peers(id, kind, role, worktree, branch, pid, pid_start_token, pid_command_hash, status, capabilities, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        role = excluded.role,
        worktree = excluded.worktree,
        branch = excluded.branch,
        pid = excluded.pid,
        pid_start_token = excluded.pid_start_token,
        pid_command_hash = excluded.pid_command_hash,
        -- hb-08: an incidental upsert with the default 'idle' status must not
        -- resurrect a peer that was explicitly marked exited/detached.
        status = CASE WHEN excluded.status = 'idle' AND peers.status IN ('exited', 'detached')
                      THEN peers.status ELSE excluded.status END,
        capabilities = excluded.capabilities,
        last_seen_at = excluded.last_seen_at
    `).run(
      peer.id,
      peer.kind || 'other',
      peer.role || '',
      peer.worktree || '',
      peer.branch || '',
      peer.pid || null,
      identity?.startToken || null,
      identity?.commandHash || null,
      peer.status || 'idle',
      peer.capabilities || '',
      t,
      t
    );
  }

  function touchPeer(db, id, status = null) {
    if (!id) return;
    const existing = db.prepare('SELECT id FROM peers WHERE id = ?').get(id);
    if (!existing) {
      upsertPeer(db, {
        id,
        kind: 'other',
        role: 'auto',
        worktree: process.cwd(),
        branch: detectBranch(process.cwd()),
        pid: process.ppid,
        status: status || 'idle',
        capabilities: ''
      });
    } else {
      db.prepare(`
        UPDATE peers
        SET last_seen_at = ?, status = COALESCE(?, status)
        WHERE id = ?
      `).run(now(), status, id);
    }
  }

  function touchCurrentPeer(db, ctx, resolved, status = null, kindHint = 'shell') {
    registerProjectActivity(ctx);
    const identity = typeof resolved === 'string'
      ? { id: resolved, auto: false }
      : resolved;
    if (!identity || !identity.id) return;
    if (!identity.auto) {
      touchPeer(db, identity.id, status);
      return;
    }

    const existing = db.prepare('SELECT id FROM peers WHERE id = ?').get(identity.id);
    if (existing) {
      touchPeer(db, identity.id, status);
      return;
    }

    const kind = autoPeerKind(kindHint);
    const sessionId = autoPeerSessionId(kind);
    const resumeId = autoPeerResumeId(kind);
    upsertPeer(db, {
      id: identity.id,
      ...autoPeerDefaults(ctx, kindHint, status || 'idle')
    });
    upsertCanonicalPeerBinding(db, {
      peer: identity.id,
      provider: kind,
      ...providerSessionParts(resumeId || sessionId),
      resume_mode: resumeId ? 'resume' : (sessionId ? 'detected' : 'auto'),
      resume_arg: resumeId || null,
      command: null,
      transport: process.env.TMUX_PANE ? 'auto-tmux' : 'auto-shell',
      runtime_session_id: identity.id
    }, true);
    addEvent(db, 'peer.auto_joined', identity.id, null, {
      root: ctx.root,
      basis: autoPeerBasis(kind),
      provider_session: resumeId || sessionId || null
    });
  }

  return { upsertPeer, touchPeer, touchCurrentPeer };
}
