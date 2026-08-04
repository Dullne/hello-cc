import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import process from 'node:process';
import { randomBytes } from 'node:crypto';
import { intOpt } from '../cli-args.mjs';
import { withRuntimeApiVersionHeader } from './api-version.mjs';
import { CliError } from '../shared/errors.mjs';
import { sanitizePeerPart } from '../core/peers/format.mjs';
import { globalWebTokenPath } from '../runtime/paths.mjs';

export function runtimeConnectHost(host) {
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1';
  return host;
}

export function runtimeBaseUrl(host, port, tls = false) {
  return `${tls ? 'https' : 'http'}://${runtimeConnectHost(host)}:${port}`;
}

export function runtimeApiUrl(runtime, route) {
  const baseUrl = typeof runtime === 'string' ? runtime : runtime?.base_url;
  return new URL(route, baseUrl);
}

export function requestUrl(req) {
  return new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
}

export function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export function nextSessionId(existingIds, kind) {
  const prefix = sanitizePeerPart(kind || 'shell', 'shell');
  const ids = new Set();
  if (existingIds instanceof Map) {
    for (const value of existingIds.values()) {
      if (value && typeof value === 'object' && value.id) ids.add(value.id);
      else if (value) ids.add(String(value));
    }
  } else {
    for (const value of existingIds || []) ids.add(String(value));
  }
  let i = 1;
  while (ids.has(`${prefix}-${i}`)) i += 1;
  return `${prefix}-${i}`;
}

export function listenServer(server, host, port, autoPort) {
  return new Promise((resolve, reject) => {
    function attempt(candidate, remaining) {
      const onError = (err) => {
        if (err.code === 'EADDRINUSE' && autoPort && remaining > 0 && candidate < 65535) {
          attempt(candidate + 1, remaining - 1);
          return;
        }
        if (err.code === 'EADDRINUSE') {
          reject(new CliError('PORT_IN_USE', `Port ${candidate} is already in use on ${host}`, { host, port: candidate }));
          return;
        }
        reject(new CliError('LISTEN_FAILED', `Cannot listen on ${host}:${candidate}: ${err.message}`, { host, port: candidate }));
      };
      server.once('error', onError);
      server.listen(candidate, host, () => {
        server.off('error', onError);
        const address = server.address();
        resolve(address && typeof address === 'object' ? address.port : candidate);
      });
    }
    attempt(port, 20);
  });
}

export function runtimeUrlQuery(runtime, projectRoot = null) {
  const parts = [];
  if (runtime.token) parts.push(`token=${encodeURIComponent(runtime.token)}`);
  if (projectRoot) parts.push(`project=${encodeURIComponent(projectRoot)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

export function publicRuntimeUrl(runtime, projectRoot = null) {
  const host = runtime.host === '0.0.0.0' || runtime.host === '::'
    ? '<machine-ip>'
    : runtime.host || runtimeConnectHost(runtime.host || '127.0.0.1');
  const scheme = runtime.tls ? 'https' : 'http';
  return `${scheme}://${host}:${runtime.port}/${runtimeUrlQuery(runtime, projectRoot)}`;
}

export function localRuntimeUrl(runtime, projectRoot = null) {
  const host = runtimeConnectHost(runtime.host || '127.0.0.1');
  const scheme = runtime.tls ? 'https' : 'http';
  return `${scheme}://${host}:${runtime.port}/${runtimeUrlQuery(runtime, projectRoot)}`;
}

// Issue a request to a runtime API route. Returns { ok, status, text }.
// Plaintext: the global fetch (mockable, no CA needed). TLS: the node https
// client with a CA agent so the CLI can trust its own self-signed cert (global
// fetch cannot take a per-call CA without undici's Agent). TLS sockets are not
// pooled so the CLI process can exit promptly.
// Both transports must serialize the request body identically: the global
// fetch rejects object bodies while https.request needs a string/buffer, so
// normalize once up front instead of letting the branches diverge.
export function normalizeRequestBody(body) {
  if (body === null || body === undefined) return null;
  return typeof body === 'string' ? body : JSON.stringify(body);
}

export async function runtimeHttpRequest(rt, route, { method = 'GET', headers = {}, body = null, timeoutMs = 8000, signal } = {}) {
  const url = runtimeApiUrl(rt, route);
  const requestBody = normalizeRequestBody(body);
  const requestHeaders = withRuntimeApiVersionHeader(headers);
  if (url.protocol !== 'https:') {
    const response = await fetch(url, { method, headers: requestHeaders, body: requestBody === null ? undefined : requestBody, signal });
    return { ok: response.ok, status: response.status, text: await response.text() };
  }
  const tlsCert = rt?.tls_cert;
  const agent = new https.Agent({
    ...(tlsCert ? { ca: tlsCert } : {}),
    // TLS-1: verify against our stored self-signed cert when we have it; when
    // the runtime object carries no cert (e.g. HCC_RUNTIME_URL=https env
    // override), the CLI and the runtime are the same user/machine trust
    // domain, so connect without extra verification rather than failing every
    // CLI call and letting `hcc down` report a false 'stopped'.
    rejectUnauthorized: Boolean(tlsCert),
    keepAlive: false
  });
  const options = {
    method,
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname + url.search,
    headers: requestHeaders,
    agent,
    signal
  };
  return new Promise((resolve, reject) => {
    const cleanup = () => { try { agent.destroy(); } catch {} };
    const req = https.request(options, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        cleanup();
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text });
      });
    });
    req.on('error', (err) => { cleanup(); reject(err); });
    req.setTimeout(timeoutMs, () => { cleanup(); req.destroy(new Error('runtime request timeout')); });
    if (requestBody !== null) req.write(requestBody);
    req.end();
  });
}

export function readStoredWebToken() {
  const file = globalWebTokenPath();
  if (!fs.existsSync(file)) return '';
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

export function writeStoredWebToken(token) {
  if (!token) return '';
  const file = globalWebTokenPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

export function validateWebTokenOpts(opts) {
  if (opts['no-token'] && (opts.token || process.env.HCC_WEB_TOKEN)) {
    throw new CliError('BAD_ARGS', '--no-token cannot be combined with --token or HCC_WEB_TOKEN');
  }
}

export function makeWebToken(opts) {
  validateWebTokenOpts(opts);
  if (opts['no-token']) return '';
  const explicitToken = opts.token || process.env.HCC_WEB_TOKEN || '';
  if (explicitToken) {
    writeStoredWebToken(explicitToken);
    return explicitToken;
  }
  const stored = readStoredWebToken();
  if (stored) return stored;
  const generated = randomBytes(24).toString('base64url');
  writeStoredWebToken(generated);
  return generated;
}

export function expectedWebHost(opts) {
  return opts.host || (opts.local ? '127.0.0.1' : '0.0.0.0');
}

export function webRuntimeMatchesRequest(runtime, opts) {
  if (!runtime) return false;
  if (opts['no-token'] && (opts.token || process.env.HCC_WEB_TOKEN)) return false;
  const runtimeTls = runtime.tls === undefined
    ? /^https:/i.test(String(runtime.base_url || ''))
    : Boolean(runtime.tls);
  if (runtimeTls !== Boolean(opts.tls)) return false;
  if (Boolean(runtime.trust_proxy) !== Boolean(opts['trust-proxy'])) return false;
  const expectedHost = expectedWebHost(opts);
  if (runtime.host !== expectedHost) return false;
  const expectedPort = intOpt(opts, 'port', 8787);
  if (opts.port !== undefined && runtime.port !== expectedPort) return false;
  const explicitToken = opts.token || process.env.HCC_WEB_TOKEN || '';
  if (opts['no-token']) return !runtime.token;
  if (explicitToken) return runtime.token === explicitToken;
  return Boolean(runtime.token);
}

export function rememberRuntimeToken(runtime, opts) {
  if (!runtime?.token || opts['no-token']) return;
  const explicitToken = opts.token || process.env.HCC_WEB_TOKEN || '';
  if (explicitToken && runtime.token !== explicitToken) return;
  writeStoredWebToken(runtime.token);
}
