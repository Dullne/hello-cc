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
import { createTmuxSessions } from '../web/tmux-sessions.mjs';
import { createAutoAttach } from '../web/auto-attach.mjs';
import { createPtySessions } from '../web/pty-sessions.mjs';
import { createHttpRoutes } from '../web/http-routes.mjs';
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
  // refreshPeerIoHeartbeat comes from createTmuxSessions below; wrap it so the
  // reference resolves at call time instead of at this forward-passing site.
  const lazyRefreshPeerIoHeartbeat = (session) => refreshPeerIoHeartbeat(session);
  const { cursorEscape, tmuxSnapshot, refreshTmuxSnapshot, scheduleTmuxReplace, startTmuxReplacePoller, startTmuxStream, stopTmuxStream } = createTmuxStream({ broadcast, now, refreshPeerIoHeartbeat: lazyRefreshPeerIoHeartbeat, bufferDirectory, withBufferDirectoryLease, shellQuoteArg, ctx });
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
    refreshPeerIoHeartbeat: lazyRefreshPeerIoHeartbeat, redactedLogText, BUFS_DIR_NAME
  });

  const {
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
  } = createTmuxSessions({
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
  });
  const {
    autoAttachPoller, listTmuxPanesOnce, attachedTmuxState,
    reconcileRunningBindings, scanAndAttachDetectedPeers
  } = createAutoAttach({
    ctx, sessions,
    connectWebProject, now, addEvent, ACTIVE_PEER_TTL,
    reconcileRunningPeerBindings,
    redactedLogText, sessionsForProject,
    attachTmuxSession,
    latestHookProviderSession,
    resolveSessionPeerId,
    reAdoptOrphanManagedTmuxSessions, reapDeadPeersForProject
  });
  scanAndAttachDetectedPeers();

  const {
    startPtySession, webSessionBuildOptions, webSessionPeerId,
    normalizeWebSessionInput, startSession
  } = createPtySessions({
    pty, ctx, sessions,
    broadcast, closeSessionClients, sessionKey,
    connectWebProject, nextProjectSessionId,
    startTmuxManagedSession,
    now, addEvent, auditPayload, refreshPeerIoHeartbeat: lazyRefreshPeerIoHeartbeat,
    upsertPeer, upsertCanonicalPeerBinding,
    requestActorPeer, requestSource
  });

  const restoredTmuxDbs = new Set();
  for (const projectCtx of runtimeProjectContexts()) {
    const dbKey = path.resolve(projectCtx.dbPath);
    if (restoredTmuxDbs.has(dbKey)) continue;
    restoredTmuxDbs.add(dbKey);
    restoreTmuxManagedSessions(projectCtx);
    reconcileRunningBindings(projectCtx);
  }
  runAutoGc();

  const { handleWebRequest } = createHttpRoutes({
    ctx, sessions,
    token, host, port, useTls, trustProxy, proxyOrigin,
    broadcast, serializeSession, sessionsForProject, resolveSessionPeerId,
    parseCookieSid, closeWebSession, issueSession, sessionCookieHeader,
    expiredSessionCookieHeader, cookieSessionOk, webAuthMode,
    rememberProject, knownProjects, resolveWebProjectContext,
    connectWebProject, projectFromRequest, getSession, resolveWebActionSession,
    prepareRuntimeBufferGc, applyPreparedRuntimeBufferGc,
    detachTmuxSession, safeTmuxKillPlan, executeTmuxKillPlan,
    killDbProvenTmuxSession, attachTmuxSession, writeSessionInput, startSession,
    webStatusSnapshot, webPeerActionForProject,
    now, addEvent, auditPayload, sendMessage,
    getProcessIdentity: () => processIdentity,
    getActualPort: () => actualPort,
    shutdown, tlsCredentials,
    renderWebIndex, renderWebLogin, sendWebHtml, webErrorStatus,
    ACTIVE_PEER_TTL, DETECTED_PEER_MAX_AGE, PRODUCT_NAME, VERSION
  });

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
