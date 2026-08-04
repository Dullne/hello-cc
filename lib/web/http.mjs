import fs from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { CliError } from '../shared/errors.mjs';

function readRequestBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new CliError('REQUEST_TOO_LARGE', 'Request body is too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export async function readJsonRequest(req) {
  const body = await readRequestBody(req);
  if (!body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new CliError('BAD_REQUEST', 'Invalid JSON request body');
    }
    throw err;
  }
}

export function contentSecurityPolicy(nonce) {
  const value = String(nonce || '');
  if (!/^[A-Za-z0-9_-]{16,}$/.test(value)) {
    throw new CliError('BAD_ARGS', 'A valid CSP nonce is required');
  }
  return "default-src 'self'; " +
    `script-src 'self' 'nonce-${value}'; ` +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; " +
    "connect-src 'self' ws: wss:; " +
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
}

export function sendHttp(res, status, contentType, body, options = {}) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': options.nonce
      ? contentSecurityPolicy(options.nonce)
      : "frame-ancestors 'none'"
  });
  res.end(body);
}

export function sendJson(res, status, body) {
  sendHttp(res, status, 'application/json; charset=utf-8', JSON.stringify(body, null, 2));
}

export function sendFile(res, filePath, contentType) {
  try {
    const body = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'"
    });
    res.end(body);
  } catch {
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Asset not found' } });
  }
}

function isLoopbackRemote(req) {
  const addr = req?.socket?.remoteAddress || '';
  return addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.');
}

export function tokenMatches(provided, expected) {
  if (!provided || !expected || provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

function firstForwardedValue(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw || '').split(',')[0].trim();
}

export function requestIsSecure(req, options = {}) {
  const trustProxy = options === true || options?.trustProxy === true;
  if (trustProxy && isLoopbackRemote(req)) {
    const forwardedProto = firstForwardedValue(req?.headers?.['x-forwarded-proto']).toLowerCase();
    if (forwardedProto) return forwardedProto === 'https';
  }
  return Boolean(req?.socket?.encrypted);
}

export function requestOriginMatches(req, options = {}) {
  const trustProxy = options === true || options?.trustProxy === true;
  const useForwardedHeaders = trustProxy && isLoopbackRemote(req);
  const origin = req?.headers?.origin || '';
  const forwardedHost = useForwardedHeaders
    ? firstForwardedValue(req?.headers?.['x-forwarded-host'])
    : '';
  const forwardedProto = useForwardedHeaders
    ? firstForwardedValue(req?.headers?.['x-forwarded-proto']).toLowerCase()
    : '';
  const host = forwardedHost || req?.headers?.host || '';
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    if (forwardedProto && !['http', 'https'].includes(forwardedProto)) return false;
    const expectedProtocol = forwardedProto
      ? `${forwardedProto}:`
      : (req?.socket?.encrypted ? 'https:' : 'http:');
    return parsed.protocol === expectedProtocol && parsed.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

export function authOk(url, req, token) {
  // No token configured: only trust loopback clients. A tokenless runtime is
  // refused on non-loopback binds at startup, so this is defense-in-depth.
  if (!token) return isLoopbackRemote(req);
  // v1-token-query-csrf-bypass: the query token is accepted ONLY on the cookie
  // exchange paths (the console page and the login endpoint). Everywhere else
  // — including all API routes and the WS upgrade — a leaked ?token= URL must
  // not authenticate writes, so a captured console URL cannot be replayed
  // cross-site. API clients authenticate with Authorization: Bearer.
  const pathname = url.pathname || '';
  const allowQueryToken = pathname === '/' || pathname === '/login';
  const queryToken = allowQueryToken ? (url.searchParams.get('token') || '') : '';
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return tokenMatches(queryToken, token) || tokenMatches(bearer, token);
}
