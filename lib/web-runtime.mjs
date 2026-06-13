import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { randomBytes } from 'node:crypto';
import { intOpt } from './cli-args.mjs';
import { CliError } from './errors.mjs';
import { globalWebTokenPath } from './runtime-paths.mjs';

export function runtimeConnectHost(host) {
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1';
  return host;
}

export function runtimeBaseUrl(host, port) {
  return `http://${runtimeConnectHost(host)}:${port}`;
}

export function runtimeApiUrl(runtime, route) {
  const baseUrl = typeof runtime === 'string' ? runtime : runtime?.base_url;
  return new URL(route, baseUrl);
}

export function requestUrl(req) {
  return new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
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
  return `http://${host}:${runtime.port}/${runtimeUrlQuery(runtime, projectRoot)}`;
}

export function localRuntimeUrl(runtime, projectRoot = null) {
  const host = runtimeConnectHost(runtime.host || '127.0.0.1');
  return `http://${host}:${runtime.port}/${runtimeUrlQuery(runtime, projectRoot)}`;
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
