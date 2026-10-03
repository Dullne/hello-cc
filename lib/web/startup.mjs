// Web startup helpers extracted from bin/hcc.mjs.
// hcc web process matching, orphan runtime reaping, exposure/token checks,
// background child launch, readiness polling, and runtime banner printing.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash, randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { CliError } from '../shared/errors.mjs';
import { redactCliArgs } from '../shared/redact.mjs';
import { intOpt, parseOpts, splitGlobalArgs, validateOpts } from '../cli-args.mjs';
import { printResult } from '../format.mjs';
import { commandPath, tailFile } from '../cli-runtime.mjs';
import { compareProcessIdentity, inspectProcessIdentity } from '../process/identity.mjs';
import { spawnPinnedCwdProcess } from '../process/pinned-cwd.mjs';
import { assertSelectedCwdSnapshot, captureSelectedCwdSnapshot } from '../process/selected-cwd-identity.mjs';
import { registerProject } from '../runtime/projects.mjs';
import { runtimePath, globalRuntimePath, globalStateDir, webLogPath } from '../runtime/paths.mjs';
import { resolveProjectDatabase, secureExistingProjectStateDirectory } from '../runtime/project-path.mjs';
import { privateProjectStateDir } from '../runtime/private-state.mjs';
import { openPrivateAppendFile } from '../runtime/private-file.mjs';
import { readHealthyGlobalRuntime, writeRuntime } from '../runtime/state.mjs';
import { runtimeRequest } from '../runtime/client.mjs';
import { withFileLock } from '../shared/file-lock.mjs';
import { writeJsonSafe } from '../shared/json-file.mjs';
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

export const WEB_RUNTIME_START_TIMEOUT_MS = 60_000;
const WEB_START_LOCK_WAIT_MS = WEB_RUNTIME_START_TIMEOUT_MS + 30_000;

function webStartOwnerAlive(owner) {
  const pid = owner?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return true;
  const observed = inspectProcessIdentity(pid);
  if (observed.state === 'dead') return false;
  if (owner.process_identity && observed.state === 'live') {
    return compareProcessIdentity(owner.process_identity, observed.identity) !== 'dead';
  }
  return true;
}

async function withWebStartLock(fn) {
  const lockFile = path.join(globalStateDir(), 'web-start.lock');
  const owner = {
    pid: process.pid,
    process_identity: inspectProcessIdentity(process.pid).identity,
    nonce: randomUUID()
  };
  const deadline = performance.now() + WEB_START_LOCK_WAIT_MS;
  while (true) {
    const acquired = withFileLock(lockFile, (lockedFile) => {
      if (fs.existsSync(lockedFile)) {
        let previous = null;
        try { previous = JSON.parse(fs.readFileSync(lockedFile, 'utf8')); } catch {}
        if (!previous || webStartOwnerAlive(previous)) return false;
      }
      writeJsonSafe(lockedFile, owner, { mode: 0o600 });
      return true;
    });
    if (acquired) break;
    if (performance.now() >= deadline) {
      throw new CliError('WEB_START_LOCK_TIMEOUT',
        'Timed out waiting for another web startup to finish.');
    }
    await sleep(100);
  }
  try {
    return await fn();
  } finally {
    withFileLock(lockFile, (lockedFile) => {
      let current = null;
      try { current = JSON.parse(fs.readFileSync(lockedFile, 'utf8')); } catch {}
      if (current?.nonce === owner.nonce && current.pid === owner.pid) {
        fs.rmSync(lockedFile, { force: true });
      }
    });
  }
}

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
    rows.push({ pid, ppid, args: match[3] });
  }

  const ancestorPids = currentProcessAncestorPids(ppidByPid);
  const candidates = [];
  for (const row of rows) {
    // A live parent still owns its web command. In particular, another CLI
    // invocation waiting for the startup lock is not an orphan runtime.
    if (row.ppid !== 1) continue;
    if (row.pid === process.pid || row.pid === keepPid || ancestorPids.has(row.pid)) continue;
    if (!hccWebProcessMatches(row.args, ctx)) continue;
    const observed = inspectProcessIdentity(row.pid);
    if (observed.state === 'live' &&
        observed.identity.commandHash === createHash('sha256').update(row.args.trim()).digest('hex')) {
      candidates.push(observed.identity);
    }
  }
  if (!candidates.length) return;

  const stillSameProcess = (identity) => {
    const observed = inspectProcessIdentity(identity.pid);
    return observed.state === 'live' &&
      compareProcessIdentity(identity, observed.identity) === 'live' &&
      identity.commandHash === observed.identity.commandHash;
  };

  for (const identity of candidates) {
    if (!stillSameProcess(identity)) continue;
    try { process.kill(identity.pid, 'SIGTERM'); } catch {}
  }
  await sleep(250);
  for (const identity of candidates) {
    if (!stillSameProcess(identity)) continue;
    try {
      process.kill(identity.pid, 'SIGKILL');
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
  return withWebStartLock(() => startWebBackgroundLocked(ctx, args, opts));
}

async function startWebBackgroundLocked(ctx, args, opts) {
  // `prepareLocalBus` opens the database and may write guidance before its
  // first await. Resolve both paths before handing it a context that can be
  // redirected by a symlink alias while setup is in progress.
  if (!fs.existsSync(ctx.root)) fs.mkdirSync(ctx.root, { recursive: true });
  const expectedRootIdentity = ctx.initialRootIdentity || captureSelectedCwdSnapshot(ctx.root);
  assertSelectedCwdSnapshot(expectedRootIdentity);
  const requestedRuntimeFile = path.join(path.resolve(ctx.root), '.hello-cc', 'runtime.json');
  const bound = resolveProjectDatabase({
    root: ctx.root, db: requestedRuntimeFile, createStateDir: true
  });
  const boundRoot = bound.root;
  const requestedDb = path.resolve(ctx.dbPath);
  const managedDb = [
    path.join(path.resolve(ctx.root), '.hello-cc'),
    path.join(boundRoot, '.hello-cc'),
    privateProjectStateDir(boundRoot)
  ].some((stateDir) => {
    const relative = path.relative(stateDir, requestedDb);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative));
  });
  // External --db/HCC_DB paths are a documented caller-managed option. Only
  // project-managed DBs need this canonicalization (including alias-spelled
  // nested paths whose parent has not been created yet).
  const boundDb = managedDb
    ? resolveProjectDatabase({
      root: ctx.root, db: requestedDb, createStateDir: true, createDatabaseParents: true
    }).db
    : requestedDb;
  const boundCtx = { ...ctx, root: boundRoot, dbPath: boundDb };
  const boundStateDir = bound.stateDir;
  const runtimeFile = path.join(boundStateDir, 'runtime.json');
  const logFile = path.join(boundStateDir, 'web.log');
  const assertBoundProject = () => {
    assertSelectedCwdSnapshot(expectedRootIdentity);
    const current = resolveProjectDatabase({ root: ctx.root, db: requestedRuntimeFile });
    if (current.root !== boundRoot || current.stateDir !== boundStateDir ||
        (managedDb && resolveProjectDatabase({ root: ctx.root, db: requestedDb }).db !== boundDb)) {
      throw new CliError('PROJECT_PATH_FORBIDDEN', 'Project state route changed during Web startup');
    }
    secureExistingProjectStateDirectory(boundRoot);
  };
  assertBoundProject();
  const setup = await prepareLocalBus(boundCtx, {
    ...opts,
    installShims: process.env.HCC_SKIP_SHIM_INSTALL === '1' ? false : true
  });
  assertBoundProject();
  registerProject(boundCtx);

  const existing = await readHealthyGlobalRuntime();
  if (existing) {
    if (webRuntimeMatchesRequest(existing, opts)) {
      await stopOrphanWebRuntimes(boundCtx, existing.pid || null);
      rememberRuntimeToken(existing, opts);
      try {
        await runtimeRequest(boundCtx, 'POST', '/api/projects', { root: boundRoot, db: boundCtx.dbPath }, existing);
      } catch {}
      assertBoundProject();
      writeRuntime(boundCtx, {
        ...existing,
        api_version: API_VERSION,
        root: boundRoot,
        db: boundCtx.dbPath,
        project_root: boundRoot,
        global_runtime: true
      });
      return printWebRuntime(boundCtx, existing, { already: true, logFile, runtimeFile, setup });
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
    try { await runtimeRequest(boundCtx, 'POST', '/api/runtime/stop', {}, existing); } catch {}
    await sleep(250);
  }
  assertBoundProject();
  await stopOrphanWebRuntimes(boundCtx);

  // A project path can be reused for a different directory after setup. Do
  // not remove its old private runtime pointer or append to its old Web log.
  assertBoundProject();
  try { fs.rmSync(runtimeFile, { force: true }); } catch {}
  try { fs.rmSync(globalRuntimePath(), { force: true }); } catch {}

  assertBoundProject();
  let logFd = openPrivateAppendFile(logFile);
  try {
    // bg-05: rotate web.log once it grows past 5 MB (keep the previous .1).
    if (fs.fstatSync(logFd).size > 5 * 1024 * 1024) {
      const previous = `${logFile}.1`;
      try {
        const stat = fs.lstatSync(previous);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
            (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
          throw new CliError('PROJECT_PATH_FORBIDDEN', `Rotated Web log is not owned: ${previous}`);
        }
        fs.unlinkSync(previous);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      fs.closeSync(logFd);
      logFd = null;
      fs.renameSync(logFile, previous);
      logFd = openPrivateAppendFile(logFile);
    }
    const redactedStart = redactedLogText(`${CLI_NAME} web ${redactCliArgs(args).join(' ')}`);
    assertBoundProject();
    fs.writeSync(logFd, `\n[${new Date().toISOString()}] ${redactedStart}\n`);
  } catch (error) {
    if (logFd !== null) fs.closeSync(logFd);
    throw error;
  }

  const childArgs = [
    commandPath(),
    '--root', boundRoot,
    '--db', boundCtx.dbPath,
    'web',
    ...args
  ];
  const childEnv = {
    ...process.env,
    [WEB_CHILD_ENV]: '1',
    HCC_ROOT: boundRoot,
    HCC_DB: boundCtx.dbPath
  };

  let child;
  try {
    child = spawnPinnedCwdProcess(process.execPath, childArgs, {
      cwd: boundRoot,
      expectedIdentity: expectedRootIdentity,
      env: childEnv,
      detached: true,
      stdio: ['ignore', logFd, logFd]
    });
  } finally {
    try { fs.closeSync(logFd); } catch {}
  }

  const runtime = await waitForStartedRuntime(boundCtx, child, logFile);
  child.unref();
  return printWebRuntime(boundCtx, runtime, { already: false, logFile, runtimeFile, setup });
}

async function waitForStartedRuntime(ctx, child, logFile) {
  let exitInfo = null;
  child.once('exit', (code, signal) => {
    exitInfo = { code, signal };
  });

  const deadline = Date.now() + WEB_RUNTIME_START_TIMEOUT_MS;
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
    `${PRODUCT_NAME} runtime did not become healthy within ${WEB_RUNTIME_START_TIMEOUT_MS / 1000}s.` +
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
    runtime: opts.runtimeFile || runtimePath(ctx),
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
