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

export function sendHttp(res, status, contentType, body) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff'
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
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(body);
  } catch {
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Asset not found' } });
  }
}

function isLoopbackRemote(req) {
  const addr = req?.socket?.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.');
}

function tokenMatches(provided, expected) {
  if (!provided || provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

export function authOk(url, req, token) {
  // No token configured: only trust loopback clients. A tokenless runtime is
  // refused on non-loopback binds at startup, so this is defense-in-depth.
  if (!token) return isLoopbackRemote(req);
  const queryToken = url.searchParams.get('token') || '';
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return tokenMatches(queryToken, token) || tokenMatches(bearer, token);
}
