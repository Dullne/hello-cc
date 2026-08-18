// HTTP request routing for the web runtime, extracted from lib/web/runtime-main.mjs.
// The single handleWebRequest dispatcher: auth/cookie exchange, static UI,
// projects, sessions, peers, tmux/buffer-GC endpoints, and the status APIs.

import path from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';
import { publicCliFailure, CliError } from '../shared/errors.mjs';
import { required } from '../cli-args.mjs';
import { packageRoot } from '../cli-runtime.mjs';
import { projectRecord } from '../runtime/projects.mjs';
import { writeRuntime } from '../runtime/state.mjs';
import { normalizeStateResources } from '../ui/state-render.mjs';
import { requestUrl, runtimeBaseUrl } from '../web/runtime.mjs';
import { authOk, readJsonRequest, requestMatchesProxyOrigin, requestOriginMatches, sendFile, sendJson, tokenMatches } from '../web/http.mjs';
import { API_VERSION, apiVersionUnsupportedBody, readHttpApiVersion } from '../web/api-version.mjs';

export function createHttpRoutes(deps) {
  const {
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
    getProcessIdentity, getActualPort,
    renderWebIndex, renderWebLogin, sendWebHtml, webErrorStatus,
    ACTIVE_PEER_TTL, DETECTED_PEER_MAX_AGE, PRODUCT_NAME, VERSION
  } = deps;

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
          ...(getProcessIdentity() ? { process_identity: getProcessIdentity() } : {}),
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

  return { handleWebRequest };
}
