// Web startup helpers extracted from bin/hcc.mjs.
// hcc web process matching, orphan runtime reaping, exposure/token checks,
// background child launch, readiness polling, and runtime banner printing.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { CliError } from '../shared/errors.mjs';
import { redactCliArgs } from '../shared/redact.mjs';
import { intOpt, parseOpts, splitGlobalArgs, validateOpts } from '../cli-args.mjs';
import { printResult } from '../format.mjs';
import { commandPath, tailFile } from '../cli-runtime.mjs';
import { registerProject } from '../runtime/projects.mjs';
import { runtimePath, globalRuntimePath, webLogPath } from '../runtime/paths.mjs';
import { readHealthyGlobalRuntime, writeRuntime } from '../runtime/state.mjs';
import { runtimeRequest } from '../runtime/client.mjs';
import {
  expectedWebHost,
  isLoopbackHost,
  localRuntimeUrl,
  publicRuntimeUrl,
  rememberRuntimeToken,
  validateWebTokenOpts,
  webRuntimeMatchesRequest
} from '../web/runtime.mjs';
import { requestOriginMatches } from '../web/http.mjs';
import { WEB_CHILD_ENV } from '../core/sessions/launch.mjs';
import { API_VERSION } from '../web/api-version.mjs';
import { ensureTmuxAvailable } from '../tmux.mjs';

export function createWebStartup(deps) {
  const {
    splitProcessArgs, sameResolvedPath,
    redactedLogText, CLI_NAME, PRODUCT_NAME, now,
    prepareLocalBus
  } = deps;

function hccWebProcessMatches(line, ctx) {
  const args = splitProcessArgs(line);
  const hccIndex = args.findIndex((arg) => sameResolvedPath(arg, commandPath()) || arg.endsWith('/hcc.mjs'));
  if (hccIndex < 0) return false;
  const hccArgs = args.slice(hccIndex + 1);
  const { global, rest } = splitGlobalArgs(hccArgs);
  if (rest[0] !== 'web') return false;
  return sameResolvedPath(global.root, ctx.root) ||
    sameResolvedPath(global.db, ctx.dbPath);
}

function currentProcessAncestorPids(ppidByPid) {
  const ancestors = new Set();
  let pid = process.ppid;
  while (Number.isFinite(pid) && pid > 0 && !ancestors.has(pid)) {
    ancestors.add(pid);
    pid = ppidByPid.get(pid);
  }
  return ancestors;
}

async function stopOrphanWebRuntimes(ctx, keepPid = null) {
  if (process.platform === 'win32') return;
  let output = '';
  try {
    output = spawnSync('ps', ['-eo', 'pid=,ppid=,args='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).stdout || '';
  } catch {
    return;
  }

  const rows = [];
  const ppidByPid = new Map();
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    if (!Number.isFinite(pid)) continue;
    if (Number.isFinite(ppid)) ppidByPid.set(pid, ppid);
    rows.push({ pid, args: match[3] });
  }

  const ancestorPids = currentProcessAncestorPids(ppidByPid);
  const pids = [];
  for (const row of rows) {
    if (row.pid === process.pid || row.pid === keepPid || ancestorPids.has(row.pid)) continue;
    if (hccWebProcessMatches(row.args, ctx)) pids.push(row.pid);
  }
  if (!pids.length) return;

  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  await sleep(250);
  for (const pid of pids) {
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

function assertWebTokenForHost(host, hasToken) {
  if (!isLoopbackHost(host) && !hasToken) {
    throw new CliError('WEB_EXPOSED_WITHOUT_TOKEN',
      `Refusing to expose the web console on ${host} without a token. A tokenless ` +
      `terminal on a non-loopback address lets anyone on the network run commands as you. ` +
      `Use --local to bind loopback only, or drop --no-token so a token is required.`);
  }
}

function webExposureWarning(host, port) {
  return `WARNING: hello-cc web is bound to ${host}:${port}, exposing a writable terminal ` +
    `(remote code execution surface) to your network. Anyone who reaches this port with the ` +
    `token can run commands as you. Prefer '--local' + 'ssh -L ${port}:127.0.0.1:${port}', ` +
    `or put it behind a TLS reverse proxy.`;
}

// Same-origin check for the WebSocket terminal upgrade. Browsers always send an
// Origin header on WebSocket handshakes, so a cross-site page attempting a
// cross-site WebSocket hijack (CSWSH) is rejected. Non-browser clients (the CLI,
// the `ws` library, regression tests) send no Origin and are allowed through to
// the token gate.
function webSocketOriginAllowed(req, options = {}) {
  const origin = req.headers.origin;
  if (!origin) return true;
  return requestOriginMatches(req, options);
}

function proxyOriginForOpts(opts) {
  const trustProxy = Boolean(opts['trust-proxy']);
  const value = String(opts['proxy-origin'] || '');
  if (!trustProxy && value) throw new CliError('BAD_ARGS', '--proxy-origin requires --trust-proxy');
  if (!trustProxy) return '';
  if (!value) throw new CliError('BAD_ARGS', '--trust-proxy requires --proxy-origin');
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('invalid origin');
    return parsed.origin;
  } catch {
    throw new CliError('BAD_ARGS', '--proxy-origin must be an http(s) origin without a path, query, or credentials');
  }
}

async function startWebBackground(ctx, args) {
  const opts = parseOpts(args, { booleans: ['local', 'no-token', 'no-guidance', 'no-discover', 'tls', 'trust-proxy'] });
  validateOpts('web', opts, ['host', 'port', 'token', 'local', 'no-token', 'no-guidance', 'no-discover', 'tls', 'trust-proxy', 'proxy-origin']);
  const requestedProxyOrigin = proxyOriginForOpts(opts);
  if (requestedProxyOrigin) opts['proxy-origin'] = requestedProxyOrigin;
  validateWebTokenOpts(opts);
  const requestedHost = expectedWebHost(opts);
  assertWebTokenForHost(requestedHost, !opts['no-token']);
  if (!isLoopbackHost(requestedHost)) console.error(redactedLogText(webExposureWarning(requestedHost, intOpt(opts, 'port', 8787)) + (opts.tls ? '' : ' Consider --tls to encrypt this connection.')));
  ensureTmuxAvailable({ autoInstall: true });
  const setup = await prepareLocalBus(ctx, {
    ...opts,
    installShims: process.env.HCC_SKIP_SHIM_INSTALL === '1' ? false : true
  });
  registerProject(ctx);

  const existing = await readHealthyGlobalRuntime();
  if (existing) {
    if (webRuntimeMatchesRequest(existing, opts)) {
      await stopOrphanWebRuntimes(ctx, existing.pid || null);
      rememberRuntimeToken(existing, opts);
      try {
        await runtimeRequest(ctx, 'POST', '/api/projects', { root: ctx.root, db: ctx.dbPath }, existing);
      } catch {}
      writeRuntime(ctx, {
        ...existing,
        api_version: API_VERSION,
        root: ctx.root,
        db: ctx.dbPath,
        project_root: ctx.root,
        global_runtime: true
      });
      return printWebRuntime(ctx, existing, { already: true, logFile: webLogPath(ctx), setup });
    }
    // TLS-2: an idempotent `hcc web` must not silently stop a TLS runtime and
    // downgrade to plaintext (or vice versa) when only --tls/--trust-proxy
    // differ. Refuse loudly instead; host/port/token mismatches below still
    // take the normal stop-and-restart path (legitimate reconfiguration).
    const runtimeTls = existing.tls === undefined
      ? /^https:/i.test(String(existing.base_url || ''))
      : Boolean(existing.tls);
    if (runtimeTls !== Boolean(opts.tls) ||
        Boolean(existing.trust_proxy) !== Boolean(opts['trust-proxy']) ||
        (existing.proxy_origin || '') !== (opts['proxy-origin'] || '')) {
      throw new CliError('RUNTIME_CONFIG_CONFLICT',
        `A ${runtimeTls ? 'TLS' : 'plaintext'} web runtime is already running${existing.trust_proxy ? ' with --trust-proxy' : ''} on port ${existing.port}. ` +
        `Run ${CLI_NAME} down first, or re-run with matching flags (${opts.tls ? '--tls' : 'no --tls'}${opts['trust-proxy'] ? ', --trust-proxy' : ''}).`);
    }
    try { await runtimeRequest(ctx, 'POST', '/api/runtime/stop', {}, existing); } catch {}
    await sleep(250);
  }
  await stopOrphanWebRuntimes(ctx);

  try { fs.rmSync(runtimePath(ctx), { force: true }); } catch {}
  try { fs.rmSync(globalRuntimePath(), { force: true }); } catch {}

  const logFile = webLogPath(ctx);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  // bg-05: rotate web.log once it grows past 5 MB (keep the previous .1).
  try {
    if (fs.statSync(logFile).size > 5 * 1024 * 1024) {
      try { fs.rmSync(`${logFile}.1`, { force: true }); } catch {}
      try { fs.renameSync(logFile, `${logFile}.1`); } catch {}
    }
  } catch {}
  const redactedStart = redactedLogText(`${CLI_NAME} web ${redactCliArgs(args).join(' ')}`);
  fs.appendFileSync(logFile, `\n[${new Date().toISOString()}] ${redactedStart}\n`, { mode: 0o600 });
  // The runtime echoes token-bearing URLs into web.log; keep it owner-only so a
  // co-tenant on the machine cannot read the token (net-02).
  try { fs.chmodSync(logFile, 0o600); } catch {}
  const logFd = fs.openSync(logFile, 'a');

  const childArgs = [
    commandPath(),
    '--root', ctx.root,
    '--db', ctx.dbPath,
    'web',
    ...args
  ];
  const childEnv = {
    ...process.env,
    [WEB_CHILD_ENV]: '1',
    HCC_ROOT: ctx.root,
    HCC_DB: ctx.dbPath
  };

  let child;
  try {
    child = spawn(process.execPath, childArgs, {
      cwd: ctx.cwd,
      env: childEnv,
      detached: true,
      stdio: ['ignore', logFd, logFd]
    });
  } finally {
    try { fs.closeSync(logFd); } catch {}
  }

  const runtime = await waitForStartedRuntime(ctx, child, logFile);
  child.unref();
  return printWebRuntime(ctx, runtime, { already: false, logFile, setup });
}

async function waitForStartedRuntime(ctx, child, logFile) {
  let exitInfo = null;
  child.once('exit', (code, signal) => {
    exitInfo = { code, signal };
  });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const runtime = await readHealthyGlobalRuntime();
    if (runtime) return runtime;
    if (exitInfo) {
      const detail = redactedLogText(tailFile(logFile));
      throw new CliError('RUNTIME_START_FAILED',
        `${PRODUCT_NAME} runtime exited before it became healthy` +
        ` (code=${exitInfo.code ?? ''}${exitInfo.signal ? ` signal=${exitInfo.signal}` : ''}).` +
        `${detail ? `\n\nLast log lines:\n${detail}` : ''}`,
        { log: logFile });
    }
    await sleep(150);
  }

  try {
    if (process.platform === 'win32') process.kill(child.pid, 'SIGTERM');
    else process.kill(-child.pid, 'SIGTERM');
  } catch {}
  const detail = redactedLogText(tailFile(logFile));
  throw new CliError('RUNTIME_START_TIMEOUT',
    `${PRODUCT_NAME} runtime did not become healthy within 15s.` +
    `${detail ? `\n\nLast log lines:\n${detail}` : ''}`,
    { log: logFile });
}

function printWebRuntime(ctx, runtime, opts = {}) {
  const logFile = opts.logFile || webLogPath(ctx);
  const data = {
    status: opts.already ? 'already_running' : 'started',
    pid: runtime.pid || null,
    root: ctx.root,
    db: ctx.dbPath,
    host: runtime.host || null,
    port: runtime.port || null,
    url: publicRuntimeUrl(runtime, ctx.root),
    local_url: localRuntimeUrl(runtime, ctx.root),
    runtime: runtimePath(ctx),
    log: logFile,
    stop: `${CLI_NAME} down`
  };
  return printResult(ctx, data, (r) => {
    const lines = [
      opts.already
        ? `${PRODUCT_NAME} web already running in background`
        : `${PRODUCT_NAME} web started in background`,
      `pid: ${r.pid}`,
      `project: ${r.root}`,
      `database: ${r.db}`,
      `runtime: ${r.runtime}`,
      `log: ${r.log}`,
      `open: ${r.url}`
    ];
    if (r.local_url !== r.url) lines.push(`local: ${r.local_url}`);
    if (opts.setup?.shims?.installed?.length) {
      lines.push(`shims: installed ${opts.setup.shims.installed.map((p) => path.basename(p)).join(', ')}`);
      if (opts.setup.shims.pathUpdated && opts.setup.shims.rcFile) {
        lines.push(`PATH updated in ${opts.setup.shims.rcFile}; open a new terminal or source it`);
      }
    }
    if (opts.setup?.warnings?.length) {
      lines.push(...opts.setup.warnings.map((warning) => `warning: ${warning}`));
    }
    lines.push(`stop: ${r.stop}`);
    return lines.join('\n');
  });
}

  return {
    hccWebProcessMatches, currentProcessAncestorPids, stopOrphanWebRuntimes,
    assertWebTokenForHost, webExposureWarning, webSocketOriginAllowed,
    proxyOriginForOpts, startWebBackground, waitForStartedRuntime, printWebRuntime
  };
}
