import fs from 'node:fs';
import { CliError } from './errors.mjs';

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
  return JSON.parse(body);
}

export function sendHttp(res, status, contentType, body) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store'
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
      'Cache-Control': 'no-store'
    });
    res.end(body);
  } catch {
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Asset not found' } });
  }
}

export function authOk(url, req, token) {
  if (!token) return true;
  const queryToken = url.searchParams.get('token');
  const auth = req.headers.authorization || '';
  return queryToken === token || auth === `Bearer ${token}`;
}
