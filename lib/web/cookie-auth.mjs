// Web cookie/session authentication helpers extracted from cmdWeb.
// Factory pattern: the webSessions Map and config are created by the factory
// and shared across all returned functions.

import { randomBytes } from 'node:crypto';

export function createCookieAuth({
  now,
  ttlSec,
  maxSessions,
  requestIsSecure,
  trustProxy,
  proxyOrigin,
  authOk,
  token
}) {
  const webSessions = new Map();

  function parseCookieSid(req) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
      const [k, ...rest] = part.trim().split('=');
      if (k === 'hcc_sid') {
        const raw = rest.join('=');
        if (raw.length > 128) return '';
        try { return decodeURIComponent(raw); } catch { return ''; }
      }
    }
    return '';
  }

  function closeWebSession(sid, reason = 'session revoked') {
    const session = webSessions.get(sid);
    webSessions.delete(sid);
    for (const ws of session?.sockets || []) {
      try { ws.close(4001, reason); } catch {}
    }
    session?.sockets?.clear();
  }

  function pruneWebSessions(t = now()) {
    for (const [sid, session] of webSessions) {
      if (session.expiresAt <= t) closeWebSession(sid, 'session expired');
    }
  }

  function issueSession() {
    pruneWebSessions();
    while (webSessions.size >= maxSessions) {
      const oldest = webSessions.keys().next().value;
      if (!oldest) break;
      closeWebSession(oldest, 'session limit reached');
    }
    const sid = randomBytes(24).toString('base64url');
    webSessions.set(sid, { expiresAt: now() + ttlSec, sockets: new Set() });
    return sid;
  }

  function sessionCookieHeader(sid, req) {
    const parts = [`hcc_sid=${sid}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${ttlSec}`];
    if (requestIsSecure(req, { trustProxy, proxyOrigin })) parts.push('Secure');
    return parts.join('; ');
  }

  function expiredSessionCookieHeader(req) {
    const parts = ['hcc_sid=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (requestIsSecure(req, { trustProxy, proxyOrigin })) parts.push('Secure');
    return parts.join('; ');
  }

  function cookieSessionRecord(req) {
    const sid = parseCookieSid(req);
    if (!sid) return null;
    const session = webSessions.get(sid);
    if (!session || session.expiresAt <= now()) {
      if (session) closeWebSession(sid, 'session expired');
      return null;
    }
    return { sid, session };
  }

  function cookieSessionOk(req) {
    return Boolean(cookieSessionRecord(req));
  }

  function cookieSocketValid(ws) {
    const auth = ws?.hccCookieAuth;
    if (!auth) return true;
    const current = webSessions.get(auth.sid);
    if (current === auth.session && current.expiresAt > now()) return true;
    const reason = current === auth.session ? 'session expired' : 'session revoked';
    if (current === auth.session) {
      closeWebSession(auth.sid, reason);
    } else {
      auth.session.sockets.delete(ws);
      try { ws.close(4001, reason); } catch {}
    }
    return false;
  }

  function webAuthMode(url, req) {
    if (authOk(url, req, token)) return 'token';
    return cookieSessionOk(req) ? 'cookie' : null;
  }

  return {
    webSessions,
    parseCookieSid,
    closeWebSession,
    pruneWebSessions,
    issueSession,
    sessionCookieHeader,
    expiredSessionCookieHeader,
    cookieSessionRecord,
    cookieSessionOk,
    cookieSocketValid,
    webAuthMode
  };
}
