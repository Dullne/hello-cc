// The web runtime main entry, extracted whole from bin/hcc.mjs.
// cmdWeb is one ~3100-line closure: 64 sibling functions share the sessions/
// projectContexts/buffer state maps. It moves as a unit; every module-scope
// dependency is injected via createWebRuntime(deps).

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { URL } from 'node:url';
import { publicCliFailure } from '../shared/errors.mjs';
import { CliError } from '../shared/errors.mjs';
import { tx } from '../db/schema.mjs';
import { intOpt, parseOpts, required, validateOpts } from '../cli-args.mjs';
import { packageRoot } from '../cli-runtime.mjs';
import { createCoordinationState } from '../coordination-state.mjs';
import { shellQuoteArg } from '../format.mjs';
import {
  CLOCK_GRACE_SEC,
  classifyClockDrift,
  clockGraceSuppressed,
  readClockGraceUntil
} from '../shared/clock-grace.mjs';
import {
  clockSafetyUnavailable,
  observeClockSafetyInTransaction
} from '../core/coordination/clock-safety.mjs';
import { peerEvidenceAllowsReap } from '../core/peers/evidence.mjs';
import {
  conditionalTmuxKill,
  conditionalTmuxRename,
  prepareTmuxRestartBinding,
  rollbackTmuxRestartBinding,
  validateTmuxDestructiveEvidence
} from '../core/peers/tmux-safety.mjs';
import {
  LAUNCH_FINGERPRINT_ENV,
  PROVIDER_STATE_ENV,
  WEB_CHILD_ENV,
  childSessionEnv,
  isRelaunchableProviderSession,
  isolatedEnvCommandArgs,
  launchFingerprint,
  providerRestartReason
} from '../core/sessions/launch.mjs';
import { providerSessionPeerId } from '../core/peers/session.mjs';
import { reconcileRunningPeerBindings } from '../core/peers/reconcile.mjs';
import {
  buildPeerCommand,
  defaultSessionCommand,
  hasResumeOpts,
  inferPeerKind
} from '../integrations/providers.mjs';
import { inspectProviderProcess } from '../integrations/peers/processes.mjs';
import {
  projectRecord,
  readProjectRegistry,
  registerProject,
  registerProjectActivity
} from '../runtime/projects.mjs';
import { resolveProjectDatabase } from '../runtime/project-path.mjs';
import { contextForProject } from '../runtime/paths.mjs';
import {
  clearRuntime,
  writeGlobalRuntime,
  writeRuntime
} from '../runtime/state.mjs';
import { createFatalShutdownController } from '../runtime/fatal-shutdown.mjs';
import { collectBufferEvidence, externalBufferEvidence, externalBufferOwnerKey, externalBufferSessionIds, readExternalBufferMetadata } from '../runtime/buffer-evidence.mjs';
import { withBufferDirectoryLease } from '../runtime/buffer-directory-lease.mjs';
import { applyClockSafeBufferPlan, createBufferGcPlanStore } from '../runtime/buffer-gc-protocol.mjs';
import { bufferPlanGcCutoffs, planBufferFiles } from '../runtime/buffer-gc.mjs';
import { detectBranch } from '../project-context.mjs';
import { normalizeStateResources } from '../ui/state-render.mjs';
import { positiveIntOpt } from '../task-cli.mjs';
import {
  expectedWebHost,
  isLoopbackHost,
  listenServer,
  makeWebToken,
  nextSessionId,
  publicRuntimeUrl,
  requestUrl,
  runtimeBaseUrl,
  validateWebTokenOpts
} from '../web/runtime.mjs';
import {
  authOk,
  readJsonRequest,
  requestIsSecure,
  requestMatchesProxyOrigin,
  requestOriginMatches,
  sendFile,
  sendJson,
  tokenMatches
} from '../web/http.mjs';
import {
  API_VERSION,
  apiVersionUnsupportedBody,
  readHttpApiVersion,
  readWebSocketApiVersion
} from '../web/api-version.mjs';
import { ensureSelfSignedCert } from '../web/tls.mjs';
import * as webUiTemplate from '../web/ui-template.mjs';
import { createWebPeerActions } from '../web/peer-actions.mjs';
import { createCookieAuth } from '../web/cookie-auth.mjs';
import { createProjectContexts } from '../web/project-contexts.mjs';
import { createExternalSessions } from '../web/external-sessions.mjs';
import { createLivenessReaper } from '../web/liveness-reaper.mjs';
import { createBufferGcRuntime } from '../web/buffer-gc-runtime.mjs';
import { createSessionSerialize } from '../web/session-serialize.mjs';
import { createTmuxStream } from '../web/tmux-stream.mjs';
import {
  ensureTmuxAvailable,
  runTmux,
  tmuxCapturePane,
  tmuxEnvironmentArgs,
  tmuxHasSession,
  tmuxKillSession,
  tmuxLaunchFingerprint,
  tmuxListSessionNames,
  tmuxManagedSessionName,
  tmuxManagedSessionNameMatches,
  tmuxPaneInfo,
  tmuxProviderState,
  tmuxSendLiteral,
  tmuxSessionEnvironmentValue,
  tmuxSessionHasClients
} from '../tmux.mjs';
import { inspectProcessIdentity, waitForLiveProcessIdentity } from '../process/identity.mjs';

export function createWebRuntime(deps) {
  const {
    // constants
    ACTIVE_PEER_TTL, BUFS_DIR_NAME, CLI_NAME, DEFAULT_LOCK_TTL,
    DETECTED_PEER_MAX_AGE, PRODUCT_NAME, UNKNOWN_EVIDENCE_GRACE_SEC, VERSION,
    // db helpers
    connect, addEvent, auditPayload,
    // peer helpers
    touchPeer, upsertPeer, upsertCanonicalPeerBinding,
    // coordination state
    assertTaskOwnerForMutation, claimNextTasksForPeer,
    queryInbox, queryOpenTasks, queryTimelineMessages,
    requestActorPeer, requestSource, sendMessage,
    statusSnapshot, statusSummary, takeOverTaskForPeer,
    webPeerAction,
    // evidence runtime
    canonicalRoot, isProjectManagedTmuxSession, liveProcessIdentity,
    mutatePeerWithEvidence, observeClockSafetyOrThrow, observePeerEvidence,
    peerEvidenceFromDb, providerOwnerEvidenceFromDb, rootEvidence,
    // tmux evidence helpers
    strictTmuxClientObservation, tmuxAttachmentAuthority,
    tmuxPaneForTarget, tmuxSessionCreationToken, tmuxSessionId,
    // gc helpers
    bufferDirectory, runGc,
    // web startup helpers
    assertWebTokenForHost, proxyOriginForOpts, startWebBackground,
    webExposureWarning, webSocketOriginAllowed,
    // local bus
    prepareLocalBus,
    // misc bin-local helpers
    findProviderSessionBinding, helpWeb, latestHookProviderSession,
    now, redactedLogText, renderWebIndex, renderWebLogin,
    sameResolvedPath, sendWebHtml, shellCommand, webErrorStatus
  } = deps;

async function cmdWeb(ctx, args, startMeta = {}) {
  if (args[0] === '--help' || args[0] === '-h') return helpWeb();
  if (process.env[WEB_CHILD_ENV] !== '1') return startWebBackground(ctx, args);
  const runtimeIdentity = await waitForLiveProcessIdentity(process.pid, { timeoutMs: 1_000 });
  if (runtimeIdentity.state !== 'live' || !runtimeIdentity.identity) {
    throw new CliError(
      'RUNTIME_IDENTITY_UNAVAILABLE',
      'Unable to verify the web runtime process identity; no runtime pointer was published.'
    );
  }
  const processIdentity = runtimeIdentity.identity;
  const opts = parseOpts(args, { booleans: ['local', 'no-token', 'no-guidance', 'no-discover', 'tls', 'trust-proxy'] });
  validateOpts('web', opts, ['host', 'port', 'token', 'local', 'no-token', 'no-guidance', 'no-discover', 'tls', 'trust-proxy', 'proxy-origin']);
  validateWebTokenOpts(opts);
  const host = expectedWebHost(opts);
  const port = intOpt(opts, 'port', 8787);
  const token = makeWebToken(opts);
  assertWebTokenForHost(host, Boolean(token));
  if (!isLoopbackHost(host)) console.error(redactedLogText(webExposureWarning(host, port) + (opts.tls ? '' : ' Consider --tls to encrypt this connection.')));
  const useTls = Boolean(opts.tls);
  const trustProxy = Boolean(opts['trust-proxy']);
  const proxyOrigin = proxyOriginForOpts(opts);
  const tlsCredentials = useTls ? ensureSelfSignedCert([host]) : null;
  // Browser sessions: a token printed in the URL is exchanged once for an
  // HttpOnly cookie so the token stops travelling in every fetch/WS URL
  // (net-02). The cookie carries an opaque session id (not the token); it is
  // meaningless outside this runtime and is lost on restart.
  const DEFAULT_WEB_SESSION_TTL_SEC = 30 * 24 * 60 * 60;
  const regressionWebSessionTtlRaw = process.env.HCC_REGRESSION_WEB_SESSION_TTL_SEC || '';
  const regressionWebSessionTtl = /^\d+$/.test(regressionWebSessionTtlRaw)
    ? Number.parseInt(regressionWebSessionTtlRaw, 10)
    : 0;
  const WEB_SESSION_TTL_SEC = process.env.HCC_REGRESSION_TEST === '1' &&
    regressionWebSessionTtl >= 1 && regressionWebSessionTtl <= 60
    ? regressionWebSessionTtl
    : DEFAULT_WEB_SESSION_TTL_SEC;
  const MAX_WEB_SESSIONS = 256;
  const {
    webSessions,
    parseCookieSid, closeWebSession, pruneWebSessions,
    issueSession, sessionCookieHeader, expiredSessionCookieHeader,
    cookieSessionRecord, cookieSessionOk, cookieSocketValid, webAuthMode
  } = createCookieAuth({
    now, ttlSec: WEB_SESSION_TTL_SEC, maxSessions: MAX_WEB_SESSIONS,
    requestIsSecure, trustProxy, proxyOrigin, authOk, token
  });
  const webSessionPruner = setInterval(pruneWebSessions, 60000);
  webSessionPruner.unref?.();
  ensureTmuxAvailable({ autoInstall: false });
  const ptyModule = await import('node-pty');
  const { WebSocketServer } = await import('ws');
  const pty = ptyModule.default || ptyModule;
  const sessions = new Map();

  const {
    sessionKey, sessionsForProject,
    resolveSessionPeerId, sessionBindingForSerialize,
    serializeBindingSummary, serializeSession,
    broadcast, hasOpenClients, closeSessionClients
  } = createSessionSerialize({ sessions, cookieSocketValid, ctx, sameResolvedPath });
  const { cursorEscape, tmuxSnapshot, refreshTmuxSnapshot, scheduleTmuxReplace, startTmuxReplacePoller, startTmuxStream, stopTmuxStream } = createTmuxStream({ broadcast, now, refreshPeerIoHeartbeat, bufferDirectory, withBufferDirectoryLease, shellQuoteArg, ctx });
  const prepared = await prepareLocalBus(ctx, opts);

const {
    projectContexts,
    newSessionActionToken, rememberProject, knownProjects,
    resolveWebProjectContext, connectWebProject, projectFromRequest,
    getSession, readActionToken, resolveWebActionSession,
    knownPeerIds, nextProjectSessionId
  } = createProjectContexts({
    ctx, sessions,
    sessionKey, sessionsForProject, resolveSessionPeerId,
    connect, now, addEvent, tx, touchPeer, upsertPeer, detectBranch,
    ACTIVE_PEER_TTL, CLI_NAME, DEFAULT_LOCK_TTL,
    queryInbox, queryOpenTasks, queryTimelineMessages,
    observePeerEvidence, peerEvidenceFromDb,
    observeClockSafetyInTransaction,
    assertTaskOwnerForMutation, claimNextTasksForPeer, takeOverTaskForPeer,
    positiveIntOpt, sameResolvedPath
  });

  const {
    statusSnapshot: webStatusSnapshot,
    statusSummary: webStatusSummary
  } = createCoordinationState({
    activePeerTtl: ACTIVE_PEER_TTL,
    cliName: CLI_NAME,
    connect: connectWebProject,
    defaultLockTtl: DEFAULT_LOCK_TTL,
    now,
    queryInbox,
    queryOpenTasks,
    queryTimelineMessages,
    observePeerEvidence
  });
  const {
    webPeerAction: webPeerActionForProject
  } = createWebPeerActions({
    activePeerTtl: ACTIVE_PEER_TTL,
    addEvent,
    assertTaskOwnerForMutation,
    claimNextTasksForPeer,
    connect: connectWebProject,
    defaultLockTtl: DEFAULT_LOCK_TTL,
    detectBranch,
    now,
    observeClockSafetyInTransaction,
    observePeerEvidence,
    positiveIntOpt,
    peerEvidenceFromDb,
    queryInbox,
    statusSnapshot: webStatusSnapshot,
    statusSummary: webStatusSummary,
    takeOverTaskForPeer,
    touchPeer,
    tx,
    upsertPeer
  });


  rememberProject(ctx);
  for (const project of readProjectRegistry()) {
    projectContexts.set(project.root, contextForProject(project.root, project.db, { json: ctx.json }));
  }

  // ── Auto-attach detected peers that are in tmux panes ─────────────────────
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

  const {
    reaperPoller, runtimeProjectContexts, runClockAwareReaper, detectClockJump
  } = createLivenessReaper({
    ctx, projectContexts, sessions,
    sessionsForProject, connectWebProject,
    now, addEvent,
    peerEvidenceFromDb, mutatePeerWithEvidence, observeClockSafetyOrThrow,
    UNKNOWN_EVIDENCE_GRACE_SEC, redactedLogText, sameResolvedPath
  });

  const {
    gcPoller, runAutoGc,
    collectRuntimeBufferEvidence, prepareRuntimeBufferGc, applyPreparedRuntimeBufferGc,
    runningBufferPathSnapshot, bufferGcPlanStore
  } = createBufferGcRuntime({
    sessions,
    connectWebProject, runtimeProjectContexts,
    now, runGc, bufferDirectory,
    canonicalRoot, observePeerEvidence, redactedLogText, sameResolvedPath
  });

  const {
    bufsWatchers, externalScanPoller, bufsWatcherSyncPoller,
    scanExternalSessions, adoptExternalSession, removeExternalBufferFiles
  } = createExternalSessions({
    ctx, sessions,
    sessionKey, broadcast,
    now, tx, connectWebProject,
    bufferDirectory, runtimeProjectContexts,
    refreshPeerIoHeartbeat, redactedLogText, BUFS_DIR_NAME
  });

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

  function startPtySession(input) {
    const pctx = input.projectCtx || ctx;
    const kind = input.kind || 'shell';
    const id = input.id || nextProjectSessionId(pctx, kind);
    const actorPeer = requestActorPeer(input, id);
    const auditSource = requestSource(input, 'web');
    const key = sessionKey(pctx, id);
    if (sessions.has(key) && sessions.get(key).status === 'running') {
      return sessions.get(key);
    }
    const role = input.role || 'peer';
    const command = input.command || defaultSessionCommand(kind);
    const cwd = path.resolve(input.cwd || pctx.root);
    const callerEnv = input.env && typeof input.env === 'object' ? input.env : process.env;
    const shell = callerEnv.SHELL || process.env.SHELL || 'bash';
    const env = childSessionEnv({
      HCC_PEER: id,
      HCC_ROOT: pctx.root,
      HCC_DB: pctx.dbPath,
      TERM: 'xterm-256color'
    }, callerEnv);
    const size = input.size || { cols: 100, rows: 30 };
    const child = pty.spawn(shell, ['-c', command], {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd,
      env
    });
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
      pid: child.pid,
      pty: child,
      status: 'running',
      createdAt: now(),
      exitedAt: null,
      buffer: '',
      clients: new Set()
    };
    sessions.set(key, session);
    const db = connectWebProject(pctx);
    try {
      upsertPeer(db, {
        id,
        kind,
        role,
        worktree: cwd,
        branch: detectBranch(cwd),
        pid: child.pid,
        status: 'running',
        capabilities: 'web-pty'
      });
      const canonical = upsertCanonicalPeerBinding(db, {
        peer: id,
        provider: input.binding?.provider || kind,
        provider_session_id: input.binding?.provider_session_id || null,
        provider_session_name: input.binding?.provider_session_name || null,
        resume_mode: input.binding?.resume_mode || 'new',
        resume_arg: input.binding?.resume_arg || null,
        command,
        transport: 'web-pty',
        runtime_session_id: id
      }, Boolean(input.force));
      session.peerId = canonical.peer;
      session.binding = { ...canonical.binding };
      addEvent(db, 'web.session.started', actorPeer, null, auditPayload({
        actor: actorPeer,
        target: session.peerId || id,
        source: auditSource,
        admin: actorPeer !== (session.peerId || id),
        command,
        cwd,
        pid: child.pid
      }));
    } finally {
      db.close();
    }
    child.onData((data) => {
      session.buffer += data;
      if (session.buffer.length > 250000) session.buffer = session.buffer.slice(-200000);
      broadcast(session, { type: 'data', data });
      refreshPeerIoHeartbeat(session);
    });
    child.onExit((event) => {
      session.status = 'exited';
      session.exitedAt = now();
      const db = connectWebProject(pctx);
      try {
        db.prepare('UPDATE peers SET status = ?, last_seen_at = ? WHERE id = ?').run('exited', now(), id);
        addEvent(db, 'web.session.exited', session.actorPeer || id, null, auditPayload({
          actor: session.actorPeer || id,
          target: session.peerId || id,
          source: session.auditSource || 'web',
          ...event
        }));
      } finally {
        db.close();
      }
      broadcast(session, { type: 'exit', event });
      closeSessionClients(session);
    });
    return session;
  }

  function webSessionBuildOptions(input) {
    const mode = input.mode || 'new';
    if (mode === 'new') return {};
    if (mode === 'resume') {
      const resume = String(input.resume || '').trim();
      if (!resume) throw new CliError('BAD_REQUEST', 'resume session required');
      return { resume };
    }
    if (mode === 'last') return { last: true };
    if (mode === 'continue') return { continue: true };
    throw new CliError('BAD_REQUEST', `Unsupported session mode: ${mode}`);
  }

  function webSessionPeerId(projectCtx, kind, opts, input) {
    if (input.id) return input.id;
    if (opts.resume) return providerSessionPeerId(kind, opts.resume);
    return nextProjectSessionId(projectCtx, kind);
  }

  function normalizeWebSessionInput(input) {
    const pctx = input.projectCtx || ctx;
    const kind = input.kind || 'shell';
    if (!['claude', 'codex', 'shell'].includes(kind)) {
      throw new CliError('BAD_REQUEST', `Unsupported session kind: ${kind}`);
    }
    if (input.command || input.binding) return { ...input, kind, projectCtx: pctx };

    const opts = webSessionBuildOptions(input);
    if (kind === 'shell' && hasResumeOpts(opts)) {
      throw new CliError('BAD_REQUEST', 'Resume modes are only supported for codex and claude sessions');
    }
    if (kind !== 'claude' && opts.continue) {
      throw new CliError('BAD_REQUEST', 'continue is only supported for claude sessions');
    }
    if (kind !== 'codex' && opts.last) {
      throw new CliError('BAD_REQUEST', 'last is only supported for codex sessions');
    }

    const id = webSessionPeerId(pctx, kind, opts, input);
    const built = buildPeerCommand(id, kind, opts, []);
    return {
      ...input,
      id,
      kind,
      command: built.command,
      binding: built.binding,
      projectCtx: pctx
    };
  }

  function startSession(input) {
    const normalized = normalizeWebSessionInput(input);
    if (normalized.backend === 'pty') return startPtySession(normalized);
    return startTmuxManagedSession(normalized);
  }

  const restoredTmuxDbs = new Set();
  for (const projectCtx of runtimeProjectContexts()) {
    const dbKey = path.resolve(projectCtx.dbPath);
    if (restoredTmuxDbs.has(dbKey)) continue;
    restoredTmuxDbs.add(dbKey);
    restoreTmuxManagedSessions(projectCtx);
    reconcileRunningBindings(projectCtx);
  }
  runAutoGc();

  const handleWebRequest = async (req, res) => {
    const url = requestUrl(req);
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        const accept = req.headers.accept || '';
        const isBrowserNav = req.headers['sec-fetch-mode'] === 'navigate' || accept.includes('text/html');
        const queryToken = url.searchParams.get('token') || '';
        const hasCookie = cookieSessionOk(req);
        // Browser navigation with a valid ?token → exchange it for a session
        // cookie and redirect to the bare URL (strips the token from the
        // address bar). API-style fetches (Accept: */*) still get the HTML
        // directly so existing CLI/test callers are unaffected.
        if (isBrowserNav && queryToken && token && tokenMatches(queryToken, token)) {
          if (trustProxy && !requestMatchesProxyOrigin(req, { trustProxy, proxyOrigin })) {
            sendJson(res, 403, { ok: false, error: { code: 'PROXY_ORIGIN_MISMATCH', message: 'Trusted proxy headers do not match --proxy-origin' } });
            return;
          }
          const sid = issueSession();
          const params = new URLSearchParams();
          for (const key of ['project', 'root']) {
            const value = url.searchParams.get(key);
            if (value) params.set(key, value);
          }
          const location = '/' + (params.toString() ? `?${params}` : '');
          res.writeHead(302, { Location: location, 'Set-Cookie': sessionCookieHeader(sid, req) });
          res.end();
          return;
        }
        // Browser navigation with no credential at all → login page (bare-URL
        // fallback, e.g. a bookmarked URL after the runtime restarted).
        if (isBrowserNav && !hasCookie && !queryToken && token) {
          sendWebHtml(res, renderWebLogin);
          return;
        }
        sendWebHtml(res, renderWebIndex);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/assets/xterm.js') {
        sendFile(res, path.join(packageRoot(), 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'), 'application/javascript; charset=utf-8');
        return;
      }
      if (req.method === 'GET' && url.pathname === '/assets/xterm.css') {
        sendFile(res, path.join(packageRoot(), 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), 'text/css; charset=utf-8');
        return;
      }
      if (req.method === 'POST' && url.pathname === '/login') {
        const input = await readJsonRequest(req);
        const loginToken = String(input.token || '');
        if (!token || !tokenMatches(loginToken, token)) {
          sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid token' } });
          return;
        }
        if (trustProxy && !requestMatchesProxyOrigin(req, { trustProxy, proxyOrigin })) {
          sendJson(res, 403, { ok: false, error: { code: 'PROXY_ORIGIN_MISMATCH', message: 'Trusted proxy headers do not match --proxy-origin' } });
          return;
        }
        const sid = issueSession();
        res.writeHead(302, { Location: '/', 'Set-Cookie': sessionCookieHeader(sid, req) });
        res.end();
        return;
      }
      if (url.pathname.startsWith('/api/') && !readHttpApiVersion(req).ok) {
        sendJson(res, 426, apiVersionUnsupportedBody());
        return;
      }
      const authMode = webAuthMode(url, req);
      if (!authMode) {
        sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });
        return;
      }
      const safeMethod = ['GET', 'HEAD', 'OPTIONS'].includes(req.method || '');
      // Cookie-authenticated writes require affirmative same-origin evidence;
      // a missing Origin is not sufficient. Token-authenticated CLI requests
      // without cookies remain origin-free, as do tokenless loopback CLI
      // requests; a supplied Origin on the tokenless runtime must still match.
      const cookieAuthenticated = authMode === 'cookie' || cookieSessionOk(req);
      const originRequired = cookieAuthenticated || (!token && Boolean(req.headers.origin));
      if (!safeMethod && originRequired && !requestOriginMatches(req, { trustProxy, proxyOrigin })) {
        sendJson(res, 403, { ok: false, error: { code: 'CSRF_ORIGIN', message: 'Cookie-authenticated writes require a same-origin request' } });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/logout') {
        const sid = parseCookieSid(req);
        if (sid) closeWebSession(sid, 'logged out');
        res.writeHead(204, { 'Set-Cookie': expiredSessionCookieHeader(req) });
        res.end();
        return;
      }
      const reqCtx = projectFromRequest(req, url);
      if (req.method === 'GET' && url.pathname === '/api/projects') {
        sendJson(res, 200, { projects: knownProjects(), current: projectRecord(reqCtx) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/projects') {
        const input = await readJsonRequest(req);
        const requestedRoot = input.root || reqCtx.root;
        const projectCtx = rememberProject(resolveWebProjectContext(
          requestedRoot,
          input.db || path.join(requestedRoot, '.hello-cc', 'mesh.db')
        ), { register: true, nonblocking: true });
        const db = connectWebProject(projectCtx);
        db.close();
        writeRuntime(projectCtx, {
          product: PRODUCT_NAME,
          version: VERSION,
          api_version: API_VERSION,
          pid: process.pid,
          ...(processIdentity ? { process_identity: processIdentity } : {}),
          root: projectCtx.root,
          db: projectCtx.dbPath,
          host,
          port: actualPort,
          base_url: runtimeBaseUrl(host, actualPort, useTls),
          token,
          tls: useTls,
          trust_proxy: trustProxy,
          proxy_origin: proxyOrigin,
          tls_cert: useTls ? tlsCredentials.cert : undefined,
          global_runtime: true,
          started_at: now()
        });
        sendJson(res, 200, { project: projectRecord(projectCtx), projects: knownProjects() });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const resources = normalizeStateResources([
          ...url.searchParams.getAll('resource'),
          url.searchParams.get('resources') || ''
        ]);
        sendJson(res, 200, webStatusSnapshot(reqCtx, url.searchParams.get('peer'), {
          resources,
          intent: url.searchParams.get('intent') || null,
          scope: url.searchParams.get('scope') || null
        }));
        return;
      }
      const peerActionMatch = url.pathname.match(/^\/api\/peers\/([^/]+)\/actions\/([^/]+)$/);
      if (peerActionMatch) {
        const peer = decodeURIComponent(peerActionMatch[1]);
        const action = decodeURIComponent(peerActionMatch[2]);
        const readOnly = ['status', 'state', 'inbox'].includes(action);
        if (readOnly && req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET for read-only peer actions' } });
          return;
        }
        if (!readOnly && req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST for mutating peer actions' } });
          return;
        }
        const input = readOnly
          ? {
              ...Object.fromEntries(url.searchParams.entries()),
              resource: url.searchParams.getAll('resource')
            }
          : await readJsonRequest(req);
        const actionInput = readOnly
          ? input
          : { ...input, actorPeer: resolveWebActionSession(reqCtx, peer, input, req) };
        sendJson(res, 200, webPeerActionForProject(reqCtx, peer, action, actionInput));
        return;
      }
      // Detected sessions: peers registered via hooks/watcher but without PTY
      if (req.method === 'GET' && url.pathname === '/api/detected') {
        const db = connectWebProject(reqCtx);
        let detected = [];
        const managedIds = new Set();
        const t = now();
        try {
          detected = db.prepare(`
            SELECT id, kind, role, status, worktree, branch, pid, capabilities,
                   created_at, last_seen_at, (? - last_seen_at) AS age_sec
            FROM peers
            WHERE status != 'exited' AND last_seen_at >= ?
            ORDER BY last_seen_at DESC, id ASC
            LIMIT 100
          `).all(t, t - DETECTED_PEER_MAX_AGE);
          for (const session of sessionsForProject(reqCtx)) {
            managedIds.add(session.id);
            const peerId = resolveSessionPeerId(db, session);
            if (peerId) managedIds.add(peerId);
          }
        } finally {
          db.close();
        }
        // Exclude peers that are already in the managed sessions Map
        sendJson(res, 200, {
          now: t,
          active_peer_ttl: ACTIVE_PEER_TTL,
          detected: detected.filter(p => !managedIds.has(p.id))
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/resumable') {
        // Provider sessions hcc has seen (via hooks/detection) that carry a real
        // provider session id or resumable provider session name.
        const db = connectWebProject(reqCtx);
        let rows = [];
        try {
          rows = db.prepare(`
            SELECT b.provider, b.provider_session_id, b.provider_session_name, b.peer,
                   p.last_seen_at
            FROM peer_bindings b
            LEFT JOIN peers p ON p.id = b.peer
            WHERE (b.provider_session_id IS NOT NULL AND b.provider_session_id != '')
               OR (b.provider_session_name IS NOT NULL AND b.provider_session_name != '')
            ORDER BY p.last_seen_at DESC, b.updated_at DESC
          `).all();
        } finally {
          db.close();
        }
        const seen = new Set();
        const resumable = [];
        for (const r of rows) {
          const resumeValue = r.provider_session_id || r.provider_session_name || '';
          if (!resumeValue) continue;
          const key = `${r.provider}:${resumeValue}`;
          if (seen.has(key)) continue;
          seen.add(key);
          resumable.push({
            provider: r.provider,
            session_id: r.provider_session_id,
            session_name: r.provider_session_name || null,
            resume: resumeValue,
            name: r.provider_session_name || null,
            peer: r.peer
          });
        }
        sendJson(res, 200, { resumable });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/runtime') {
        sendJson(res, 200, {
          product: PRODUCT_NAME,
          version: VERSION,
          api_version: API_VERSION,
          pid: process.pid,
          ...(processIdentity ? { process_identity: processIdentity } : {}),
          root: reqCtx.root,
          db: reqCtx.dbPath,
          projects: knownProjects(),
          sessions: sessionsForProject(reqCtx).length
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/runtime/gc-buffers') {
        const input = await readJsonRequest(req);
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw new CliError('BAD_REQUEST', 'buffer GC request must be an object');
        }
        if (input.phase === 'prepare') {
          const allowed = new Set(['phase', 'retentionSec', 'dryRun']);
          if (Object.keys(input).some((key) => !allowed.has(key))) {
            throw new CliError('BAD_REQUEST', 'buffer GC prepare contains unsupported fields');
          }
          if (typeof input.dryRun !== 'boolean') {
            throw new CliError('BAD_REQUEST', 'dryRun must be a boolean');
          }
          if (!Number.isSafeInteger(input.retentionSec) || input.retentionSec < 0 ||
              Object.is(input.retentionSec, -0) ||
              !Number.isSafeInteger(input.retentionSec * 1000)) {
            throw new CliError('BAD_REQUEST', 'retentionSec must be a canonical non-negative safe integer');
          }
          sendJson(res, 200, prepareRuntimeBufferGc(reqCtx, input));
          return;
        }
        if (input.phase === 'apply') {
          const allowed = new Set(['phase', 'token']);
          if (Object.keys(input).some((key) => !allowed.has(key)) ||
              typeof input.token !== 'string' || input.token.length === 0) {
            throw new CliError('BAD_REQUEST', 'buffer GC apply requires only its token');
          }
          sendJson(res, 200, applyPreparedRuntimeBufferGc(reqCtx, input.token));
          return;
        }
        throw new CliError('BAD_REQUEST', 'buffer GC phase must be prepare or apply');
      }
      if (req.method === 'POST' && url.pathname === '/api/runtime/stop') {
        sendJson(res, 200, { ok: true, pid: process.pid });
        setTimeout(shutdown, 10);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        const db = connectWebProject(reqCtx);
        try {
          sendJson(res, 200, {
            sessions: sessionsForProject(reqCtx).map((session) => serializeSession(session, db))
          });
        } finally {
          db.close();
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/sessions') {
        const input = await readJsonRequest(req);
        const session = startSession({ ...input, projectCtx: reqCtx, auditActorPeer: 'web', auditSource: 'web' });
        sendJson(res, 200, { session: serializeSession(session) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/sessions/attach') {
        const input = await readJsonRequest(req);
        const session = attachTmuxSession({ ...input, projectCtx: reqCtx, auditActorPeer: 'web', auditSource: 'web' });
        sendJson(res, 200, { session: serializeSession(session) });
        return;
      }
      const inputMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/input$/);
      if (req.method === 'POST' && inputMatch) {
        // This HTTP input route is the admin injection path used by the CLI
        // (hcc inject / ask / broadcast). It is gated by the runtime token
        // (authOk above) and intentionally does NOT require the per-session
        // action token — the browser types via the WebSocket input frame
        // (which DOES require it), and the CLI cannot obtain the action token.
        const id = decodeURIComponent(inputMatch[1]);
        const lookupDb = connectWebProject(reqCtx);
        let session;
        try {
          session = getSession(reqCtx, id, lookupDb);
        } finally {
          lookupDb.close();
        }
        if (!session) {
          sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Session not found' } });
          return;
        }
        if (session.status !== 'running') {
          sendJson(res, 409, { ok: false, error: { code: 'SESSION_NOT_RUNNING', message: 'Session is not running' } });
          return;
        }
        const input = await readJsonRequest(req);
        const text = String(input.text ?? input.data ?? '');
        const data = input.data !== undefined ? String(input.data) : `${text}${input.enter === false ? '' : '\r'}`;
        writeSessionInput(session, data);
        const db = connectWebProject(session.ctx || reqCtx);
        try {
          addEvent(db, 'web.session.input', 'web', null, auditPayload({
            actor: 'web',
            target: session.peerId || id,
            source: 'web',
            admin: true,
            peer: session.peerId || id,
            runtime_session_id: session.id,
            bytes: data.length,
            enter: input.enter !== false
          }));
        } finally {
          db.close();
        }
        sendJson(res, 200, { session: serializeSession(session), bytes: data.length });
        return;
      }
      const stopMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/stop$/);
      if (req.method === 'POST' && stopMatch) {
        const id = decodeURIComponent(stopMatch[1]);
        let stopInput = {};
        try { stopInput = await readJsonRequest(req); } catch {}
        const lookupDb = connectWebProject(reqCtx);
        let session;
        try {
          session = getSession(reqCtx, id, lookupDb);
        } finally {
          lookupDb.close();
        }
        if (!session) {
          sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Session not found' } });
          return;
        }
        if (session.status === 'running') {
          if (session.type === 'external') {
            // Stop the hcc run wrapper first so it can kill the PTY and clean
            // buffer files; fall back to the child pid for older metadata.
            if (session.wrapperPid) { try { process.kill(session.wrapperPid, 'SIGTERM'); } catch {} }
            if (session.pid && session.pid !== session.wrapperPid) { try { process.kill(session.pid, 'SIGTERM'); } catch {} }
          } else if (session.type === 'tmux') {
            let killPlan = null;
            const stopDb = connectWebProject(reqCtx);
            try {
              const peerId = resolveSessionPeerId(stopDb, session) || session.peerId || session.id;
              if (stopInput.kill_tmux) {
                killPlan = safeTmuxKillPlan(reqCtx, stopDb, peerId, session.pane || null);
              }
            } finally {
              stopDb.close();
            }
            if (killPlan) executeTmuxKillPlan(reqCtx, killPlan);
            detachTmuxSession(session, 'detached');
          } else {
            session.pty.kill();
          }
        }
        const eventDb = connectWebProject(reqCtx);
        try {
          const peerId = resolveSessionPeerId(eventDb, session) || session.peerId || id;
          addEvent(eventDb, 'web.session.stop_requested', 'web', null, auditPayload({
            actor: 'web',
            target: peerId,
            source: 'web',
            admin: true,
            peer: peerId,
            runtime_session_id: session.id,
            kill_tmux: Boolean(stopInput.kill_tmux)
          }));
        } finally {
          eventDb.close();
        }
        sendJson(res, 200, { session: serializeSession(session) });
        return;
      }
      // Send a message to a detected (non-managed) peer's inbox
      const detectedMsgMatch = url.pathname.match(/^\/api\/detected\/([^/]+)\/msg$/);
      if (req.method === 'POST' && detectedMsgMatch) {
        const peerId = decodeURIComponent(detectedMsgMatch[1]);
        const input = await readJsonRequest(req);
        const body = String(input.body || '');
        const sender = 'web';
        const taskId = input.task ? Number(input.task) : null;
        if (!body) { sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: 'body required' } }); return; }
        const db = connectWebProject(reqCtx);
        let msgId;
        try {
          msgId = sendMessage(db, sender, peerId, taskId, 'note', body);
        } finally {
          db.close();
        }
        sendJson(res, 200, { ok: true, id: msgId });
        return;
      }
      const detectedStopMatch = url.pathname.match(/^\/api\/detected\/([^/]+)\/stop$/);
      if (req.method === 'POST' && detectedStopMatch) {
        const peerId = decodeURIComponent(detectedStopMatch[1]);
        let input = {};
        try { input = await readJsonRequest(req); } catch {}
        const db = connectWebProject(reqCtx);
        try {
          const now_ = now();
          let killPlan = null;
          if (input.kill_tmux) {
            killPlan = killDbProvenTmuxSession(reqCtx, db, peerId);
          }
          // Preserve last_seen_at on death so the just-stopped owner is not
          // misread as freshly active (hb-01); status='exited' drives liveness.
          db.prepare('UPDATE peers SET status = ? WHERE id = ?').run('exited', peerId);
          db.prepare('UPDATE peer_bindings SET runtime_target = NULL, updated_at = ? WHERE peer = ?').run(now_, peerId);
          addEvent(db, 'peer.stopped', 'web', null, auditPayload({
            actor: 'web',
            target: peerId,
            source: 'web',
            admin: true,
            peer: peerId,
            kill_tmux: Boolean(killPlan),
            tmux_session: killPlan?.session || null,
            runtime_target: killPlan?.runtime_target || null
          }));
        } finally {
          db.close();
        }
        sendJson(res, 200, { ok: true, peer: peerId, status: 'exited' });
        return;
      }
      const detectedRestartMatch = url.pathname.match(/^\/api\/detected\/([^/]+)\/restart$/);
      if (req.method === 'POST' && detectedRestartMatch) {
        const peerId = decodeURIComponent(detectedRestartMatch[1]);
        const db = connectWebProject(reqCtx);
        try {
          // v1-detected-restart: only flip a real detected peer that has a live
          // process or is not explicitly exited. Do not bump last_seen_at
          // (the peer did not actually heartbeat) so the reaper's age filter
          // still applies and a phantom cannot persist indefinitely.
          const peer = db.prepare('SELECT id, pid, status FROM peers WHERE id = ?').get(peerId);
          if (!peer || peer.status === 'exited') {
            sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `No live detected peer for ${peerId}` } });
            return;
          }
          db.prepare('UPDATE peers SET status = ? WHERE id = ?').run('running', peerId);
          addEvent(db, 'peer.restarted', 'web', null, auditPayload({
            actor: 'web',
            target: peerId,
            source: 'web',
            admin: true,
            peer: peerId
          }));
        } finally {
          db.close();
        }
        sendJson(res, 200, { ok: true, peer: peerId, status: 'running' });
        return;
      }
      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Route not found' } });
    } catch (err) {
      const publicFailure = publicCliFailure(err);
      const publicError = publicFailure?.error || err;
      const detail = publicFailure || process.env.HCC_DEBUG
        ? publicError.message
        : 'internal server error';
      sendJson(res, webErrorStatus(publicError), {
        ok: false,
        error: {
          code: publicError.code || 'SERVER_ERROR',
          message: detail,
          ...(publicFailure?.cleanupFailed ? { cleanup_failed: true } : {})
        }
      });
    }
  };
  const server = useTls
    ? https.createServer({ key: tlsCredentials.key, cert: tlsCredentials.cert }, handleWebRequest)
    : http.createServer(handleWebRequest);

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    try {
    const url = requestUrl(req);
    if (!readWebSocketApiVersion(url).ok) {
      const body = JSON.stringify(apiVersionUnsupportedBody());
      socket.end([
        'HTTP/1.1 426 Upgrade Required',
        'Content-Type: application/json; charset=utf-8',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        body
      ].join('\r\n'));
      return;
    }
    const upgradeAuthMode = webAuthMode(url, req);
    if (!upgradeAuthMode) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const cookieAuth = upgradeAuthMode === 'cookie' ? cookieSessionRecord(req) : null;
    if (upgradeAuthMode === 'cookie' && !cookieAuth) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!webSocketOriginAllowed(req, { trustProxy, proxyOrigin })) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const match = url.pathname.match(/^\/ws\/terminal\/([^/]+)$/);
    if (!match) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const reqCtx = projectFromRequest(req, url);
    const id = decodeURIComponent(match[1]);
    const lookupDb = connectWebProject(reqCtx);
    let session;
    try {
      session = getSession(reqCtx, id, lookupDb);
    } finally {
      lookupDb.close();
    }
    if (!session) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    // ws-5: cap concurrent WS clients per session so the action_token (delivered
    // via the snapshot frame) cannot be harvested by unlimited connections.
    if (session.clients.size >= 4) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const connectionActionToken = newSessionActionToken();
      ws.hccCookieAuth = cookieAuth;
      session.clients.add(ws);
      if (cookieAuth) cookieAuth.session.sockets.add(ws);
      if (!cookieSocketValid(ws)) {
        session.clients.delete(ws);
        return;
      }
      session.actionTokens ||= new Set();
      session.actionTokens.add(connectionActionToken);
      ws.send(JSON.stringify({ type: 'snapshot', data: refreshTmuxSnapshot(session), action_token: connectionActionToken }));
      ws.on('message', (raw) => {
        try {
          if (!cookieSocketValid(ws)) return;
          const msg = JSON.parse(String(raw));
          if (msg.type === 'input' && session.status === 'running') {
            if (!tokenMatches(msg.action_token, connectionActionToken)) return;
            const data = String(msg.data || '');
            writeSessionInput(session, data);
          } else if (msg.type === 'resize' && session.status === 'running') {
            if (!tokenMatches(msg.action_token, connectionActionToken)) return;
            const cols = Math.max(20, Number.parseInt(msg.cols || 100, 10));
            const rows = Math.max(8, Number.parseInt(msg.rows || 30, 10));
            resizeSession(session, cols, rows);
            scheduleTmuxReplace(session);
          }
        } catch {
          // Ignore malformed terminal frames.
        }
      });
      ws.on('close', () => {
        session.clients.delete(ws);
        session.actionTokens.delete(connectionActionToken);
        if (cookieAuth) cookieAuth.session.sockets.delete(ws);
      });
    });
    } catch (err) {
      console.error(redactedLogText(`[${new Date().toISOString()}] ws upgrade failed: ${err?.message || err}`));
      try { socket.destroy(); } catch {}
    }
  });

  let cleanupPromise = null;
  let shutdownExitCode = 0;
  async function performRuntimeCleanup() {
    clearRuntime(ctx);
    // rob-07: clear this runtime's per-project pointers for every registered
    // project, not just the primary ctx, so sibling projects don't keep
    // pointing at a now-dead runtime.
    try {
      for (const project of readProjectRegistry()) {
        clearRuntime({ root: project.root }, process.pid);
      }
    } catch {}
    // sess-02: mark managed (tmux/pty) sessions detached in their own project
    // DB and clear their runtime_target, so a restart does not consume stale
    // bindings. Best-effort; never block shutdown.
    try {
      const byRoot = new Map();
      for (const s of sessions.values()) {
        if (s.status !== 'running' || (s.type !== 'tmux' && s.type !== 'pty')) continue;
        const peerId = s.peerId || s.id;
        if (!peerId) continue;
        const root = path.resolve(s.ctx?.root || s.root || ctx.root);
        if (!byRoot.has(root)) byRoot.set(root, new Set());
        byRoot.get(root).add(peerId);
      }
      const detachedAt = now();
      for (const [root, idSet] of byRoot) {
        const peerIds = [...idSet];
        if (!peerIds.length) continue;
        const placeholders = peerIds.map(() => '?').join(',');
        const cleanupDb = connectWebProject(contextForProject(root, null, { json: ctx.json }));
        try {
          cleanupDb.prepare(`UPDATE peers SET status = 'detached' WHERE id IN (${placeholders}) AND status IN ('running','working','busy')`).run(...peerIds);
          cleanupDb.prepare(`UPDATE peer_bindings SET runtime_target = NULL, updated_at = ? WHERE peer IN (${placeholders})`).run(detachedAt, ...peerIds);
        } finally {
          cleanupDb.close();
        }
      }
    } catch {}
    clearInterval(externalScanPoller);
    clearInterval(autoAttachPoller);
    clearInterval(reaperPoller);
    clearInterval(gcPoller);
    clearInterval(webSessionPruner);
    try { for (const w of bufsWatchers.values()) w.close(); } catch {}
    clearInterval(bufsWatcherSyncPoller);
    for (const session of sessions.values()) {
      closeSessionClients(session);
      if (session.status !== 'running') continue;
      if (session.type === 'external') {
        try { if (session.outputFd) fs.closeSync(session.outputFd); } catch {}
        try { if (session.outputPoller) clearInterval(session.outputPoller); } catch {}
        try { if (session.exitPoller) clearInterval(session.exitPoller); } catch {}
      } else if (session.type === 'tmux') {
        try { stopTmuxStream(session); } catch {}
        try { if (session.exitPoller) clearInterval(session.exitPoller); } catch {}
      } else {
        try { session.pty.kill(); } catch {}
      }
    }
    try { wss.close(); } catch {}
    await new Promise((resolve) => {
      const terminateClients = setTimeout(() => {
        for (const session of sessions.values()) {
          for (const client of [...(session.clients || [])]) {
            try { if (typeof client.terminate === 'function') client.terminate(); } catch {}
          }
        }
        try { server.closeAllConnections?.(); } catch {}
      }, 250);
      const forceClose = setTimeout(() => {
        try { server.closeAllConnections?.(); } catch {}
        resolve();
      }, 1500);
      try {
        server.close(() => {
          clearTimeout(terminateClients);
          clearTimeout(forceClose);
          resolve();
        });
        try { server.closeIdleConnections?.(); } catch {}
      } catch {
        clearTimeout(terminateClients);
        clearTimeout(forceClose);
        resolve();
      }
    });
  }
  function cleanupRuntime() {
    if (!cleanupPromise) cleanupPromise = performRuntimeCleanup();
    return cleanupPromise;
  }
  function shutdown() {
    void cleanupRuntime().then(
      () => process.exit(shutdownExitCode),
      (error) => {
        console.error(redactedLogText(`[${new Date().toISOString()}] runtime cleanup failed: ${error?.stack || error}`));
        process.exit(1);
      }
    );
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  // Best-effort backstop for exit paths that bypass shutdown() (process.exit,
  // uncaught exceptions): synchronously kill pty-backed children so they are not
  // orphaned. Cannot run on SIGKILL — the dead-peer reaper repairs DB state on
  // the next start. tmux sessions are intentionally left alive.
  process.on('exit', () => {
    for (const session of sessions.values()) {
      if (session.type !== 'tmux' && session.type !== 'external' && session.pty) {
        try { session.pty.kill(); } catch {}
      }
    }
  });

  const fatalController = createFatalShutdownController({
    cleanup: () => {
      shutdownExitCode = 1;
      return cleanupRuntime();
    },
    exit: (code) => process.exit(code),
    forceExit: (code) => process.exit(code),
    log: (entry) => console.error(redactedLogText({
      timestamp: new Date().toISOString(),
      ...entry
    }))
  });
  process.on('uncaughtException', (err) => {
    void fatalController.fatal(err);
  });
  process.on('unhandledRejection', (reason) => {
    void fatalController.fatal(reason);
  });

  const actualPort = await listenServer(server, host, port, opts.port === undefined);
  const runtime = {
    product: PRODUCT_NAME,
    version: VERSION,
    api_version: API_VERSION,
    pid: process.pid,
    ...(processIdentity ? { process_identity: processIdentity } : {}),
    root: ctx.root,
    db: ctx.dbPath,
    host,
    port: actualPort,
    base_url: runtimeBaseUrl(host, actualPort, useTls),
    token,
    tls: useTls,
    trust_proxy: trustProxy,
    proxy_origin: proxyOrigin,
    tls_cert: useTls ? tlsCredentials.cert : undefined,
    started_at: now()
  };
  const runtimeFile = writeRuntime(ctx, runtime);
  writeGlobalRuntime(runtime);
  registerProject(ctx);
  const db = connectWebProject(ctx);
  try {
    addEvent(db, startMeta.eventType || 'web.started', 'human', null, auditPayload({
      actor: 'human',
      source: 'cli',
      root: ctx.root,
      db: ctx.dbPath,
      host,
      port: actualPort,
      requested_port: port,
      guidance: startMeta.guidance || prepared.guidance || null,
      runtime: runtimeFile
    }));
  } finally {
    db.close();
  }
  console.log(redactedLogText(`${PRODUCT_NAME} web listening on ${host}:${actualPort}`));
  console.log(redactedLogText(`project: ${ctx.root}`));
  console.log(redactedLogText(`database: ${ctx.dbPath}`));
  console.log(redactedLogText(`open: ${publicRuntimeUrl(runtime, ctx.root)}`));
}

  return { cmdWeb };
}
