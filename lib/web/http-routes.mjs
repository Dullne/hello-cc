// HTTP request routing for the web runtime, extracted from lib/web/runtime-main.mjs.
// The single handleWebRequest dispatcher: auth/cookie exchange, static UI,
// projects, sessions, peers, tmux/buffer-GC endpoints, and the status APIs.

import process from 'node:process';
import { URL } from 'node:url';
import { publicCliFailure, CliError } from '../shared/errors.mjs';
import { required } from '../cli-args.mjs';
import { terminalAssetPath } from './terminal-assets.mjs';
import { browserAssetPath } from './browser-assets.mjs';
import { listContextFiles } from './context-files.mjs';
import { createAgentDefaults } from './agent-defaults.mjs';
import { listProjectFiles, previewProjectFile, inspectProjectFileStatus, projectFileErrorStatus } from './project-files.mjs';
import { saveProjectFile, uploadProjectFile } from './project-file-write.mjs';
import { projectRecord } from '../runtime/projects.mjs';
import { prevalidateProjectDatabaseLocation } from '../runtime/project-path.mjs';
import { writeRuntime } from '../runtime/state.mjs';
import { normalizeStateResources } from '../ui/state-render.mjs';
import { requestUrl, runtimeBaseUrl } from '../web/runtime.mjs';
import { authOk, readJsonRequest, requestMatchesProxyOrigin, requestOriginMatches, sendFile, sendJson, tokenMatches, tokenlessRequestAllowed } from '../web/http.mjs';
import { API_VERSION, apiVersionUnsupportedBody, readHttpApiVersion } from '../web/api-version.mjs';
import { isDshHookBinding } from '../core/peers/bindings.mjs';
import { writeAdoptionState } from './adoption-state.mjs';
import { CodexAppServerError } from './codex-app-server.mjs';
import { sameSelectedCwdIdentity } from '../process/selected-cwd-identity.mjs';
import { scheduleResponseShutdown } from './shutdown-response.mjs';

// Keep unknown API requests out of project resolution: resolving an arbitrary
// root can create its managed state directory and refresh the project registry
// even when the dispatcher ultimately returns 404. Null means the matching
// dispatcher branch handles its own method error.
const projectApiPaths = new Map([
  ['/api/agent-defaults', ['GET', 'PUT']],
  ['/api/files/tree', ['GET']], ['/api/files/preview', ['GET']],
  ['/api/files/status', ['GET']], ['/api/files/content', ['PUT']], ['/api/files/upload', ['POST']],
  ['/api/context/files', ['GET']],
  ['/api/projects/select', ['POST']], ['/api/projects', ['GET', 'POST']],
  ['/api/state', ['GET']], ['/api/detected', ['GET']], ['/api/resumable', ['GET']],
  ['/api/runtime', ['GET']], ['/api/runtime/gc-buffers', ['POST']], ['/api/runtime/stop', ['POST']],
  ['/api/sessions', ['GET', 'POST']], ['/api/sessions/attach', ['POST']],
  ['/api/native/history', ['GET']], ['/api/codex/threads', ['GET']]
]);
const peerReadActions = new Set(['status', 'state', 'inbox']);
const peerWriteActions = new Set([
  'task-next', 'task-takeover', 'lock-acquire', 'lock-release', 'heartbeat', 'register'
]);
const projectApiPatterns = [
  [/^\/api\/native\/history\/[^/]+$/, ['GET']],
  [/^\/api\/native\/history\/[^/]+\/resume$/, ['POST']],
  [/^\/api\/sessions\/[^/]+\/native\/([^/]+)$/, null, {
    GET: ['state', 'account'], POST: ['send', 'interrupt', 'close', 'respond']
  }],
  [/^\/api\/codex\/threads\/[^/]+$/, ['GET']],
  [/^\/api\/codex\/threads\/[^/]+\/fork$/, ['POST']],
  [/^\/api\/sessions\/[^/]+\/results$/, ['GET', 'POST']],
  [/^\/api\/sessions\/[^/]+\/codex\/([^/]+)$/, null, {
    GET: ['state', 'read', 'account'], POST: ['turn', 'steer', 'interrupt', 'approve']
  }],
  [/^\/api\/sessions\/[^/]+\/(?:input|stop)$/, ['POST']],
  [/^\/api\/detected\/[^/]+\/(?:msg|stop|restart)$/, ['POST']]
];

function peerApiActionKind(pathname) {
  const match = pathname.match(/^\/api\/peers\/[^/]+\/actions\/([^/]+)$/);
  if (!match) return null;
  try {
    const action = decodeURIComponent(match[1]).replace(/_/g, '-');
    if (peerReadActions.has(action)) return 'read';
    if (peerWriteActions.has(action)) return 'write';
  } catch {}
  return 'unknown';
}

function projectApiRouteExists(method, pathname) {
  if (projectApiPaths.has(pathname)) {
    const methods = projectApiPaths.get(pathname);
    return methods === null || methods.includes(method);
  }
  const peerAction = peerApiActionKind(pathname);
  if (peerAction !== null) return peerAction === 'read' ? method === 'GET' :
    peerAction === 'write' && method === 'POST';
  return projectApiPatterns.some(([pattern, methods, actions]) => {
    const match = pathname.match(pattern);
    if (!match || methods !== null && !methods.includes(method)) return false;
    if (!actions) return true;
    try { return Array.isArray(actions[method]) && actions[method].includes(decodeURIComponent(match[1])); }
    catch { return false; }
  });
}

function legacyForbiddenCodexAction(method, pathname) {
  if (method !== 'POST') return false;
  const match = pathname.match(/^\/api\/sessions\/[^/]+\/codex\/([^/]+)$/);
  if (!match) return false;
  try { return ['account', 'login', 'logout', 'refreshToken'].includes(decodeURIComponent(match[1])); }
  catch { return false; }
}

export function createHttpRoutes(deps) {
  const {
    ctx, sessions,
    token, host, port, useTls, trustProxy, proxyOrigin,
    broadcast, serializeSession, sessionsForProject, resolveSessionPeerId,
    parseCookieSid, closeWebSession, issueSession, sessionCookieHeader,
    expiredSessionCookieHeader, cookieSessionOk, webAuthMode,
    rememberProject, knownProjects, selectedProjectIdentity, resolveWebProjectContext,
    connectWebProject, projectFromRequest, getSession, resolveWebActionSession,
    prepareRuntimeBufferGc, applyPreparedRuntimeBufferGc,
    detachTmuxSession, safeTmuxKillPlan, executeTmuxKillPlan,
    killDbProvenTmuxSession, attachTmuxSession, writeSessionInput, startSession,
    startCodexSession, codexAction, stopCodexSession, assertWebWrite,
    listCodexThreads, readCodexThread, forkCodexThread, readSessionResults, writeSessionResult,
    startNativeSession, listNativeHistory, nativeWorkerHistory, resumeNativeSession, discoverNativeSessions, nativeAction,
    webStatusSnapshot, webPeerActionForProject,
    now, addEvent, auditPayload, sendMessage,
    getProcessIdentity, getActualPort,
    shutdown, prepareShutdown = () => {}, isStopping = () => false,
    shutdownDiagnostic = () => {}, tlsCredentials,
    renderWebIndex, renderWebLogin, sendWebHtml, webErrorStatus,
    ACTIVE_PEER_TTL, DETECTED_PEER_MAX_AGE, PRODUCT_NAME, VERSION
  } = deps;
  const { readAgentDefaults, saveAgentDefaults } = createAgentDefaults({ connectWebProject });

  function assertRunning() {
    if (isStopping()) throw new CliError('RUNTIME_STOPPING', 'Web runtime is stopping');
  }
  async function readActiveJsonRequest(req, options) {
    const input = await readJsonRequest(req, options);
    assertRunning();
    return input;
  }

  function ownsExecutor(session) {
    return session.status === 'running' || (session.type === 'app-server' &&
      !session.executorReleased && !session.adapter.snapshot().processExited) ||
      (session.type === 'native' && !session.nativeRetired && session.status !== 'exited');
  }

  const handleWebRequest = async (req, res) => {
    try {
      const url = requestUrl(req);
      if (!token && !tokenlessRequestAllowed(req, { trustProxy, proxyOrigin })) {
        sendJson(res, 403, { ok: false, error: { code: 'UNTRUSTED_HOST', message: 'Tokenless access requires a trusted local Host' } });
        return;
      }
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
          for (const key of ['project', 'root', 'session']) {
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
        sendWebHtml(res, nonce => renderWebIndex({ nonce, paneAllowed: hasCookie }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/assets/xterm.js') {
        sendFile(res, terminalAssetPath('xterm.js'), 'application/javascript; charset=utf-8');
        return;
      }
      if (req.method === 'GET' && url.pathname === '/assets/xterm.css') {
        sendFile(res, terminalAssetPath('xterm.css'), 'text/css; charset=utf-8');
        return;
      }
      if (req.method === 'GET' && url.pathname === '/assets/addon-fit.js') {
        sendFile(res, terminalAssetPath('addon-fit.js'), 'application/javascript; charset=utf-8');
        return;
      }
      if (req.method === 'GET' && url.pathname === '/assets/addon-search.js') {
        sendFile(res, terminalAssetPath('addon-search.js'), 'application/javascript; charset=utf-8');
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
      if (req.method === 'GET' && browserAssetPath(url.pathname)) {
        sendFile(res, browserAssetPath(url.pathname), 'application/javascript; charset=utf-8');
        return;
      }
      if (req.method === 'GET' && url.pathname === '/pane') {
        // Only an existing browser session may create a workspace pane. Never
        // exchange a query token here or make the login page embeddable.
        if (!cookieSessionOk(req)) {
          sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'A browser session is required for a workspace pane' } });
          return;
        }
        sendWebHtml(res, renderWebIndex, { pane: true });
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
      // All remaining routes are versioned API routes. An unknown top-level
      // navigation carries a SameSite=Lax cookie but cannot supply the API
      // version header; do not resolve (and possibly create) a project before
      // returning its 404.
      if (!url.pathname.startsWith('/api/')) {
        sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Route not found' } });
        return;
      }
      // Dynamic IDs can be malformed even when the route shape and action
      // match. Validate the whole pathname before resolving a project.
      let pathEncodingValid = true;
      try { decodeURIComponent(url.pathname); } catch { pathEncodingValid = false; }
      if (!pathEncodingValid || !projectApiRouteExists(req.method, url.pathname)) {
        const peerAction = pathEncodingValid ? peerApiActionKind(url.pathname) : null;
        if (peerAction === 'read' || peerAction === 'write') {
          sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED',
            message: peerAction === 'read' ? 'Use GET for read-only peer actions' : 'Use POST for mutating peer actions' } });
          return;
        }
        if (url.pathname === '/api/agent-defaults') {
          throw new CliError('BAD_REQUEST', 'Agent defaults support GET and PUT only');
        }
        // The legacy Codex account-control POSTs have a stable BAD_REQUEST
        // contract. Reject them here without resolving an arbitrary project.
        if (pathEncodingValid && legacyForbiddenCodexAction(req.method, url.pathname)) {
          throw new CliError('BAD_REQUEST', 'Unsupported Codex action');
        }
        sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Route not found' } });
        return;
      }
      if (url.pathname !== '/api/runtime/stop' && url.pathname !== '/api/runtime') assertRunning();
      // Project registration may explicitly name a replacement root in the
      // JSON body. Read it after auth/origin checks, then resolve that root
      // directly; falling through the stale startup root would reject B
      // before its explicit selection is even examined.
      const projectInput = req.method === 'POST' && url.pathname === '/api/projects'
        ? await readActiveJsonRequest(req) : null;
      // Reject an outside DB before resolving the body-selected root, which
      // can create its managed state directory and record registry activity.
      if (projectInput?.db) {
        prevalidateProjectDatabaseLocation({
          root: projectInput.root || url.searchParams.get('root') ||
            url.searchParams.get('project') || req.headers['x-hcc-root'] || ctx.root,
          db: projectInput.db
        });
      }
      const projectUrl = projectInput?.root && !url.searchParams.has('root') &&
        !url.searchParams.has('project') && !req.headers['x-hcc-root']
        ? new URL(url) : url;
      if (projectUrl !== url) projectUrl.searchParams.set('root', projectInput.root);
      const reqCtx = projectFromRequest(req, projectUrl, { requireIdentity: cookieAuthenticated });
      if (url.pathname === '/api/agent-defaults') {
        if (req.method === 'GET') { sendJson(res, 200, readAgentDefaults(reqCtx)); return; }
        if (req.method === 'PUT') { sendJson(res, 200, saveAgentDefaults(reqCtx, await readActiveJsonRequest(req))); return; }
        throw new CliError('BAD_REQUEST', 'Agent defaults support GET and PUT only');
      }

      if (req.method === 'GET' && url.pathname === '/api/files/tree') {
        sendJson(res, 200, await listProjectFiles(reqCtx.root, url.searchParams.get('path') || '',
          { rootIdentity: reqCtx.rootIdentity }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/files/preview') {
        sendJson(res, 200, await previewProjectFile(reqCtx.root, url.searchParams.get('path'),
          { rootIdentity: reqCtx.rootIdentity }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/files/status') {
        sendJson(res, 200, await inspectProjectFileStatus(reqCtx.root, url.searchParams.get('path'),
          { rootIdentity: reqCtx.rootIdentity })); return;
      }
      if (req.method === 'PUT' && url.pathname === '/api/files/content') {
        const input = await readActiveJsonRequest(req, { maxBytes: 6 * 1024 * 1024 + 65536 });
        sendJson(res, 200, await saveProjectFile(reqCtx.root, input, { rootIdentity: reqCtx.rootIdentity })); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/files/upload') {
        const input = await readActiveJsonRequest(req, { maxBytes: 14 * 1024 * 1024 + 65536 });
        sendJson(res, 201, await uploadProjectFile(reqCtx.root, input, { rootIdentity: reqCtx.rootIdentity })); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/context/files') {
        sendJson(res, 200, await listContextFiles(reqCtx.root, url.searchParams.get('query') || '',
          { rootIdentity: reqCtx.rootIdentity }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/projects/select') {
        // Selection is deliberate and may name any accessible server directory.
        // It is not constrained to the registry, and does not inherit a stale
        // identity from the previously selected browser project.
        const selected = rememberProject(reqCtx, { register: true, nonblocking: true });
        sendJson(res, 200, { projects: knownProjects(), current: projectRecord(selected),
          project_identity: selectedProjectIdentity(selected) });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/projects') {
        sendJson(res, 200, { projects: knownProjects(), current: projectRecord(reqCtx), project_identity: selectedProjectIdentity(reqCtx) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/projects') {
        const input = projectInput;
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw new CliError('BAD_REQUEST', 'Project registration requires a JSON object');
        }
        const requestedRoot = input.root || reqCtx.root;
        const selected = resolveWebProjectContext(
          requestedRoot,
          input.db || null,
          { explicitSelection: true }
        );
        let projectCtx;
        try {
          if ((req.headers['x-hcc-root-identity'] !== undefined || url.searchParams.has('root_identity')) &&
              !sameSelectedCwdIdentity(reqCtx.rootIdentity, selected.rootIdentity)) {
            throw new CliError('PROJECT_PATH_CHANGED', 'Selected project directory changed during request');
          }
          projectCtx = rememberProject(selected, { register: true, nonblocking: true });
        } catch (error) {
          selected.rootIdentity?.release();
          throw error;
        }
        const db = connectWebProject(projectCtx);
        db.close();
        writeRuntime(projectCtx, {
          product: PRODUCT_NAME,
          version: VERSION,
          api_version: API_VERSION,
          pid: process.pid,
          ...(getProcessIdentity() ? { process_identity: getProcessIdentity() } : {}),
          root: projectCtx.root,
          db: projectCtx.dbPath,
          host,
          port: getActualPort(),
          base_url: runtimeBaseUrl(host, getActualPort(), useTls),
          token,
          tls: useTls,
          trust_proxy: trustProxy,
          proxy_origin: proxyOrigin,
          tls_cert: useTls ? tlsCredentials.cert : undefined,
          global_runtime: true,
          started_at: now()
        });
        sendJson(res, 200, { project: projectRecord(projectCtx), projects: knownProjects(), project_identity: selectedProjectIdentity(projectCtx) });
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
          : await readActiveJsonRequest(req);
        if (!readOnly && nativeAction) {
          const nativeSession = sessionsForProject(reqCtx).find(s => s.type === 'native' && [s.id, s.peerId].includes(peer));
          if (nativeSession) await nativeAction(nativeSession, 'read');
        }
        const actionInput = readOnly
          ? input
          : { ...input, actorPeer: resolveWebActionSession(reqCtx, peer, input, req) };
        sendJson(res, 200, webPeerActionForProject(reqCtx, peer, action, actionInput));
        return;
      }
      // Detected sessions: peers registered via hooks/watcher but without PTY
      if (req.method === 'GET' && url.pathname === '/api/detected') {
        await discoverNativeSessions?.(reqCtx);
        const db = connectWebProject(reqCtx);
        let detected = [];
        const managedIds = new Set();
        const t = now();
        try {
          detected = db.prepare(`
            SELECT p.id, p.kind, p.role, p.status, p.worktree, p.branch, p.pid, p.capabilities,
                   p.created_at, p.last_seen_at, (? - p.last_seen_at) AS age_sec,
                   b.provider, b.transport, b.provider_session_id, b.provider_session_name
            FROM peers p
            LEFT JOIN peer_bindings b ON b.peer = p.id
            WHERE p.status != 'exited' AND p.last_seen_at >= ?
            ORDER BY p.last_seen_at DESC, p.id ASC
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
          ...(getProcessIdentity() ? { process_identity: getProcessIdentity() } : {}),
          root: reqCtx.root,
          db: reqCtx.dbPath,
          projects: knownProjects(),
          sessions: sessionsForProject(reqCtx).length
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/runtime/gc-buffers') {
        const input = await readActiveJsonRequest(req);
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
        if (cookieAuthenticated) throw new CliError('RUNTIME_ADMIN_REQUIRED', 'Stop the runtime with the local administrator CLI');
        shutdownDiagnostic('stop_accepted');
        prepareShutdown();
        scheduleResponseShutdown(res, shutdown);
        sendJson(res, 200, { ok: true, pid: process.pid });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        await discoverNativeSessions?.(reqCtx);
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
      if (req.method === 'GET' && url.pathname === '/api/native/history') {
        sendJson(res, 200, await listNativeHistory(reqCtx)); return;
      }
      const nativeHistoryMatch = url.pathname.match(/^\/api\/native\/history\/([^/]+)(\/resume)?$/);
      if (nativeHistoryMatch) {
        const peer = decodeURIComponent(nativeHistoryMatch[1]);
        if (req.method === 'GET' && !nativeHistoryMatch[2]) {
          const afterText = url.searchParams.get('after') || '0';
          if (!/^(?:0|[1-9][0-9]*)$/.test(afterText) || !Number.isSafeInteger(Number(afterText))) throw new CliError('BAD_REQUEST', 'History cursor must be a nonnegative safe integer');
          sendJson(res, 200, await nativeWorkerHistory(reqCtx, peer, { after: Number(afterText) })); return;
        }
        if (req.method === 'POST' && nativeHistoryMatch[2]) {
          const session = await resumeNativeSession(reqCtx, peer, await readActiveJsonRequest(req));
          sendJson(res, 200, { session: serializeSession(session) }); return;
        }
        throw new CliError('BAD_REQUEST', 'Unsupported native history action');
      }
      if (req.method === 'POST' && url.pathname === '/api/sessions') {
        const input = await readActiveJsonRequest(req);
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CliError('BAD_REQUEST', 'Session creation requires a JSON object');
        if (input.transport === 'native' || input.backend === 'native') {
          if (Object.keys(input).some(key => !['transport', 'kind', 'id', 'cwd', 'model'].includes(key))) {
            throw new CliError('BAD_REQUEST', 'Native creation accepts only transport, kind, id, cwd and model');
          }
          const session = await startNativeSession({ ...input, projectCtx: reqCtx });
          sendJson(res, 200, { session: serializeSession(session) });
          return;
        }
        const existing = input.id && sessionsForProject(reqCtx).find(s => s.id === input.id || s.peerId === input.id);
        if (existing) assertWebWrite?.(existing, input, authMode, req);
        const start = input.transport === 'app-server' || input.backend === 'app-server' ? startCodexSession : startSession;
        const session = await start({ ...input, projectCtx: reqCtx, auditActorPeer: 'web', auditSource: 'web',
          authorizeMutation: existing => assertWebWrite?.(existing, input, authMode, req) });
        sendJson(res, 200, { session: serializeSession(session) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/sessions/attach') {
        const input = await readActiveJsonRequest(req);
        const bindingDb = connectWebProject(reqCtx);
        let binding;
        try {
          binding = input.id ? bindingDb.prepare('SELECT provider, transport FROM peer_bindings WHERE peer = ?').get(input.id) : null;
        } finally {
          bindingDb.close();
        }
        if (binding?.transport === 'native') throw new CliError('NATIVE_MANAGED_SESSION', 'Open the existing native worker instead of attaching a terminal');
        if (isDshHookBinding(binding) || input.kind === 'dsh' || input.binding?.provider === 'dsh') {
          sendJson(res, 409, { ok: false, error: { code: 'DSH_SESSION_CONTROL_UNSUPPORTED', message: 'Control this agent in the dsh Web UI. A dsh service pane cannot represent an individual agent session.' } });
          return;
        }
        for (const existing of sessionsForProject(reqCtx)) {
          if ((input.id && [existing.id, existing.peerId].includes(input.id)) ||
            (input.pane && existing.pane === input.pane)) assertWebWrite?.(existing, input, authMode, req);
        }
        const session = attachTmuxSession({ ...input, projectCtx: reqCtx, auditActorPeer: 'web', auditSource: 'web',
          authorizeMutation: existing => assertWebWrite?.(existing, input, authMode, req) });
        const adoptionDb = connectWebProject(reqCtx);
        try { writeAdoptionState(adoptionDb, session, false, now()); } finally { adoptionDb.close(); }
        sendJson(res, 200, { session: serializeSession(session) });
        return;
      }
      const nativeMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/native\/([^/]+)$/);
      if (nativeMatch) {
        await discoverNativeSessions?.(reqCtx);
        const db = connectWebProject(reqCtx);
        let session;
        try { session = getSession(reqCtx, decodeURIComponent(nativeMatch[1]), db); } finally { db.close(); }
        if (!session || session.type !== 'native') throw new CliError('NOT_FOUND', 'Native worker not found');
        const action = decodeURIComponent(nativeMatch[2]);
        if (req.method === 'GET' && action === 'state') {
          sendJson(res, 200, { state: await nativeAction(session, 'read') }); return;
        }
        if (req.method === 'GET' && action === 'account') {
          sendJson(res, 200, { state: await nativeAction(session, 'account', {
            generation: url.searchParams.get('generation'), owner: url.searchParams.get('owner'), sessionId: url.searchParams.get('sessionId') }) }); return;
        }
        if (req.method !== 'POST' || !['send', 'interrupt', 'close', 'respond'].includes(action)) throw new CliError('BAD_REQUEST', 'Unsupported native action');
        const input = await readActiveJsonRequest(req);
        const authorizeMutation = () => assertWebWrite(session, input, 'cookie', req);
        authorizeMutation();
        const receipt = await nativeAction(session, action, { ...input, authorizeMutation });
        sendJson(res, 200, { receipt, state: session.nativeSnapshot() }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/codex/threads') {
        const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 30;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new CliError('BAD_REQUEST', 'limit must be from 1 to 100');
        sendJson(res, 200, await listCodexThreads(reqCtx, { cursor: url.searchParams.get('cursor') || null, limit }));
        return;
      }
      const historyMatch = url.pathname.match(/^\/api\/codex\/threads\/([^/]+)(\/fork)?$/);
      if (historyMatch) {
        const threadId = decodeURIComponent(historyMatch[1]);
        if (req.method === 'GET' && !historyMatch[2]) {
          sendJson(res, 200, await readCodexThread(reqCtx, threadId)); return;
        }
        if (req.method !== 'POST' || !historyMatch[2]) throw new CliError('BAD_REQUEST', 'Unsupported history action');
        const input = await readActiveJsonRequest(req);
        // Fork keeps the source task owner; it is still a mutation of history
        // and must respect a source session's browser control when present.
        for (const source of sessionsForProject(reqCtx)) {
          if (source.binding?.provider === 'codex' && source.binding.provider_session_id === threadId && ownsExecutor(source)) {
            assertWebWrite(source, input, 'cookie', req);
          }
        }
        const authorizeMutation = () => {
          for (const source of sessionsForProject(reqCtx)) {
            if (source.binding?.provider === 'codex' && source.binding.provider_session_id === threadId && ownsExecutor(source)) {
              assertWebWrite(source, input, 'cookie', req);
            }
          }
        };
        const forked = await forkCodexThread(reqCtx, threadId, { ...input, authorizeMutation });
        sendJson(res, 200, { session: serializeSession(forked.session), thread: forked.thread, source_thread_id: threadId }); return;
      }
      const resultsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/results$/);
      if (resultsMatch) {
        const db = connectWebProject(reqCtx);
        let session;
        try { session = getSession(reqCtx, decodeURIComponent(resultsMatch[1]), db); } finally { db.close(); }
        if (!session) throw new CliError('NOT_FOUND', 'Session not found');
        if (req.method === 'GET') { sendJson(res, 200, readSessionResults(session)); return; }
        if (req.method !== 'POST') throw new CliError('BAD_REQUEST', 'Unsupported result action');
        const input = await readActiveJsonRequest(req);
        assertWebWrite(session, input, 'cookie', req);
        if (session.type === 'native') {
          await nativeAction(session, 'read');
          assertWebWrite(session, input, 'cookie', req);
        }
        sendJson(res, 200, writeSessionResult(session, input)); return;
      }
      const codexMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/codex\/([^/]+)$/);
      if (codexMatch && ['GET', 'POST'].includes(req.method)) {
        const id = decodeURIComponent(codexMatch[1]);
        const action = decodeURIComponent(codexMatch[2]);
        const db = connectWebProject(reqCtx);
        let session;
        try { session = getSession(reqCtx, id, db); } finally { db.close(); }
        if (!session || session.type !== 'app-server') throw new CliError('NOT_FOUND', 'Codex App Server session not found');
        if (req.method === 'GET' && action === 'state') {
          sendJson(res, 200, { state: session.adapter.snapshot() }); return;
        }
        if (req.method === 'GET' && action === 'read') {
          sendJson(res, 200, await codexAction(session, 'read', {})); return;
        }
        if (req.method === 'GET' && action === 'account') {
          const account = await codexAction(session, 'account', { executorId: url.searchParams.get('executorId') });
          sendJson(res, 200, { executorId: session.adapter.snapshot().executorId, account }); return;
        }
        if (req.method !== 'POST' || !['turn', 'steer', 'interrupt', 'approve'].includes(action)) {
          throw new CliError('BAD_REQUEST', 'Unsupported Codex action');
        }
        const input = await readActiveJsonRequest(req);
        // Structured turns and approvals always need a live browser controller,
        // even when the caller also possesses the runtime administrator token.
        assertWebWrite(session, input, 'cookie', req);
        sendJson(res, 200, await codexAction(session, action, input)); return;
      }
      const inputMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/input$/);
      if (req.method === 'POST' && inputMatch) {
        // CLI injection remains available without a browser controller. While
        // Web owns a lease, all injection paths require that controller's epoch.
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
        const input = await readActiveJsonRequest(req);
        assertWebWrite?.(session, input, authMode, req);
        if (['app-server', 'native'].includes(session.type)) throw new CliError('BAD_REQUEST', 'Use structured worker actions');
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
        try { stopInput = await readActiveJsonRequest(req); } catch {}
        assertRunning();
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
        assertWebWrite?.(session, stopInput, authMode, req);
        if (session.type === 'native') {
          await nativeAction(session, 'close', { ...stopInput,
            authorizeMutation: () => assertWebWrite(session, stopInput, 'cookie', req) });
        } else if (session.type === 'app-server') {
          await stopCodexSession(session);
        } else if (session.status === 'running') {
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
              if (!stopInput.kill_tmux) writeAdoptionState(stopDb, session, true, now());
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
        const input = await readActiveJsonRequest(req);
        if (['all', '*'].includes(peerId)) throw new CliError('CONTROL_REQUIRED', 'Detected inbox messaging requires an individual peer; use a controlled coordination action for broadcast');
        if (sessionsForProject(reqCtx).some(s => [s.id, s.peerId].includes(peerId))) {
          throw new CliError('CONTROL_REQUIRED', 'Use the managed session message endpoint and its control lease');
        }
        const body = String(input.body || '');
        const sender = 'web';
        const taskId = input.task ? Number(input.task) : null;
        if (!body) { sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: 'body required' } }); return; }
        const db = connectWebProject(reqCtx);
        let msgId;
        try {
          const binding = db.prepare('SELECT transport FROM peer_bindings WHERE peer = ?').get(peerId);
          if (['native', 'app-server'].includes(binding?.transport)) throw new CliError('STRUCTURED_SESSION_NO_TERMINAL', 'Use the structured worker control endpoint for messages');
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
        if (sessionsForProject(reqCtx).some(s => [s.id, s.peerId].includes(peerId))) {
          throw new CliError('CONTROL_REQUIRED', 'Use the managed session stop endpoint and its control lease');
        }
        let input = {};
        try { input = await readActiveJsonRequest(req); } catch {}
        assertRunning();
        const db = connectWebProject(reqCtx);
        try {
          const binding = db.prepare('SELECT provider, transport FROM peer_bindings WHERE peer = ?').get(peerId);
          if (binding?.transport === 'native') throw new CliError('NATIVE_MANAGED_SESSION', 'Use the existing native worker control endpoint');
          if (isDshHookBinding(binding)) {
            sendJson(res, 409, { ok: false, error: { code: 'DSH_SESSION_CONTROL_UNSUPPORTED', message: 'Control this agent in the dsh Web UI. hello-cc hooks support coordination only.' } });
            return;
          }
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
        if (sessionsForProject(reqCtx).some(s => [s.id, s.peerId].includes(peerId))) {
          throw new CliError('CONTROL_REQUIRED', 'Open the existing managed session');
        }
        const db = connectWebProject(reqCtx);
        try {
          const binding = db.prepare('SELECT provider, transport FROM peer_bindings WHERE peer = ?').get(peerId);
          if (binding?.transport === 'native') throw new CliError('NATIVE_MANAGED_SESSION', 'Use the existing native worker control endpoint');
          if (isDshHookBinding(binding)) {
            sendJson(res, 409, { ok: false, error: { code: 'DSH_SESSION_CONTROL_UNSUPPORTED', message: 'Resume this agent in the dsh Web UI. hello-cc hooks support coordination only.' } });
            return;
          }
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
      if (err instanceof CodexAppServerError) err = new CliError(err.code, err.message);
      const publicFailure = publicCliFailure(err);
      const publicError = publicFailure?.error || err;
      const detail = publicFailure || process.env.HCC_DEBUG
        ? publicError.message
        : 'internal server error';
      const status = publicError.code === 'RUNTIME_STOPPING' ? 503 : projectFileErrorStatus(publicError) || (['DSH_SESSION_CONTROL_UNSUPPORTED', 'AGENT_DEFAULTS_CONFLICT', 'AGENT_DEFAULTS_INVALID'].includes(publicError.code) ? 409
        : publicError.code === 'INVALID_CONTEXT_QUERY' ? 400 : webErrorStatus(publicError));
      sendJson(res, status, {
        ok: false,
        error: {
          code: publicError.code || 'SERVER_ERROR',
          message: detail,
          ...(['NATIVE_WORKER_DISCOVERY_FAILED', 'NATIVE_CREATE_UNCONFIRMED', 'NATIVE_RESUME_UNCONFIRMED'].includes(publicError.code) ? {
            extra: { peer: publicError.extra.peer, provider: publicError.extra.provider,
              ...(publicError.extra.executorId ? { executorId: publicError.extra.executorId } : {}),
              created: publicError.extra.created === true, uncertain: publicError.extra.uncertain === true }
          } : {}),
          ...(publicFailure?.cleanupFailed ? { cleanup_failed: true } : {})
        }
      });
    }
  };

  return { handleWebRequest };
}
