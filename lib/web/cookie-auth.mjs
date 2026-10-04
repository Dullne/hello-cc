// Web cookie/session authentication helpers extracted from cmdWeb.
// Factory pattern: the webSessions Map and config are created by the factory
// and shared across all returned functions.

import { randomBytes } from 'node:crypto';

// Cookies are shared across ports on one hostname, while the session Map is
// private to a runtime. Scope the name to the configured public endpoint so
// ordinary logins to another local runtime cannot replace this runtime's SID.
// Hostnames remain isolated by the browser's host-only cookie rules. This is
// coexistence isolation, not an authority boundary between same-host servers.
export function createCookieNameForRequest({ useTls = false, trustProxy = false, proxyOrigin = '' } = {}) {
  let protocol = useTls ? 'https' : 'http';
  let proxyPort;
  if (trustProxy) {
    let parsed;
    try { parsed = new URL(proxyOrigin); } catch {}
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new TypeError('Web cookie naming requires a valid configured proxy origin');
    }
    protocol = parsed.protocol.slice(0, -1);
    proxyPort = Number(parsed.port || (protocol === 'https' ? 443 : 80));
    if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
      throw new TypeError('Web cookie naming requires a valid configured proxy port');
    }
  } else if (proxyOrigin) {
    throw new TypeError('Web cookie proxy origin requires trustProxy');
  }
  return (req) => {
    // The socket reports the port actually bound (including --port 0 and
    // auto-increment). Do not use Host or forwarded request headers here.
    const port = proxyPort ?? req?.socket?.localPort;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new TypeError('Web cookie naming requires a valid listener port');
    }
    return `hcc_sid_v2_${protocol}_${port}`;
  };
}

export function createCookieAuth({
  now,
  ttlSec,
  maxSessions,
  cookieNameForRequest,
  requestIsSecure,
  trustProxy,
  proxyOrigin,
  authOk,
  token
}) {
  if (typeof cookieNameForRequest !== 'function') {
    throw new TypeError('Web cookie authentication requires cookieNameForRequest');
  }
  const webSessions = new Map();

  function cookieName(req) {
    const name = cookieNameForRequest(req);
    if (typeof name !== 'string' || !/^hcc_sid_v2_(?:http|https)_[1-9]\d{0,4}$/.test(name) ||
        Number(name.slice(name.lastIndexOf('_') + 1)) > 65535) {
      throw new TypeError('Web cookie authentication requires a scoped cookie name');
    }
    return name;
  }

  function parseCookieSid(req) {
    const name = cookieName(req);
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
      const [k, ...rest] = part.trim().split('=');
      if (k === name) {
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
    const parts = [`${cookieName(req)}=${sid}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${ttlSec}`];
    if (requestIsSecure(req, { trustProxy, proxyOrigin })) parts.push('Secure');
    return parts.join('; ');
  }

  function expiredSessionCookieHeader(req) {
    const parts = [`${cookieName(req)}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
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
    if (authOk(url, req, token, { trustProxy, proxyOrigin })) return 'token';
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
