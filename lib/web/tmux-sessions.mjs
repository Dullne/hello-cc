// tmux-backed terminal sessions, extracted from lib/web/runtime-main.mjs.
// DB-proven kill/rebind plans, destructive-evidence guards, attach + managed
// start (PTY/tmux bridges), restore/re-adopt after restart, session I/O,
// resize, and dead-peer reaping for hcc-managed tmux sessions.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { CliError } from '../shared/errors.mjs';
import { tx } from '../db/schema.mjs';
import { required } from '../cli-args.mjs';
import { readClockGraceUntil } from '../shared/clock-grace.mjs';
import { peerEvidenceAllowsReap } from '../core/peers/evidence.mjs';
import { conditionalTmuxKill, conditionalTmuxRename, prepareTmuxRestartBinding, rollbackTmuxRestartBinding, validateTmuxDestructiveEvidence } from '../core/peers/tmux-safety.mjs';
import { LAUNCH_FINGERPRINT_ENV, PROVIDER_STATE_ENV, childSessionEnv, isRelaunchableProviderSession, isolatedEnvCommandArgs, launchFingerprint, providerRestartReason } from '../core/sessions/launch.mjs';
import { defaultSessionCommand, inferPeerKind } from '../integrations/providers.mjs';
import { contextForProject } from '../runtime/paths.mjs';
import { detectBranch } from '../project-context.mjs';
import { ensureTmuxAvailable, runTmux, tmuxCapturePane, tmuxEnvironmentArgs, tmuxHasSession, tmuxKillSession, tmuxLaunchFingerprint, tmuxListSessionNames, tmuxManagedSessionName, tmuxManagedSessionNameMatches, tmuxPaneInfo, tmuxProviderState, tmuxSendLiteral, tmuxSessionEnvironmentValue, tmuxSessionHasClients } from '../tmux.mjs';

export function createTmuxSessions(deps) {
  const {
    ctx, sessions,
    broadcast, closeSessionClients, hasOpenClients,
    sessionKey, sessionsForProject, resolveSessionPeerId,
    startTmuxStream, stopTmuxStream, refreshTmuxSnapshot,
    connectWebProject, nextProjectSessionId, getSession,
    runtimeProjectContexts,
    scanExternalSessions, adoptExternalSession, removeExternalBufferFiles,
    now, addEvent, auditPayload, tx,
    canonicalRoot, liveProcessIdentity, rootEvidence,
    observePeerEvidence, mutatePeerWithEvidence, observeClockSafetyOrThrow,
    strictTmuxClientObservation, tmuxAttachmentAuthority,
    tmuxPaneForTarget, tmuxSessionCreationToken, tmuxSessionId,
    isProjectManagedTmuxSession, redactedLogText, bufferDirectory,
    UNKNOWN_EVIDENCE_GRACE_SEC, BUFS_DIR_NAME, CLI_NAME,
    requestActorPeer, requestSource,
    upsertPeer, upsertCanonicalPeerBinding,
    findProviderSessionBinding, providerOwnerEvidenceFromDb,
    shellCommand, detectBranch
  } = deps;

  // ── Serialize + broadcast helpers ─────────────────────────────────────────
  function detachTmuxSession(session, status = 'detached') {
    stopTmuxStream(session);
    if (session.exitPoller) { clearInterval(session.exitPoller); session.exitPoller = null; }

    session.status = status;
    session.exitedAt = now();
    broadcast(session, { type: 'exit', event: { reason: status } });
    closeSessionClients(session);
    const pctx = session.ctx || contextForProject(session.root || ctx.root, null, { json: ctx.json });
    sessions.delete(sessionKey(pctx, session.id));
    const db = connectWebProject(pctx);
    try {
      const t = now();
      const peerId = resolveSessionPeerId(db, session) || session.id;
      // Do not bump last_seen_at on death: preserve the true last-seen time so a
      // just-detached owner is not misread as freshly active (hb-01).
      db.prepare('UPDATE peers SET status = ? WHERE id IN (?, ?)').run(status, session.id, peerId);
      db.prepare(`
        UPDATE peer_bindings
        SET runtime_target = NULL, updated_at = ?
        WHERE peer IN (?, ?)
           OR runtime_session_id = ?
           OR (? IS NOT NULL AND runtime_target = ?)
      `).run(t, session.id, peerId, session.id, session.pane || null, session.pane || null);
      addEvent(db, status === 'exited' ? 'tmux.session.exited' : 'tmux.session.detached', peerId, null, auditPayload({
        actor: peerId,
        target: peerId,
        source: session.auditSource || 'runtime',
        runtime_session_id: session.id,
        pane: session.pane
      }));
    } finally {
      db.close();
    }
  }

  // Build the escape that places + shows/hides the cursor at a viewport cell,
  // used only to seed the initial snapshot (live output carries its own cursor).
  function tmuxSessionNameForPane(pane) {
    if (!pane) return null;
    try {
      return runTmux(['display-message', '-p', '-t', pane, '#{session_name}']).trim() || null;
    } catch {
      return null;
    }
  }

  function detachRuntimeSessionForPane(projectCtx, pane, status = 'detached') {
    if (!pane) return;
    for (const session of [...sessionsForProject(projectCtx)]) {
      if (session.type === 'tmux' && session.pane === pane) {
        detachTmuxSession(session, status);
      }
    }
  }

  function openClientCountForPane(projectCtx, pane) {
    let count = 0;
    for (const session of [...sessionsForProject(projectCtx)]) {
      if (session.type === 'tmux' && session.pane === pane && hasOpenClients(session)) count += 1;
    }
    return count;
  }

  function tmuxClientObservation(sessionName) {
    return strictTmuxClientObservation(sessionName);
  }

  function observeTmuxDestructiveEvidence(projectCtx, runtimeTarget) {
    let paneInfo = null;
    try { paneInfo = tmuxPaneInfo(runtimeTarget); } catch {}
    const pane = paneInfo?.pane || tmuxPaneForTarget(runtimeTarget);
    const sessionName = tmuxSessionNameForPane(runtimeTarget);
    return {
      session: sessionName,
      session_created: tmuxSessionCreationToken(sessionName),
      session_id: tmuxSessionId(sessionName),
      root: canonicalRoot(tmuxSessionEnvironmentValue(sessionName, 'HCC_ROOT')),
      pane,
      process_identity: liveProcessIdentity(paneInfo?.pid),
      clients: tmuxClientObservation(sessionName),
      expected_root: canonicalRoot(projectCtx.root)
    };
  }

  function tmuxAttachmentEvidence(db, peerId, runtimeTarget) {
    return tmuxAttachmentAuthority(db, peerId, runtimeTarget);
  }

  function assertTmuxDestructiveEvidence(stored, observed, details = {}, options = {}) {
    const validation = validateTmuxDestructiveEvidence(stored, observed, options);
    if (validation.ok) return;
    throw new CliError('TMUX_DESTRUCTIVE_EVIDENCE_INVALID',
      `Refusing destructive tmux action: ${validation.reason}`,
      { ...details, reason: validation.reason });
  }

  function attachmentEvidenceForPane(projectCtx, paneInfo) {
    const expectedRoot = canonicalRoot(projectCtx.root);
    let observed = observeTmuxDestructiveEvidence(projectCtx, paneInfo.pane);
    if (observed.session && !observed.root) {
      runTmux(['set-environment', '-t', observed.session, 'HCC_ROOT', expectedRoot]);
      observed = observeTmuxDestructiveEvidence(projectCtx, paneInfo.pane);
    }
    if (!observed.session || !observed.session_created || !observed.session_id || observed.root !== expectedRoot ||
        observed.pane !== paneInfo.pane || !observed.process_identity) {
      throw new CliError('TMUX_ATTACH_EVIDENCE_INCOMPLETE',
        'Cannot attach tmux pane without complete immutable session evidence', {
          pane: paneInfo.pane,
          tmux_session: observed.session,
          hcc_root: observed.root,
          expected_root: expectedRoot
        });
    }
    return {
      session: observed.session,
      session_created: observed.session_created,
      session_id: observed.session_id,
      root: observed.root,
      pane: observed.pane,
      process_identity: observed.process_identity
    };
  }

  function oldTmuxEventEvidence(projectCtx, sessionName, runtimeTarget) {
    let paneInfo = null;
    try { paneInfo = tmuxPaneInfo(runtimeTarget); } catch {}
    const processIdentity = liveProcessIdentity(paneInfo?.pid);
    const hccRoot = canonicalRoot(tmuxSessionEnvironmentValue(sessionName, 'HCC_ROOT'));
    const sessionCreated = tmuxSessionCreationToken(sessionName);
    const sessionId = tmuxSessionId(sessionName);
    return {
      ...(paneInfo?.pane ? { old_pane: paneInfo.pane } : {}),
      ...(processIdentity ? { old_process_identity: processIdentity } : {}),
      ...(hccRoot ? { old_hcc_root: hccRoot } : {}),
      ...(sessionCreated ? { old_tmux_session_created: sessionCreated } : {}),
      ...(sessionId ? { old_tmux_session_id: sessionId } : {})
    };
  }

  function addRebindCleanupFailedEvent(projectCtx, db, actor, payload) {
    if (!db) return;
    const evidence = oldTmuxEventEvidence(
      projectCtx,
      payload.old_tmux_session,
      payload.old_runtime_target
    );
    addEvent(db, 'tmux.session.rebind_cleanup_failed', actor, null, auditPayload({
      actor,
      target: payload.old_peer || payload.target_peer || null,
      admin: true,
      ...evidence,
      ...payload
    }));
  }

  function oldTmuxRebindTarget(projectCtx, oldTarget, newTarget) {
    if (!oldTarget || oldTarget === newTarget) return false;
    const oldSessionName = tmuxSessionNameForPane(oldTarget);
    const oldSessionRoot = tmuxSessionEnvironmentValue(oldSessionName, 'HCC_ROOT');
    if (!isProjectManagedTmuxSession(projectCtx, oldSessionName, oldSessionRoot)) return false;
    const newSessionName = tmuxSessionNameForPane(newTarget);
    if (oldSessionName === newSessionName) return false;
    return { oldSessionName, newSessionName };
  }

  function tmuxSessionClientCountForStop(sessionName) {
    const clients = tmuxClientObservation(sessionName);
    if (clients.state !== 'known') {
      throw new CliError('TMUX_CLIENT_QUERY_FAILED',
        `Refusing destructive tmux action because clients for ${sessionName || 'unknown session'} could not be queried`);
    }
    return clients.count;
  }

  function safeTmuxKillPlan(projectCtx, db, peerId, expectedTarget) {
    if (!peerId) {
      throw new CliError('BAD_REQUEST', 'peer id required for tmux kill');
    }
    const binding = db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get(peerId);
    if (!binding || binding.transport !== 'tmux' || !binding.runtime_target) {
      throw new CliError('TMUX_KILL_NOT_MANAGED', `No DB-proven tmux runtime binding for ${peerId}`);
    }
    if (expectedTarget && binding.runtime_target !== expectedTarget) {
      throw new CliError('TMUX_KILL_TARGET_CHANGED', `tmux runtime target for ${peerId} changed`, {
        peer: peerId,
        expected_runtime_target: expectedTarget,
        runtime_target: binding.runtime_target
      });
    }

    const stored = tmuxAttachmentEvidence(db, peerId, binding.runtime_target);
    const observed = observeTmuxDestructiveEvidence(projectCtx, binding.runtime_target);
    const actualSession = observed.session;
    const actualPane = observed.pane;
    if (!actualSession || !actualPane) {
      throw new CliError('TMUX_KILL_TARGET_MISSING', `tmux runtime target for ${peerId} is not running`);
    }

    const expectedSession = tmuxManagedSessionName(projectCtx, peerId);
    const sessionRoot = tmuxSessionEnvironmentValue(actualSession, 'HCC_ROOT');
    if (!tmuxManagedSessionNameMatches(projectCtx, actualSession, peerId, sessionRoot)) {
      throw new CliError('TMUX_KILL_NOT_HCC_MANAGED', `Refusing to kill non-managed tmux session ${actualSession}`, {
        peer: peerId,
        expected_session: expectedSession,
        actual_session: actualSession,
        runtime_target: binding.runtime_target
      });
    }

    assertTmuxDestructiveEvidence(stored, observed, {
      peer: peerId,
      runtime_target: binding.runtime_target
    });

    return {
      binding,
      stored,
      session: actualSession,
      pane: actualPane,
      runtime_target: binding.runtime_target,
      hcc_root: observed.root
    };
  }

  function executeTmuxKillPlan(projectCtx, plan) {
    const observed = observeTmuxDestructiveEvidence(projectCtx, plan.runtime_target);
    assertTmuxDestructiveEvidence(plan.stored, observed, {
      peer: plan.binding?.peer || null,
      runtime_target: plan.runtime_target
    });
    conditionalTmuxKill(runTmux, plan.stored);
  }

  function killDbProvenTmuxSession(projectCtx, db, peerId, expectedTarget = null) {
    const plan = safeTmuxKillPlan(projectCtx, db, peerId, expectedTarget);
    executeTmuxKillPlan(projectCtx, plan);
    return plan;
  }

  function safeOldTmuxRebindPlan(projectCtx, db, oldPeer, oldTarget, newTarget, actor, opts = {}) {
    const target = oldTmuxRebindTarget(projectCtx, oldTarget, newTarget);
    if (!target) return null;
    const { oldSessionName, newSessionName } = target;
    const actualPane = tmuxPaneForTarget(oldTarget);
    if (!actualPane) return null;
    if (!oldPeer) {
      throw new CliError('TMUX_REBIND_OLD_PEER_REQUIRED', 'old peer id required for tmux rebind cleanup');
    }
    if (db) {
      const oldBinding = db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get(oldPeer);
      if (!oldBinding || oldBinding.transport !== 'tmux' || oldBinding.runtime_target !== oldTarget) {
        addRebindCleanupFailedEvent(projectCtx, db, actor, {
          reason: 'old_binding_runtime_target_changed',
          old_peer: oldPeer,
          old_runtime_target: oldTarget,
          new_runtime_target: newTarget,
          current_runtime_target: oldBinding?.runtime_target || null,
          old_tmux_session: oldSessionName,
          new_tmux_session: newSessionName || null
        });
        throw new CliError('TMUX_REBIND_OLD_TARGET_CHANGED', `tmux runtime target for ${oldPeer} changed before rebind cleanup`, {
          old_peer: oldPeer,
          expected_runtime_target: oldTarget,
          runtime_target: oldBinding?.runtime_target || null
        });
      }
    }
    const expectedSession = tmuxManagedSessionName(projectCtx, oldPeer);
    const allowedSession = opts.allowedSessionName || null;
    const oldSessionRoot = tmuxSessionEnvironmentValue(oldSessionName, 'HCC_ROOT');
    if (!tmuxManagedSessionNameMatches(projectCtx, oldSessionName, oldPeer, oldSessionRoot) &&
        oldSessionName !== allowedSession) {
      addRebindCleanupFailedEvent(projectCtx, db, actor, {
        reason: 'not_hcc_managed_peer_session',
        old_peer: oldPeer,
        old_runtime_target: oldTarget,
        new_runtime_target: newTarget,
        expected_tmux_session: expectedSession,
        allowed_tmux_session: allowedSession,
        old_tmux_session: oldSessionName,
        new_tmux_session: newSessionName || null
      });
      throw new CliError('TMUX_REBIND_NOT_HCC_MANAGED', `Refusing to rebind-cleanup non-managed tmux session ${oldSessionName}`, {
        old_peer: oldPeer,
        expected_session: expectedSession,
        allowed_session: allowedSession,
        actual_session: oldSessionName,
        runtime_target: oldTarget
      });
    }
    const attachedStored = tmuxAttachmentEvidence(db, oldPeer, oldTarget);
    const observed = observeTmuxDestructiveEvidence(projectCtx, oldTarget);
    const stored = allowedSession && observed.session === allowedSession &&
      attachedStored.session === expectedSession
      ? { ...attachedStored, session: allowedSession }
      : attachedStored;
    const webClientCount = openClientCountForPane(projectCtx, oldTarget);
    assertTmuxDestructiveEvidence(stored, observed, {
      old_peer: oldPeer,
      old_runtime_target: oldTarget,
      new_runtime_target: newTarget
    }, { allowClients: Boolean(opts.force) });
    const tmuxClientCount = observed.clients.count;
    if ((webClientCount > 0 || tmuxClientCount > 0) && !opts.force) {
      addRebindCleanupFailedEvent(projectCtx, db, actor, {
        reason: 'has_clients',
        old_peer: oldPeer,
        old_runtime_target: oldTarget,
        new_runtime_target: newTarget,
        old_tmux_session: oldSessionName,
        new_tmux_session: newSessionName || null,
        web_client_count: webClientCount,
        tmux_client_count: tmuxClientCount
      });
      throw new CliError('TMUX_REBIND_OLD_SESSION_IN_USE',
        `Old tmux session ${oldSessionName} still has clients; detach clients or run ${CLI_NAME} tmux gc later.`,
        {
          old_runtime_target: oldTarget,
          new_runtime_target: newTarget,
          old_tmux_session: oldSessionName,
          web_client_count: webClientCount,
          tmux_client_count: tmuxClientCount
        });
    }
    const eventEvidence = {
      old_pane: stored.pane,
      old_process_identity: stored.process_identity,
      old_hcc_root: stored.root,
      old_tmux_session_created: stored.session_created,
      old_tmux_session_id: stored.session_id
    };
    if (db) {
      addEvent(db, 'tmux.session.rebind_cleanup_pending', actor, null, auditPayload({
        actor,
        target: oldPeer,
        admin: true,
        old_peer: oldPeer,
        old_runtime_target: oldTarget,
        new_runtime_target: newTarget,
        old_tmux_session: oldSessionName,
        new_tmux_session: newSessionName || null,
        expected_tmux_session: expectedSession,
        allowed_tmux_session: allowedSession,
        hcc_root: stored.root,
        ...eventEvidence
      }));
    }
    return {
      oldPeer,
      oldTarget,
      newTarget,
      oldSessionName,
      newSessionName,
      oldPane: actualPane,
      expectedSession,
      allowedSession,
      hccRoot: stored.root,
      stored,
      webClientCount,
      tmuxClientCount,
      eventEvidence,
      force: Boolean(opts.force)
    };
  }

  function assertOldTmuxCanRebind(projectCtx, oldPeer, oldTarget, newTarget, actor, db = null, opts = {}) {
    return safeOldTmuxRebindPlan(projectCtx, db, oldPeer, oldTarget, newTarget, actor, opts);
  }

  function killOldTmuxForRebind(projectCtx, plan, actor, db = null) {
    if (!plan) return false;
    const {
      oldPeer,
      oldTarget,
      newTarget,
      oldSessionName,
      newSessionName,
      webClientCount,
      tmuxClientCount
    } = plan;
    const force = Boolean(plan.force);
    let latestWebClientCount = webClientCount;
    let latestTmuxClientCount = tmuxClientCount;

    try {
      latestWebClientCount = openClientCountForPane(projectCtx, oldTarget);
      let observed = observeTmuxDestructiveEvidence(projectCtx, oldTarget);
      assertTmuxDestructiveEvidence(plan.stored, observed, {
        old_peer: oldPeer,
        old_runtime_target: oldTarget,
        new_runtime_target: newTarget
      }, { allowClients: force });
      latestTmuxClientCount = observed.clients.count;
      if ((latestWebClientCount > 0 || latestTmuxClientCount > 0) && !force) {
        throw new CliError('TMUX_REBIND_OLD_SESSION_IN_USE',
          `Old tmux session ${oldSessionName} still has clients; detach clients or run ${CLI_NAME} tmux gc later.`,
          {
            old_runtime_target: oldTarget,
            new_runtime_target: newTarget,
            old_tmux_session: oldSessionName,
            web_client_count: latestWebClientCount,
            tmux_client_count: latestTmuxClientCount
          });
      }
      detachRuntimeSessionForPane(projectCtx, oldTarget, 'detached');
      observed = observeTmuxDestructiveEvidence(projectCtx, oldTarget);
      assertTmuxDestructiveEvidence(plan.stored, observed, {
        old_peer: oldPeer,
        old_runtime_target: oldTarget,
        new_runtime_target: newTarget
      }, { allowClients: force });
      conditionalTmuxKill(runTmux, plan.stored, { allowClients: force });
    } catch (err) {
      addRebindCleanupFailedEvent(projectCtx, db, actor, {
        reason: err?.code || 'cleanup_failed',
        error: err?.message || String(err),
        old_peer: oldPeer,
        old_runtime_target: oldTarget,
        new_runtime_target: newTarget,
        old_tmux_session: oldSessionName,
        new_tmux_session: newSessionName || null,
        web_client_count: latestWebClientCount,
        tmux_client_count: latestTmuxClientCount,
        ...(plan.eventEvidence || {})
      });
      throw err;
    }
    if (db) {
      addEvent(db, 'tmux.session.rebound', actor, null, auditPayload({
        actor,
        target: oldPeer,
        admin: true,
        old_peer: oldPeer,
        old_runtime_target: oldTarget,
        new_runtime_target: newTarget,
        old_tmux_session: oldSessionName,
        new_tmux_session: newSessionName || null
      }));
    }
    return true;
  }

  function providerSessionBindingMatches(a, b) {
    if (!a || !b || a.provider !== b.provider) return false;
    if (b.provider_session_id) return a.provider_session_id === b.provider_session_id;
    if (b.provider_session_name) return a.provider_session_name === b.provider_session_name;
    return false;
  }

  function attachTmuxSession(input) {
    const pctx = input.projectCtx || ctx;
    const id = input.id;
    if (!id) throw new CliError('BAD_REQUEST', 'id required');
    const actorPeer = requestActorPeer(input, id);
    const auditSource = requestSource(input, input.autoAttach ? 'runtime' : 'web');
    const info = tmuxPaneInfo(input.pane || null);
    if (info.dead) throw new CliError('TMUX_PANE_DEAD', `tmux pane is not running: ${info.pane}`);

    for (const existing of [...sessions.values()]) {
      if (existing.type === 'tmux' && existing.pane === info.pane && existing.id !== id) {
        if (!input.force) {
          throw new CliError('TMUX_PANE_IN_USE', `tmux pane ${info.pane} is already attached to ${existing.id}`, {
            pane: info.pane,
            peer: existing.id
          });
        }
        detachTmuxSession(existing, 'detached');
      }
    }

    const key = sessionKey(pctx, id);
    const existing = sessions.get(key);
    if (existing && existing.status === 'running') {
      if (existing.type === 'tmux' && existing.pane === info.pane) return existing;
      if (existing !== input.replaceSession) {
        throw new CliError('SESSION_EXISTS', `Session ${id} is already running`);
      }
    }

    const kind = inferPeerKind(id, input.kind || null, info.command);
    const role = input.role || 'peer';
    const cwd = path.resolve(input.cwd || info.cwd || pctx.root);
    const command = input.command || `tmux ${info.pane} (${info.command})`;
    const branch = detectBranch(cwd);
    const attachedEvidence = attachmentEvidenceForPane(pctx, info);
    const binding = input.binding || {};
    const nextBinding = {
      peer: id,
      provider: binding.provider || kind,
      provider_session_id: binding.provider_session_id || null,
      provider_session_name: binding.provider_session_name || null,
      resume_mode: binding.resume_mode || 'attached',
      resume_arg: binding.resume_arg || info.pane,
      command: binding.command || command,
      transport: 'tmux',
      runtime_session_id: id,
      runtime_target: info.pane
    };

    const captured = tmuxCapturePane(info.pane);
    const session = {
      id,
      peerId: id,
      actorPeer,
      auditSource,
      actionTokens: new Set(),
      root: pctx.root,
      ctx: pctx,
      kind,
      role,
      command,
      cwd,
      pid: info.pid,
      type: 'tmux',
      pane: info.pane,
      status: 'running',
      createdAt: now(),
      exitedAt: null,
      buffer: captured,
      clients: new Set(),
      streamPoller: null,
      streamFd: null,
      pipeFile: null,
      replacePoller: null,
      lastBroadcastTime: 0,
      exitPoller: null
    };
    sessions.set(key, session);
    try {
      startTmuxStream(session);
      if (!session.streamPoller && !session.replacePoller) {
        throw new CliError('TMUX_STREAM_ERROR', `Could not establish output tracking for ${info.pane}`);
      }
    } catch (err) {
      stopTmuxStream(session);
      if (sessions.get(key) === session) sessions.delete(key);
      throw err;
    }
    let rebindOldTarget = null;
    let rebindOldPeer = null;
    let rebindOldPlan = null;
    let rebindOldBindingSubject = null;

    // Detect pane death (retry 3 times before detaching — handles Ctrl+C transient states)
    let deadCount = 0;
    session.exitPoller = setInterval(() => {
      try {
        const fresh = tmuxPaneInfo(session.pane);
        if (fresh.dead) {
          deadCount++;
          if (deadCount >= 3) detachTmuxSession(session, 'exited');
        } else {
          deadCount = 0;
        }
      } catch (err) {
        // sess-03: only a definitive "pane/session is gone" error counts toward
        // detach; a transient tmux failure (busy server, momentary hiccup) must
        // not detach a live session after 3 attempts.
        const message = err?.code === 'TMUX_ERROR' ? String(err.message || '') : '';
        const definitivelyGone = /can't find pane|can't find session|no server running/i.test(message);
        if (definitivelyGone) {
          deadCount++;
          if (deadCount >= 3) detachTmuxSession(session, 'exited');
        }
      }
    }, 3000);

    let db = null;
    try {
      db = connectWebProject(pctx);
      if (input.rebindOldTmux && !input.skipProviderRebindCleanup &&
          (nextBinding.provider_session_id || nextBinding.provider_session_name)) {
        const existingPeerBinding = db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get(id);
        const conflictBinding = findProviderSessionBinding(db, nextBinding);
        const oldBinding = [existingPeerBinding, conflictBinding]
          .filter((row) => providerSessionBindingMatches(row, nextBinding))
          .find((row) => row?.transport === 'tmux' && row.runtime_target && row.runtime_target !== info.pane);
        if (oldBinding) {
          rebindOldTarget = oldBinding.runtime_target;
          rebindOldPeer = oldBinding.peer;
          rebindOldBindingSubject = { ...oldBinding };
          rebindOldPlan = assertOldTmuxCanRebind(pctx, rebindOldPeer, rebindOldTarget, info.pane, id, db, {
            force: Boolean(input.providerForce)
          });
        }
      }
      tx(db, () => {
        if (rebindOldBindingSubject) {
          const currentOldBinding = db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get(rebindOldPeer);
          if (JSON.stringify(currentOldBinding || null) !== JSON.stringify(rebindOldBindingSubject)) {
            throw new CliError('SUBJECT_CHANGED', 'tmux rebind binding changed during evidence validation', {
              retryable: true,
              old_peer: rebindOldPeer
            });
          }
        }
        upsertPeer(db, {
          id,
          kind,
          role,
          worktree: cwd,
          branch,
          pid: info.pid,
          processIdentity: attachedEvidence.process_identity,
          status: 'running',
          capabilities: 'tmux'
        });
        const providerForce = Boolean(input.providerForce);
        const canonical = upsertCanonicalPeerBinding(db, nextBinding, providerForce, {
          override: Boolean(input.rebindOldTmux && providerForce)
        });
        session.peerId = canonical.peer;
        session.binding = { ...canonical.binding };
        addEvent(db, 'tmux.session.attached', actorPeer, null, auditPayload({
          actor: actorPeer,
          target: session.peerId || id,
          source: auditSource,
          admin: actorPeer !== (session.peerId || id),
          pane: info.pane,
          command,
          cwd,
          pid: info.pid,
          tmux_session: attachedEvidence.session,
          tmux_session_created: attachedEvidence.session_created,
          tmux_session_id: attachedEvidence.session_id,
          hcc_root: attachedEvidence.root,
          process_identity: attachedEvidence.process_identity
        }));
      });
    } catch (err) {
      stopTmuxStream(session);
      if (session.exitPoller) { clearInterval(session.exitPoller); session.exitPoller = null; }
      if (sessions.get(key) === session) sessions.delete(key);
      throw err;
    } finally {
      try { db?.close(); } catch {}
    }
    if (rebindOldTarget) {
      try {
        const eventDb = connectWebProject(pctx);
        try {
          killOldTmuxForRebind(pctx, rebindOldPlan, session.peerId || id, eventDb);
          if (rebindOldPeer && rebindOldPeer !== id) {
            const actor = actorPeer || session.peerId || id;
            addEvent(eventDb, 'provider.session.rebound', actor, null, auditPayload({
              actor,
              target: rebindOldPeer,
              source: auditSource,
              admin: true,
              from_peer: rebindOldPeer,
              to_peer: id,
              old_runtime_target: rebindOldTarget,
              new_runtime_target: info.pane
            }));
          }
        } finally {
          eventDb.close();
        }
      } catch (err) {
        session.warning = {
          code: err?.code || 'TMUX_REBIND_CLEANUP_FAILED',
          message: err?.message || String(err),
          old_peer: rebindOldPeer,
          old_runtime_target: rebindOldTarget
        };
      }
    }
    return session;
  }

  // hb-04: real terminal I/O is a liveness signal. Throttle-refresh the peer's
  // last_seen_at (~30s) so an actively-used but hook-quiet terminal is not
  // judged stale/takeover-able. Never throws — I/O hot paths stay safe.
  function refreshPeerIoHeartbeat(session) {
    try {
      const t = now();
      if (session.lastIoRefreshAt && t - session.lastIoRefreshAt < 30) return;
      session.lastIoRefreshAt = t;
      const peerId = session.peerId || session.id;
      if (!peerId) return;
      const ioDb = connectWebProject(session.ctx || ctx);
      try {
        ioDb.prepare('UPDATE peers SET last_seen_at = ? WHERE id = ?').run(t, peerId);
      } finally {
        ioDb.close();
      }
    } catch {}
  }

  function writeSessionInput(session, data) {
    if (session.type === 'external') {
      try { fs.appendFileSync(session.inFile, data); } catch {}
    } else if (session.type === 'tmux') {
      tmuxSendLiteral(session.pane, data);
      scheduleTmuxInputRefresh(session);
    } else {
      session.pty.write(data);
    }
    refreshPeerIoHeartbeat(session);
  }

  function scheduleTmuxInputRefresh(session) {
    if (session.type !== 'tmux' || !session.pane) return;
    if (session.inputRefreshTimer) return;
    session.inputRefreshTimer = setTimeout(() => {
      session.inputRefreshTimer = null;
      if (session.status === 'running') broadcast(session, { type: 'replace', data: refreshTmuxSnapshot(session) });
    }, 80);
  }

  function resizeSession(session, cols, rows) {
    if (session.type === 'external') {
      try { fs.appendFileSync(session.resizeFile, JSON.stringify({ cols, rows }) + '\n'); } catch {}
    } else if (session.type === 'tmux') {
      // Resize the tmux window to match the browser terminal so the captured
      // mirror has identical geometry — a prerequisite for accurate cursor
      // placement. Older tmux without resize-window simply keeps native size.
      session.cols = cols;
      session.rows = rows;
      try {
        if (!session.windowSizeManual) {
          runTmux(['set-window-option', '-t', session.pane, 'window-size', 'manual']);
          session.windowSizeManual = true;
        }
        runTmux(['resize-window', '-t', session.pane, '-x', String(cols), '-y', String(rows)]);
      } catch {
        // tmux too old or pane gone; keep mirroring at the native pane size.
      }
    } else if (session.pty) {
      session.pty.resize(cols, rows);
    }
  }

  function startTmuxManagedSession(input) {
    ensureTmuxAvailable({ autoInstall: false });
    const pctx = input.projectCtx || ctx;
    const kind = input.kind || 'shell';
    const id = input.id || nextProjectSessionId(pctx, kind);
    const actorPeer = requestActorPeer(input, id);
    const auditSource = requestSource(input, 'web');
    const role = input.role || 'peer';
    const command = input.command || defaultSessionCommand(kind);
    const cwd = path.resolve(input.cwd || pctx.root);
    const sessionName = tmuxManagedSessionName(pctx, id);
    let paneTarget = `${sessionName}:0.0`;
    const callerEnv = input.env && typeof input.env === 'object' ? input.env : process.env;
    const env = childSessionEnv({
      HCC_PEER: id,
      HCC_ROOT: pctx.root,
      HCC_DB: pctx.dbPath,
      TERM: 'xterm-256color'
    }, callerEnv);
    env[LAUNCH_FINGERPRINT_ENV] = launchFingerprint({ command, cwd, env });
    let hasSession = tmuxHasSession(sessionName);
    const relaunchableProvider = isRelaunchableProviderSession(kind, command, input.binding || {});
    const oldTmuxTargetsForRebind = [];
    const parkedOldTmuxSessions = [];
    let createdTmuxSession = false;
    let pendingOldSession = null;
    let pendingRestartAudit = null;

    function restoreParkedOldTmuxSessions() {
      const failures = [];
      const quarantined = [];
      for (const parked of [...parkedOldTmuxSessions].reverse()) {
        if (!tmuxHasSession(parked.parkedName)) {
          failures.push(`parked session missing: ${parked.parkedName}`);
          continue;
        }
        let quarantineName = null;
        if (tmuxHasSession(parked.originalName)) {
          quarantineName = `hcc-rollback-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
          try {
            runTmux(['rename-session', '-t', parked.originalName, quarantineName]);
          } catch (err) {
            failures.push(`could not quarantine failed replacement ${parked.originalName}: ${err?.message || err}`);
            continue;
          }
        }
        try {
          runTmux(['rename-session', '-t', parked.parkedName, parked.originalName]);
        } catch (err) {
          failures.push(`could not restore ${parked.parkedName} to ${parked.originalName}: ${err?.message || err}`);
          if (quarantineName && !tmuxHasSession(parked.originalName)) {
            try { runTmux(['rename-session', '-t', quarantineName, parked.originalName]); } catch {}
          }
          continue;
        }
        if (quarantineName) {
          try { tmuxKillSession(quarantineName); } catch { quarantined.push(quarantineName); }
        }
      }
      return { failures, quarantined };
    }

    function restartExistingTmuxSession(reason) {
      const existing = getSession(pctx, id);
      const hasWebClients = hasOpenClients(existing);
      const hasTmuxClients = tmuxSessionHasClients(sessionName);
      if (hasWebClients || hasTmuxClients) {
        const isEnvChange = reason === 'launch_environment_changed';
        throw new CliError(
          isEnvChange ? 'SESSION_ENV_CHANGED' : 'SESSION_IN_USE',
          isEnvChange
            ? `Session ${id} is already running with a different launch environment. Detach/close existing clients or run ${CLI_NAME} peer stop ${id}, then start it again.`
            : `Session ${id} is still attached. Detach/close existing clients or run ${CLI_NAME} peer stop ${id}, then start it again.`,
          {
            peer: id,
            tmux_session: sessionName,
            reason
          });
      }
      let oldTarget = null;
      try {
        oldTarget = tmuxPaneInfo(paneTarget).pane;
      } catch {}
      if (!oldTarget) {
        throw new CliError('TMUX_DESTRUCTIVE_EVIDENCE_INVALID',
          'Refusing destructive tmux restart: pane target could not be resolved', {
            peer: id,
            tmux_session: sessionName,
            reason
          });
      }
      const authorityDb = connectWebProject(pctx);
      let storedAuthority;
      let bindingPreparation;
      try {
        storedAuthority = tmuxAttachmentEvidence(authorityDb, id, oldTarget);
        assertTmuxDestructiveEvidence(
          storedAuthority,
          observeTmuxDestructiveEvidence(pctx, oldTarget),
          { peer: id, tmux_session: sessionName, reason }
        );
        // The liveness reaper may have safely detached a dead provider while
        // leaving its fallback tmux shell alive. Restore only that null binding
        // after immutable tmux authority is verified so the rebind CAS can
        // distinguish recovery from a foreign target change.
        bindingPreparation = prepareTmuxRestartBinding(authorityDb, {
          peer: id,
          runtimeTarget: oldTarget,
          nowSec: now()
        });
        if (!bindingPreparation.ok) {
          throw new CliError('TMUX_REBIND_OLD_TARGET_CHANGED',
            `tmux runtime target for ${id} changed before provider restart`, {
              peer: id,
              expected_runtime_target: oldTarget,
              reason: bindingPreparation.reason
            });
        }
      } finally {
        authorityDb.close();
      }
      const parkedName = `${sessionName}-old-${Date.now().toString(36)}`.slice(0, 80);
      try {
        conditionalTmuxRename(runTmux, storedAuthority, parkedName);
      } catch (err) {
        let bindingRolledBack = true;
        if (bindingPreparation?.restored) {
          const rollbackDb = connectWebProject(pctx);
          try {
            bindingRolledBack = rollbackTmuxRestartBinding(rollbackDb, bindingPreparation);
          } finally {
            rollbackDb.close();
          }
        }
        if (err instanceof CliError && err.code === 'TMUX_CONDITIONAL_RENAME_MISMATCH' && bindingRolledBack) throw err;
        throw new CliError('TMUX_REBIND_PREPARE_FAILED', `Could not park old tmux session ${sessionName} before rebind: ${err.message}`, {
          peer: id,
          tmux_session: sessionName,
          reason,
          binding_rollback_failed: !bindingRolledBack
        });
      }
      parkedOldTmuxSessions.push({ oldTarget, originalName: sessionName, parkedName });
      if (oldTarget) oldTmuxTargetsForRebind.push({ oldPeer: id, oldTarget, allowedSessionName: parkedName });
      if (existing) {
        oldTarget = oldTarget || existing.pane || null;
        // sess-06: do NOT tear down the in-memory session yet — keep it fully
        // alive until the replacement tmux session exists, so a failed restart
        // leaves the old session (stream/pollers/clients) intact.
        pendingOldSession = existing;
      }
      hasSession = false;
      pendingRestartAudit = { reason, oldTarget, parkedName };
    }

    if (hasSession && input.restartOnEnvChange) {
      const existingFingerprint = tmuxLaunchFingerprint(sessionName);
      if (existingFingerprint !== env[LAUNCH_FINGERPRINT_ENV]) {
        restartExistingTmuxSession('launch_environment_changed');
      }
    }

    if (hasSession && relaunchableProvider) {
      // G4a: HCC_PROVIDER_STATE is a tmux-env hint that can be forged from
      // inside the session. Before a destructive park-and-replace, require
      // process evidence that the provider is really gone: the pane process
      // must be dead, or have no live non-shell child (the provider wrapper
      // leaves the pane as a bare shell after the provider exits). A session
      // with a live provider child is never torn down.
      const providerState = tmuxProviderState(sessionName);
      const info = tmuxPaneInfo(paneTarget);
      const ownerDb = connectWebProject(pctx);
      let ownerEvidence;
      try {
        ownerEvidence = providerOwnerEvidenceFromDb(ownerDb, id);
      } finally {
        ownerDb.close();
      }
      const reason = providerRestartReason({
        providerState,
        ownerEvidence,
        paneCommand: info.command
      });
      if (reason) restartExistingTmuxSession(reason);
    }

    let session;
    let pane = null;
    try {
      if (!hasSession) {
        const shell = callerEnv.SHELL || process.env.SHELL || 'bash';
        const launch = shellCommand([...isolatedEnvCommandArgs(env), shell, '-c', command]);
        const tmuxEnv = {
          HCC_ROOT: pctx.root,
          HCC_DB: pctx.dbPath,
          [LAUNCH_FINGERPRINT_ENV]: env[LAUNCH_FINGERPRINT_ENV]
        };
        if (relaunchableProvider) tmuxEnv[PROVIDER_STATE_ENV] = 'starting';
        runTmux(['new-session', '-d', '-s', sessionName, '-c', cwd, ...tmuxEnvironmentArgs(tmuxEnv), launch]);
        createdTmuxSession = true;
      }

      pane = tmuxPaneInfo(paneTarget).pane;
      for (const oldInfo of oldTmuxTargetsForRebind) {
        const eventDb = connectWebProject(pctx);
        try {
          oldInfo.plan = assertOldTmuxCanRebind(pctx, oldInfo.oldPeer, oldInfo.oldTarget, pane, id, eventDb, {
            force: Boolean(input.providerForce),
            allowedSessionName: oldInfo.allowedSessionName || null
          });
        } finally {
          eventDb.close();
        }
      }
      session = attachTmuxSession({
        ...input,
        id,
        kind,
        role,
        cwd,
        command,
        pane,
        projectCtx: pctx,
        binding: {
          ...(input.binding || {}),
          command: input.binding?.command || command,
          transport: 'tmux',
          runtime_session_id: id,
          runtime_target: pane
        },
        providerForce: Boolean(input.providerForce),
        rebindOldTmux: true,
        skipProviderRebindCleanup: oldTmuxTargetsForRebind.length > 0,
        replaceSession: pendingOldSession,
        force: true
      });
    } catch (err) {
      if (createdTmuxSession) {
        try { tmuxKillSession(sessionName); } catch {}
      }
      const rollback = restoreParkedOldTmuxSessions();
      // attachTmuxSession removes a failed candidate from the map. Restore the
      // parked session, whose stream/pollers/clients were deliberately kept
      // alive until the replacement completed its DB transaction.
      if (pendingOldSession && rollback.failures.length === 0) {
        sessions.set(sessionKey(pctx, pendingOldSession.id), pendingOldSession);
      }
      if (pendingRestartAudit) {
        try {
          const eventDb = connectWebProject(pctx);
          try {
            addEvent(eventDb, 'tmux.session.restart_failed', actorPeer, null, auditPayload({
              actor: actorPeer,
              target: id,
              source: auditSource,
              admin: true,
              reason: pendingRestartAudit.reason,
              old_runtime_target: pendingRestartAudit.oldTarget,
              old_tmux_session: pendingRestartAudit.parkedName,
              error: err?.message || String(err),
              rollback_failures: rollback.failures,
              quarantined_sessions: rollback.quarantined
            }));
          } finally {
            eventDb.close();
          }
        } catch {}
      }
      pendingOldSession = null;
      if (rollback.failures.length) {
        throw new CliError('TMUX_RESTART_ROLLBACK_FAILED', `Session ${id} restart failed and the previous tmux session could not be restored`, {
          peer: id,
          original_error: err?.message || String(err),
          rollback_failures: rollback.failures,
          quarantined_sessions: rollback.quarantined
        });
      }
      throw err;
    }
    if (pendingRestartAudit) {
      try {
        const eventDb = connectWebProject(pctx);
        try {
          addEvent(eventDb, 'tmux.session.restarted', actorPeer, null, auditPayload({
            actor: actorPeer,
            target: id,
            source: auditSource,
            admin: true,
            reason: pendingRestartAudit.reason,
            old_runtime_target: pendingRestartAudit.oldTarget,
            old_tmux_session: pendingRestartAudit.parkedName,
            new_runtime_target: pane
          }));
        } finally {
          eventDb.close();
        }
      } catch {}
    }
    if (pendingOldSession) {
      stopTmuxStream(pendingOldSession);
      if (pendingOldSession.exitPoller) { clearInterval(pendingOldSession.exitPoller); pendingOldSession.exitPoller = null; }
      pendingOldSession.status = 'detached';
      pendingOldSession.exitedAt = now();
      pendingOldSession = null;
    }
    for (const oldInfo of oldTmuxTargetsForRebind) {
      try {
        const eventDb = connectWebProject(pctx);
        try {
          killOldTmuxForRebind(pctx, oldInfo.plan, actorPeer, eventDb);
        } finally {
          eventDb.close();
        }
      } catch (err) {
        session.warning = {
          code: err?.code || 'TMUX_REBIND_CLEANUP_FAILED',
          message: err?.message || String(err),
          old_peer: oldInfo.oldPeer,
          old_runtime_target: oldInfo.oldTarget
        };
      }
    }
    return session;
  }

  function restoreTmuxManagedSessions(projectCtx = ctx) {
    const db = connectWebProject(projectCtx);
    let rows = [];
    try {
      rows = db.prepare(`
        SELECT p.id, p.kind, p.role, p.status, p.worktree, p.pid,
               p.pid_start_token, p.pid_command_hash, b.command, b.runtime_target,
               b.provider, b.provider_session_id, b.provider_session_name,
               b.resume_mode, b.resume_arg
        FROM peers p
        JOIN peer_bindings b ON b.peer = p.id
        WHERE b.transport = 'tmux' AND b.runtime_target IS NOT NULL
        ORDER BY p.last_seen_at DESC
        LIMIT 100
      `).all();
    } finally {
      db.close();
    }
    for (const row of rows) {
      // Do not re-adopt a pane by its stored id without confirming it still
      // belongs to THIS peer's managed tmux session. tmux pane ids (%N) are
      // recycled across a tmux server restart, so a stale runtime_target can
      // point at an unrelated local pane (e.g. the user's editor) and stream its
      // content + inject keystrokes (sess-01). Apply the same ownership checks
      // the GC/kill paths already use.
      const evidence = observePeerEvidence(projectCtx, row, row);
      if (evidence.state !== 'live') {
        // Unknown evidence (including parser/permission/root mismatch) is kept
        // intact. Only jointly confirmed dead tmux/process evidence is stale.
        if (evidence.state !== 'dead') continue;
        try {
          const db2 = connectWebProject(projectCtx);
          try {
            db2.prepare('UPDATE peer_bindings SET runtime_target = NULL, updated_at = ? WHERE peer = ?').run(now(), row.id);
          } finally { db2.close(); }
        } catch {}
        continue;
      }
      try {
        attachTmuxSession({
          id: row.id,
          kind: row.kind,
          role: row.role || 'peer',
          cwd: row.worktree || projectCtx.root,
          command: row.command || null,
          pane: row.runtime_target,
          projectCtx,
          force: true,
          auditActorPeer: 'web-runtime',
          auditSource: 'runtime',
          binding: {
            provider: row.provider,
            provider_session_id: row.provider_session_id,
            provider_session_name: row.provider_session_name,
            resume_mode: row.resume_mode,
            resume_arg: row.resume_arg,
            command: row.command,
            transport: 'tmux',
            runtime_session_id: row.id,
            runtime_target: row.runtime_target
          }
        });
      } catch {}
    }
    // The fast path above only re-adopts bindings whose runtime_target is still
    // set. Also sweep by session name so sessions left alive with a cleared
    // runtime_target (default Stop = detach-without-kill) are recovered.
    reAdoptOrphanManagedTmuxSessions(projectCtx);
  }

  // tmux is the source of truth for managed sessions. Re-adopt any live
  // `hcc-<hash(root)>-*` session this runtime is not already tracking, so a
  // session left alive by a detach-without-kill or across a runtime restart
  // stays visible + re-enterable. Returns the set of peerIds that currently own
  // a live managed tmux session (used by the dead-peer reaper).
  function reAdoptOrphanManagedTmuxSessions(projectCtx = ctx) {
    const live = new Set();
    let names;
    try {
      names = tmuxListSessionNames().filter((name) => isProjectManagedTmuxSession(
        projectCtx,
        name,
        tmuxSessionEnvironmentValue(name, 'HCC_ROOT')
      ));
    } catch {
      return live;
    }
    if (!names.length) return live;

    // Capture known peers and their stored process evidence so a detached
    // session is only re-adopted after root, exact name, and identity agree.
    const bindingByPeer = new Map();
    try {
      const db = connectWebProject(projectCtx);
      try {
        for (const row of db.prepare(`
          SELECT p.id, p.status, p.pid, p.pid_start_token, p.pid_command_hash,
                 b.provider, b.provider_session_id, b.provider_session_name,
                 b.resume_mode, b.resume_arg, b.command, b.runtime_target
          FROM peers p
          LEFT JOIN peer_bindings b ON b.peer = p.id
        `).all()) {
          bindingByPeer.set(row.id, row);
        }
      } finally {
        db.close();
      }
    } catch {
      return live;
    }

    const tracked = new Set(
      sessionsForProject(projectCtx)
        .filter((session) => session.status === 'running' && session.type === 'tmux')
        .map((session) => session.id)
    );

    for (const name of names) {
      // Ownership: the session's HCC_ROOT env must match this project root.
      const hccRoot = tmuxSessionEnvironmentValue(name, 'HCC_ROOT');
      if (rootEvidence(projectCtx.root, hccRoot).state !== 'match') continue;

      let info;
      try { info = tmuxPaneInfo(`${name}:0.0`); } catch { continue; }
      if (!info || info.dead) continue;

      const candidates = [...bindingByPeer.entries()].filter(([peerId, binding]) => {
        if (!tmuxManagedSessionNameMatches(projectCtx, name, peerId, hccRoot)) return false;
        return observePeerEvidence(projectCtx, binding, {
          transport: 'tmux',
          runtime_target: info.pane
        }).state === 'live';
      });
      if (candidates.length !== 1) continue;
      const [[peerId, b]] = candidates;
      live.add(peerId);
      if (tracked.has(peerId)) continue;
      const binding = b ? {
        provider: b.provider,
        provider_session_id: b.provider_session_id,
        provider_session_name: b.provider_session_name,
        resume_mode: b.resume_mode,
        resume_arg: b.resume_arg,
        command: b.command,
        transport: 'tmux',
        runtime_session_id: peerId,
        runtime_target: info.pane
      } : null;

      try {
        attachTmuxSession({
          id: peerId,
          pane: info.pane,
          cwd: info.cwd || projectCtx.root,
          command: b?.command || null,
          projectCtx,
          force: false,
          autoAttach: true,
          auditActorPeer: 'web-runtime',
          auditSource: 'runtime',
          binding
        });
      } catch {}
    }
    return live;
  }

  // Mark dead or grace-expired unknown peers as exited so crashed/killed
  // sessions stop lingering as running. This path only detaches DB state.
  function reapDeadPeersForProject(projectCtx, liveManagedPeerIds, db) {
    let rows;
    try {
      rows = db.prepare(`
        SELECT p.id, p.status, p.pid, p.pid_start_token, p.pid_command_hash,
               p.last_seen_at,
               b.transport, b.runtime_target
        FROM peers p
        LEFT JOIN peer_bindings b ON b.peer = p.id
        WHERE p.status IN ('running', 'working', 'busy')
      `).all();
    } catch {
      return;
    }
    if (!rows.length) return;
    const observedAt = now();
    const evidenceByPeer = new Map(rows.map((row) => [
      row.id,
      observePeerEvidence(projectCtx, row, row)
    ]));
    let clockObservation;
    try {
      clockObservation = observeClockSafetyOrThrow(db, {
        operation: 'ownership',
        candidates: rows.map((row) => ({
          boundary: Math.max(0, Number(row.last_seen_at || 0) + UNKNOWN_EVIDENCE_GRACE_SEC),
          evidence: evidenceByPeer.get(row.id)?.state || 'unknown',
          owner: row.id
        })),
        nowSec: observedAt
      });
    } catch {
      return;
    }
    for (const row of rows) {
      if (liveManagedPeerIds.has(row.id)) continue;
      const evidence = evidenceByPeer.get(row.id) || { state: 'unknown' };
      if (!peerEvidenceAllowsReap(evidence, {
        nowSec: observedAt,
        lastSeenAt: Number(row.last_seen_at || 0),
        staleAfterSec: UNKNOWN_EVIDENCE_GRACE_SEC,
        graceUntil: clockObservation.graceUntil
      })) continue;
      try {
        mutatePeerWithEvidence(db, projectCtx, row.id, (subject, currentEvidence) => {
          // Preserve last_seen_at (see detachTmuxSession) — only flip status.
          db.prepare('UPDATE peers SET status = ? WHERE id = ?').run('exited', row.id);
          db.prepare('UPDATE peer_bindings SET runtime_target = NULL, updated_at = ? WHERE peer = ?').run(now(), row.id);
          addEvent(db, 'peer.reaped', 'web-runtime', null, auditPayload({
            actor: 'web-runtime',
            target: row.id,
            source: 'runtime',
            peer: row.id,
            pid: subject.peer.pid,
            reason: currentEvidence.reason
          }));
        }, {
          acceptEvidence: (currentEvidence, subject) => peerEvidenceAllowsReap(currentEvidence, {
            nowSec: now(),
            lastSeenAt: Number(subject.peer.last_seen_at || 0),
            staleAfterSec: UNKNOWN_EVIDENCE_GRACE_SEC,
            graceUntil: readClockGraceUntil(db)
          }),
          beforeMutate: ({ subject, evidence: currentEvidence }) => peerEvidenceAllowsReap(currentEvidence, {
            nowSec: now(),
            lastSeenAt: Number(subject.peer.last_seen_at || 0),
            staleAfterSec: UNKNOWN_EVIDENCE_GRACE_SEC,
            graceUntil: readClockGraceUntil(db)
          })
        });
      } catch {}
    }
  }

  return {
    detachTmuxSession, tmuxSessionNameForPane, detachRuntimeSessionForPane,
    openClientCountForPane, tmuxClientObservation,
    observeTmuxDestructiveEvidence, tmuxAttachmentEvidence,
    assertTmuxDestructiveEvidence, attachmentEvidenceForPane,
    oldTmuxEventEvidence, addRebindCleanupFailedEvent, oldTmuxRebindTarget,
    tmuxSessionClientCountForStop, safeTmuxKillPlan, executeTmuxKillPlan,
    killDbProvenTmuxSession, safeOldTmuxRebindPlan, assertOldTmuxCanRebind,
    killOldTmuxForRebind, providerSessionBindingMatches, attachTmuxSession,
    refreshPeerIoHeartbeat, writeSessionInput, scheduleTmuxInputRefresh,
    resizeSession, startTmuxManagedSession, restoreTmuxManagedSessions,
    reAdoptOrphanManagedTmuxSessions, reapDeadPeersForProject
  };
}
