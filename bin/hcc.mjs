#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { URL, fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// Lazy-load lib modules (they may import node-pty which needs to be optional)
const _libDir = path.resolve(fileURLToPath(import.meta.url), '..', '..', 'lib');
async function loadDiscover() { return import(path.join(_libDir, 'discover.mjs')); }
async function loadSetup()    { return import(path.join(_libDir, 'setup.mjs')); }

const VERSION = '0.2.0';
const PRODUCT_NAME = 'hello-cc';
const CLI_NAME = 'hcc';
const DEFAULT_LOCK_TTL = 900;
const ACTIVE_PEER_TTL = 600;
// Directory under .hello-cc/ for optional external PTY buffer files.
const BUFS_DIR_NAME = 'bufs';
const WEB_CHILD_ENV = 'HCC_WEB_CHILD';

class CliError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function iso(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toISOString();
}

function runGit(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function hasHccRootSync(cwd) {
  if (!cwd) return null;
  const dir = path.resolve(cwd);
  const hccDir = path.join(dir, '.hello-cc');
  return fs.existsSync(path.join(hccDir, 'mesh.db')) ||
    fs.existsSync(path.join(hccDir, 'config.json'));
}

function detectRoot(cwd, explicitRoot) {
  if (explicitRoot) return path.resolve(explicitRoot);
  if (process.env.HCC_ROOT) return path.resolve(process.env.HCC_ROOT);
  return path.resolve(cwd);
}

function detectBranch(cwd) {
  return runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd) || '';
}

function splitGlobalArgs(argv) {
  const global = { json: false, root: null, db: null };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      global.json = true;
    } else if (arg === '--root') {
      global.root = argv[++i];
    } else if (arg.startsWith('--root=')) {
      global.root = arg.slice('--root='.length);
    } else if (arg === '--db') {
      global.db = argv[++i];
    } else if (arg.startsWith('--db=')) {
      global.db = arg.slice('--db='.length);
    } else {
      rest.push(arg);
    }
  }
  return { global, rest };
}

function parseOpts(args, spec = {}) {
  const booleans = new Set(spec.booleans || []);
  const arrays = new Set(spec.arrays || []);
  const opts = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--') || arg === '--') {
      opts._.push(arg);
      continue;
    }
    let key;
    let value;
    const eq = arg.indexOf('=');
    if (eq >= 0) {
      key = arg.slice(2, eq);
      value = arg.slice(eq + 1);
    } else {
      key = arg.slice(2);
      if (booleans.has(key)) {
        value = true;
      } else {
        value = args[++i];
      }
    }
    if (!key) throw new CliError('BAD_ARGS', `Invalid option: ${arg}`);
    if (value === undefined) throw new CliError('BAD_ARGS', `Missing value for --${key}`);
    if (arrays.has(key)) {
      if (!opts[key]) opts[key] = [];
      opts[key].push(value);
    } else {
      opts[key] = value;
    }
  }
  return opts;
}

function validateOpts(command, opts, allowed = []) {
  const allowedSet = new Set(['_', ...allowed]);
  for (const key of Object.keys(opts)) {
    if (!allowedSet.has(key)) throw new CliError('BAD_ARGS', `${command}: unknown option --${key}`);
  }
  if (opts._?.length) throw new CliError('BAD_ARGS', `${command}: unexpected argument ${opts._[0]}`);
}

function required(opts, key, envName = null) {
  const value = opts[key] || (envName ? process.env[envName] : null);
  if (!value) throw new CliError('BAD_ARGS', `Missing --${key}${envName ? ` or $${envName}` : ''}`);
  return value;
}

function sanitizePeerPart(value, fallback = 'peer') {
  const text = String(value || '').toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return text || fallback;
}

function shortHash(value) {
  return createHash('sha1').update(String(value)).digest('hex').slice(0, 8);
}

function currentTtyName() {
  if (process.env.TTY) return process.env.TTY;
  const result = spawnSync('tty', [], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  });
  if (result.status !== 0) return '';
  const tty = result.stdout.trim();
  return tty && tty !== 'not a tty' ? tty : '';
}

let ancestorCliInfoCache = undefined;

function readProcCmdline(pid) {
  if (process.platform !== 'linux' || !pid) return [];
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

function readProcEnv(pid) {
  const env = {};
  if (process.platform !== 'linux' || !pid) return env;
  try {
    for (const entry of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      const eq = entry.indexOf('=');
      if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
  } catch {}
  return env;
}

function readProcParentPid(pid) {
  if (process.platform !== 'linux' || !pid) return null;
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = status.match(/^PPid:\s+(\d+)/m);
    return match ? Number.parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

function argsLookLikeCli(args, kind) {
  return args.some((arg) => {
    const text = String(arg || '').toLowerCase();
    const base = path.basename(text);
    if (kind === 'codex') return base === 'codex' || text.includes('/codex') || text.includes('@openai/codex');
    if (kind === 'claude') return base === 'claude' || base === 'claude-code' || text.includes('/claude') || text.includes('@anthropic-ai/claude-code');
    return false;
  });
}

function detectCliKindFromProcess(args, env) {
  if (env.CLAUDE_CODE_SESSION_ID || env.CLAUDECODE === '1' || argsLookLikeCli(args, 'claude')) return 'claude';
  if (
    env.CODEX_SESSION_ID ||
    env.CODEX_THREAD_ID ||
    env.CODEX_MANAGED_BY_NPM === '1' ||
    env.CODEX_MANAGED_BY_BUN === '1' ||
    argsLookLikeCli(args, 'codex')
  ) return 'codex';
  return null;
}

function readAncestorCliInfo() {
  if (ancestorCliInfoCache !== undefined) return ancestorCliInfoCache;
  if (process.platform !== 'linux') {
    ancestorCliInfoCache = null;
    return ancestorCliInfoCache;
  }

  let pid = process.ppid;
  const seen = new Set();
  for (let depth = 0; pid && pid > 1 && depth < 12 && !seen.has(pid); depth += 1) {
    seen.add(pid);
    const args = readProcCmdline(pid);
    const env = readProcEnv(pid);
    const kind = detectCliKindFromProcess(args, env);
    if (kind) {
      ancestorCliInfoCache = { pid, kind, args, env };
      return ancestorCliInfoCache;
    }
    pid = readProcParentPid(pid);
  }

  ancestorCliInfoCache = null;
  return ancestorCliInfoCache;
}

function resumeIdFromArgs(kind, args) {
  if (!Array.isArray(args)) return null;
  if (kind === 'claude') {
    if (args.includes('--fork-session')) return null;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if ((arg === '--resume' || arg === '-r') && args[i + 1]) return args[i + 1];
      if (arg.startsWith('--resume=')) return arg.slice('--resume='.length);
    }
  }
  if (kind === 'codex') {
    const idx = args.indexOf('resume');
    if (idx >= 0) {
      for (let i = idx + 1; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--last') return null;
        if (arg.startsWith('-')) continue;
        return arg;
      }
    }
  }
  return null;
}

function autoPeerProviderSession(kind) {
  const ancestor = readAncestorCliInfo();
  const ancestorEnv = ancestor?.kind === kind ? ancestor.env || {} : {};
  const sessionId = kind === 'claude'
    ? (process.env.CLAUDE_CODE_SESSION_ID || ancestorEnv.CLAUDE_CODE_SESSION_ID || '')
    : kind === 'codex'
      ? (process.env.CODEX_SESSION_ID || process.env.CODEX_THREAD_ID || ancestorEnv.CODEX_SESSION_ID || ancestorEnv.CODEX_THREAD_ID || '')
      : '';
  const resumeId = ancestor?.kind === kind ? resumeIdFromArgs(kind, ancestor.args) : null;
  return { sessionId, resumeId, ancestor };
}

function autoPeerSessionId(kind) {
  return autoPeerProviderSession(kind).sessionId;
}

function autoPeerResumeId(kind) {
  return autoPeerProviderSession(kind).resumeId;
}

function autoPeerKind(kindHint = 'shell') {
  if (process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDECODE === '1') return 'claude';
  if (
    process.env.CODEX_SESSION_ID ||
    process.env.CODEX_THREAD_ID ||
    process.env.CODEX_MANAGED_BY_NPM === '1' ||
    process.env.CODEX_MANAGED_BY_BUN === '1'
  ) return 'codex';
  const ancestor = readAncestorCliInfo();
  if (ancestor?.kind) return ancestor.kind;
  return kindHint || 'shell';
}

function autoPeerBasis(kind = null) {
  const ancestor = readAncestorCliInfo();
  if (ancestor && (!kind || ancestor.kind === kind)) return `cli:${ancestor.kind}:${ancestor.pid}`;
  const ttyName = currentTtyName();
  if (process.env.TMUX_PANE) return `tmux:${process.env.TMUX_PANE}`;
  if (ttyName) return `tty:${ttyName}`;
  return `ppid:${process.ppid}`;
}

function autoPeerId(ctx, kindHint = 'shell') {
  const kind = autoPeerKind(kindHint);
  const { sessionId, resumeId } = autoPeerProviderSession(kind);
  const providerId = resumeId || sessionId;
  if (providerId) return `${kind}-${sanitizePeerPart(providerId.slice(0, 8), shortHash(providerId))}`;

  const basis = autoPeerBasis(kind);
  return `${kind}-${shortHash(`${ctx.root}:${basis}`)}`;
}

function resolveCurrentPeer(ctx, opts = {}, key = 'peer', kindHint = 'shell') {
  if (opts[key]) return { id: opts[key], auto: false };
  if (process.env.HCC_PEER) return { id: process.env.HCC_PEER, auto: false };
  return { id: autoPeerId(ctx, kindHint), auto: true };
}

function currentPeer(ctx, opts = {}, key = 'peer', kindHint = 'shell') {
  return resolveCurrentPeer(ctx, opts, key, kindHint).id;
}

function autoPeerDefaults(ctx, kindHint = 'shell', status = 'working') {
  const kind = autoPeerKind(kindHint);
  const ancestor = readAncestorCliInfo();
  return {
    kind,
    role: 'peer',
    worktree: ctx.cwd,
    branch: detectBranch(ctx.cwd),
    pid: ancestor?.kind === kind ? ancestor.pid : process.ppid,
    status,
    capabilities: 'auto-shell'
  };
}

function intOpt(opts, key, fallback = null) {
  if (opts[key] === undefined || opts[key] === null || opts[key] === '') return fallback;
  const value = Number.parseInt(String(opts[key]), 10);
  if (!Number.isFinite(value)) throw new CliError('BAD_ARGS', `--${key} must be an integer`);
  return value;
}

function createContext(global) {
  const cwd = process.cwd();
  const root = detectRoot(cwd, global.root);
  const dbPath = path.resolve(global.db || process.env.HCC_DB || path.join(root, '.hello-cc', 'mesh.db'));
  return { cwd, root, dbPath, json: global.json, explicitRoot: Boolean(global.root || process.env.HCC_ROOT) };
}

function runtimePath(ctx) {
  return path.join(ctx.root, '.hello-cc', 'runtime.json');
}

function webLogPath(ctx) {
  return path.join(ctx.root, '.hello-cc', 'web.log');
}

function globalStateDir() {
  return path.join(os.homedir(), '.hello-cc');
}

function globalRuntimePath() {
  return path.join(globalStateDir(), 'runtime.json');
}

function projectRegistryPath() {
  return path.join(globalStateDir(), 'projects.json');
}

function contextForProject(root, dbPath = null, base = {}) {
  const resolvedRoot = path.resolve(root);
  return {
    cwd: base.cwd || resolvedRoot,
    root: resolvedRoot,
    dbPath: path.resolve(dbPath || path.join(resolvedRoot, '.hello-cc', 'mesh.db')),
    json: Boolean(base.json),
    explicitRoot: true
  };
}

function projectRecord(ctx) {
  return {
    root: ctx.root,
    db: ctx.dbPath,
    name: path.basename(ctx.root) || ctx.root,
    last_seen_at: now()
  };
}

function readProjectRegistry() {
  const file = projectRegistryPath();
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rows = Array.isArray(parsed?.projects) ? parsed.projects : [];
    return rows
      .filter((p) => p && typeof p.root === 'string')
      .map((p) => ({
        root: path.resolve(p.root),
        db: path.resolve(p.db || path.join(p.root, '.hello-cc', 'mesh.db')),
        name: String(p.name || path.basename(p.root) || p.root),
        last_seen_at: Number.parseInt(p.last_seen_at || '0', 10) || 0
      }));
  } catch {
    return [];
  }
}

function writeProjectRegistry(projects) {
  const file = projectRegistryPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const unique = new Map();
  for (const project of projects) {
    if (!project?.root) continue;
    unique.set(path.resolve(project.root), {
      root: path.resolve(project.root),
      db: path.resolve(project.db || path.join(project.root, '.hello-cc', 'mesh.db')),
      name: String(project.name || path.basename(project.root) || project.root),
      last_seen_at: Number.parseInt(project.last_seen_at || '0', 10) || 0
    });
  }
  const rows = [...unique.values()].sort((a, b) => (b.last_seen_at || 0) - (a.last_seen_at || 0));
  fs.writeFileSync(file, JSON.stringify({ projects: rows }, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return rows;
}

function registerProject(ctx) {
  const rows = readProjectRegistry().filter((p) => path.resolve(p.root) !== ctx.root);
  rows.unshift(projectRecord(ctx));
  return writeProjectRegistry(rows);
}

function registerProjectActivity(ctx) {
  try { registerProject(ctx); } catch {}
}

function readGlobalRuntimeFile() {
  const file = globalRuntimePath();
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    try { fs.rmSync(file, { force: true }); } catch {}
    return null;
  }
}

function writeGlobalRuntime(runtime) {
  const file = globalRuntimePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(runtime, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

function runtimeConnectHost(host) {
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1';
  return host;
}

function runtimeBaseUrl(host, port) {
  return `http://${runtimeConnectHost(host)}:${port}`;
}

function writeRuntime(ctx, runtime) {
  const file = runtimePath(ctx);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(runtime, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

function readRuntime(ctx) {
  if (process.env.HCC_RUNTIME_URL) {
    return {
      base_url: process.env.HCC_RUNTIME_URL,
      token: process.env.HCC_RUNTIME_TOKEN || '',
      source: 'env'
    };
  }
  const file = runtimePath(ctx);
  if (fs.existsSync(file)) {
    try {
      const runtime = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!runtime.base_url) throw new Error('missing base_url');
      return { ...runtime, source: file };
    } catch {
      try { fs.rmSync(file, { force: true }); } catch {}
    }
  }
  const global = readGlobalRuntimeFile();
  if (global?.base_url) {
    return { ...global, source: globalRuntimePath(), global: true };
  }
  throw new CliError('RUNTIME_NOT_RUNNING',
    `No running ${PRODUCT_NAME} web runtime found. Start it with:\n  ${CLI_NAME} web`);
}

function readRuntimeFile(ctx) {
  const file = runtimePath(ctx);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function probeRuntime(runtime) {
  if (!runtime?.base_url) return false;
  const url = new URL('/api/runtime', runtime.base_url);
  const headers = {};
  if (runtime.token) headers.Authorization = `Bearer ${runtime.token}`;
  try {
    const response = await fetch(url, { headers });
    return response.ok;
  } catch {
    return false;
  }
}

async function readHealthyRuntime(ctx) {
  try {
    const runtime = readRuntimeFile(ctx);
    if (runtime && await probeRuntime(runtime)) return runtime;
    const global = readGlobalRuntimeFile();
    if (global && await probeRuntime(global)) return global;
    return null;
  } catch {
    return null;
  }
}

async function readHealthyGlobalRuntime() {
  try {
    const runtime = readGlobalRuntimeFile();
    if (!runtime) return null;
    return await probeRuntime(runtime) ? runtime : null;
  } catch {
    return null;
  }
}

function clearRuntime(ctx, pid = process.pid) {
  const file = runtimePath(ctx);
  if (fs.existsSync(file)) {
    try {
      const runtime = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!runtime.pid || runtime.pid === pid) fs.rmSync(file, { force: true });
    } catch {
      fs.rmSync(file, { force: true });
    }
  }
  const globalFile = globalRuntimePath();
  if (!fs.existsSync(globalFile)) return;
  try {
    const runtime = JSON.parse(fs.readFileSync(globalFile, 'utf8'));
    if (!runtime.pid || runtime.pid === pid) fs.rmSync(globalFile, { force: true });
  } catch {
    fs.rmSync(globalFile, { force: true });
  }
}

function shellQuoteArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function shellCommand(args) {
  return args.map(shellQuoteArg).join(' ');
}

function runtimeUrlQuery(runtime, projectRoot = null) {
  const parts = [];
  if (runtime.token) parts.push(`token=${encodeURIComponent(runtime.token)}`);
  if (projectRoot) parts.push(`project=${encodeURIComponent(projectRoot)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

function publicRuntimeUrl(runtime, projectRoot = null) {
  const host = runtime.host === '0.0.0.0' || runtime.host === '::'
    ? '<machine-ip>'
    : runtime.host || runtimeConnectHost(runtime.host || '127.0.0.1');
  return `http://${host}:${runtime.port}/${runtimeUrlQuery(runtime, projectRoot)}`;
}

function localRuntimeUrl(runtime, projectRoot = null) {
  const host = runtimeConnectHost(runtime.host || '127.0.0.1');
  return `http://${host}:${runtime.port}/${runtimeUrlQuery(runtime, projectRoot)}`;
}

function tailFile(file, maxBytes = 12000) {
  try {
    const stat = fs.statSync(file);
    const size = Math.min(stat.size, maxBytes);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, Math.max(0, stat.size - size));
      return buf.toString('utf8').trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function childSessionEnv(extra = {}, baseEnv = process.env) {
  const env = { ...(baseEnv || {}), ...extra };
  delete env[WEB_CHILD_ENV];
  return env;
}

const LAUNCH_FINGERPRINT_ENV = 'HCC_LAUNCH_FINGERPRINT';
const PROVIDER_STATE_ENV = 'HCC_PROVIDER_STATE';

const LAUNCH_ENV_IGNORED_KEYS = new Set([
  '_',
  'COLUMNS',
  'HCC_DB',
  'HCC_NO_AUTO_INSTALL_TMUX',
  'HCC_PEER',
  'HCC_ROOT',
  PROVIDER_STATE_ENV,
  'HCC_SHIM_ENSURED',
  'HCC_SHIM_NO_ATTACH',
  'HCC_WEB_TOKEN',
  LAUNCH_FINGERPRINT_ENV,
  'LINES',
  'OLDPWD',
  'PROMPT_COMMAND',
  'PS1',
  'PS2',
  'PS4',
  'PWD',
  'SHLVL',
  'TERM',
  'TERMCAP',
  'TMUX',
  'TMUX_PANE',
  'WINDOWID'
]);

function launchEnvironmentFingerprint(env) {
  const entries = Object.entries(env || {})
    .filter(([key, value]) =>
      value !== undefined &&
      value !== null &&
      !LAUNCH_ENV_IGNORED_KEYS.has(key) &&
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    )
    .map(([key, value]) => [key, String(value)])
    .sort(([a], [b]) => a.localeCompare(b));
  return shortHash(JSON.stringify(entries));
}

function launchFingerprint({ command, cwd, env }) {
  return shortHash(JSON.stringify({
    command: command || '',
    cwd: cwd || '',
    env: launchEnvironmentFingerprint(env || {})
  }));
}

function runTmux(args, opts = {}) {
  const result = spawnSync('tmux', args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    input: opts.input || ''
  });
  if (result.error) {
    throw new CliError('TMUX_ERROR', `tmux failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || '').trim() || `tmux ${args.join(' ')} failed`;
    throw new CliError('TMUX_ERROR', message);
  }
  return result.stdout || '';
}

function tmuxInstallHint() {
  if (process.platform === 'darwin') return 'Install tmux with: brew install tmux';
  if (process.platform === 'linux') {
    if (fs.existsSync('/etc/debian_version')) return 'Install tmux with: sudo apt-get update && sudo apt-get install -y tmux';
    if (fs.existsSync('/etc/alpine-release')) return 'Install tmux with: sudo apk add tmux';
    if (fs.existsSync('/etc/arch-release')) return 'Install tmux with: sudo pacman -S --noconfirm tmux';
    if (fs.existsSync('/etc/fedora-release')) return 'Install tmux with: sudo dnf install -y tmux';
    return 'Install tmux with your system package manager.';
  }
  return 'Install tmux and make sure it is on PATH.';
}

function commandExists(name) {
  return spawnSync('sh', ['-lc', `command -v ${shellQuoteArg(name)} >/dev/null 2>&1`], {
    stdio: ['ignore', 'ignore', 'ignore']
  }).status === 0;
}

function runInstallCommand(command) {
  const result = spawnSync('sh', ['-lc', command], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000
  });
  return {
    ok: result.status === 0,
    output: [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
  };
}

function tryInstallTmux() {
  if (process.env.HCC_NO_AUTO_INSTALL_TMUX === '1') {
    return { ok: false, output: 'automatic tmux installation disabled by HCC_NO_AUTO_INSTALL_TMUX=1' };
  }
  const sudo = typeof process.getuid === 'function' && process.getuid() === 0 ? '' : (commandExists('sudo') ? 'sudo ' : '');
  if (process.platform === 'darwin' && commandExists('brew')) {
    return runInstallCommand('brew install tmux');
  }
  if (process.platform === 'linux') {
    if (commandExists('apt-get')) {
      const update = runInstallCommand(`${sudo}apt-get update`);
      if (!update.ok) return update;
      return runInstallCommand(`${sudo}apt-get install -y tmux`);
    }
    if (commandExists('dnf')) return runInstallCommand(`${sudo}dnf install -y tmux`);
    if (commandExists('yum')) return runInstallCommand(`${sudo}yum install -y tmux`);
    if (commandExists('apk')) return runInstallCommand(`${sudo}apk add tmux`);
    if (commandExists('pacman')) return runInstallCommand(`${sudo}pacman -S --noconfirm tmux`);
  }
  return { ok: false, output: 'no supported package manager found' };
}

function ensureTmuxAvailable({ autoInstall = true } = {}) {
  if (spawnSync('tmux', ['-V'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).status === 0) return;
  let install = { ok: false, output: '' };
  if (autoInstall) {
    install = tryInstallTmux();
    if (install.ok && spawnSync('tmux', ['-V'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).status === 0) return;
  }
  const detail = install.output ? `\n\nAutomatic install failed:\n${install.output}` : '';
  throw new CliError('TMUX_REQUIRED', `tmux is required for browser-controllable local terminals. ${tmuxInstallHint()}${detail}`);
}

function tmuxHasSession(sessionName) {
  const result = spawnSync('tmux', ['has-session', '-t', sessionName], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return result.status === 0;
}

function tmuxSessionHasClients(sessionName) {
  const result = spawnSync('tmux', ['list-clients', '-t', sessionName], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.status !== 0) return false;
  return Boolean((result.stdout || '').trim());
}

function tmuxKillSession(sessionName) {
  const result = spawnSync('tmux', ['kill-session', '-t', sessionName], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.status !== 0 && !String(result.stderr || result.stdout || '').includes('can\'t find session')) {
    const message = (result.stderr || result.stdout || '').trim() || `tmux kill-session -t ${sessionName} failed`;
    throw new CliError('TMUX_ERROR', message);
  }
}

function tmuxSessionEnvironmentValue(sessionName, key) {
  const result = spawnSync('tmux', ['show-environment', '-t', sessionName, key], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.status !== 0) return null;
  const line = (result.stdout || '').trim();
  if (!line || line.startsWith('-')) return null;
  const prefix = `${key}=`;
  return line.startsWith(prefix) ? line.slice(prefix.length) : null;
}

function isLikelyShellCommand(command) {
  const base = path.basename(String(command || '')).replace(/^-/, '');
  return new Set(['bash', 'dash', 'fish', 'ksh', 'mksh', 'sh', 'zsh']).has(base);
}

function isProviderFallbackWrapper(command) {
  const text = String(command || '');
  return text.includes(PROVIDER_STATE_ENV) || /\bexec\s+(?:bash|dash|fish|ksh|mksh|sh|zsh)\b/.test(text);
}

function isRelaunchableProviderSession(kind, command, binding = {}) {
  const provider = binding.provider || kind;
  return ['claude', 'codex'].includes(provider) && isProviderFallbackWrapper(command);
}

function tmuxProviderState(sessionName) {
  return tmuxSessionEnvironmentValue(sessionName, PROVIDER_STATE_ENV);
}

function tmuxManagedSessionName(ctx, peerId) {
  const name = `hcc-${shortHash(ctx.root)}-${sanitizePeerPart(peerId, 'peer')}`;
  return name.slice(0, 80);
}

function tmuxEnvironmentArgs(env) {
  const args = [];
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (['TMUX', 'TMUX_PANE'].includes(key)) continue;
    if (value === undefined || value === null) continue;
    args.push('-e', `${key}=${String(value)}`);
  }
  return args;
}

function isolatedEnvCommandArgs(env) {
  const envBin = fs.existsSync('/usr/bin/env') ? '/usr/bin/env' : 'env';
  const args = [envBin, '-i'];
  for (const [key, value] of Object.entries(env || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (['TMUX', 'TMUX_PANE'].includes(key)) continue;
    if (value === undefined || value === null) continue;
    args.push(`${key}=${String(value)}`);
  }
  return args;
}

function tmuxPaneInfo(targetPane = null) {
  const pane = targetPane || process.env.TMUX_PANE;
  if (!pane) throw new CliError('BAD_ARGS', 'Missing --pane and current terminal is not inside tmux');
  const format = '#{pane_id}\t#{pane_current_path}\t#{pane_pid}\t#{pane_current_command}\t#{pane_dead}';
  const out = runTmux(['display-message', '-p', '-t', pane, format]).trimEnd();
  const [paneId, currentPath, pid, currentCommand, paneDead] = out.split('\t');
  if (!paneId) throw new CliError('TMUX_ERROR', `Cannot resolve tmux pane: ${pane}`);
  return {
    pane: paneId,
    cwd: currentPath || '',
    pid: Number.parseInt(pid || '0', 10) || null,
    command: currentCommand || 'tmux',
    dead: paneDead === '1'
  };
}

function tmuxCapturePane(pane) {
  // No -J (join): keep one captured line per physical pane row so the web
  // terminal's row count matches tmux exactly, which is required for accurate
  // cursor placement. Strip the single trailing newline tmux appends so the
  // line count is exactly scrollback+height (no phantom bottom row in xterm).
  const out = runTmux(['capture-pane', '-p', '-e', '-S', '-2000', '-t', pane]);
  return out.endsWith('\n') ? out.slice(0, -1) : out;
}

// Read the real cursor cell + screen geometry from tmux so the browser mirror
// can draw the input cursor at the right place. Returns null if unavailable.
function tmuxCursorInfo(pane) {
  try {
    const out = runTmux(['display-message', '-p', '-t', pane,
      '#{cursor_x},#{cursor_y},#{cursor_flag},#{history_size},#{pane_height}']);
    const [x, y, flag, hist, height] = out.trim().split(',').map((n) => Number.parseInt(n, 10));
    return {
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
      visible: flag !== 0,
      history: Number.isFinite(hist) ? hist : 0,
      height: Number.isFinite(height) && height > 0 ? height : 1
    };
  } catch {
    return null;
  }
}

// Map tmux's cursor (relative to the visible pane) onto the web terminal's
// viewport row, accounting for captured scrollback and capture-pane's trailing
// blank-line stripping. Returns { row, col, visible } in viewport coordinates.
function tmuxCursorPayload(captured, info) {
  if (!info) return null;
  const height = info.height;
  const scrollback = Math.min(2000, info.history);
  const lineCount = captured ? captured.split('\n').length : 0;
  const viewportTop = Math.max(0, lineCount - height);
  let row = scrollback + info.y - viewportTop;
  if (row < 0) row = 0;
  if (row > height - 1) row = height - 1;
  return { row, col: info.x, visible: info.visible };
}

function tmuxSendKeys(pane, keys) {
  if (!keys.length) return;
  runTmux(['send-keys', '-t', pane, ...keys]);
}

function tmuxSendRawLiteral(pane, text) {
  if (!text) return;
  runTmux(['send-keys', '-t', pane, '-l', '--', text]);
}

function tmuxInCopyMode(pane) {
  try {
    const out = runTmux(['display-message', '-p', '-t', pane, '#{pane_in_mode}']);
    return out.trim() === '1';
  } catch { return false; }
}

function tmuxExitCopyMode(pane) {
  try {
    runTmux(['send-keys', '-t', pane, '-X', 'cancel']);
  } catch {}
}

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

function tmuxPasteBuffer(pane, text, opts = {}) {
  if (!text) return;

  // Cancel copy-mode so input isn't swallowed
  if (tmuxInCopyMode(pane)) {
    tmuxExitCopyMode(pane);
  }

  // paste-buffer handles all special characters safely (including $ ` " ' \ | ; ~ # and multi-byte UTF-8)
  const bufferName = `hcc-tmux-${pane.replace(/[%\\/]/g, '')}-${Date.now()}`;
  try {
    runTmux(['load-buffer', '-b', bufferName, '-'], { input: text });
    const args = ['paste-buffer'];
    if (opts.bracketed) args.push('-p');
    if (opts.raw) args.push('-r');
    args.push('-t', pane, '-b', bufferName);
    runTmux(args);
  } finally {
    try { runTmux(['delete-buffer', '-b', bufferName], { silent: true }); } catch {}
  }
}

function readTmuxEscapeSequence(text, start) {
  let i = start + 1;
  if (i >= text.length) return text.slice(start, i);
  const marker = text[i];
  if (marker === '[') {
    i += 1;
    while (i < text.length) {
      const code = text.charCodeAt(i);
      i += 1;
      if (code >= 0x40 && code <= 0x7e) break;
    }
    return text.slice(start, i);
  }
  if (marker === 'O') {
    return text.slice(start, Math.min(text.length, start + 3));
  }
  if (marker === ']') {
    i += 1;
    while (i < text.length) {
      if (text.charCodeAt(i) === 0x07) return text.slice(start, i + 1);
      if (text.charCodeAt(i) === 0x1b && text[i + 1] === '\\') return text.slice(start, i + 2);
      i += 1;
    }
    return text.slice(start, i);
  }
  return text.slice(start, Math.min(text.length, start + 2));
}

function isTmuxRawControlChar(ch) {
  const code = ch.charCodeAt(0);
  return (code < 0x20 && ch !== '\r' && ch !== '\n' && ch !== '\b') ||
    (code >= 0x80 && code <= 0x9f);
}

function tmuxSendLiteral(pane, text) {
  if (!text) return;
  const chunks = [];
  let current = '';
  for (let i = 0; i < text.length;) {
    const codePoint = text.codePointAt(i);
    const ch = String.fromCodePoint(codePoint);
    const width = ch.length;
    if (ch === '\r' || ch === '\n') {
      if (current) { chunks.push({ type: 'literal', text: current }); current = ''; }
      chunks.push({ type: 'key', key: 'Enter' });
      i += width;
    } else if (ch === '\x7f' || ch === '\b') {
      if (current) { chunks.push({ type: 'literal', text: current }); current = ''; }
      chunks.push({ type: 'key', key: 'BSpace' });
      i += width;
    } else if (text.startsWith(BRACKETED_PASTE_START, i)) {
      if (current) { chunks.push({ type: 'literal', text: current }); current = ''; }
      const end = text.indexOf(BRACKETED_PASTE_END, i + BRACKETED_PASTE_START.length);
      if (end >= 0) {
        chunks.push({
          type: 'paste',
          text: text.slice(i + BRACKETED_PASTE_START.length, end)
        });
        i = end + BRACKETED_PASTE_END.length;
      } else {
        const sequence = readTmuxEscapeSequence(text, i);
        chunks.push({ type: 'raw', text: sequence });
        i += sequence.length;
      }
    } else if (ch === '\x1b') {
      if (current) { chunks.push({ type: 'literal', text: current }); current = ''; }
      const sequence = readTmuxEscapeSequence(text, i);
      chunks.push({ type: 'raw', text: sequence });
      i += sequence.length;
    } else if (isTmuxRawControlChar(ch)) {
      if (current) { chunks.push({ type: 'literal', text: current }); current = ''; }
      chunks.push({ type: 'raw', text: ch });
      i += width;
    } else {
      current += ch;
      i += width;
    }
  }
  if (current) chunks.push({ type: 'literal', text: current });

  let pendingText = '';
  for (const chunk of chunks) {
    if (chunk.type === 'literal') {
      pendingText += chunk.text;
    } else {
      if (pendingText) { tmuxPasteBuffer(pane, pendingText, { raw: true }); pendingText = ''; }
      if (chunk.type === 'key') tmuxSendKeys(pane, [chunk.key]);
      else if (chunk.type === 'paste') tmuxPasteBuffer(pane, chunk.text, { bracketed: true, raw: true });
      else tmuxSendRawLiteral(pane, chunk.text);
    }
  }
  if (pendingText) tmuxPasteBuffer(pane, pendingText, { raw: true });
}

function inferPeerKind(id, explicitKind, firstCommand) {
  if (explicitKind) return explicitKind;
  if (['codex', 'claude'].includes(firstCommand)) return firstCommand;
  if (String(id).startsWith('codex')) return 'codex';
  if (String(id).startsWith('claude')) return 'claude';
  return 'shell';
}

function hasResumeOpts(opts) {
  return opts.resume !== undefined || Boolean(opts.last) || Boolean(opts.continue) || Boolean(opts.fork) || opts.session !== undefined;
}

function buildPeerCommand(id, kind, opts, cmdArgs) {
  const explicitCommand = opts.command || cmdArgs.length > 0;
  if (explicitCommand && hasResumeOpts(opts)) {
    throw new CliError('BAD_ARGS', 'Use resume options without an explicit -- COMMAND');
  }
  if (explicitCommand) {
    const command = opts.command || shellCommand(cmdArgs);
    return {
      command,
      binding: {
        peer: id,
        provider: kind,
        resume_mode: 'command',
        resume_arg: null,
        command
      }
    };
  }
  if (kind === 'codex') return buildCodexCommand(id, opts);
  if (kind === 'claude') return buildClaudeCommand(id, opts);
  if (hasResumeOpts(opts)) throw new CliError('BAD_ARGS', `Resume options are only supported for codex and claude peers`);
  const command = defaultSessionCommand(kind);
  return {
    command,
    binding: {
      peer: id,
      provider: kind,
      resume_mode: 'new',
      resume_arg: null,
      command
    }
  };
}

function buildCodexCommand(id, opts) {
  let command;
  let resumeMode = 'new';
  let resumeArg = null;
  let session = { provider_session_id: null, provider_session_name: null };
  if (opts.fork) {
    resumeMode = opts.last ? 'fork-last' : 'fork';
    if (opts.last) {
      command = 'codex fork --last';
      resumeArg = '--last';
    } else if (opts.resume) {
      command = `codex fork ${shellQuoteArg(opts.resume)}`;
      resumeArg = opts.resume;
    } else {
      command = 'codex fork';
    }
  } else if (opts.last) {
    command = 'codex resume --last';
    resumeMode = 'last';
    resumeArg = '--last';
  } else if (opts.resume) {
    command = `codex resume ${shellQuoteArg(opts.resume)}`;
    resumeMode = 'resume';
    resumeArg = opts.resume;
    session = providerSessionParts(opts.resume);
  } else {
    command = 'codex';
  }
  return {
    command,
    binding: {
      peer: id,
      provider: 'codex',
      ...session,
      resume_mode: resumeMode,
      resume_arg: resumeArg,
      command
    }
  };
}

function buildClaudeCommand(id, opts) {
  let command = 'claude';
  let resumeMode = 'new';
  let resumeArg = null;
  let session = { provider_session_id: null, provider_session_name: null };
  if (opts.continue) {
    command += ' --continue';
    resumeMode = opts.fork ? 'fork-continue' : 'continue';
    resumeArg = '--continue';
  } else if (opts.resume) {
    command += ` --resume ${shellQuoteArg(opts.resume)}`;
    resumeMode = opts.fork ? 'fork-resume' : 'resume';
    resumeArg = opts.resume;
    if (!opts.fork) session = providerSessionParts(opts.resume);
  } else if (opts.session) {
    command += ` --session-id ${shellQuoteArg(opts.session)}`;
    resumeMode = 'session';
    resumeArg = opts.session;
    session = { provider_session_id: opts.session, provider_session_name: null };
  }
  if (opts.fork && (opts.continue || opts.resume)) command += ' --fork-session';
  if (opts.name) command += ` --name ${shellQuoteArg(opts.name)}`;
  return {
    command,
    binding: {
      peer: id,
      provider: 'claude',
      ...session,
      resume_mode: resumeMode,
      resume_arg: resumeArg,
      command
    }
  };
}

function bindingFromDetected(peer, transport = 'detected') {
  const provider = peer.kind || 'other';
  const session = providerSessionParts(peer.resumeId || peer.sessionId || '');
  return {
    peer: peer.peerId || peer.id,
    provider,
    ...session,
    resume_mode: peer.resumeId ? 'resume' : (peer.sessionId ? 'detected' : 'unknown'),
    resume_arg: peer.resumeId || null,
    command: peer.command || null,
    transport,
    runtime_session_id: peer.peerId || peer.id
  };
}

function bindingFromRun(id, kind, command, commandArgs, transport) {
  const cmdline = [command, ...commandArgs];
  const provider = kind || 'other';
  let resumeMode = 'command';
  let resumeArg = null;
  let session = { provider_session_id: null, provider_session_name: null };
  if (provider === 'codex') {
    const parsed = parseCodexCommandArgs(cmdline);
    resumeMode = parsed.resume_mode;
    resumeArg = parsed.resume_arg;
    session = parsed.session;
  } else if (provider === 'claude') {
    const parsed = parseClaudeCommandArgs(cmdline);
    resumeMode = parsed.resume_mode;
    resumeArg = parsed.resume_arg;
    session = parsed.session;
  }
  return {
    peer: id,
    provider,
    ...session,
    resume_mode: resumeMode,
    resume_arg: resumeArg,
    command: cmdline.join(' '),
    transport,
    runtime_session_id: id
  };
}

function optionValue(args, names) {
  const nameSet = new Set(names);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (nameSet.has(arg) && args[i + 1]) return args[i + 1];
    for (const name of names) {
      if (name.startsWith('--') && arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    }
  }
  return null;
}

function hasFlag(args, names) {
  const nameSet = new Set(names);
  return args.some((arg) => nameSet.has(arg));
}

function parseClaudeCommandArgs(args) {
  const resumeId = optionValue(args, ['--resume', '-r']);
  const sessionId = optionValue(args, ['--session-id']);
  const name = optionValue(args, ['--name', '-n']);
  const continuing = hasFlag(args, ['--continue', '-c']);
  const fork = hasFlag(args, ['--fork-session']);
  let resumeMode = 'command';
  let resumeArg = null;
  let session = { provider_session_id: null, provider_session_name: null };

  if (sessionId) {
    resumeMode = 'session';
    resumeArg = sessionId;
    session = { provider_session_id: sessionId, provider_session_name: null };
  } else if (resumeId) {
    resumeMode = fork ? 'fork-resume' : 'resume';
    resumeArg = resumeId;
    if (!fork) session = providerSessionParts(resumeId);
  } else if (continuing) {
    resumeMode = fork ? 'fork-continue' : 'continue';
    resumeArg = '--continue';
  } else if (fork) {
    resumeMode = 'fork';
  } else if (name) {
    resumeMode = 'named';
    resumeArg = name;
  }

  return { resume_mode: resumeMode, resume_arg: resumeArg, session };
}

function codexOptionTakesValue(arg) {
  if (!arg || arg.includes('=')) return false;
  return new Set([
    '-c', '--config',
    '--remote',
    '--remote-auth-token-env',
    '--enable',
    '--disable',
    '-i', '--image',
    '-m', '--model',
    '--local-provider',
    '-p', '--profile',
    '-s', '--sandbox',
    '-C', '--cd',
    '--add-dir',
    '-a', '--ask-for-approval'
  ]).has(arg);
}

function firstCodexSessionArg(args, startIndex) {
  for (let i = startIndex; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--last') continue;
    if (arg.startsWith('-')) {
      if (codexOptionTakesValue(arg)) i += 1;
      continue;
    }
    return arg;
  }
  return null;
}

function parseCodexCommandArgs(args) {
  const subIndex = args.findIndex((arg) => arg === 'resume' || arg === 'fork');
  if (subIndex < 0) {
    return {
      resume_mode: 'command',
      resume_arg: null,
      session: { provider_session_id: null, provider_session_name: null }
    };
  }

  const subcommand = args[subIndex];
  const last = args.slice(subIndex + 1).includes('--last');
  const sessionArg = firstCodexSessionArg(args, subIndex + 1);
  let resumeMode = subcommand;
  let resumeArg = sessionArg || null;
  let session = { provider_session_id: null, provider_session_name: null };

  if (subcommand === 'resume') {
    if (last && !sessionArg) {
      resumeMode = 'last';
      resumeArg = '--last';
    } else if (sessionArg) {
      resumeMode = 'resume';
      session = providerSessionParts(sessionArg);
    }
  } else if (subcommand === 'fork') {
    resumeMode = last && !sessionArg ? 'fork-last' : 'fork';
    resumeArg = sessionArg || (last ? '--last' : null);
  }

  return { resume_mode: resumeMode, resume_arg: resumeArg, session };
}

async function runtimeRequest(ctx, method, route, body = null, runtime = null) {
  const rt = runtime || readRuntime(ctx);
  const url = new URL(route, rt.base_url);
  const headers = { 'Content-Type': 'application/json' };
  headers['X-HCC-Root'] = ctx.root;
  headers['X-HCC-DB'] = ctx.dbPath;
  if (rt.token) headers.Authorization = `Bearer ${rt.token}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body)
    });
  } catch (err) {
    throw new CliError('RUNTIME_UNREACHABLE', `Runtime is not reachable at ${rt.base_url}. Start ${CLI_NAME} web again.`, {
      runtime: rt.source || rt.base_url,
      message: err.message
    });
  }
  let json = null;
  const text = await res.text();
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new CliError('RUNTIME_BAD_RESPONSE', `Runtime returned non-JSON response from ${url.pathname}`);
    }
  }
  if (!res.ok) {
    const error = json && json.error ? json.error : { code: 'RUNTIME_ERROR', message: `Runtime request failed: ${res.status}` };
    throw new CliError(error.code || 'RUNTIME_ERROR', error.message || `Runtime request failed: ${res.status}`, error);
  }
  return json || {};
}

const sleepBuffer = new SharedArrayBuffer(4);
const sleepView = new Int32Array(sleepBuffer);

function sleepSync(ms) {
  Atomics.wait(sleepView, 0, 0, ms);
}

function isSqliteBusy(err) {
  const text = `${err?.code || ''} ${err?.message || ''} ${err?.errstr || ''}`;
  return err?.errcode === 5 ||
    err?.errcode === 6 ||
    err?.errcode === 261 ||
    /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database is busy/i.test(text);
}

function execWithBusyRetry(db, sql, { attempts = 30, delayMs = 100, ignoreBusy = false } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      db.exec(sql);
      return true;
    } catch (err) {
      if (!isSqliteBusy(err)) throw err;
      if (attempt === attempts - 1) {
        if (ignoreBusy) return false;
        throw err;
      }
      sleepSync(delayMs);
    }
  }
  return false;
}

function connect(ctx) {
  fs.mkdirSync(path.dirname(ctx.dbPath), { recursive: true });
  const db = new DatabaseSync(ctx.dbPath, { timeout: 5000 });
  db.exec('PRAGMA busy_timeout = 5000;');
  execWithBusyRetry(db, 'PRAGMA journal_mode = WAL;', { ignoreBusy: true });
  db.exec('PRAGMA foreign_keys = ON;');
  initSchema(db);
  return db;
}

function initSchema(db) {
  execWithBusyRetry(db, `
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS peers (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      role TEXT,
      worktree TEXT,
      branch TEXT,
      pid INTEGER,
      status TEXT NOT NULL DEFAULT 'idle',
      capabilities TEXT,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS peer_bindings (
      peer TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_session_id TEXT,
      provider_session_name TEXT,
      resume_mode TEXT NOT NULL DEFAULT 'new',
      resume_arg TEXT,
      command TEXT,
      transport TEXT NOT NULL,
      runtime_session_id TEXT,
      runtime_target TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (peer) REFERENCES peers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      assignee TEXT,
      owner TEXT,
      priority INTEGER NOT NULL DEFAULT 100,
      created_by TEXT,
      claimed_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT NOT NULL,
      recipient TEXT,
      task_id INTEGER,
      kind TEXT NOT NULL DEFAULT 'note',
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS message_reads (
      message_id INTEGER NOT NULL,
      peer TEXT NOT NULL,
      read_at INTEGER NOT NULL,
      PRIMARY KEY (message_id, peer),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS locks (
      resource TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      task_id INTEGER,
      reason TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS handoffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER,
      from_peer TEXT NOT NULL,
      to_peer TEXT,
      summary TEXT NOT NULL,
      changed_files TEXT,
      tests TEXT,
      risks TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      actor TEXT,
      task_id INTEGER,
      payload TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status_priority ON tasks(status, priority, id);
    CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner);
    CREATE INDEX IF NOT EXISTS idx_peer_bindings_provider_session ON peer_bindings(provider, provider_session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_recipient_id ON messages(recipient, id);
    CREATE INDEX IF NOT EXISTS idx_events_id ON events(id);
    CREATE INDEX IF NOT EXISTS idx_locks_expires ON locks(expires_at);
  `);
  db.prepare(`
    INSERT INTO meta(key, value) VALUES ('schema_version', '1')
    ON CONFLICT(key) DO NOTHING
  `).run();

  const peerBindingColumns = new Set(db.prepare('PRAGMA table_info(peer_bindings)').all().map((col) => col.name));
  if (!peerBindingColumns.has('runtime_target')) {
    db.exec('ALTER TABLE peer_bindings ADD COLUMN runtime_target TEXT');
  }
}

function tx(db, fn) {
  execWithBusyRetry(db, 'BEGIN IMMEDIATE;');
  try {
    const result = fn();
    db.exec('COMMIT;');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // Ignore rollback failures; the original error is more useful.
    }
    throw err;
  }
}

function addEvent(db, type, actor, taskId, payload) {
  db.prepare(`
    INSERT INTO events(type, actor, task_id, payload, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(type, actor || null, taskId || null, JSON.stringify(payload || {}), now());
}

function upsertPeer(db, peer) {
  const t = now();
  db.prepare(`
    INSERT INTO peers(id, kind, role, worktree, branch, pid, status, capabilities, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind,
      role = excluded.role,
      worktree = excluded.worktree,
      branch = excluded.branch,
      pid = excluded.pid,
      status = excluded.status,
      capabilities = excluded.capabilities,
      last_seen_at = excluded.last_seen_at
  `).run(
    peer.id,
    peer.kind || 'other',
    peer.role || '',
    peer.worktree || '',
    peer.branch || '',
    peer.pid || null,
    peer.status || 'idle',
    peer.capabilities || '',
    t,
    t
  );
}

function providerSessionParts(value) {
  if (!value) return { provider_session_id: null, provider_session_name: null };
  const text = String(value);
  const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text);
  return uuidLike
    ? { provider_session_id: text, provider_session_name: null }
    : { provider_session_id: null, provider_session_name: text };
}

function upsertPeerBinding(db, binding, force = false) {
  const t = now();
  if ((binding.provider_session_id || binding.provider_session_name) && !force) {
    const conflict = db.prepare(`
      SELECT peer, provider, provider_session_id, provider_session_name
      FROM peer_bindings
      WHERE provider = ?
        AND peer <> ?
        AND (
          (? IS NOT NULL AND provider_session_id = ?)
          OR (? IS NOT NULL AND provider_session_name = ?)
        )
      LIMIT 1
    `).get(
      binding.provider,
      binding.peer,
      binding.provider_session_id || null,
      binding.provider_session_id || null,
      binding.provider_session_name || null,
      binding.provider_session_name || null
    );
    if (conflict) {
      const providerSession = conflict.provider_session_id || conflict.provider_session_name;
      throw new CliError('PROVIDER_SESSION_IN_USE', `${binding.provider} session ${providerSession} is already bound to ${conflict.peer}`, {
        peer: conflict.peer,
        provider: conflict.provider,
        provider_session: providerSession
      });
    }
  }
  db.prepare(`
    INSERT INTO peer_bindings(
      peer, provider, provider_session_id, provider_session_name, resume_mode,
      resume_arg, command, transport, runtime_session_id, runtime_target, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(peer) DO UPDATE SET
      provider = excluded.provider,
      provider_session_id = excluded.provider_session_id,
      provider_session_name = excluded.provider_session_name,
      resume_mode = excluded.resume_mode,
      resume_arg = excluded.resume_arg,
      command = excluded.command,
      transport = excluded.transport,
      runtime_session_id = excluded.runtime_session_id,
      runtime_target = excluded.runtime_target,
      updated_at = excluded.updated_at
  `).run(
    binding.peer,
    binding.provider,
    binding.provider_session_id || null,
    binding.provider_session_name || null,
    binding.resume_mode || 'new',
    binding.resume_arg || null,
    binding.command || null,
    binding.transport,
    binding.runtime_session_id || binding.peer,
    binding.runtime_target || null,
    t,
    t
  );
}

function mergeHookPeerBinding(db, binding) {
  const existing = db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get(binding.peer);
  if (!existing) return binding;

  const hasRuntimeBinding = Boolean(existing.runtime_target) ||
    ['tmux', 'web-pty'].includes(existing.transport);
  if (!hasRuntimeBinding) return binding;

  return {
    ...binding,
    command: existing.command || binding.command || null,
    transport: existing.transport,
    runtime_session_id: existing.runtime_session_id || binding.runtime_session_id || binding.peer,
    runtime_target: existing.runtime_target || null
  };
}

function touchPeer(db, id, status = null) {
  if (!id) return;
  const existing = db.prepare('SELECT id FROM peers WHERE id = ?').get(id);
  if (!existing) {
    upsertPeer(db, {
      id,
      kind: 'other',
      role: 'auto',
      worktree: process.cwd(),
      branch: detectBranch(process.cwd()),
      pid: process.ppid,
      status: status || 'idle',
      capabilities: ''
    });
  } else {
    db.prepare(`
      UPDATE peers
      SET last_seen_at = ?, status = COALESCE(?, status)
      WHERE id = ?
    `).run(now(), status, id);
  }
}

function touchCurrentPeer(db, ctx, resolved, status = null, kindHint = 'shell') {
  registerProjectActivity(ctx);
  const identity = typeof resolved === 'string'
    ? { id: resolved, auto: false }
    : resolved;
  if (!identity || !identity.id) return;
  if (!identity.auto) {
    touchPeer(db, identity.id, status);
    return;
  }

  const existing = db.prepare('SELECT id FROM peers WHERE id = ?').get(identity.id);
  if (existing) {
    touchPeer(db, identity.id, status);
    return;
  }

  const kind = autoPeerKind(kindHint);
  const sessionId = autoPeerSessionId(kind);
  const resumeId = autoPeerResumeId(kind);
  upsertPeer(db, {
    id: identity.id,
    ...autoPeerDefaults(ctx, kindHint, status || 'idle')
  });
  upsertPeerBinding(db, {
    peer: identity.id,
    provider: kind,
    ...providerSessionParts(resumeId || sessionId),
    resume_mode: resumeId ? 'resume' : (sessionId ? 'detected' : 'auto'),
    resume_arg: resumeId || null,
    command: null,
    transport: process.env.TMUX_PANE ? 'auto-tmux' : 'auto-shell',
    runtime_session_id: identity.id
  }, true);
  addEvent(db, 'peer.auto_joined', identity.id, null, {
    root: ctx.root,
    basis: autoPeerBasis(kind),
    provider_session: resumeId || sessionId || null
  });
}

function sendMessage(db, sender, recipient, taskId, kind, body) {
  const info = db.prepare(`
    INSERT INTO messages(sender, recipient, task_id, kind, body, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sender, recipient || 'all', taskId || null, kind || 'note', body, now());
  addEvent(db, 'message.sent', sender, taskId || null, {
    message_id: Number(info.lastInsertRowid),
    recipient: recipient || 'all',
    kind: kind || 'note'
  });
  return Number(info.lastInsertRowid);
}

function queryInbox(db, peer, includeAll, limit) {
  return db.prepare(`
    SELECT
      m.id, m.sender, m.recipient, m.task_id, m.kind, m.body, m.created_at, r.read_at
    FROM messages m
    LEFT JOIN message_reads r
      ON r.message_id = m.id AND r.peer = ?
    WHERE
      (m.recipient IS NULL OR m.recipient = '' OR m.recipient = 'all' OR m.recipient = ?)
      AND (? = 1 OR r.read_at IS NULL)
    ORDER BY m.id ASC
    LIMIT ?
  `).all(peer, peer, includeAll ? 1 : 0, limit);
}

function queryOpenTasks(db, limit, peer = null) {
  const sql = `
    SELECT * FROM tasks
    WHERE status NOT IN ('done', 'abandoned')
      ${peer ? 'AND (owner = ? OR assignee = ?)' : ''}
    ORDER BY
      CASE status
        WHEN 'claimed' THEN 0
        WHEN 'running' THEN 1
        WHEN 'pending' THEN 2
        WHEN 'blocked' THEN 3
        WHEN 'review' THEN 4
        ELSE 5
      END,
      priority ASC,
      id ASC
    LIMIT ?
  `;
  return peer
    ? db.prepare(sql).all(peer, peer, limit)
    : db.prepare(sql).all(limit);
}

function formatOpenTaskLine(task) {
  const parts = [`#${task.id}`, task.status];
  if (task.owner) parts.push(`owner=${task.owner}`);
  if (task.assignee) parts.push(`assignee=${task.assignee}`);
  return `${parts.join(' ')}: ${task.title}`;
}

function formatHookEventName(hookType) {
  const known = {
    sessionstart: 'SessionStart',
    userpromptsubmit: 'UserPromptSubmit',
    stop: 'Stop',
    posttooluse: 'PostToolUse',
    pretooluse: 'PreToolUse'
  };
  const compact = String(hookType || '').replace(/[^a-z]/gi, '').toLowerCase();
  return known[compact] || String(hookType || 'unknown');
}

function buildHookCoordinationContext(db, peerId) {
  const openTasks = queryOpenTasks(db, 8);
  const unread = queryInbox(db, peerId, false, 5);
  const t = now();
  const peers = db.prepare(`
    SELECT id, kind, status, last_seen_at
    FROM peers
    ORDER BY last_seen_at DESC, id ASC
    LIMIT 8
  `).all();
  const parts = [
    '[hello-cc coordination]',
    `peer: ${peerId}`,
    'This is live project coordination context injected by hello-cc.',
    'You are not isolated for project coordination: hcc is the source of truth for other Claude/Codex/shell sessions in this project.',
    'If the user asks what other sessions are doing, what tasks exist, or whether you can see other sessions, do not answer from generic model knowledge and do not say sessions are isolated. Run hcc status, hcc peers, hcc task list, hcc msg inbox, and hcc lock list, then answer from those results.',
    'Tasks are project work facts, not read/unread items. Open tasks stay relevant to every session until they are marked done or abandoned. Messages are the unread/ack notification channel.'
  ];

  if (peers.length > 0) {
    parts.push('[hello-cc known peers]');
    parts.push(...peers.map((peer) => {
      const age = Math.max(0, t - Number(peer.last_seen_at || 0));
      const active = age <= ACTIVE_PEER_TTL ? 'active' : 'stale';
      return `- ${peer.id} ${peer.kind || 'other'} ${peer.status || 'idle'} ${active}`;
    }));
  } else {
    parts.push('[hello-cc known peers]\n(none)');
  }

  if (openTasks.length > 0) {
    parts.push('[hello-cc open tasks]');
    parts.push(...openTasks.map((task) => `- ${formatOpenTaskLine(task)}`));
  } else {
    parts.push('[hello-cc open tasks]\n(none)');
  }

  if (unread.length > 0) {
    parts.push('[hello-cc unread messages]');
    parts.push(...unread.map((m) =>
      `- #${m.id} from ${m.sender}${m.task_id ? ` task #${m.task_id}` : ''}: ${m.body}`
    ));
  } else {
    parts.push('[hello-cc unread messages]\n(none)');
  }

  return { text: parts.join('\n'), messages: unread };
}

function ackMessages(db, peerId, messages) {
  if (!messages.length) return;
  const t = now();
  for (const m of messages) {
    db.prepare(`
      INSERT INTO message_reads(message_id, peer, read_at)
      VALUES (?, ?, ?)
      ON CONFLICT(message_id, peer) DO UPDATE SET read_at = excluded.read_at
    `).run(m.id, peerId, t);
  }
}

function formatJson(ok, dataOrError) {
  if (ok) return JSON.stringify({ ok: true, data: dataOrError }, null, 2);
  return JSON.stringify({ ok: false, error: dataOrError }, null, 2);
}

function printResult(ctx, data, render) {
  if (ctx.json) {
    console.log(formatJson(true, data));
  } else {
    const output = render ? render(data) : String(data ?? '');
    if (output) console.log(output);
  }
}

function shellExports(values) {
  return Object.entries(values)
    .map(([key, value]) => `export ${key}=${shellQuoteArg(value)}`)
    .join('\n');
}

function table(rows, columns) {
  if (!rows.length) return '(none)';
  const widths = columns.map((col) => Math.max(col.label.length, ...rows.map((row) => String(col.value(row) ?? '').length)));
  const header = columns.map((col, i) => col.label.padEnd(widths[i])).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const body = rows.map((row) => columns.map((col, i) => String(col.value(row) ?? '').padEnd(widths[i])).join('  '));
  return [header, sep, ...body].join('\n');
}

function writeGuidance(ctx) {
  const guidePath = path.join(ctx.root, '.hello-cc', 'HCC.md');
  fs.mkdirSync(path.dirname(guidePath), { recursive: true });
  const content = `# hello-cc Coordination Rules

This project may be edited by multiple Claude Code and Codex CLI sessions.

Use \`hcc\` as the source of truth for cross-session coordination. If the user
asks what other sessions are doing, do not answer from generic model knowledge.
Run the project-local commands below and summarize the result.

Each terminal session must use a stable peer id, for example codex-a,
codex-b, claude-a, claude-b, or gpu-runner-a.

Status checks:
- \`hcc peers\` shows known Claude/Codex/shell sessions.
- \`hcc task list\` shows all open tasks. Tasks stay visible until \`done\` or
  \`abandoned\`; they are not read/unread items.
- \`hcc msg inbox\` shows unread messages for this session.
- \`hcc lock list\` shows active advisory locks.
- \`hcc status\` summarizes peers, tasks, locks, inbox, and recent events.

Before work:
- Register with hcc.
- Read current status with \`hcc status\`, \`hcc task list\`, and \`hcc msg inbox\`.
- Claim one task before editing.

Before editing:
- Acquire an advisory lock for the file, directory, module, or shared resource.
- If another live peer holds the lock, message that peer instead of editing.

During work:
- Keep changes scoped to the claimed task.
- Send progress messages when another session needs context.

Before stopping:
- Mark the task done or blocked.
- Create a handoff with changed files, tests, and remaining risks.
- Release locks you no longer need.
`;
  fs.writeFileSync(guidePath, content);
  const clause = `\n<!-- hello-cc:start -->\n\n${content}\n<!-- hello-cc:end -->\n`;
  for (const file of ['CLAUDE.md', 'AGENTS.md']) {
    const target = path.join(ctx.root, file);
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, clause.trimStart());
      continue;
    }
    const existing = fs.readFileSync(target, 'utf8');
    const updated = existing.includes('<!-- hello-cc:start -->')
      ? existing.replace(/<!-- hello-cc:start -->[\s\S]*?<!-- hello-cc:end -->/, clause.trim())
      : `${existing.trimEnd()}\n${clause}`;
    fs.writeFileSync(target, updated);
  }
  return guidePath;
}

function removeGuidanceBlocks(ctx) {
  const changed = [];
  for (const file of ['CLAUDE.md', 'AGENTS.md']) {
    const target = path.join(ctx.root, file);
    if (!fs.existsSync(target)) continue;
    const existing = fs.readFileSync(target, 'utf8');
    const updated = existing
      .replace(/\n?<!-- hello-cc:start -->[\s\S]*?<!-- hello-cc:end -->\n?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd();
    if (updated !== existing) {
      fs.writeFileSync(target, updated ? `${updated}\n` : '');
      changed.push(target);
    }
  }
  return changed;
}

function normalizeListText(value, fallback = []) {
  if (value === undefined || value === null || value === '') return JSON.stringify(fallback);
  const text = String(value);
  try {
    JSON.parse(text);
    return text;
  } catch {
    return JSON.stringify(text.split(',').map((item) => item.trim()).filter(Boolean));
  }
}

function changedFiles(cwd) {
  const unstaged = runGit(['diff', '--name-only'], cwd);
  const staged = runGit(['diff', '--cached', '--name-only'], cwd);
  const files = new Set();
  for (const block of [unstaged, staged]) {
    if (!block) continue;
    for (const line of block.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) files.add(trimmed);
    }
  }
  return [...files].sort();
}

function commandPath() {
  try { return fs.realpathSync(process.argv[1]); }
  catch { return path.resolve(process.argv[1]); }
}

function packageRoot() {
  return path.resolve(path.dirname(commandPath()), '..');
}

async function cmdInit(ctx, args) {
  registerProjectActivity(ctx);
  const opts = parseOpts(args, { booleans: ['no-guidance'] });
  const db = connect(ctx);
  const guidance = opts['no-guidance'] ? null : writeGuidance(ctx);
  addEvent(db, 'mesh.init', 'human', null, { root: ctx.root, db: ctx.dbPath, guidance });
  printResult(ctx, { root: ctx.root, db: ctx.dbPath, guidance }, (data) => [
    'hello-cc initialized',
    `root: ${data.root}`,
    `db: ${data.db}`,
    data.guidance ? `guidance: ${data.guidance}` : 'guidance: skipped'
  ].join('\n'));
}

async function cmdRegister(ctx, args) {
  registerProjectActivity(ctx);
  const opts = parseOpts(args, { arrays: ['cap'] });
  const id = required(opts, 'peer', 'HCC_PEER');
  const db = connect(ctx);
  const peer = {
    id,
    kind: opts.kind || 'other',
    role: opts.role || '',
    worktree: path.resolve(opts.worktree || ctx.cwd),
    branch: opts.branch || detectBranch(ctx.cwd),
    pid: intOpt(opts, 'pid', process.ppid),
    status: opts.status || 'idle',
    capabilities: Array.isArray(opts.cap) ? opts.cap.join(',') : (opts.cap || opts.capabilities || '')
  };
  upsertPeer(db, peer);
  addEvent(db, 'peer.registered', id, null, peer);
  printResult(ctx, peer, (data) => `registered ${data.id} (${data.kind}${data.role ? `, ${data.role}` : ''})`);
}

async function cmdEnv(ctx, args) {
  if (args[0] === '--help' || args[0] === '-h') return helpEnv();
  const opts = parseOpts(args);
  const peer = required(opts, 'peer', 'HCC_PEER');
  const values = {
    HCC_PEER: peer,
    HCC_ROOT: ctx.root,
    HCC_DB: ctx.dbPath
  };
  printResult(ctx, values, (data) => shellExports(data));
}

async function cmdJoin(ctx, args) {
  if (args[0] === '--help' || args[0] === '-h') return helpJoin();
  registerProjectActivity(ctx);
  const opts = parseOpts(args, { arrays: ['cap'] });
  const id = required(opts, 'peer', 'HCC_PEER');
  const peer = {
    id,
    kind: opts.kind || 'other',
    role: opts.role || 'peer',
    worktree: path.resolve(opts.worktree || ctx.cwd),
    branch: opts.branch || detectBranch(ctx.cwd),
    pid: intOpt(opts, 'pid', process.ppid),
    status: opts.status || 'working',
    capabilities: Array.isArray(opts.cap) ? opts.cap.join(',') : (opts.cap || opts.capabilities || 'manual-shell')
  };
  const db = connect(ctx);
  try {
    upsertPeer(db, peer);
    upsertPeerBinding(db, {
      peer: id,
      provider: peer.kind,
      provider_session_id: null,
      provider_session_name: null,
      resume_mode: 'manual',
      resume_arg: null,
      command: null,
      transport: 'manual-shell',
      runtime_session_id: id
    }, true);
    addEvent(db, 'peer.joined', id, null, peer);
  } finally {
    db.close();
  }
  const values = {
    HCC_PEER: id,
    HCC_ROOT: ctx.root,
    HCC_DB: ctx.dbPath
  };
  printResult(ctx, { peer, env: values }, (data) => shellExports(data.env));
}

async function cmdHeartbeat(ctx, args) {
  const opts = parseOpts(args, { booleans: ['renew-locks'] });
  const identity = resolveCurrentPeer(ctx, opts, 'peer', 'shell');
  const peer = identity.id;
  const status = opts.status || null;
  const ttl = intOpt(opts, 'ttl', DEFAULT_LOCK_TTL);
  const db = connect(ctx);
  const t = now();
  touchCurrentPeer(db, ctx, identity, status, 'shell');
  let renewed = 0;
  if (opts['renew-locks']) {
    renewed = db.prepare(`
      UPDATE locks SET expires_at = ?
      WHERE owner = ? AND expires_at > ?
    `).run(t + ttl, peer, t).changes;
  }
  addEvent(db, 'peer.heartbeat', peer, null, { status, renewed });
  printResult(ctx, { peer, status, renewed }, (data) => `heartbeat ${data.peer}${data.renewed ? `, renewed locks: ${data.renewed}` : ''}`);
}

async function cmdPeers(ctx, args) {
  parseOpts(args);
  const db = connect(ctx);
  const t = now();
  const rows = db.prepare(`
    SELECT *, (? - last_seen_at) AS age_sec
    FROM peers
    ORDER BY last_seen_at DESC, id ASC
  `).all(t);
  printResult(ctx, rows, (data) => table(data, [
    { label: 'id', value: (r) => r.id },
    { label: 'kind', value: (r) => r.kind },
    { label: 'role', value: (r) => r.role || '' },
    { label: 'status', value: (r) => r.status },
    { label: 'age', value: (r) => `${r.age_sec}s` },
    { label: 'active', value: (r) => r.age_sec <= ACTIVE_PEER_TTL ? 'yes' : 'stale' },
    { label: 'branch', value: (r) => r.branch || '' }
  ]));
}

async function cmdTask(ctx, args) {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') return helpTask();
  if (sub === 'create') return taskCreate(ctx, args.slice(1));
  if (sub === 'list') return taskList(ctx, args.slice(1));
  if (sub === 'claim') return taskClaim(ctx, args.slice(1));
  if (sub === 'next') return taskNext(ctx, args.slice(1));
  if (sub === 'update') return taskUpdate(ctx, args.slice(1));
  if (sub === 'done') return taskDone(ctx, args.slice(1));
  throw new CliError('BAD_ARGS', `Unknown task command: ${sub}`);
}

async function taskCreate(ctx, args) {
  const opts = parseOpts(args);
  const title = required(opts, 'title');
  const body = opts.body || '';
  const identity = resolveCurrentPeer(ctx, opts, 'from', 'shell');
  const createdBy = identity.id;
  const assignee = opts.to || opts.assignee || null;
  const priority = intOpt(opts, 'priority', 100);
  const db = connect(ctx);
  touchCurrentPeer(db, ctx, identity, null, 'shell');
  const t = now();
  const id = tx(db, () => {
    const info = db.prepare(`
      INSERT INTO tasks(title, body, status, assignee, owner, priority, created_by, created_at, updated_at)
      VALUES (?, ?, 'pending', ?, NULL, ?, ?, ?, ?)
    `).run(title, body, assignee, priority, createdBy, t, t);
    const taskId = Number(info.lastInsertRowid);
    addEvent(db, 'task.created', createdBy, taskId, { title, assignee, priority });
    if (assignee) {
      sendMessage(db, createdBy, assignee, taskId, 'task', `Task #${taskId} assigned: ${title}`);
    }
    return taskId;
  });
  printResult(ctx, { id, title, assignee, priority }, (data) => `created task #${data.id}: ${data.title}${data.assignee ? ` -> ${data.assignee}` : ''}`);
}

async function taskList(ctx, args) {
  const opts = parseOpts(args, { booleans: ['all'] });
  const status = opts.status || null;
  const peer = opts.peer || null;
  const limit = intOpt(opts, 'limit', 50);
  const db = connect(ctx);
  let rows;
  if (status && peer) {
    rows = db.prepare(`
      SELECT * FROM tasks
      WHERE status = ? AND (owner = ? OR assignee = ?)
      ORDER BY priority ASC, id ASC LIMIT ?
    `).all(status, peer, peer, limit);
  } else if (status) {
    rows = db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY priority ASC, id ASC LIMIT ?').all(status, limit);
  } else if (opts.all && peer) {
    rows = db.prepare(`
      SELECT * FROM tasks
      WHERE owner = ? OR assignee = ?
      ORDER BY status ASC, priority ASC, id ASC
      LIMIT ?
    `).all(peer, peer, limit);
  } else if (opts.all) {
    rows = db.prepare('SELECT * FROM tasks ORDER BY status ASC, priority ASC, id ASC LIMIT ?').all(limit);
  } else if (peer) {
    rows = queryOpenTasks(db, limit, peer);
  } else {
    rows = queryOpenTasks(db, limit);
  }
  printResult(ctx, rows, (data) => table(data, [
    { label: 'id', value: (r) => `#${r.id}` },
    { label: 'status', value: (r) => r.status },
    { label: 'prio', value: (r) => r.priority },
    { label: 'assignee', value: (r) => r.assignee || '' },
    { label: 'owner', value: (r) => r.owner || '' },
    { label: 'title', value: (r) => r.title }
  ]));
}

async function taskClaim(ctx, args) {
  const opts = parseOpts(args, { booleans: ['force'] });
  const identity = resolveCurrentPeer(ctx, opts, 'peer', 'shell');
  const peer = identity.id;
  const id = intOpt(opts, 'id', intOpt({ id: opts._[0] }, 'id'));
  if (!id) throw new CliError('BAD_ARGS', 'Missing --id');
  const db = connect(ctx);
  touchCurrentPeer(db, ctx, identity, 'working', 'shell');
  const task = tx(db, () => {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!row) throw new CliError('NOT_FOUND', `Task #${id} does not exist`);
    if (row.owner && row.owner !== peer && !opts.force) {
      throw new CliError('TASK_OWNED', `Task #${id} is owned by ${row.owner}`, { owner: row.owner });
    }
    if (row.assignee && row.assignee !== peer && !opts.force) {
      throw new CliError('TASK_ASSIGNED', `Task #${id} is assigned to ${row.assignee}`, { assignee: row.assignee });
    }
    if (!['pending', 'blocked', 'claimed', 'running'].includes(row.status) && !opts.force) {
      throw new CliError('BAD_STATE', `Task #${id} is ${row.status}`);
    }
    const t = now();
    db.prepare(`
      UPDATE tasks
      SET owner = ?, status = 'claimed', claimed_at = COALESCE(claimed_at, ?), updated_at = ?
      WHERE id = ?
    `).run(peer, t, t, id);
    addEvent(db, 'task.claimed', peer, id, { previous_owner: row.owner, force: Boolean(opts.force) });
    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  });
  printResult(ctx, task, (data) => `claimed task #${data.id}: ${data.title}`);
}

async function taskNext(ctx, args) {
  const opts = parseOpts(args);
  const identity = resolveCurrentPeer(ctx, opts, 'peer', 'shell');
  const peer = identity.id;
  const db = connect(ctx);
  touchCurrentPeer(db, ctx, identity, 'working', 'shell');
  const task = tx(db, () => {
    const row = db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'pending'
        AND owner IS NULL
        AND (assignee IS NULL OR assignee = ?)
      ORDER BY CASE WHEN assignee = ? THEN 0 ELSE 1 END, priority ASC, id ASC
      LIMIT 1
    `).get(peer, peer);
    if (!row) return null;
    const t = now();
    db.prepare(`
      UPDATE tasks
      SET owner = ?, status = 'claimed', claimed_at = ?, updated_at = ?
      WHERE id = ? AND owner IS NULL AND status = 'pending'
    `).run(peer, t, t, row.id);
    addEvent(db, 'task.claimed', peer, row.id, { next: true });
    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id);
  });
  printResult(ctx, task, (data) => data ? `claimed task #${data.id}: ${data.title}` : 'no pending task');
}

async function taskUpdate(ctx, args) {
  const opts = parseOpts(args, { booleans: ['force'] });
  const identity = resolveCurrentPeer(ctx, opts, 'peer', 'shell');
  const peer = identity.id;
  const id = intOpt(opts, 'id', intOpt({ id: opts._[0] }, 'id'));
  const status = required(opts, 'status');
  if (!['pending', 'claimed', 'running', 'review', 'blocked', 'done', 'abandoned'].includes(status)) {
    throw new CliError('BAD_ARGS', `Unsupported status: ${status}`);
  }
  if (!id) throw new CliError('BAD_ARGS', 'Missing --id');
  const db = connect(ctx);
  touchCurrentPeer(db, ctx, identity, status === 'done' ? 'idle' : 'working', 'shell');
  const task = tx(db, () => {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!row) throw new CliError('NOT_FOUND', `Task #${id} does not exist`);
    if (row.owner && row.owner !== peer && !opts.force) {
      throw new CliError('TASK_OWNED', `Task #${id} is owned by ${row.owner}`, { owner: row.owner });
    }
    const t = now();
    const completedAt = status === 'done' ? t : row.completed_at;
    db.prepare(`
      UPDATE tasks
      SET status = ?, completed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(status, completedAt, t, id);
    addEvent(db, `task.${status}`, peer, id, { summary: opts.summary || opts.reason || '' });
    if (opts.body) {
      sendMessage(db, peer, opts.to || 'all', id, 'task.update', opts.body);
    }
    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  });
  printResult(ctx, task, (data) => `task #${data.id} -> ${data.status}`);
}

async function taskDone(ctx, args) {
  const opts = parseOpts(args, { booleans: ['force'] });
  opts.status = 'done';
  if (opts.summary && !opts.body) opts.body = opts.summary;
  return taskUpdate(ctx, args.concat(['--status', 'done']));
}

async function cmdMsg(ctx, args) {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') return helpMsg();
  if (sub === 'send') return msgSend(ctx, args.slice(1));
  if (sub === 'inbox') return msgInbox(ctx, args.slice(1));
  if (sub === 'ack') return msgAck(ctx, args.slice(1));
  throw new CliError('BAD_ARGS', `Unknown msg command: ${sub}`);
}

async function msgSend(ctx, args) {
  const opts = parseOpts(args);
  const identity = resolveCurrentPeer(ctx, opts, 'from', 'shell');
  const sender = identity.id;
  const recipient = opts.to || 'all';
  const body = required(opts, 'body');
  const taskId = intOpt(opts, 'task', null);
  const kind = opts.kind || 'note';
  const db = connect(ctx);
  touchCurrentPeer(db, ctx, identity, null, 'shell');
  const id = sendMessage(db, sender, recipient, taskId, kind, body);
  printResult(ctx, { id, sender, recipient, task_id: taskId, kind, body }, (data) => `sent message #${data.id} ${data.sender} -> ${data.recipient}`);
}

async function msgInbox(ctx, args) {
  const opts = parseOpts(args, { booleans: ['all'] });
  const identity = resolveCurrentPeer(ctx, opts, 'peer', 'shell');
  const peer = identity.id;
  const waitSec = intOpt(opts, 'wait', 0);
  const limit = intOpt(opts, 'limit', 20);
  const includeAll = Boolean(opts.all);
  const db = connect(ctx);
  touchCurrentPeer(db, ctx, identity, null, 'shell');
  const deadline = Date.now() + waitSec * 1000;
  let rows = queryInbox(db, peer, includeAll, limit);
  while (!rows.length && waitSec > 0 && Date.now() < deadline) {
    await sleep(1000);
    rows = queryInbox(db, peer, includeAll, limit);
  }
  printResult(ctx, rows, (data) => table(data, [
    { label: 'id', value: (r) => `#${r.id}` },
    { label: 'from', value: (r) => r.sender },
    { label: 'kind', value: (r) => r.kind },
    { label: 'task', value: (r) => r.task_id ? `#${r.task_id}` : '' },
    { label: 'time', value: (r) => iso(r.created_at) },
    { label: 'body', value: (r) => r.body }
  ]));
}

async function msgAck(ctx, args) {
  const opts = parseOpts(args);
  const identity = resolveCurrentPeer(ctx, opts, 'peer', 'shell');
  const peer = identity.id;
  const id = intOpt(opts, 'id', intOpt({ id: opts._[0] }, 'id'));
  if (!id) throw new CliError('BAD_ARGS', 'Missing --id');
  const db = connect(ctx);
  touchCurrentPeer(db, ctx, identity, null, 'shell');
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  if (!message) throw new CliError('NOT_FOUND', `Message #${id} does not exist`);
  db.prepare(`
    INSERT INTO message_reads(message_id, peer, read_at)
    VALUES (?, ?, ?)
    ON CONFLICT(message_id, peer) DO UPDATE SET read_at = excluded.read_at
  `).run(id, peer, now());
  addEvent(db, 'message.ack', peer, message.task_id || null, { message_id: id });
  printResult(ctx, { id, peer }, (data) => `acknowledged message #${data.id} for ${data.peer}`);
}

async function cmdAsk(ctx, args) {
  if (args[0] === '--help' || args[0] === '-h') return helpAsk();
  const opts = parseOpts(args, { booleans: ['inject', 'no-enter'] });
  const recipient = opts.to || opts._[0];
  if (!recipient) throw new CliError('BAD_ARGS', 'Missing peer');
  const body = opts.body || opts._.slice(opts.to ? 0 : 1).join(' ');
  if (!body) throw new CliError('BAD_ARGS', 'Missing message');
  const identity = resolveCurrentPeer(ctx, opts, 'from', 'shell');
  const sender = identity.id;
  const taskId = intOpt(opts, 'task', null);
  const kind = opts.kind || 'ask';
  const runtime = opts.inject ? readRuntime(ctx) : null;
  const db = connect(ctx);
  touchCurrentPeer(db, ctx, identity, null, 'shell');
  const id = sendMessage(db, sender, recipient, taskId, kind, body);
  let injected = false;
  if (opts.inject) {
    await injectPeer(ctx, recipient, body, !opts['no-enter'], runtime);
    injected = true;
  }
  printResult(ctx, { id, sender, recipient, task_id: taskId, kind, body, injected }, (data) => `asked ${data.recipient} with message #${data.id}${data.injected ? ' and injected terminal input' : ''}`);
}

async function cmdBroadcast(ctx, args) {
  if (args[0] === '--help' || args[0] === '-h') return helpBroadcast();
  const opts = parseOpts(args, { booleans: ['inject', 'no-enter'] });
  const body = opts.body || opts._.join(' ');
  if (!body) throw new CliError('BAD_ARGS', 'Missing message');
  const identity = resolveCurrentPeer(ctx, opts, 'from', 'shell');
  const sender = identity.id;
  const taskId = intOpt(opts, 'task', null);
  const kind = opts.kind || 'broadcast';
  const runtime = opts.inject ? readRuntime(ctx) : null;
  const db = connect(ctx);
  touchCurrentPeer(db, ctx, identity, null, 'shell');
  const id = sendMessage(db, sender, 'all', taskId, kind, body);
  let injected = 0;
  if (opts.inject) {
    const sessions = await runtimeRequest(ctx, 'GET', '/api/sessions', null, runtime);
    const running = (sessions.sessions || []).filter((session) => session.status === 'running');
    for (const session of running) {
      await injectPeer(ctx, session.id, body, !opts['no-enter'], runtime);
      injected += 1;
    }
  }
  printResult(ctx, { id, sender, recipient: 'all', task_id: taskId, kind, body, injected }, (data) => `broadcast message #${data.id}${data.injected ? ` and injected ${data.injected} terminal(s)` : ''}`);
}

async function injectPeer(ctx, peer, text, enter = true, runtime = null) {
  return runtimeRequest(ctx, 'POST', `/api/sessions/${encodeURIComponent(peer)}/input`, { text, enter }, runtime);
}

async function cmdInject(ctx, args) {
  if (args[0] === '--help' || args[0] === '-h') return helpInject();
  const opts = parseOpts(args, { booleans: ['no-enter'] });
  const peer = opts.peer || opts._[0];
  if (!peer) throw new CliError('BAD_ARGS', 'Missing peer');
  const text = opts.body || opts._.slice(opts.peer ? 0 : 1).join(' ');
  if (!text) throw new CliError('BAD_ARGS', 'Missing text');
  const enter = !opts['no-enter'];
  const result = await injectPeer(ctx, peer, text, enter);
  printResult(ctx, { peer, text, enter, result }, (data) => `injected ${data.peer}${data.enter ? ' and pressed Enter' : ''}`);
}

async function cmdPeer(ctx, args) {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') return helpPeer();
  if (sub === 'list') return peerList(ctx, args.slice(1));
  if (sub === 'start') return peerStart(ctx, args.slice(1));
  if (sub === 'attach') return peerAttach(ctx, args.slice(1));
  if (sub === 'stop') return peerStop(ctx, args.slice(1));
  throw new CliError('BAD_ARGS', `Unknown peer command: ${sub}`);
}

async function peerList(ctx, args) {
  parseOpts(args);
  try {
    const data = await runtimeRequest(ctx, 'GET', '/api/sessions');
    const db = connect(ctx);
    let bindings;
    try {
      bindings = new Map(db.prepare('SELECT * FROM peer_bindings').all().map((row) => [row.peer, row]));
    } finally {
      db.close();
    }
    const rows = (data.sessions || []).map((session) => ({ ...session, binding: bindings.get(session.id) || null }));
    printResult(ctx, rows, (items) => table(items, [
      { label: 'id', value: (r) => r.id },
      { label: 'kind', value: (r) => r.kind },
      { label: 'role', value: (r) => r.role || '' },
      { label: 'status', value: (r) => r.status },
      { label: 'type', value: (r) => r.type || '' },
      { label: 'pane', value: (r) => r.pane || '' },
      { label: 'provider', value: (r) => r.binding ? r.binding.provider : '' },
      { label: 'resume', value: (r) => r.binding ? r.binding.resume_mode : '' },
      { label: 'session', value: (r) => r.binding ? (r.binding.provider_session_id || r.binding.provider_session_name || '') : '' },
      { label: 'pid', value: (r) => r.pid || '' },
      { label: 'command', value: (r) => r.command || '' }
    ]));
  } catch (err) {
    if (err instanceof CliError && ['RUNTIME_NOT_RUNNING', 'RUNTIME_UNREACHABLE'].includes(err.code)) {
      return cmdPeers(ctx, []);
    }
    throw err;
  }
}

async function peerStart(ctx, args) {
  const sep = args.indexOf('--');
  const optArgs = sep >= 0 ? args.slice(0, sep) : args;
  const cmdArgs = sep >= 0 ? args.slice(sep + 1) : [];
  const opts = parseOpts(optArgs, { booleans: ['last', 'continue', 'fork', 'force', 'restart-env'] });
  const id = opts.peer || opts._[0];
  if (!id) throw new CliError('BAD_ARGS', 'Missing peer');
  const firstCommand = cmdArgs[0] || '';
  const kind = inferPeerKind(id, opts.kind, firstCommand);
  const role = opts.role || 'peer';
  const cwd = path.resolve(opts.cwd || ctx.root);
  const built = buildPeerCommand(id, kind, opts, cmdArgs);
  const command = built.command;
  const binding = { ...built.binding, transport: 'tmux', runtime_session_id: id };

  let runtime;
  try { runtime = readRuntime(ctx); } catch (e) {
    if (e instanceof CliError && e.code === 'RUNTIME_NOT_RUNNING') {
      throw new CliError('RUNTIME_NOT_RUNNING',
        `No running web runtime found. Start ${CLI_NAME} web first, then ${CLI_NAME} peer start ${id}`);
    }
    throw e;
  }

  await runtimeRequest(ctx, 'GET', '/api/runtime', null, runtime);
  const db = connect(ctx);
  try {
    tx(db, () => {
      upsertPeer(db, {
        id, kind, role,
        worktree: cwd,
        branch: detectBranch(cwd),
        pid: null,
        status: 'starting',
        capabilities: 'tmux'
      });
      upsertPeerBinding(db, binding, Boolean(opts.force));
    });
  } finally {
    db.close();
  }
  const data = await runtimeRequest(ctx, 'POST', '/api/sessions', {
    id,
    kind,
    role,
    command,
    cwd,
    binding,
    env: childSessionEnv(),
    restartOnEnvChange: Boolean(opts['restart-env'])
  }, runtime);
  printResult(ctx, data.session, (session) =>
    `started ${session.id} (${session.kind}, ${session.role})${session.pane ? ` pane=${session.pane}` : ` pid=${session.pid}`}`);
}

async function peerAttach(ctx, args) {
  const opts = parseOpts(args, { booleans: ['force'] });
  const id = opts.peer || opts._[0];
  if (!id) throw new CliError('BAD_ARGS', 'Missing peer');
  const pane = opts.pane || process.env.TMUX_PANE || null;
  const kind = opts.kind || null;
  const role = opts.role || 'peer';
  const cwd = opts.cwd ? path.resolve(opts.cwd) : null;

  let runtime;
  try { runtime = readRuntime(ctx); } catch (e) {
    if (e instanceof CliError && e.code === 'RUNTIME_NOT_RUNNING') {
      throw new CliError('RUNTIME_NOT_RUNNING',
        `No running web runtime found. Start ${CLI_NAME} web first, then ${CLI_NAME} peer attach ${id}`);
    }
    throw e;
  }
  await runtimeRequest(ctx, 'GET', '/api/runtime', null, runtime);
  const data = await runtimeRequest(ctx, 'POST', '/api/sessions/attach', {
    id,
    kind,
    role,
    pane,
    cwd,
    force: Boolean(opts.force)
  }, runtime);
  printResult(ctx, data.session, (session) => `attached ${session.id} (${session.kind}, ${session.role}) pane=${session.pane}`);
}

async function peerStop(ctx, args) {
  const opts = parseOpts(args);
  const id = opts.peer || opts._[0];
  if (!id) throw new CliError('BAD_ARGS', 'Missing peer');
  let data;
  try {
    data = await runtimeRequest(ctx, 'POST', `/api/sessions/${encodeURIComponent(id)}/stop`, {});
  } catch (err) {
    if (err instanceof CliError && err.code === 'RUNTIME_NOT_RUNNING') {
      // No server: just update the DB to mark the peer as exited
      const db = connect(ctx);
      try {
        db.prepare('UPDATE peers SET status = ?, last_seen_at = ? WHERE id = ?').run('exited', now(), id);
        addEvent(db, 'peer.stopped', process.env.HCC_PEER || 'human', null, { peer: id });
      } finally { db.close(); }
      printResult(ctx, { id, status: 'exited' }, (s) => `stopped ${s.id} (no server running — DB marked exited)`);
      return;
    }
    throw err;
  }
  printResult(ctx, data.session, (session) => `stopped ${session.id}`);
}

async function cmdLock(ctx, args) {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') return helpLock();
  if (sub === 'acquire') return lockAcquire(ctx, args.slice(1));
  if (sub === 'release') return lockRelease(ctx, args.slice(1));
  if (sub === 'renew') return lockRenew(ctx, args.slice(1));
  if (sub === 'list') return lockList(ctx, args.slice(1));
  throw new CliError('BAD_ARGS', `Unknown lock command: ${sub}`);
}

async function lockAcquire(ctx, args) {
  const opts = parseOpts(args);
  const identity = resolveCurrentPeer(ctx, opts, 'peer', 'shell');
  const peer = identity.id;
  const resource = required(opts, 'resource');
  const taskId = intOpt(opts, 'task', null);
  const ttl = intOpt(opts, 'ttl', DEFAULT_LOCK_TTL);
  const reason = opts.reason || '';
  const db = connect(ctx);
  touchCurrentPeer(db, ctx, identity, 'working', 'shell');
  const lock = tx(db, () => {
    const t = now();
    const existing = db.prepare('SELECT * FROM locks WHERE resource = ?').get(resource);
    if (existing && existing.expires_at > t && existing.owner !== peer) {
      throw new CliError('LOCK_HELD', `Resource is locked by ${existing.owner}`, {
        resource,
        owner: existing.owner,
        expires_at: iso(existing.expires_at)
      });
    }
    db.prepare(`
      INSERT INTO locks(resource, owner, task_id, reason, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(resource) DO UPDATE SET
        owner = excluded.owner,
        task_id = excluded.task_id,
        reason = excluded.reason,
        expires_at = excluded.expires_at
    `).run(resource, peer, taskId, reason, t + ttl, existing ? existing.created_at : t);
    addEvent(db, 'lock.acquired', peer, taskId, { resource, ttl, previous_owner: existing ? existing.owner : null });
    return db.prepare('SELECT * FROM locks WHERE resource = ?').get(resource);
  });
  printResult(ctx, lock, (data) => `locked ${data.resource} by ${data.owner} until ${iso(data.expires_at)}`);
}

async function lockRelease(ctx, args) {
  const opts = parseOpts(args, { booleans: ['force'] });
  const identity = resolveCurrentPeer(ctx, opts, 'peer', 'shell');
  const peer = identity.id;
  const resource = required(opts, 'resource');
  const db = connect(ctx);
  touchCurrentPeer(db, ctx, identity, null, 'shell');
  const result = tx(db, () => {
    const existing = db.prepare('SELECT * FROM locks WHERE resource = ?').get(resource);
    if (!existing) return { released: false, resource };
    if (existing.owner !== peer && !opts.force) {
      throw new CliError('LOCK_OWNED', `Lock is owned by ${existing.owner}`, { owner: existing.owner });
    }
    db.prepare('DELETE FROM locks WHERE resource = ?').run(resource);
    addEvent(db, 'lock.released', peer, existing.task_id || null, { resource, force: Boolean(opts.force) });
    return { released: true, resource };
  });
  printResult(ctx, result, (data) => data.released ? `released ${data.resource}` : `no lock for ${data.resource}`);
}

async function lockRenew(ctx, args) {
  const opts = parseOpts(args);
  const identity = resolveCurrentPeer(ctx, opts, 'peer', 'shell');
  const peer = identity.id;
  const resource = required(opts, 'resource');
  const ttl = intOpt(opts, 'ttl', DEFAULT_LOCK_TTL);
  const db = connect(ctx);
  touchCurrentPeer(db, ctx, identity, 'working', 'shell');
  const lock = tx(db, () => {
    const existing = db.prepare('SELECT * FROM locks WHERE resource = ?').get(resource);
    if (!existing) throw new CliError('NOT_FOUND', `No lock for ${resource}`);
    if (existing.owner !== peer) throw new CliError('LOCK_OWNED', `Lock is owned by ${existing.owner}`, { owner: existing.owner });
    db.prepare('UPDATE locks SET expires_at = ? WHERE resource = ?').run(now() + ttl, resource);
    addEvent(db, 'lock.renewed', peer, existing.task_id || null, { resource, ttl });
    return db.prepare('SELECT * FROM locks WHERE resource = ?').get(resource);
  });
  printResult(ctx, lock, (data) => `renewed ${data.resource} until ${iso(data.expires_at)}`);
}

async function lockList(ctx, args) {
  const opts = parseOpts(args, { booleans: ['all'] });
  const db = connect(ctx);
  const rows = opts.all
    ? db.prepare('SELECT * FROM locks ORDER BY resource ASC').all()
    : db.prepare('SELECT * FROM locks WHERE expires_at > ? ORDER BY resource ASC').all(now());
  printResult(ctx, rows, (data) => table(data, [
    { label: 'resource', value: (r) => r.resource },
    { label: 'owner', value: (r) => r.owner },
    { label: 'task', value: (r) => r.task_id ? `#${r.task_id}` : '' },
    { label: 'expires', value: (r) => iso(r.expires_at) },
    { label: 'reason', value: (r) => r.reason || '' }
  ]));
}

async function cmdHandoff(ctx, args) {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') return helpHandoff();
  if (sub === 'create') return handoffCreate(ctx, args.slice(1));
  if (sub === 'list') return handoffList(ctx, args.slice(1));
  throw new CliError('BAD_ARGS', `Unknown handoff command: ${sub}`);
}

async function handoffCreate(ctx, args) {
  const opts = parseOpts(args);
  const identity = resolveCurrentPeer(ctx, opts, 'from', 'shell');
  const from = identity.id;
  const taskId = intOpt(opts, 'task', null);
  const to = opts.to || null;
  const summary = required(opts, 'summary');
  const files = opts['changed-files']
    ? normalizeListText(opts['changed-files'])
    : JSON.stringify(changedFiles(ctx.cwd));
  const tests = normalizeListText(opts.tests, []);
  const risks = normalizeListText(opts.risks, []);
  const db = connect(ctx);
  touchCurrentPeer(db, ctx, identity, 'idle', 'shell');
  const id = tx(db, () => {
    const info = db.prepare(`
      INSERT INTO handoffs(task_id, from_peer, to_peer, summary, changed_files, tests, risks, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(taskId, from, to, summary, files, tests, risks, now());
    const handoffId = Number(info.lastInsertRowid);
    addEvent(db, 'handoff.created', from, taskId, { handoff_id: handoffId, to });
    if (to) sendMessage(db, from, to, taskId, 'handoff', `Handoff #${handoffId}: ${summary}`);
    return handoffId;
  });
  printResult(ctx, { id, task_id: taskId, from, to, summary, changed_files: files, tests, risks }, (data) => `created handoff #${data.id}${data.to ? ` -> ${data.to}` : ''}`);
}

async function handoffList(ctx, args) {
  const opts = parseOpts(args);
  const taskId = intOpt(opts, 'task', null);
  const limit = intOpt(opts, 'limit', 20);
  const db = connect(ctx);
  const rows = taskId
    ? db.prepare('SELECT * FROM handoffs WHERE task_id = ? ORDER BY id DESC LIMIT ?').all(taskId, limit)
    : db.prepare('SELECT * FROM handoffs ORDER BY id DESC LIMIT ?').all(limit);
  printResult(ctx, rows, (data) => table(data, [
    { label: 'id', value: (r) => `#${r.id}` },
    { label: 'task', value: (r) => r.task_id ? `#${r.task_id}` : '' },
    { label: 'from', value: (r) => r.from_peer },
    { label: 'to', value: (r) => r.to_peer || '' },
    { label: 'time', value: (r) => iso(r.created_at) },
    { label: 'summary', value: (r) => r.summary }
  ]));
}

async function cmdEvent(ctx, args) {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') return helpEvent();
  if (sub === 'tail') return eventTail(ctx, args.slice(1));
  throw new CliError('BAD_ARGS', `Unknown event command: ${sub}`);
}

async function eventTail(ctx, args) {
  const opts = parseOpts(args);
  const limit = intOpt(opts, 'limit', 30);
  const db = connect(ctx);
  const rows = db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit).reverse();
  printResult(ctx, rows, (data) => table(data, [
    { label: 'id', value: (r) => `#${r.id}` },
    { label: 'type', value: (r) => r.type },
    { label: 'actor', value: (r) => r.actor || '' },
    { label: 'task', value: (r) => r.task_id ? `#${r.task_id}` : '' },
    { label: 'time', value: (r) => iso(r.created_at) }
  ]));
}

async function cmdStatus(ctx, args) {
  const opts = parseOpts(args);
  const identity = resolveCurrentPeer(ctx, opts, 'peer', 'shell');
  const peer = identity.id;
  const db = connect(ctx);
  touchCurrentPeer(db, ctx, identity, null, 'shell');
  const t = now();
  const activePeers = db.prepare('SELECT COUNT(*) AS n FROM peers WHERE last_seen_at >= ?').get(t - ACTIVE_PEER_TTL).n;
  const stalePeers = db.prepare('SELECT COUNT(*) AS n FROM peers WHERE last_seen_at < ?').get(t - ACTIVE_PEER_TTL).n;
  const taskRows = db.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status ORDER BY status').all();
  const locks = db.prepare('SELECT COUNT(*) AS n FROM locks WHERE expires_at > ?').get(t).n;
  const unread = peer ? queryInbox(db, peer, false, 1000).length : null;
  const recent = db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 8').all().reverse();
  const data = { root: ctx.root, db: ctx.dbPath, active_peers: activePeers, stale_peers: stalePeers, tasks: taskRows, active_locks: locks, unread, recent_events: recent };
  printResult(ctx, data, (s) => {
    const taskSummary = s.tasks.length ? s.tasks.map((r) => `${r.status}:${r.n}`).join(', ') : 'none';
    return [
      `root: ${s.root}`,
      `db: ${s.db}`,
      `peers: active=${s.active_peers}, stale=${s.stale_peers}`,
      `tasks: ${taskSummary}`,
      `locks: active=${s.active_locks}`,
      peer ? `inbox(${peer}): unread=${s.unread}` : null,
      '',
      'recent events:',
      table(s.recent_events, [
        { label: 'id', value: (r) => `#${r.id}` },
        { label: 'type', value: (r) => r.type },
        { label: 'actor', value: (r) => r.actor || '' },
        { label: 'task', value: (r) => r.task_id ? `#${r.task_id}` : '' },
        { label: 'time', value: (r) => iso(r.created_at) }
      ])
    ].filter((line) => line !== null).join('\n');
  });
}

async function cmdPrompt(ctx, args) {
  const opts = parseOpts(args);
  const peer = required(opts, 'peer', 'HCC_PEER');
  const kind = opts.kind || 'codex';
  const role = opts.role || 'peer';
  const cmd = `node ${commandPath()} --root ${JSON.stringify(ctx.root)}`;
  const text = `You are ${peer}, a ${kind} ${role} session working in this project.

Use hcc as the shared coordination bus for this terminal session. This
project uses a flat peer mesh: there is no required main/worker hierarchy.

Run these commands before changing files:

${cmd} register --peer ${peer} --kind ${kind} --role ${role}
${cmd} msg inbox --peer ${peer}
${cmd} task next --peer ${peer}

Coordination rules:
- Claim exactly one task before editing.
- Before editing a file, directory, module, or shared test resource, run:
  ${cmd} lock acquire --peer ${peer} --resource <path-or-module> --task <task-id>
- If a lock is held by another peer, message that peer instead of editing:
  ${cmd} msg send --from ${peer} --to <peer-id> --body "<question>"
- Report progress or requests through msg send.
- Before stopping, run tests, create a handoff, and release locks:
  ${cmd} handoff create --from ${peer} --task <task-id> --summary "<what changed>" --tests "<commands/results>" --risks "<known risks>"
  ${cmd} task done --peer ${peer} --id <task-id> --summary "<done summary>"
  ${cmd} lock release --peer ${peer} --resource <path-or-module>
`;
  printResult(ctx, { prompt: text }, () => text);
}

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

async function readJsonRequest(req) {
  const body = await readRequestBody(req);
  if (!body.trim()) return {};
  return JSON.parse(body);
}

function sendHttp(res, status, contentType, body) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendJson(res, status, body) {
  sendHttp(res, status, 'application/json; charset=utf-8', JSON.stringify(body, null, 2));
}

function sendFile(res, filePath, contentType) {
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

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function authOk(url, req, token) {
  if (!token) return true;
  const queryToken = url.searchParams.get('token');
  const auth = req.headers.authorization || '';
  return queryToken === token || auth === `Bearer ${token}`;
}

function defaultSessionCommand(kind) {
  if (kind === 'codex') return 'codex';
  if (kind === 'claude') return 'claude';
  return process.env.SHELL || 'bash';
}

function nextSessionId(existingIds, kind) {
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

function listenServer(server, host, port, autoPort) {
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

async function cmdUp(ctx, args) {
  if (args[0] === '--help' || args[0] === '-h') return helpUp();
  const opts = parseOpts(args, { booleans: ['no-guidance', 'no-discover'] });
  validateOpts('up', opts, ['no-guidance', 'no-discover']);
  const result = await prepareLocalBus(ctx, opts);
  return printResult(ctx, result, (r) => {
    const lines = [
      `${PRODUCT_NAME} local coordination ready`,
      `project: ${r.root}`,
      `database: ${r.db}`
    ];
    if (r.guidance) lines.push(`guidance: ${r.guidance}`);
    if (r.hooks.claudeInstalled) lines.push('Claude Code hooks installed');
    if (r.hooks.codexInstalled) lines.push('Codex hooks installed');
    if (r.detected.length) lines.push(`detected: ${r.detected.map((s) => s.peerId).join(', ')}`);
    lines.push('web: run hcc web when you need browser terminal control');
    return lines.join('\n');
  });
}

async function prepareLocalBus(ctx, opts = {}) {
  let guidance = null;
  const db = connect(ctx);
  try {
    guidance = opts['no-guidance'] ? null : writeGuidance(ctx);
  } finally {
    db.close();
  }

  const hooks = { claudeInstalled: false, codexInstalled: false };
  const shims = { installed: [], skipped: [], pathUpdated: false, rcFile: null };
  try {
    const { verifyClaudeHooks, installClaudeHooks,
            verifyCodexHooks, installCodexHooks,
            installShims, installPathEntry } = await loadSetup();
    if (!verifyClaudeHooks()) {
      installClaudeHooks(commandPath());
      hooks.claudeInstalled = true;
    }
    if (!verifyCodexHooks()) {
      try {
        installCodexHooks(commandPath());
        hooks.codexInstalled = true;
      } catch {}
    }
    if (opts.installShims) {
      const result = installShims(commandPath());
      shims.installed = result.installed;
      shims.skipped = result.skipped;
      if (result.installed.length) {
        const pathResult = installPathEntry();
        shims.pathUpdated = !pathResult.alreadyPresent;
        shims.rcFile = pathResult.rcFile;
      }
    }
  } catch {}

  const detected = [];
  if (!opts['no-discover']) {
    try {
      const { scanClaudeSessions, scanCodexSessions, scanProcesses } = await loadDiscover();
      const found = [
        ...scanClaudeSessions(),
        ...scanCodexSessions(),
        ...scanProcesses(),
      ].filter((s) => s.hccRoot === ctx.root);
      const byId = new Map();
      for (const s of found) {
        if (!byId.has(s.peerId)) byId.set(s.peerId, s);
      }
      if (byId.size > 0) {
        const db2 = connect(ctx);
        try {
          for (const s of byId.values()) {
            detected.push(s);
            upsertPeer(db2, {
              id: s.peerId, kind: s.kind, role: 'peer',
              worktree: s.cwd,
              branch: detectBranch(s.cwd),
              pid: s.pid,
              status: 'running',
              capabilities: 'detected'
            });
            upsertPeerBinding(db2, bindingFromDetected(s, s.transport || 'detected'), true);
          }
        } finally {
          db2.close();
        }
      }
    } catch {}
  }

  return {
    root: ctx.root,
    db: ctx.dbPath,
    guidance,
    hooks,
    shims,
    detected
  };
}

async function startWebBackground(ctx, args) {
  const opts = parseOpts(args, { booleans: ['local', 'no-guidance', 'no-discover'] });
  validateOpts('web', opts, ['host', 'port', 'token', 'local', 'no-guidance', 'no-discover']);
  ensureTmuxAvailable({ autoInstall: true });
  const setup = await prepareLocalBus(ctx, { ...opts, installShims: true });
  registerProject(ctx);

  const existing = await readHealthyGlobalRuntime();
  if (existing) {
    try {
      await runtimeRequest(ctx, 'POST', '/api/projects', { root: ctx.root, db: ctx.dbPath }, existing);
    } catch {}
    writeRuntime(ctx, { ...existing, root: ctx.root, db: ctx.dbPath, project_root: ctx.root, global_runtime: true });
    return printWebRuntime(ctx, existing, { already: true, logFile: webLogPath(ctx), setup });
  }

  try { fs.rmSync(runtimePath(ctx), { force: true }); } catch {}
  try { fs.rmSync(globalRuntimePath(), { force: true }); } catch {}

  const logFile = webLogPath(ctx);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, `\n[${new Date().toISOString()}] ${CLI_NAME} web ${args.join(' ')}\n`);
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
      const detail = tailFile(logFile);
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
  const detail = tailFile(logFile);
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
    lines.push(`stop: ${r.stop}`);
    return lines.join('\n');
  });
}

async function cmdDown(ctx, args) {
  if (args[0] === '--help' || args[0] === '-h') return helpDown();
  const runtime = readRuntime(ctx);
  try {
    await runtimeRequest(ctx, 'POST', '/api/runtime/stop', {}, runtime);
  } catch (err) {
    if (!(err instanceof CliError && err.code === 'RUNTIME_UNREACHABLE')) throw err;
    try { fs.rmSync(runtimePath(ctx), { force: true }); } catch {}
  }
  printResult(ctx, { runtime: runtime.source || runtime.base_url }, () => `${PRODUCT_NAME} runtime stopped`);
}

function statusSnapshot(ctx, peer = null) {
  const db = connect(ctx);
  try {
    const t = now();
    const peers = db.prepare(`
      SELECT id, kind, role, status, worktree, branch, pid, capabilities,
             created_at, last_seen_at, (? - last_seen_at) AS age_sec
      FROM peers
      ORDER BY last_seen_at DESC, id ASC
      LIMIT 200
    `).all(t);
    const tasks = queryOpenTasks(db, 200);
    const locks = db.prepare(`
      SELECT resource, owner, task_id, reason, expires_at, created_at
      FROM locks
      WHERE expires_at > ?
      ORDER BY resource ASC
      LIMIT 200
    `).all(t);
    const messages = peer
      ? queryInbox(db, peer, false, 50)
      : db.prepare(`
          SELECT id, sender, recipient, task_id, kind, body, created_at
          FROM messages
          ORDER BY id DESC
          LIMIT 50
        `).all().reverse();
    const handoffs = db.prepare(`
      SELECT id, task_id, from_peer, to_peer, summary, changed_files, tests, risks, created_at
      FROM handoffs
      ORDER BY id DESC
      LIMIT 50
    `).all().reverse();
    const events = db.prepare(`
      SELECT id, type, actor, task_id, payload, created_at
      FROM events
      ORDER BY id DESC
      LIMIT 80
    `).all().reverse();
    return {
      root: ctx.root,
      db: ctx.dbPath,
      now: t,
      active_peer_ttl: ACTIVE_PEER_TTL,
      peers,
      tasks,
      locks,
      messages,
      handoffs,
      events
    };
  } finally {
    try {
      db.close();
    } catch {
      // Ignore close failures for short-lived snapshots.
    }
  }
}

function webIndexHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>hello-cc</title>
  <link rel="stylesheet" href="/assets/xterm.css">
  <style>
    :root {
      color-scheme: dark;
      --bg: #101214;
      --panel: #181b1f;
      --panel-2: #20242a;
      --border: #303640;
      --text: #eef2f6;
      --muted: #a3adba;
      --accent: #40c4aa;
      --warn: #f2bb4f;
      --danger: #ff6b6b;
      --ok: #75d17c;
      --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      --sans: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      overflow: hidden;
    }
    button, input, select {
      font: inherit;
    }
    button {
      border: 1px solid var(--border);
      background: var(--panel-2);
      color: var(--text);
      height: 32px;
      border-radius: 6px;
      padding: 0 10px;
      cursor: pointer;
    }
    button:hover { border-color: var(--accent); }
    button.primary { background: #1b5f54; border-color: #267f71; }
    button.danger { background: #5d252a; border-color: #8c333d; }
    input, select {
      width: 100%;
      height: 32px;
      border: 1px solid var(--border);
      background: #0d0f12;
      color: var(--text);
      border-radius: 6px;
      padding: 0 9px;
      min-width: 0;
    }
    label {
      display: grid;
      gap: 4px;
      color: var(--muted);
      font-size: 12px;
    }
    .app {
      height: 100vh;
      display: grid;
      grid-template-columns: 320px 1fr 360px;
      min-width: 980px;
    }
    .sidebar, .inspector {
      min-height: 0;
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
      background: var(--panel);
      border-right: 1px solid var(--border);
      display: grid;
      grid-template-rows: auto auto auto auto 1fr;
    }
    .inspector {
      border-right: 0;
      border-left: 1px solid var(--border);
      grid-template-rows: auto 1fr;
    }
    .sidebar > *, .inspector > * {
      min-width: 0;
      max-width: 100%;
    }
    .brand {
      padding: 14px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .brand > div {
      min-width: 0;
    }
    .brand strong { font-size: 15px; }
    .brand span, .path {
      color: var(--muted);
      font-family: var(--mono);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #connState {
      flex: 0 0 92px;
      max-width: 92px;
      text-align: right;
    }
    .form {
      padding: 12px;
      display: grid;
      gap: 9px;
      border-bottom: 1px solid var(--border);
    }
    .grid2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .start-row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      align-items: end;
    }
    .session-header {
      border-bottom: 1px solid var(--border);
      padding: 8px 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 48px;
    }
    .session-header strong {
      font-size: 13px;
      font-weight: 600;
    }
    .session-header label {
      width: 118px;
    }
    .sessions, .state {
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 10px;
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      align-content: start;
      gap: 8px;
      scrollbar-width: thin;
      scrollbar-color: #3a3f4a transparent;
    }
    .sessions::-webkit-scrollbar, .state::-webkit-scrollbar { width: 8px; }
    .sessions::-webkit-scrollbar-track, .state::-webkit-scrollbar-track { background: transparent; }
    .sessions::-webkit-scrollbar-thumb, .state::-webkit-scrollbar-thumb { background: #3a3f4a; border-radius: 4px; }
    .session {
      border: 1px solid var(--border);
      background: #111418;
      border-radius: 8px;
      padding: 9px;
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 7px;
      cursor: pointer;
    }
    .session.active { border-color: var(--accent); }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }
    .row strong {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .badge {
      font-family: var(--mono);
      font-size: 11px;
      border: 1px solid var(--border);
      color: var(--muted);
      padding: 2px 6px;
      border-radius: 999px;
      white-space: nowrap;
    }
    .badge.running { color: var(--ok); border-color: #3b7b44; }
    .badge.exited { color: var(--danger); border-color: #87434a; }
    .main {
      min-height: 0;
      min-width: 0;
      overflow: hidden;
      display: grid;
      grid-template-rows: auto 1fr;
      background: #0b0d10;
    }
    .toolbar {
      min-height: 48px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      overflow: hidden;
    }
    .toolbar .title {
      min-width: 180px;
      display: grid;
      gap: 2px;
    }
    .quick {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      justify-content: flex-end;
      width: 100%;
    }
    #terminal {
      min-height: 0;
      overflow: hidden;
      padding: 8px;
    }
    #terminal .xterm {
      cursor: default;
    }
    /* The terminal mirrors a tmux pane; keep xterm's own hidden helper textarea
       off-screen, but DO show the rendered block cursor (positioned from tmux). */
    #terminal .xterm-helper-textarea {
      caret-color: transparent !important;
      color: transparent !important;
      background: transparent !important;
      left: -10000px !important;
      top: 0 !important;
      width: 1px !important;
      height: 1px !important;
      opacity: 0 !important;
    }
    .card {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: #111418;
      overflow: hidden;
    }
    .card h2 {
      margin: 0;
      padding: 8px 10px;
      border-bottom: 1px solid var(--border);
      font-size: 13px;
      font-weight: 600;
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }
    .card .body {
      padding: 8px 10px;
      display: grid;
      gap: 6px;
    }
    .item {
      display: grid;
      gap: 2px;
      font-size: 12px;
      color: var(--muted);
      border-bottom: 1px solid #242932;
      padding-bottom: 6px;
    }
    .item:last-child { border-bottom: 0; padding-bottom: 0; }
    .item strong { color: var(--text); font-size: 12px; }
    .mono { font-family: var(--mono); }
    .empty { color: var(--muted); font-size: 12px; }
    .sec-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); padding: 6px 10px 2px; display: flex; align-items: center; gap: 6px; }
    #terminal { display: flex; flex-direction: column; }
  </style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div class="brand">
        <div>
          <strong>hello-cc</strong>
          <div class="path" id="rootPath"></div>
        </div>
        <span id="connState">offline</span>
      </div>
      <div class="form" style="padding-top:10px;padding-bottom:10px">
        <label>Project<select id="projectSelect"></select></label>
        <label>Project path<input id="projectPath" placeholder="/path/to/project"></label>
        <button id="addProjectBtn" type="button">Register Project</button>
      </div>
      <form class="form" id="startForm">
        <div class="start-row">
          <label>New session<select id="kind"><option value="codex">codex</option><option value="claude">claude</option><option value="shell">shell</option></select></label>
          <button class="primary" type="submit">Start</button>
        </div>
      </form>
      <div class="session-header">
        <strong>Sessions</strong>
        <label>View<select id="sessionKindFilter"><option value="all">all</option><option value="claude">claude</option><option value="codex">codex</option><option value="shell">shell</option><option value="other">other</option></select></label>
      </div>
      <div class="sessions" id="sessions"></div>
    </aside>

    <main class="main">
      <div class="toolbar">
        <div class="title">
          <strong id="activeTitle">No session selected</strong>
          <span class="path" id="activeMeta">Start or select a session from the left panel</span>
        </div>
        <div class="quick" id="quickBar">
          <button data-send="register">register</button>
          <button data-send="inbox">inbox</button>
          <button data-send="next">next task</button>
          <button data-send="status">status</button>
          <button data-send="heartbeat">heartbeat</button>
          <button class="danger" id="stopBtn" type="button">stop</button>
        </div>
      </div>
      <div id="terminal" style="min-height:0;flex:1"></div>
      <div id="detectedPanel" style="display:none;overflow:auto;flex:1"></div>
    </main>

    <aside class="inspector">
      <div class="brand">
        <strong>Project State</strong>
        <button id="refreshBtn" type="button">Refresh</button>
      </div>
      <div class="state" id="state"></div>
    </aside>
  </div>

  <script src="/assets/xterm.js"></script>
  <script>
    const initialParams = new URLSearchParams(location.search);
    const token = initialParams.get('token') || '';
    const headers = token ? { Authorization: 'Bearer ' + token } : {};
    let currentProject = initialParams.get('project') || initialParams.get('root') || '';
    let projects = [];
    let sessionKindFilter = initialParams.get('kind') || 'all';
    let sessions  = [];    // managed (PTY) sessions
    let detected  = [];    // coordination-only peers (from hooks/watcher)
    let active    = null;  // active managed session id
    let activeDetected = null; // active detected peer id
    let activeType = 'managed'; // 'managed' | 'detected'
    let ws        = null;
    let wsReconnectTimer = null;

    function requestQuery(extra = {}) {
      const params = new URLSearchParams();
      if (token) params.set('token', token);
      if (currentProject) params.set('root', currentProject);
      for (const [key, value] of Object.entries(extra)) {
        if (value !== undefined && value !== null && value !== '') params.set(key, value);
      }
      const text = params.toString();
      return text ? '?' + text : '';
    }

    function updateLocationProject() {
      const params = new URLSearchParams(location.search);
      if (token) params.set('token', token);
      if (currentProject) params.set('project', currentProject);
      if (sessionKindFilter && sessionKindFilter !== 'all') params.set('kind', sessionKindFilter);
      history.replaceState(null, '', location.pathname + '?' + params.toString());
    }

    const term = new Terminal({
      cursorBlink: true,
      cursorInactiveStyle: 'outline',
      cursorStyle: 'bar',
      convertEol: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      theme: { background: '#0b0d10', foreground: '#eef2f6', cursor: '#7dd3fc', cursorAccent: '#0b0d10' }
    });
    term.open(document.getElementById('terminal'));

    // Accurate terminal sizing via character measurement
    function measureCharSize() {
      const el = document.getElementById('terminal');
      const canvas = document.createElement('canvas');
      const ctx2d = canvas.getContext('2d');
      ctx2d.font = '13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      const m = ctx2d.measureText('M');
      return { w: m.width || 8, h: 17 };
    }

    function resizeTerm() {
      const el = document.getElementById('terminal');
      const { w, h } = measureCharSize();
      const cols = Math.max(60, Math.floor((el.clientWidth  - 16) / w));
      const rows = Math.max(10, Math.floor((el.clientHeight - 16) / h));
      term.resize(cols, rows);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    }
    window.addEventListener('resize', resizeTerm);
    setTimeout(resizeTerm, 80);

    term.onData((data) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    async function api(path, options = {}) {
      const res = await fetch(path + (path.includes('?') ? '&' : '?') + requestQuery().slice(1), {
        ...options,
        headers: { 'Content-Type': 'application/json', ...headers, ...(options.headers || {}) }
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || json.message || 'request failed');
      return json;
    }

    function renderProjects() {
      const select = document.getElementById('projectSelect');
      select.innerHTML = projects.map((p) =>
        '<option value="' + esc(p.root) + '">' + esc((p.name || p.root) + ' · ' + p.root) + '</option>'
      ).join('');
      if (currentProject) select.value = currentProject;
      document.getElementById('sessionKindFilter').value = sessionKindFilter;
    }

    function kindMatches(item) {
      const kind = ['claude', 'codex', 'shell'].includes(item.kind) ? item.kind : 'other';
      return sessionKindFilter === 'all' || kind === sessionKindFilter;
    }

    async function loadProjects() {
      const data = await api('/api/projects');
      projects = data.projects || [];
      if (!currentProject) currentProject = data.current?.root || projects[0]?.root || '';
      renderProjects();
      updateLocationProject();
    }

    async function switchProject(root) {
      currentProject = root;
      updateLocationProject();
      active = null;
      activeDetected = null;
      activeType = 'managed';
      if (ws) { clearTimeout(wsReconnectTimer); ws.close(); ws = null; }
      term.reset();
      document.getElementById('activeTitle').textContent = 'No session selected';
      document.getElementById('activeMeta').textContent = 'Start or select a session from the left panel';
      await Promise.all([refreshSessions(), refreshDetected(), refreshState()]);
      const first = sessions.find(s => s.status === 'running');
      if (first) connectManaged(first.id);
    }

    function esc(text) {
      return String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }

    function fmtTime(ts) {
      if (!ts) return '';
      return new Date(ts * 1000).toLocaleTimeString();
    }

    document.getElementById('projectSelect').addEventListener('change', (event) => {
      switchProject(event.target.value).catch(console.error);
    });
    document.getElementById('sessionKindFilter').addEventListener('change', (event) => {
      sessionKindFilter = event.target.value || 'all';
      updateLocationProject();
      renderSections();
    });
    document.getElementById('addProjectBtn').addEventListener('click', async () => {
      const input = document.getElementById('projectPath');
      const root = input.value.trim();
      if (!root) return;
      await api('/api/projects', { method: 'POST', body: JSON.stringify({ root }) });
      input.value = '';
      await loadProjects();
      await switchProject(root);
    });

    // ── Sessions rendering (managed + detected) ──────────────────────────
    function renderSections() {
      const box = document.getElementById('sessions');
      const visibleSessions = sessions.filter(kindMatches);
      const visibleDetected = detected.filter(kindMatches);
      const filterNote = sessionKindFilter === 'all' ? '' : '<br><br>View filter: ' + esc(sessionKindFilter);
      const manHtml = visibleSessions.length
        ? visibleSessions.map((s) => \`
          <div class="session \${active === s.id && activeType === 'managed' ? 'active' : ''}" data-id="\${esc(s.id)}" data-type="managed">
            <div class="row"><strong>\${esc(s.id)}</strong><span class="badge \${esc(s.status)}">\${esc(s.status)}</span></div>
            <div class="row"><span class="badge">\${esc(s.kind)}</span><span class="badge \${s.type === 'external' || s.type === 'tmux' ? 'warn' : ''}">\${s.type === 'external' ? 'external' : s.type === 'tmux' ? 'tmux' : 'pty'}</span></div>
            <div class="path">\${esc(s.command)}</div>
          </div>\`).join('')
        : '<div class="empty">No active sessions.' + filterNote + '<br><br>Start one above<br>or run in any terminal:<br><code>hcc peer start X -- claude</code></div>';

      const detHtml = visibleDetected.length
        ? visibleDetected.map((p) => \`
          <div class="session \${activeDetected === p.id && activeType === 'detected' ? 'active' : ''}" data-id="\${esc(p.id)}" data-type="detected">
            <div class="row"><strong>\${esc(p.id)}</strong><span class="badge" style="color:var(--warn);border-color:#6b5a20">detected</span></div>
            <div class="row"><span class="badge">\${esc(p.kind)}</span><span class="badge">\${esc(p.status)}</span></div>
            <div class="path" title="\${esc(p.worktree || '')}">\${esc((p.worktree || '').split('/').slice(-2).join('/'))}</div>
          </div>\`).join('')
        : '<div class="empty">No detected peers.' + filterNote + '</div>';

      const savedScroll = box.scrollTop;
      box.innerHTML = \`
        <div class="sec-label">Managed <span class="badge">\${visibleSessions.filter(s=>s.status==='running').length} running</span></div>
        \${manHtml}
        <div class="sec-label" style="margin-top:10px">Detected <span class="badge" style="color:var(--warn)">\${visibleDetected.length}</span></div>
        \${detHtml}
      \`;
      box.scrollTop = savedScroll;
      box.querySelectorAll('.session[data-type="managed"]').forEach((el) => {
        el.addEventListener('click', () => connectManaged(el.dataset.id));
      });
      box.querySelectorAll('.session[data-type="detected"]').forEach((el) => {
        el.addEventListener('click', () => connectDetected(el.dataset.id));
      });
    }

    async function refreshSessions() {
      const data = await api('/api/sessions');
      sessions = data.sessions || [];
      renderSections();
      document.getElementById('connState').textContent = 'online';
    }

    async function refreshDetected() {
      try {
        const data = await api('/api/detected');
        detected = data.detected || [];
        renderSections();
      } catch {}
    }

    // ── Project state panel ───────────────────────────────────────────────
    function renderState(data) {
      document.getElementById('rootPath').textContent = data.root || '';
      const state = document.getElementById('state');
      const tasks = (data.tasks || []).slice(0, 8).map((t) => \`
        <div class="item"><strong>#\${t.id} \${esc(t.title)}</strong><span>\${esc(t.status)} owner=\${esc(t.owner || '')} assignee=\${esc(t.assignee || '')}</span></div>
      \`).join('') || '<div class="empty">No tasks.</div>';
      const peers = (data.peers || []).slice(0, 8).map((a) => \`
        <div class="item"><strong>\${esc(a.id)} <span class="badge">\${esc(a.kind)}</span></strong><span>\${esc(a.status)} age=\${esc(a.age_sec)}s branch=\${esc(a.branch || '')}</span></div>
      \`).join('') || '<div class="empty">No peers.</div>';
      const locks = (data.locks || []).slice(0, 8).map((l) => \`
        <div class="item"><strong>\${esc(l.resource)}</strong><span>owner=\${esc(l.owner)} task=\${l.task_id ? '#' + l.task_id : ''}</span></div>
      \`).join('') || '<div class="empty">No active locks.</div>';
      const messages = (data.messages || []).slice(-8).map((m) => \`
        <div class="item"><strong>#\${m.id} \${esc(m.sender)} → \${esc(m.recipient || 'all')}</strong><span>\${esc(m.body)}</span></div>
      \`).join('') || '<div class="empty">No messages.</div>';
      const events = (data.events || []).slice(-10).map((e) => \`
        <div class="item"><strong>#\${e.id} \${esc(e.type)}</strong><span>\${esc(e.actor || '')} \${e.task_id ? '#' + e.task_id : ''} \${fmtTime(e.created_at)}</span></div>
      \`).join('') || '<div class="empty">No events.</div>';
      state.innerHTML = \`
        <div class="card"><h2>Peers</h2><div class="body">\${peers}</div></div>
        <div class="card"><h2>Tasks</h2><div class="body">\${tasks}</div></div>
        <div class="card"><h2>Locks</h2><div class="body">\${locks}</div></div>
        <div class="card"><h2>Messages</h2><div class="body">\${messages}</div></div>
        <div class="card"><h2>Events</h2><div class="body">\${events}</div></div>
      \`;
    }

    async function refreshState() {
      const p = active ? '/api/state?peer=' + encodeURIComponent(active) : '/api/state';
      const data = await api(p);
      renderState(data);
    }

    async function refreshDetectedState() {
      if (!activeDetected) return;
      const data = await api('/api/state?peer=' + encodeURIComponent(activeDetected));
      renderState(data);
    }

    // ── Connect to managed (PTY) session ─────────────────────────────────
    function connectManaged(id) {
      const meta = sessions.find((s) => s.id === id);
      active = id;
      activeDetected = null;
      activeType = 'managed';
      renderSections();
      document.getElementById('activeTitle').textContent = id;
      document.getElementById('activeMeta').textContent = meta ? meta.command + (meta.pane ? ' · ' + meta.pane : '') + ' · ' + (meta.cwd || '') : '';
      document.getElementById('terminal').style.display = '';
      document.getElementById('detectedPanel').style.display = 'none';
      document.getElementById('quickBar').style.display = '';

      if (ws) { clearTimeout(wsReconnectTimer); ws.close(); }
      term.reset();
      openWs(id);
      refreshState().catch(console.error);
    }

    function openWs(id) {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(proto + '://' + location.host + '/ws/terminal/' + encodeURIComponent(id) + requestQuery());
      ws.onopen = () => {
        resizeTerm();
        document.getElementById('connState').textContent = 'attached';
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        // Check before any reset whether the viewport is pinned at the bottom
        const pinned = (() => {
          try { const b = term.buffer.active; return b.viewportY >= b.baseY; } catch { return true; }
        })();
        // The server streams the tmux pane's raw output, so xterm renders
        // incrementally (no reset/redraw → no flicker) and the program's own
        // escape sequences carry the cursor.
        if (msg.type === 'snapshot') { term.write(msg.data || '', () => { term.scrollToBottom(); }); }
        if (msg.type === 'data') { term.write(msg.data || '', pinned ? () => { term.scrollToBottom(); } : undefined); }
        if (msg.type === 'replace') { term.reset(); term.write(msg.data || '', pinned ? () => { term.scrollToBottom(); } : undefined); }
        if (msg.type === 'exit') { refreshSessions().catch(console.error); }
      };
      ws.onclose = () => {
        document.getElementById('connState').textContent = 'reconnecting...';
        // Auto-reconnect if session is still in the list and running
        wsReconnectTimer = setTimeout(() => {
          const s = sessions.find((s) => s.id === id);
          if (s && s.status === 'running' && active === id) openWs(id);
          else document.getElementById('connState').textContent = 'online';
        }, 2000);
      };
    }

    // ── Connect to detected (coordination-only) peer ──────────────────────
    function connectDetected(id) {
      const peer = detected.find((p) => p.id === id);
      active = null;
      activeDetected = id;
      activeType = 'detected';
      if (ws) { clearTimeout(wsReconnectTimer); ws.close(); ws = null; }
      renderSections();
      document.getElementById('activeTitle').textContent = id + ' (detected)';
      document.getElementById('activeMeta').textContent = peer ? peer.kind + ' · ' + (peer.worktree || '') : '';
      document.getElementById('terminal').style.display = 'none';
      document.getElementById('detectedPanel').style.display = '';
      document.getElementById('quickBar').style.display = 'none';
      document.getElementById('connState').textContent = 'coordination only';
      renderDetectedPanel(peer || { id });
      refreshDetectedState().catch(console.error);
    }

    function renderDetectedPanel(peer) {
      const dp = document.getElementById('detectedPanel');
      dp.innerHTML = \`
        <div style="padding:16px;display:grid;gap:12px">
          <div class="card">
            <h2>Detected Session</h2>
            <div class="body">
              <div class="item"><strong>peer</strong><span class="mono">\${esc(peer.id)}</span></div>
              <div class="item"><strong>kind</strong><span>\${esc(peer.kind || '')}</span></div>
              <div class="item"><strong>status</strong><span>\${esc(peer.status || '')}</span></div>
              <div class="item"><strong>cwd</strong><span class="mono" style="font-size:11px">\${esc(peer.worktree || '')}</span></div>
              <div class="item"><strong>pid</strong><span>\${esc(peer.pid || 'unknown')}</span></div>
              <div class="item"><strong>last seen</strong><span>\${peer.age_sec != null ? peer.age_sec + 's ago' : ''}</span></div>
            </div>
          </div>
          <div class="card">
            <h2>Send Message</h2>
            <div class="body" style="gap:8px">
              <div style="font-size:12px;color:var(--muted)">Message will appear in the peer's <code>hcc msg inbox</code> and be injected on next hook fire.</div>
              <textarea id="detMsg" rows="3" style="width:100%;background:#0d0f12;border:1px solid var(--border);color:var(--text);border-radius:6px;padding:8px;font:inherit;resize:vertical" placeholder="Message body..."></textarea>
              <button class="primary" id="sendDetMsg">Send</button>
            </div>
          </div>
        </div>
      \`;
      document.getElementById('sendDetMsg').addEventListener('click', async () => {
        const body = document.getElementById('detMsg').value.trim();
        if (!body) return;
        await api('/api/detected/' + encodeURIComponent(peer.id) + '/msg', {
          method: 'POST',
          body: JSON.stringify({ body, from: 'web' })
        });
        document.getElementById('detMsg').value = '';
      });
    }

    // ── Helpers ───────────────────────────────────────────────────────────
    function sendLine(text) {
      if (!active || !ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'input', data: text + '\\r' }));
    }

    // ── Start session form ────────────────────────────────────────────────
    document.getElementById('startForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const payload = {
        kind: document.getElementById('kind').value
      };
      const data = await api('/api/sessions', { method: 'POST', body: JSON.stringify(payload) });
      await refreshSessions();
      connectManaged(data.session.id);
    });

    document.querySelectorAll('[data-send]').forEach((button) => {
      button.addEventListener('click', () => {
        if (!active) return;
        const session = sessions.find((s) => s.id === active) || { kind: 'other', role: 'peer' };
        const lines = {
          register: \`hcc register --peer \${active} --kind \${session.kind || 'other'} --role \${session.role || 'peer'}\`,
          inbox:    \`hcc msg inbox --peer \${active}\`,
          next:     \`hcc task next --peer \${active}\`,
          status:   \`hcc status --peer \${active}\`,
          heartbeat:\`hcc heartbeat --peer \${active} --renew-locks\`
        };
        sendLine(lines[button.dataset.send]);
      });
    });

    document.getElementById('stopBtn').addEventListener('click', async () => {
      if (!active) return;
      await api('/api/sessions/' + encodeURIComponent(active) + '/stop', { method: 'POST', body: '{}' });
      await refreshSessions();
    });
    document.getElementById('refreshBtn').addEventListener('click', () => {
      Promise.all([refreshSessions(), refreshDetected(), refreshState()]).catch(console.error);
    });

    loadProjects().then(() => Promise.all([refreshSessions(), refreshDetected(), refreshState()])).then(() => {
      // Auto-connect to first running managed session on load
      if (!active && !activeDetected) {
        const first = sessions.find(s => s.status === 'running');
        if (first) connectManaged(first.id);
      }
    }).catch((err) => {
      document.getElementById('connState').textContent = 'error';
      console.error(err);
    });
    // ── Auto-poll state ──────────────────────────────────────────────────
    setInterval(() => {
      refreshSessions().catch(console.error);
      refreshDetected().catch(console.error);
      if (activeType === 'detected') refreshDetectedState().catch(console.error);
      else if (active) refreshState().catch(console.error);
    }, 3000);
    setInterval(() => {
      loadProjects().catch(console.error);
    }, 8000);
  </script>
</body>
</html>`;
}

async function cmdWeb(ctx, args, startMeta = {}) {
  if (args[0] === '--help' || args[0] === '-h') return helpWeb();
  if (process.env[WEB_CHILD_ENV] !== '1') return startWebBackground(ctx, args);
  const opts = parseOpts(args, { booleans: ['local', 'no-guidance', 'no-discover'] });
  validateOpts('web', opts, ['host', 'port', 'token', 'local', 'no-guidance', 'no-discover']);
  const host = opts.host || (opts.local ? '127.0.0.1' : '0.0.0.0');
  const port = intOpt(opts, 'port', 8787);
  const explicitToken = opts.token || process.env.HCC_WEB_TOKEN || '';
  const token = explicitToken;
  ensureTmuxAvailable({ autoInstall: false });
  const ptyModule = await import('node-pty');
  const { WebSocketServer } = await import('ws');
  const pty = ptyModule.default || ptyModule;
  const sessions = new Map();
  const projectContexts = new Map();
  const prepared = await prepareLocalBus(ctx, opts);

  function rememberProject(projectCtx) {
    const normalized = contextForProject(projectCtx.root, projectCtx.dbPath, { cwd: projectCtx.cwd, json: ctx.json });
    projectContexts.set(normalized.root, normalized);
    registerProject(normalized);
    return normalized;
  }

  function knownProjects() {
    const rows = readProjectRegistry();
    if (!rows.some((p) => p.root === ctx.root)) rows.unshift(projectRecord(ctx));
    for (const project of rows) {
      if (!projectContexts.has(project.root)) {
        projectContexts.set(project.root, contextForProject(project.root, project.db, { json: ctx.json }));
      }
    }
    return rows;
  }

  function projectFromRequest(req, url) {
    const root = url.searchParams.get('root') ||
      url.searchParams.get('project') ||
      req.headers['x-hcc-root'] ||
      ctx.root;
    const db = url.searchParams.get('db') ||
      req.headers['x-hcc-db'] ||
      path.join(path.resolve(root), '.hello-cc', 'mesh.db');
    return rememberProject(contextForProject(root, db, { cwd: path.resolve(root), json: ctx.json }));
  }

  function sessionKey(projectCtx, id) {
    return `${projectCtx.root}\u0000${id}`;
  }

  function sessionsForProject(projectCtx) {
    return [...sessions.values()].filter((session) => session.root === projectCtx.root);
  }

  function getSession(projectCtx, id) {
    return sessions.get(sessionKey(projectCtx, id));
  }

  function knownPeerIds(projectCtx) {
    const db = connect(projectCtx);
    try {
      return db.prepare('SELECT id FROM peers').all().map((row) => row.id);
    } finally {
      db.close();
    }
  }

  function nextProjectSessionId(projectCtx, kind) {
    return nextSessionId([
      ...sessionsForProject(projectCtx).map((session) => session.id),
      ...knownPeerIds(projectCtx)
    ], kind);
  }

  rememberProject(ctx);
  for (const project of readProjectRegistry()) {
    projectContexts.set(project.root, contextForProject(project.root, project.db, { json: ctx.json }));
  }

  // ── Optional external buffer-file session adoption ───────────────────────
  const bufsDir = path.join(ctx.root, '.hello-cc', BUFS_DIR_NAME);
  fs.mkdirSync(bufsDir, { recursive: true });

  function adoptExternalSession(id) {
    const pctx = ctx;
    const key = sessionKey(pctx, id);
    if (sessions.has(key)) return;
    const outFile  = path.join(bufsDir, `${id}.out`);
    const inFile   = path.join(bufsDir, `${id}.in`);
    const resizeFile = path.join(bufsDir, `${id}.resize`);
    const metaFile = path.join(bufsDir, `${id}.meta`);
    if (!fs.existsSync(outFile)) return;

    let meta = { kind: 'external', role: 'peer', command: '(shim)', cwd: ctx.root, pid: null, wrapper_pid: null, cols: 120, rows: 40 };
    try { meta = { ...meta, ...JSON.parse(fs.readFileSync(metaFile, 'utf8')) }; } catch {}

    const session = {
      id,
      root: pctx.root,
      ctx: pctx,
      kind: meta.kind || 'external',
      role: meta.role || 'peer',
      command: meta.command || '(shim)',
      cwd: meta.cwd || ctx.root,
      pid: meta.pid || null,
      wrapperPid: meta.wrapper_pid || null,
      type: 'external',
      outFile, inFile, resizeFile,
      status: 'running',
      createdAt: now(),
      exitedAt: null,
      buffer: '',
      clients: new Set(),
      outputPoller: null,
      outputFd: null,
      exitPoller: null,
    };
    // Load existing output as initial snapshot
    try { session.buffer = fs.readFileSync(outFile, 'utf8'); } catch {}
    sessions.set(key, session);

    // Open a persistent fd for polling output; fstatSync is cheap.
    let outputOffset = 0;
    try {
      session.outputFd = fs.openSync(outFile, 'r');
      outputOffset = fs.fstatSync(session.outputFd).size;
    } catch {}
    session.outputPoller = setInterval(() => {
      try {
        if (session.outputFd === null) return;
        const stat = fs.fstatSync(session.outputFd);
        if (stat.size < outputOffset) outputOffset = 0;
        if (stat.size <= outputOffset) return;
        const buf = Buffer.alloc(stat.size - outputOffset);
        fs.readSync(session.outputFd, buf, 0, buf.length, outputOffset);
        outputOffset = stat.size;
        const data = buf.toString();
        session.buffer += data;
        if (session.buffer.length > 250000) session.buffer = session.buffer.slice(-200000);
        broadcast(session, { type: 'data', data });
      } catch {
        // File removed or truncated — close and stop polling
        if (session.outputFd) { try { fs.closeSync(session.outputFd); } catch {} session.outputFd = null; }
      }
    }, 100);

    // Detect when .out file is removed (session ended)
    session.exitPoller = setInterval(() => {
      if (!fs.existsSync(outFile)) {
        session.status = 'exited';
        session.exitedAt = now();
        broadcast(session, { type: 'exit', event: {} });
        if (session.outputFd) { try { fs.closeSync(session.outputFd); } catch {} session.outputFd = null; }
        if (session.outputPoller) clearInterval(session.outputPoller);
        if (session.exitPoller) clearInterval(session.exitPoller);
        sessions.delete(key);
      }
    }, 2000);
  }

  // Adopt any already-running external sessions
  function scanExternalSessions() {
    try {
      for (const f of fs.readdirSync(bufsDir)) {
        if (f.endsWith('.out')) adoptExternalSession(path.basename(f, '.out'));
      }
    } catch {}
  }

  scanExternalSessions();

  const externalScanPoller = setInterval(scanExternalSessions, 1000);

  // Watch for new external sessions appearing
  try {
    fs.watch(bufsDir, { persistent: false }, (event, filename) => {
      if (filename?.endsWith('.out')) {
        setTimeout(() => adoptExternalSession(path.basename(filename, '.out')), 300);
      }
    });
  } catch {}

  // ── Auto-attach detected peers that are in tmux panes ─────────────────────
  function scanAndAttachDetectedPeers() {
    const db = connect(ctx);
    try {
      const rows = db.prepare(`
        SELECT id, kind, pid FROM peers
        WHERE status IN ('running', 'working', 'busy')
          AND pid IS NOT NULL
          AND last_seen_at >= ? - ?
        ORDER BY last_seen_at DESC
      `).all(now(), ACTIVE_PEER_TTL);

      for (const row of rows) {
        const key = sessionKey(ctx, row.id);
        if (sessions.has(key)) continue;

        try {
          const result = runTmux(['list-panes', '-a', '-F', '#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}']);
          for (const line of result.trim().split('\n')) {
            const [pane, panePid, command, cwd] = line.split('\t');
            if (parseInt(panePid) === row.pid) {
              try {
                attachTmuxSession({
                  id: row.id,
                  pane,
                  kind: row.kind || inferPeerKind(row.id, null, command),
                  role: 'peer',
                  cwd: cwd || ctx.root,
                  force: false,
                  projectCtx: ctx
                });
              } catch {}
              break;
            }
          }
        } catch {}
      }
    } finally { db.close(); }
  }

  scanAndAttachDetectedPeers();
  const autoAttachPoller = setInterval(scanAndAttachDetectedPeers, 5000);

  // ── Serialize + broadcast helpers ─────────────────────────────────────────
  function serializeSession(session) {
    return {
      id: session.id,
      kind: session.kind,
      role: session.role,
      command: session.command,
      cwd: session.cwd,
      pid: session.pid,
      pane: session.pane || null,
      root: session.root || session.ctx?.root || ctx.root,
      status: session.status,
      type: session.type || 'pty',
      created_at: session.createdAt,
      exited_at: session.exitedAt || null
    };
  }

  function broadcast(session, payload) {
    const text = JSON.stringify(payload);
    for (const client of session.clients) {
      if (client.readyState === client.OPEN) client.send(text);
    }
  }

  function hasOpenClients(session) {
    if (!session?.clients?.size) return false;
    let open = false;
    for (const client of [...session.clients]) {
      if (client.readyState === client.OPEN || client.readyState === 1) {
        open = true;
      } else {
        session.clients.delete(client);
      }
    }
    return open;
  }

  function detachTmuxSession(session, status = 'detached') {
    stopTmuxStream(session);
    if (session.exitPoller) { clearInterval(session.exitPoller); session.exitPoller = null; }

    session.status = status;
    session.exitedAt = now();
    broadcast(session, { type: 'exit', event: { reason: status } });
    const pctx = session.ctx || contextForProject(session.root || ctx.root, null, { json: ctx.json });
    sessions.delete(sessionKey(pctx, session.id));
    const db = connect(pctx);
    try {
      db.prepare('UPDATE peers SET status = ?, last_seen_at = ? WHERE id = ?').run(status, now(), session.id);
      db.prepare('UPDATE peer_bindings SET runtime_target = NULL, updated_at = ? WHERE peer = ?').run(now(), session.id);
      addEvent(db, status === 'exited' ? 'tmux.session.exited' : 'tmux.session.detached', session.id, null, {
        pane: session.pane
      });
    } finally {
      db.close();
    }
  }

  // Build the escape that places + shows/hides the cursor at a viewport cell,
  // used only to seed the initial snapshot (live output carries its own cursor).
  function cursorEscape(payload) {
    if (!payload) return '';
    return '[' + (payload.row + 1) + ';' + (payload.col + 1) + 'H' +
      (payload.visible ? '[?25h' : '[?25l');
  }

  // Stream the tmux pane's RAW output (escape sequences and all) into the
  // browser via `tmux pipe-pane`, so xterm.js renders incrementally — no
  // screenshot-poll, no full-screen reset, no flicker — and the program's own
  // cursor sequences are mirrored verbatim (works for bash, codex, claude, vim).
  function startTmuxStream(session) {
    const safePane = String(session.pane).replace(/[^A-Za-z0-9_-]/g, '');
    const safeId = String(session.id).replace(/[^A-Za-z0-9_.-]/g, '_');
    const pipeFile = path.join(bufsDir, `tmux-${safePane}-${safeId}.pipe`);
    session.pipeFile = pipeFile;
    // Capture the existing screen once for the initial paint; pipe-pane only
    // forwards output produced after it is enabled.
    try {
      const captured = tmuxCapturePane(session.pane);
      session.buffer = captured + cursorEscape(tmuxCursorPayload(captured, tmuxCursorInfo(session.pane)));
    } catch {}

    // Use a FIFO rather than an append-only regular file. The old file-backed
    // implementation capped session.buffer but let .hello-cc/bufs grow forever
    // for long-lived tmux panes.
    try {
      fs.rmSync(pipeFile, { force: true });
      const mkfifo = spawnSync('mkfifo', [pipeFile], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      });
      if (mkfifo.status !== 0) {
        const message = (mkfifo.stderr || mkfifo.stdout || '').trim() || 'mkfifo failed';
        throw new CliError('TMUX_STREAM_ERROR', message);
      }
      try { fs.chmodSync(pipeFile, 0o600); } catch {}
      session.streamFd = fs.openSync(pipeFile, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    } catch {
      session.streamFd = null;
      return;
    }

    // Enable raw output piping after the read end is open. This avoids the
    // old "enable pipe, then seek to EOF" window that could skip early output.
    try {
      runTmux(['pipe-pane', '-t', session.pane, `cat > ${shellQuoteArg(pipeFile)}`]);
    } catch {
      stopTmuxStream(session);
      return;
    }
    session.streamPoller = setInterval(() => {
      try {
        if (session.streamFd === null || session.streamFd === undefined) return;
        const chunks = [];
        for (;;) {
          const buf = Buffer.alloc(65536);
          let bytes = 0;
          try {
            bytes = fs.readSync(session.streamFd, buf, 0, buf.length, null);
          } catch (err) {
            if (['EAGAIN', 'EWOULDBLOCK'].includes(err?.code)) break;
            throw err;
          }
          if (bytes <= 0) break;
          chunks.push(buf.subarray(0, bytes));
          if (bytes < buf.length) break;
        }
        if (!chunks.length) return;
        const data = Buffer.concat(chunks).toString();
        session.buffer += data;
        if (session.buffer.length > 250000) session.buffer = session.buffer.slice(-200000);
        broadcast(session, { type: 'data', data });
      } catch {
        if (session.streamFd !== null && session.streamFd !== undefined) {
          try { fs.closeSync(session.streamFd); } catch {}
          session.streamFd = null;
        }
      }
    }, 40);
  }

  function stopTmuxStream(session) {
    if (session.streamPoller) { clearInterval(session.streamPoller); session.streamPoller = null; }
    // Turn piping back off for this pane (no command toggles it off).
    try { runTmux(['pipe-pane', '-t', session.pane]); } catch {}
    if (session.streamFd !== null && session.streamFd !== undefined) {
      try { fs.closeSync(session.streamFd); } catch {}
      session.streamFd = null;
    }
    if (session.pipeFile) { try { fs.unlinkSync(session.pipeFile); } catch {} session.pipeFile = null; }
  }

  function attachTmuxSession(input) {
    const pctx = input.projectCtx || ctx;
    const id = input.id;
    if (!id) throw new CliError('BAD_REQUEST', 'id required');
    const info = tmuxPaneInfo(input.pane || null);
    if (info.dead) throw new CliError('TMUX_PANE_DEAD', `tmux pane is not running: ${info.pane}`);

    for (const existing of [...sessions.values()]) {
      if (existing.type === 'tmux' && existing.pane === info.pane && existing.id !== id) {
        if (!input.force) {
          throw new CliError('TMUX_PANE_IN_USE', `tmux pane ${info.pane} is already attached to ${existing.id}`, {
            pane: info.pane,
            peer: existing.id
          });
        }
        detachTmuxSession(existing, 'detached');
      }
    }

    const key = sessionKey(pctx, id);
    const existing = sessions.get(key);
    if (existing && existing.status === 'running') {
      if (existing.type === 'tmux' && existing.pane === info.pane) return existing;
      throw new CliError('SESSION_EXISTS', `Session ${id} is already running`);
    }

    const kind = inferPeerKind(id, input.kind || null, info.command);
    const role = input.role || 'peer';
    const cwd = path.resolve(input.cwd || info.cwd || pctx.root);
    const command = input.command || `tmux ${info.pane} (${info.command})`;

    const captured = tmuxCapturePane(info.pane);
    const session = {
      id,
      root: pctx.root,
      ctx: pctx,
      kind,
      role,
      command,
      cwd,
      pid: info.pid,
      type: 'tmux',
      pane: info.pane,
      status: 'running',
      createdAt: now(),
      exitedAt: null,
      buffer: captured,
      clients: new Set(),
      streamPoller: null,
      streamFd: null,
      pipeFile: null,
      exitPoller: null
    };
    sessions.set(key, session);
    startTmuxStream(session);

    // Detect pane death (retry 3 times before detaching — handles Ctrl+C transient states)
    let deadCount = 0;
    session.exitPoller = setInterval(() => {
      try {
        const fresh = tmuxPaneInfo(session.pane);
        if (fresh.dead) {
          deadCount++;
          if (deadCount >= 3) detachTmuxSession(session, 'exited');
        } else {
          deadCount = 0;
        }
      } catch { deadCount++; if (deadCount >= 3) detachTmuxSession(session, 'exited'); }
    }, 3000);

    const db = connect(pctx);
    try {
      upsertPeer(db, {
        id,
        kind,
        role,
        worktree: cwd,
        branch: detectBranch(cwd),
        pid: info.pid,
        status: 'running',
        capabilities: 'tmux'
      });
      const binding = input.binding || {};
      upsertPeerBinding(db, {
        peer: id,
        provider: binding.provider || kind,
        provider_session_id: binding.provider_session_id || null,
        provider_session_name: binding.provider_session_name || null,
        resume_mode: binding.resume_mode || 'attached',
        resume_arg: binding.resume_arg || info.pane,
        command: binding.command || command,
        transport: 'tmux',
        runtime_session_id: id,
        runtime_target: info.pane
      }, Boolean(input.force));
      addEvent(db, 'tmux.session.attached', id, null, { pane: info.pane, command, cwd, pid: info.pid });
    } finally {
      db.close();
    }
    return session;
  }

  function writeSessionInput(session, data) {
    if (session.type === 'external') {
      try { fs.appendFileSync(session.inFile, data); } catch {}
    } else if (session.type === 'tmux') {
      tmuxSendLiteral(session.pane, data);
    } else {
      session.pty.write(data);
    }
  }

  function resizeSession(session, cols, rows) {
    if (session.type === 'external') {
      try { fs.appendFileSync(session.resizeFile, JSON.stringify({ cols, rows }) + '\n'); } catch {}
    } else if (session.type === 'tmux') {
      // Resize the tmux window to match the browser terminal so the captured
      // mirror has identical geometry — a prerequisite for accurate cursor
      // placement. Older tmux without resize-window simply keeps native size.
      session.cols = cols;
      session.rows = rows;
      try {
        if (!session.windowSizeManual) {
          runTmux(['set-window-option', '-t', session.pane, 'window-size', 'manual']);
          session.windowSizeManual = true;
        }
        runTmux(['resize-window', '-t', session.pane, '-x', String(cols), '-y', String(rows)]);
      } catch {
        // tmux too old or pane gone; keep mirroring at the native pane size.
      }
    } else if (session.pty) {
      session.pty.resize(cols, rows);
    }
  }

  function startTmuxManagedSession(input) {
    ensureTmuxAvailable({ autoInstall: false });
    const pctx = input.projectCtx || ctx;
    const kind = input.kind || 'shell';
    const id = input.id || nextProjectSessionId(pctx, kind);
    const role = input.role || 'peer';
    const command = input.command || defaultSessionCommand(kind);
    const cwd = path.resolve(input.cwd || pctx.root);
    const sessionName = tmuxManagedSessionName(pctx, id);
    let paneTarget = `${sessionName}:0.0`;
    const callerEnv = input.env && typeof input.env === 'object' ? input.env : process.env;
    const env = childSessionEnv({
      HCC_PEER: id,
      HCC_ROOT: pctx.root,
      HCC_DB: pctx.dbPath,
      TERM: 'xterm-256color'
    }, callerEnv);
    env[LAUNCH_FINGERPRINT_ENV] = launchFingerprint({ command, cwd, env });
    let hasSession = tmuxHasSession(sessionName);
    const relaunchableProvider = isRelaunchableProviderSession(kind, command, input.binding || {});

    function restartExistingTmuxSession(reason) {
      const existing = getSession(pctx, id);
      const hasWebClients = hasOpenClients(existing);
      const hasTmuxClients = tmuxSessionHasClients(sessionName);
      if (hasWebClients || hasTmuxClients) {
        const isEnvChange = reason === 'launch_environment_changed';
        throw new CliError(
          isEnvChange ? 'SESSION_ENV_CHANGED' : 'SESSION_IN_USE',
          isEnvChange
            ? `Session ${id} is already running with a different launch environment. Detach/close existing clients or run ${CLI_NAME} peer stop ${id}, then start it again.`
            : `Session ${id} is still attached. Detach/close existing clients or run ${CLI_NAME} peer stop ${id}, then start it again.`,
          {
            peer: id,
            tmux_session: sessionName,
            reason
          });
      }
      if (existing) detachTmuxSession(existing, 'detached');
      tmuxKillSession(sessionName);
      hasSession = false;
      const db = connect(pctx);
      try {
        addEvent(db, 'tmux.session.restarted', id, null, { reason });
      } finally {
        db.close();
      }
    }

    if (hasSession && input.restartOnEnvChange) {
      const existingFingerprint = tmuxSessionEnvironmentValue(sessionName, LAUNCH_FINGERPRINT_ENV);
      if (existingFingerprint !== env[LAUNCH_FINGERPRINT_ENV]) {
        restartExistingTmuxSession('launch_environment_changed');
      }
    }

    if (hasSession && relaunchableProvider) {
      const providerState = tmuxProviderState(sessionName);
      if (providerState === 'exited') {
        restartExistingTmuxSession('provider_exited');
      } else if (!providerState) {
        const info = tmuxPaneInfo(paneTarget);
        if (isLikelyShellCommand(info.command)) {
          restartExistingTmuxSession('provider_fallback_shell');
        }
      }
    }

    if (!hasSession) {
      const shell = callerEnv.SHELL || process.env.SHELL || 'bash';
      const launch = shellCommand([...isolatedEnvCommandArgs(env), shell, '-c', command]);
      const tmuxEnv = { [LAUNCH_FINGERPRINT_ENV]: env[LAUNCH_FINGERPRINT_ENV] };
      if (relaunchableProvider) tmuxEnv[PROVIDER_STATE_ENV] = 'starting';
      runTmux(['new-session', '-d', '-s', sessionName, '-c', cwd, ...tmuxEnvironmentArgs(tmuxEnv), launch]);
    }

    const pane = tmuxPaneInfo(paneTarget).pane;
    return attachTmuxSession({
      ...input,
      id,
      kind,
      role,
      cwd,
      command,
      pane,
      projectCtx: pctx,
      binding: {
        ...(input.binding || {}),
        command: input.binding?.command || command,
        transport: 'tmux',
        runtime_session_id: id,
        runtime_target: pane
      },
      force: true
    });
  }

  function restoreTmuxManagedSessions(projectCtx = ctx) {
    const db = connect(projectCtx);
    let rows = [];
    try {
      rows = db.prepare(`
        SELECT p.id, p.kind, p.role, p.worktree, b.command, b.runtime_target,
               b.provider, b.provider_session_id, b.provider_session_name,
               b.resume_mode, b.resume_arg
        FROM peers p
        JOIN peer_bindings b ON b.peer = p.id
        WHERE b.transport = 'tmux' AND b.runtime_target IS NOT NULL
        ORDER BY p.last_seen_at DESC
        LIMIT 100
      `).all();
    } finally {
      db.close();
    }
    for (const row of rows) {
      try {
        attachTmuxSession({
          id: row.id,
          kind: row.kind,
          role: row.role || 'peer',
          cwd: row.worktree || projectCtx.root,
          command: row.command || null,
          pane: row.runtime_target,
          projectCtx,
          force: true,
          binding: {
            provider: row.provider,
            provider_session_id: row.provider_session_id,
            provider_session_name: row.provider_session_name,
            resume_mode: row.resume_mode,
            resume_arg: row.resume_arg,
            command: row.command,
            transport: 'tmux',
            runtime_session_id: row.id,
            runtime_target: row.runtime_target
          }
        });
      } catch {}
    }
  }

  function startPtySession(input) {
    const pctx = input.projectCtx || ctx;
    const kind = input.kind || 'shell';
    const id = input.id || nextProjectSessionId(pctx, kind);
    const key = sessionKey(pctx, id);
    if (sessions.has(key) && sessions.get(key).status === 'running') {
      return sessions.get(key);
    }
    const role = input.role || 'peer';
    const command = input.command || defaultSessionCommand(kind);
    const cwd = path.resolve(input.cwd || pctx.root);
    const callerEnv = input.env && typeof input.env === 'object' ? input.env : process.env;
    const shell = callerEnv.SHELL || process.env.SHELL || 'bash';
    const env = childSessionEnv({
      HCC_PEER: id,
      HCC_ROOT: pctx.root,
      HCC_DB: pctx.dbPath,
      TERM: 'xterm-256color'
    }, callerEnv);
    const size = input.size || { cols: 100, rows: 30 };
    const child = pty.spawn(shell, ['-c', command], {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd,
      env
    });
    const session = {
      id,
      root: pctx.root,
      ctx: pctx,
      kind,
      role,
      command,
      cwd,
      pid: child.pid,
      pty: child,
      status: 'running',
      createdAt: now(),
      exitedAt: null,
      buffer: '',
      clients: new Set()
    };
    sessions.set(key, session);
    const db = connect(pctx);
    try {
      upsertPeer(db, {
        id,
        kind,
        role,
        worktree: cwd,
        branch: detectBranch(cwd),
        pid: child.pid,
        status: 'running',
        capabilities: 'web-pty'
      });
      upsertPeerBinding(db, {
        peer: id,
        provider: input.binding?.provider || kind,
        provider_session_id: input.binding?.provider_session_id || null,
        provider_session_name: input.binding?.provider_session_name || null,
        resume_mode: input.binding?.resume_mode || 'new',
        resume_arg: input.binding?.resume_arg || null,
        command,
        transport: 'web-pty',
        runtime_session_id: id
      }, Boolean(input.force));
      addEvent(db, 'web.session.started', id, null, { command, cwd, pid: child.pid });
    } finally {
      db.close();
    }
    child.onData((data) => {
      session.buffer += data;
      if (session.buffer.length > 250000) session.buffer = session.buffer.slice(-200000);
      broadcast(session, { type: 'data', data });
    });
    child.onExit((event) => {
      session.status = 'exited';
      session.exitedAt = now();
      const db = connect(pctx);
      try {
        db.prepare('UPDATE peers SET status = ?, last_seen_at = ? WHERE id = ?').run('exited', now(), id);
        addEvent(db, 'web.session.exited', id, null, event);
      } finally {
        db.close();
      }
      broadcast(session, { type: 'exit', event });
    });
    return session;
  }

  function startSession(input) {
    if (input.backend === 'pty') return startPtySession(input);
    return startTmuxManagedSession(input);
  }

  for (const projectCtx of projectContexts.values()) {
    restoreTmuxManagedSessions(projectCtx);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        sendHttp(res, 200, 'text/html; charset=utf-8', webIndexHtml());
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
      if (!authOk(url, req, token)) {
        sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });
        return;
      }
      const reqCtx = projectFromRequest(req, url);
      if (req.method === 'GET' && url.pathname === '/api/projects') {
        sendJson(res, 200, { projects: knownProjects(), current: projectRecord(reqCtx) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/projects') {
        const input = await readJsonRequest(req);
        const projectCtx = rememberProject(contextForProject(input.root || reqCtx.root, input.db || reqCtx.dbPath, { json: ctx.json }));
        const db = connect(projectCtx);
        db.close();
        writeRuntime(projectCtx, {
          product: PRODUCT_NAME,
          version: VERSION,
          pid: process.pid,
          root: projectCtx.root,
          db: projectCtx.dbPath,
          host,
          port: actualPort,
          base_url: runtimeBaseUrl(host, actualPort),
          token,
          global_runtime: true,
          started_at: now()
        });
        sendJson(res, 200, { project: projectRecord(projectCtx), projects: knownProjects() });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        sendJson(res, 200, statusSnapshot(reqCtx, url.searchParams.get('peer')));
        return;
      }
      // Detected sessions: peers registered via hooks/watcher but without PTY
      if (req.method === 'GET' && url.pathname === '/api/detected') {
        const db = connect(reqCtx);
        let detected = [];
        try {
          const t = now();
          detected = db.prepare(`
            SELECT id, kind, role, status, worktree, branch, pid, capabilities,
                   created_at, last_seen_at, (? - last_seen_at) AS age_sec
            FROM peers
            ORDER BY last_seen_at DESC, id ASC
            LIMIT 100
          `).all(t);
        } finally {
          db.close();
        }
        // Exclude peers that are already in the managed sessions Map
        const managedIds = new Set(sessionsForProject(reqCtx).map((s) => s.id));
        sendJson(res, 200, { detected: detected.filter(p => !managedIds.has(p.id)) });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/runtime') {
        sendJson(res, 200, {
          product: PRODUCT_NAME,
          version: VERSION,
          pid: process.pid,
          root: reqCtx.root,
          db: reqCtx.dbPath,
          projects: knownProjects(),
          sessions: sessionsForProject(reqCtx).length
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/runtime/stop') {
        sendJson(res, 200, { ok: true, pid: process.pid });
        setTimeout(shutdown, 10);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        sendJson(res, 200, { sessions: sessionsForProject(reqCtx).map(serializeSession) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/sessions') {
        const input = await readJsonRequest(req);
        const session = startSession({ ...input, projectCtx: reqCtx });
        sendJson(res, 200, { session: serializeSession(session) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/sessions/attach') {
        const input = await readJsonRequest(req);
        const session = attachTmuxSession({ ...input, projectCtx: reqCtx });
        sendJson(res, 200, { session: serializeSession(session) });
        return;
      }
      const inputMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/input$/);
      if (req.method === 'POST' && inputMatch) {
        const id = decodeURIComponent(inputMatch[1]);
        const session = getSession(reqCtx, id);
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
        const db = connect(session.ctx || reqCtx);
        try {
          addEvent(db, 'web.session.input', id, null, { bytes: data.length, enter: input.enter !== false });
        } finally {
          db.close();
        }
        sendJson(res, 200, { session: serializeSession(session), bytes: data.length });
        return;
      }
      const stopMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/stop$/);
      if (req.method === 'POST' && stopMatch) {
        const id = decodeURIComponent(stopMatch[1]);
        const session = getSession(reqCtx, id);
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
            detachTmuxSession(session, 'detached');
          } else {
            session.pty.kill();
          }
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
        const sender = String(input.from || 'web');
        const taskId = input.task ? Number(input.task) : null;
        if (!body) { sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: 'body required' } }); return; }
        const db = connect(reqCtx);
        let msgId;
        try {
          msgId = sendMessage(db, sender, peerId, taskId, 'note', body);
        } finally {
          db.close();
        }
        sendJson(res, 200, { ok: true, id: msgId });
        return;
      }
      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Route not found' } });
    } catch (err) {
      const detail = err instanceof CliError || process.env.HCC_DEBUG ? err.message : 'internal server error';
      sendJson(res, 500, { ok: false, error: { code: err.code || 'SERVER_ERROR', message: detail } });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (!authOk(url, req, token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const match = url.pathname.match(/^\/ws\/terminal\/([^/]+)$/);
    if (!match) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const reqCtx = projectFromRequest(req, url);
    const id = decodeURIComponent(match[1]);
    const session = getSession(reqCtx, id);
    if (!session) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      session.clients.add(ws);
      ws.send(JSON.stringify({ type: 'snapshot', data: session.buffer }));
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(String(raw));
          if (msg.type === 'input' && session.status === 'running') {
            const data = String(msg.data || '');
            writeSessionInput(session, data);
          } else if (msg.type === 'resize' && session.status === 'running') {
            const cols = Math.max(20, Number.parseInt(msg.cols || 100, 10));
            const rows = Math.max(8, Number.parseInt(msg.rows || 30, 10));
            resizeSession(session, cols, rows);
          }
        } catch {
          // Ignore malformed terminal frames.
        }
      });
      ws.on('close', () => session.clients.delete(ws));
    });
  });

  function shutdown() {
    clearRuntime(ctx);
    clearInterval(externalScanPoller);
    clearInterval(autoAttachPoller);
    for (const session of sessions.values()) {
      if (session.status !== 'running') continue;
      if (session.type === 'external') {
        try { if (session.outputFd) fs.closeSync(session.outputFd); } catch {}
        try { if (session.outputPoller) clearInterval(session.outputPoller); } catch {}
        try { if (session.exitPoller) clearInterval(session.exitPoller); } catch {}
      } else if (session.type === 'tmux') {
        try { stopTmuxStream(session); } catch {}
        try { if (session.exitPoller) clearInterval(session.exitPoller); } catch {}
      } else {
        try { session.pty.kill(); } catch {}
      }
    }
    server.close(() => process.exit(0));
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  const actualPort = await listenServer(server, host, port, opts.port === undefined);
  const runtime = {
    product: PRODUCT_NAME,
    version: VERSION,
    pid: process.pid,
    root: ctx.root,
    db: ctx.dbPath,
    host,
    port: actualPort,
    base_url: runtimeBaseUrl(host, actualPort),
    token,
    started_at: now()
  };
  const runtimeFile = writeRuntime(ctx, runtime);
  writeGlobalRuntime(runtime);
  registerProject(ctx);
  const db = connect(ctx);
  try {
    addEvent(db, startMeta.eventType || 'web.started', 'human', null, {
      root: ctx.root,
      db: ctx.dbPath,
      host,
      port: actualPort,
      requested_port: port,
      guidance: startMeta.guidance || prepared.guidance || null,
      runtime: runtimeFile
    });
  } finally {
    db.close();
  }
  const shownHost = host === '0.0.0.0' ? '<machine-ip>' : host;
  const url = `http://${shownHost}:${actualPort}/${runtimeUrlQuery(runtime, ctx.root)}`;
  console.log(`${PRODUCT_NAME} web listening on ${host}:${actualPort}`);
  console.log(`project: ${ctx.root}`);
  console.log(`database: ${ctx.dbPath}`);
  console.log(`open: ${url}`);
}

async function cmdRun(ctx, args) {
  if (args[0] === '--help' || args[0] === '-h') return helpRun();
  registerProjectActivity(ctx);
  const sep = args.indexOf('--');
  const optArgs = sep >= 0 ? args.slice(0, sep) : args;
  const cmdArgs = sep >= 0 ? args.slice(sep + 1) : [];
  const opts = parseOpts(optArgs, { booleans: ['force', 'web-managed'] });
  validateOpts('run', opts, ['peer', 'kind', 'role', 'cwd', 'force']);
  const id = required(opts, 'peer', 'HCC_PEER');
  const kind = opts.kind || 'other';
  const role = opts.role || 'peer';
  const cwd = path.resolve(opts.cwd || ctx.cwd);
  const command = cmdArgs.length ? cmdArgs[0] : defaultSessionCommand(kind);
  const commandArgs = cmdArgs.length ? cmdArgs.slice(1) : [];
  const binding = bindingFromRun(id, kind, command, commandArgs, 'hcc-run');

  const db = connect(ctx);
  try {
    upsertPeer(db, {
      id, kind, role,
      worktree: cwd,
      branch: detectBranch(cwd),
      pid: process.pid,
      status: 'running',
      capabilities: 'run-wrapper'
    });
    upsertPeerBinding(db, binding, Boolean(opts.force));
    addEvent(db, 'run.session.started', id, null, { command: [command, ...commandArgs].join(' '), cwd });
  } finally {
    db.close();
  }
  console.error(`${CLI_NAME}: running ${id} (${kind}, ${role}) -> ${command} ${commandArgs.join(' ')}`.trim());
  const child = spawn(command, commandArgs, {
    cwd,
    stdio: 'inherit',
    env: childSessionEnv({ HCC_PEER: id, HCC_ROOT: ctx.root, HCC_DB: ctx.dbPath })
  });
  const exitCode = await new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
    child.on('error', (err) => {
      console.error(`${CLI_NAME}: failed to start ${command}: ${err.message}`);
      resolve({ code: 127, signal: null });
    });
  });
  const db2 = connect(ctx);
  try {
    db2.prepare('UPDATE peers SET status = ?, last_seen_at = ? WHERE id = ?').run('exited', now(), id);
    addEvent(db2, 'run.session.exited', id, null, exitCode);
  } finally {
    db2.close();
  }
  if (exitCode.signal) {
    process.kill(process.pid, exitCode.signal);
  } else {
    process.exitCode = exitCode.code ?? 0;
  }
}

/**
 * Internal external PTY bridge: start a child in a PTY, forward output to both
 * the local terminal and a shared buffer file so hcc web can stream it to
 * browsers. Input from the browser is written to a .in file that we relay.
 */
async function cmdRunWebManaged(ctx, { id, kind, role, cwd, command, commandArgs, binding, force = false }) {
  registerProjectActivity(ctx);
  const ptyModule = await import('node-pty');
  const pty = ptyModule.default || ptyModule;

  const bufsDir = path.join(ctx.root, '.hello-cc', BUFS_DIR_NAME);
  fs.mkdirSync(bufsDir, { recursive: true });
  const outFile = path.join(bufsDir, `${id}.out`);
  const inFile  = path.join(bufsDir, `${id}.in`);
  const resizeFile = path.join(bufsDir, `${id}.resize`);
  const metaFile = path.join(bufsDir, `${id}.meta`);

  // Wipe stale input file
  try { fs.writeFileSync(inFile, ''); } catch {}
  try { fs.writeFileSync(resizeFile, ''); } catch {}

  const db = connect(ctx);
  try {
    upsertPeer(db, {
      id, kind, role,
      worktree: cwd,
      branch: detectBranch(cwd),
      pid: process.pid,
      status: 'running',
      capabilities: 'run-pty'
    });
    upsertPeerBinding(db, binding, force);
    addEvent(db, 'run.session.started', id, null, { command: [command, ...commandArgs].join(' '), cwd, webManaged: true });
  } finally {
    db.close();
  }

  // Estimate terminal size from current process
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 40;

  const child = pty.spawn(command, commandArgs, {
    name: 'xterm-256color', cols, rows, cwd,
    env: childSessionEnv({ HCC_PEER: id, HCC_ROOT: ctx.root, HCC_DB: ctx.dbPath, TERM: 'xterm-256color' })
  });
  let terminatingSignal = null;
  let forceKillTimer = null;
  const onTerminate = (signal) => {
    terminatingSignal = signal;
    try { child.kill(signal === 'SIGTERM' ? 'SIGHUP' : signal); } catch {}
    forceKillTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, 1200);
    forceKillTimer.unref?.();
  };
  const onSigint = () => onTerminate('SIGINT');
  const onSigterm = () => onTerminate('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  // Write metadata so hcc web can discover this session
  fs.writeFileSync(metaFile, JSON.stringify({ id, kind, role, command: [command, ...commandArgs].join(' '), cwd, pid: child.pid, wrapper_pid: process.pid, cols, rows }));

  // Open output file for append
  let outFd = fs.openSync(outFile, 'w');

  child.onData((data) => {
    // Forward to local terminal
    process.stdout.write(data);
    // Append to shared buffer
    try { fs.write(outFd, data, () => {}); } catch {}
  });

  // Poll for browser input (written to .in file by hcc web)
  let inOffset = 0;
  const inputPoller = setInterval(() => {
    try {
      const stat = fs.statSync(inFile);
      if (stat.size > inOffset) {
        const buf = Buffer.alloc(stat.size - inOffset);
        const fd = fs.openSync(inFile, 'r');
        fs.readSync(fd, buf, 0, buf.length, inOffset);
        fs.closeSync(fd);
        inOffset = stat.size;
        if (buf.length) child.write(buf.toString());
      }
    } catch {}
  }, 100);

  let resizeOffset = 0;
  const resizePoller = setInterval(() => {
    try {
      const stat = fs.statSync(resizeFile);
      if (stat.size <= resizeOffset) return;
      const buf = Buffer.alloc(stat.size - resizeOffset);
      const fd = fs.openSync(resizeFile, 'r');
      fs.readSync(fd, buf, 0, buf.length, resizeOffset);
      fs.closeSync(fd);
      resizeOffset = stat.size;
      const lines = buf.toString().trim().split('\n').filter(Boolean);
      const last = lines.at(-1);
      if (!last) return;
      const size = JSON.parse(last);
      const c = Math.max(20, Number.parseInt(size.cols || 120, 10));
      const r = Math.max(8, Number.parseInt(size.rows || 40, 10));
      child.resize(c, r);
      try { fs.writeFileSync(metaFile, JSON.stringify({ id, kind, role, command: [command, ...commandArgs].join(' '), cwd, pid: child.pid, wrapper_pid: process.pid, cols: c, rows: r })); } catch {}
    } catch {}
  }, 250);

  // Handle SIGWINCH for local terminal resize
  const onStdoutResize = () => {
    const c = process.stdout.columns || 120;
    const r = process.stdout.rows || 40;
    child.resize(c, r);
    try { fs.writeFileSync(metaFile, JSON.stringify({ id, kind, role, command: [command, ...commandArgs].join(' '), cwd, pid: child.pid, wrapper_pid: process.pid, cols: c, rows: r })); } catch {}
  };
  process.stdout.on('resize', onStdoutResize);

  // Forward local stdin to PTY
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (data) => child.write(data));
  }

  const exitCode = await new Promise((resolve) => {
    child.onExit((event) => resolve(event));
  });

  clearInterval(inputPoller);
  clearInterval(resizePoller);
  if (forceKillTimer) clearTimeout(forceKillTimer);
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
  process.stdout.off('resize', onStdoutResize);
  if (process.stdin.isTTY) {
    try { process.stdin.setRawMode(false); } catch {}
  }
  try { fs.closeSync(outFd); } catch {}
  // Clean up buffer files
  try { fs.unlinkSync(outFile); } catch {}
  try { fs.unlinkSync(inFile); } catch {}
  try { fs.unlinkSync(resizeFile); } catch {}
  try { fs.unlinkSync(metaFile); } catch {}

  const db2 = connect(ctx);
  try {
    db2.prepare('UPDATE peers SET status = ?, last_seen_at = ? WHERE id = ?').run('exited', now(), id);
    addEvent(db2, 'run.session.exited', id, null, exitCode);
  } finally {
    db2.close();
  }

  const signal = exitCode.signal || terminatingSignal;
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exitCode = exitCode.exitCode ?? 0;
  }
}

function helpMain() {
  console.log(`${PRODUCT_NAME} ${VERSION}

Project-local coordination bus for multiple Claude Code and Codex CLI sessions.

Usage:
  ${CLI_NAME} [--root DIR] [--db FILE] [--json] <command> [args]

Commands:
  web                          Start coordination, shims, tmux, and browser console
  up                           Initialize local coordination only
  down                         Stop the running hello-cc web runtime
  init                         Initialize .hello-cc/mesh.db and guidance
  register --peer ID           Register or update a peer session identity
  join --peer ID               Register this shell and print eval-able env
  env --peer ID                Print eval-able HCC_PEER/HCC_ROOT/HCC_DB exports
  heartbeat [--peer ID]        Mark the current peer alive, optionally renew locks
  peers                        List known peers
  status [--peer ID]           Show project coordination state
  scan [--register]            Detect existing Claude/Codex sessions
  prompt --peer ID             Print copy/paste session instructions
  run --peer ID -- COMMAND     Register a peer and run a command in this terminal
  peer <subcommand>            Start, attach, list, and stop tmux-backed peers
  inject PEER TEXT             Write text into an attached terminal
  ask PEER MESSAGE             Send a direct work request to one peer
  broadcast MESSAGE            Send a work request to all peers
  task <subcommand>            Create, list, claim, update, finish tasks
  msg <subcommand>             Send, read, and ack messages
  lock <subcommand>            Acquire, renew, release, and list advisory locks
  handoff <subcommand>         Create and list handoffs
  event tail                   Show recent coordination events
  gc [--older-than DAYS] [--yes] Clean up stale peers, events, tasks, and buf files
Internal:
  hook                         Hook entrypoint used by Claude/Codex
  find-root                    Shim helper
  which-real                   Shim helper

Environment:
  HCC_ROOT               Override project root
  HCC_DB                 Override database path
  HCC_PEER               Default peer id; inferred automatically when absent
  HCC_WEB_TOKEN          Optional web access token
`);
}

function helpTask() {
  console.log(`${CLI_NAME} task

Usage:
  ${CLI_NAME} task create --title TEXT [--body TEXT] [--from ID] [--to ID] [--priority N]
  ${CLI_NAME} task list [--status pending|claimed|running|review|blocked|done|abandoned] [--peer ID] [--all]
  ${CLI_NAME} task claim [--peer ID] --id N
  ${CLI_NAME} task next [--peer ID]
  ${CLI_NAME} task update [--peer ID] --id N --status STATUS [--summary TEXT] [--body TEXT] [--to ID]
  ${CLI_NAME} task done [--peer ID] --id N --summary TEXT

Default task list shows all project tasks that are not done or abandoned.
--peer is an explicit filter; HCC_PEER does not hide other open tasks.
Messages use per-peer unread ack state; tasks do not.

If --peer/--from and HCC_PEER are absent, hcc auto-joins the current terminal
as a stable project-local peer.
`);
}

function helpJoin() {
  console.log(`${CLI_NAME} join

Usage:
  eval "$(${CLI_NAME} join --peer ID [--kind codex|claude|shell|other] [--role ROLE])"

Examples:
  eval "$(${CLI_NAME} join --peer codex-current --kind codex)"
  ${CLI_NAME} status

This registers the current shell as a peer and prints shell exports for
HCC_PEER, HCC_ROOT, and HCC_DB. A child CLI cannot mutate its parent shell
environment directly, so use eval to apply the exports to the current window.
`);
}

function helpEnv() {
  console.log(`${CLI_NAME} env

Usage:
  eval "$(${CLI_NAME} env --peer ID)"

Examples:
  eval "$(${CLI_NAME} env --peer codex-current)"

This only prints shell exports. Use hcc join when you also want to register
the peer in the project bus.
`);
}

function helpMsg() {
  console.log(`${CLI_NAME} msg

Usage:
  ${CLI_NAME} msg send [--from ID] [--to ID|all] --body TEXT [--task N] [--kind note|task|handoff]
  ${CLI_NAME} msg inbox [--peer ID] [--wait SEC] [--all] [--limit N]
  ${CLI_NAME} msg ack [--peer ID] --id N

If --peer/--from and HCC_PEER are absent, hcc auto-joins the current terminal.
`);
}

function helpAsk() {
  console.log(`${CLI_NAME} ask

Usage:
  ${CLI_NAME} ask PEER MESSAGE [--from ID] [--task N] [--inject]
  ${CLI_NAME} ask --to PEER --body TEXT [--from ID] [--task N] [--inject]

Examples:
  ${CLI_NAME} ask claude-a "Please review task #3."
  ${CLI_NAME} ask --to codex-b --body "Can you run the router tests?" --task 3
  ${CLI_NAME} ask claude-a "Please review task #3." --inject
`);
}

function helpBroadcast() {
  console.log(`${CLI_NAME} broadcast

Usage:
  ${CLI_NAME} broadcast MESSAGE [--from ID] [--task N] [--inject]
  ${CLI_NAME} broadcast --body TEXT [--from ID] [--task N] [--inject]

Example:
  ${CLI_NAME} broadcast "Pause edits under src/router until lock clears."
`);
}

function helpInject() {
  console.log(`${CLI_NAME} inject

Usage:
  ${CLI_NAME} inject PEER TEXT [--no-enter]
  ${CLI_NAME} inject --peer PEER --body TEXT [--no-enter]

Examples:
  ${CLI_NAME} inject codex-a "hcc msg inbox --peer codex-a"
  ${CLI_NAME} inject claude-a "Please review task #3."

This works for peers attached to the running hcc web runtime, including
tmux-backed local terminals, attached tmux panes, and shim-launched tmux
terminals.
`);
}

function helpPeer() {
  console.log(`${CLI_NAME} peer

Usage:
  ${CLI_NAME} peer list
  ${CLI_NAME} peer start PEER [--kind codex|claude|shell] [--role ROLE] [--cwd DIR] [--resume ID|NAME]
  ${CLI_NAME} peer start PEER --kind codex --last
  ${CLI_NAME} peer start PEER --kind claude --continue
  ${CLI_NAME} peer start PEER [--kind codex|claude|shell] [--role ROLE] [--cwd DIR] -- COMMAND [ARGS...]
  ${CLI_NAME} peer attach PEER [--pane PANE] [--kind codex|claude|shell] [--role ROLE] [--cwd DIR]
  ${CLI_NAME} peer stop PEER

Examples:
  ${CLI_NAME} peer start codex-a --kind codex -- codex
  ${CLI_NAME} peer start codex-a --kind codex --resume 00000000-0000-0000-0000-000000000000
  ${CLI_NAME} peer start codex-a --kind codex --last
  ${CLI_NAME} peer start claude-a --kind claude -- claude
  ${CLI_NAME} peer start claude-a --kind claude --resume 00000000-0000-0000-0000-000000000000
  ${CLI_NAME} peer start claude-a --kind claude --continue
  ${CLI_NAME} peer attach codex-a --pane %1
  ${CLI_NAME} peer stop codex-a

Start hcc web first. peer start creates a local tmux-backed terminal by default.
The web runtime attaches to that terminal; hcc down stops only the web runtime
and leaves the tmux terminal alive. peer attach imports an existing tmux pane.
If --pane is omitted, peer attach uses the current tmux pane when available.
Use --force only when intentionally overriding a provider-session or pane binding.
`);
}

function helpLock() {
  console.log(`${CLI_NAME} lock

Usage:
  ${CLI_NAME} lock acquire [--peer ID] --resource PATH [--task N] [--ttl SEC] [--reason TEXT]
  ${CLI_NAME} lock renew [--peer ID] --resource PATH [--ttl SEC]
  ${CLI_NAME} lock release [--peer ID] --resource PATH [--force]
  ${CLI_NAME} lock list [--all]
`);
}

function helpHandoff() {
  console.log(`${CLI_NAME} handoff

Usage:
  ${CLI_NAME} handoff create [--from ID] --summary TEXT [--task N] [--to ID] [--changed-files JSON_OR_CSV] [--tests TEXT] [--risks TEXT]
  ${CLI_NAME} handoff list [--task N] [--limit N]
`);
}

function helpEvent() {
  console.log(`${CLI_NAME} event

Usage:
  ${CLI_NAME} event tail [--limit N]
`);
}

function helpRun() {
  console.log(`${CLI_NAME} run

Usage:
  ${CLI_NAME} run --peer ID --kind codex|claude|shell --role ROLE -- COMMAND [ARGS...]

Examples:
  ${CLI_NAME} run --peer codex-a --kind codex --role peer -- codex
  ${CLI_NAME} run --peer claude-a --kind claude --role peer -- claude

This keeps the CLI in your current terminal while injecting HCC_PEER,
HCC_ROOT, and HCC_DB so the session can use the shared bus.
Use hcc peer start, hcc web, or the installed claude/codex shims when the
session should also be browser-controllable.
`);
}

function helpUp() {
  console.log(`${CLI_NAME} up

Usage:
  ${CLI_NAME} up [--no-discover] [--no-guidance]

Examples:
  ${CLI_NAME} up

This initializes the project-local coordination bus, writes bounded guidance,
installs Claude/Codex hooks when missing, and registers currently detected
sessions. It does not start the browser terminal console.

Run hcc web for the default full experience: local coordination, hooks, shims,
tmux-backed terminal sessions, and browser control.
`);
}

function helpDown() {
  console.log(`${CLI_NAME} down

Usage:
  ${CLI_NAME} down

Stops the web runtime started by hcc web for this project.
`);
}

function helpWeb() {
  console.log(`${CLI_NAME} web

Usage:
  ${CLI_NAME} web [--host HOST] [--port N] [--token TEXT] [--local] [--no-discover] [--no-guidance]

Examples:
  ${CLI_NAME} web
  HCC_WEB_TOKEN='long-token' ${CLI_NAME} web --host 0.0.0.0 --port 8787

This is the default one-command entrypoint. It prepares local coordination,
installs Claude/Codex hooks and shims, ensures tmux is available, starts the
browser terminal console as a background runtime, prints the URL, PID, runtime
file, and log file, then returns the terminal to you.

Web token auth is disabled by default. Pass --token or set HCC_WEB_TOKEN to
require a token.

After hcc web, plain claude/codex commands started from a new shell are wrapped
as local tmux-backed terminals. Existing ordinary terminals can communicate
through the bus, but cannot be visually attached unless they were started under
tmux/screen or a hello-cc shim.
`);
}

/**
 * Read /proc/<ppid>/cmdline and extract --resume / -r / resume subcommand arg.
 * Returns the resume ID string or null.
 */
function readParentResumeId(kind) {
  if (process.platform !== 'linux') return null;
  try {
    const raw = fs.readFileSync(`/proc/${process.ppid}/cmdline`, 'utf8');
    const args = raw.split('\0').filter(Boolean);
    if (kind === 'claude') {
      for (let i = 0; i < args.length; i++) {
        if ((args[i] === '--resume' || args[i] === '-r') && args[i + 1]) return args[i + 1];
      }
    } else if (kind === 'codex') {
      const ri = args.indexOf('resume');
      if (ri >= 0 && args[ri + 1] && !args[ri + 1].startsWith('-')) return args[ri + 1];
    }
  } catch {}
  return null;
}

// ─── hcc hook ────────────────────────────────────────────────────────────────
// Called by Claude Code / Codex hooks. Reads JSON from stdin, registers the
// peer in the current HCC project, and injects a bounded coordination snapshot
// into model context on prompt/session/turn events.

async function cmdHook(ctx, args) {
  let hookType = args[0] || 'unknown';

  // Read stdin with a short timeout (hooks must complete quickly)
  const raw = await new Promise((resolve) => {
    let buf = '';
    const timer = setTimeout(() => resolve(buf), 2000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(buf); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(buf); });
  });

  let payload = {};
  try { payload = JSON.parse(raw); } catch {}
  hookType = payload.hook_event_name || payload.hookEventName || hookType;
  const hookEventName = formatHookEventName(hookType);
  const hookKey = hookEventName.replace(/[^a-z]/gi, '').toLowerCase();

  // Extract session identity (Claude Code sets these in its hook JSON)
  const kind = autoPeerKind('other');
  const providerSession = autoPeerProviderSession(kind);
  const sessionId  = payload.session_id || payload.sessionId || payload.conversation_id || payload.conversationId ||
    providerSession.sessionId || '';
  const hookCwd    = payload.cwd         || payload.workingDirectory || process.cwd();

  // Hooks auto-join the exact current project path, creating its mesh.db on
  // first use. Cross-path sharing is explicit via HCC_ROOT/HCC_DB.
  const hccRoot = process.env.HCC_ROOT
    ? path.resolve(process.env.HCC_ROOT)
    : path.resolve(hookCwd);

  const hookCtx = {
    ...ctx,
    root: hccRoot,
    dbPath: path.join(hccRoot, '.hello-cc', 'mesh.db')
  };
  registerProjectActivity(hookCtx);

  // Derive peer ID: HCC_PEER > resume ID from parent cmdline > session ID > terminal
  let peerId = process.env.HCC_PEER;
  let resumeId = null;
  if (!peerId) {
    resumeId = providerSession.resumeId || readParentResumeId(kind);
    if (resumeId) {
      peerId = `${kind}-${sanitizePeerPart(resumeId.slice(0, 8), shortHash(resumeId))}`;
    }
  }
  if (!peerId) {
    peerId = sessionId
      ? `${kind}-${sanitizePeerPart(sessionId.slice(0, 8), shortHash(sessionId))}`
      : `${kind}-${shortHash(`${hookCtx.root}:${autoPeerBasis(kind)}`)}`;
  }

  const db = connect(hookCtx);
  try {
    const status = hookKey === 'stop' ? 'idle' : 'working';
    const existing = db.prepare('SELECT id FROM peers WHERE id = ?').get(peerId);
    if (!existing) {
      upsertPeer(db, {
        id: peerId, kind, role: 'peer',
        worktree: hookCwd,
        branch: detectBranch(hookCwd),
        pid: process.ppid,
        status,
        capabilities: `hook-${hookKey}`
      });
    } else {
      db.prepare(`
        UPDATE peers
        SET last_seen_at = ?, status = COALESCE(?, status)
        WHERE id = ?
      `).run(now(), status, peerId);
    }
    const hookBinding = mergeHookPeerBinding(db, {
      peer: peerId,
      provider: kind,
      ...providerSessionParts(resumeId || sessionId),
      resume_mode: resumeId ? 'resume' : (sessionId ? 'detected' : 'unknown'),
      resume_arg: resumeId || null,
      command: null,
      transport: 'hook',
      runtime_session_id: peerId
    });
    upsertPeerBinding(db, hookBinding, true);
    addEvent(db, `hook.${hookKey}`, peerId, null, { session_id: sessionId, cwd: hookCwd });

    if (['sessionstart', 'userpromptsubmit'].includes(hookKey)) {
      const snapshot = buildHookCoordinationContext(db, peerId);
      ackMessages(db, peerId, snapshot.messages);
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName,
          additionalContext: snapshot.text
        }
      }) + '\n');
    } else if (['posttooluse', 'stop'].includes(hookKey)) {
      const snapshot = buildHookCoordinationContext(db, peerId);
      if (snapshot.messages.length > 0) {
        ackMessages(db, peerId, snapshot.messages);
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName,
            additionalContext: snapshot.text
          }
        }) + '\n');
      }
    }
  } finally {
    try { db.close(); } catch {}
  }
  process.exit(0);
}

// ─── hcc install-hooks ───────────────────────────────────────────────────────

async function cmdInstallHooks(ctx, args) {
  const opts = parseOpts(args, { booleans: ['uninstall', 'status'] });
  const { installClaudeHooks, uninstallClaudeHooks, verifyClaudeHooks,
          installCodexHooks, uninstallCodexHooks, verifyCodexHooks } = await loadSetup();
  const hccBin = commandPath();

  if (opts.uninstall) {
    const claude = uninstallClaudeHooks();
    const codex  = uninstallCodexHooks();
    const parts = [];
    if (claude) parts.push('~/.claude/settings.json');
    if (codex)  parts.push('~/.codex/hooks.json');
    printResult(ctx, { claude, codex }, () =>
      parts.length ? 'hooks removed from ' + parts.join(', ') : 'no hooks found to remove');
    return;
  }
  if (opts.status) {
    const claudeOk = verifyClaudeHooks();
    const codexOk  = verifyCodexHooks();
    printResult(ctx, { claude: claudeOk, codex: codexOk }, () =>
      `hooks: claude=${claudeOk ? 'yes' : 'no'} codex=${codexOk ? 'yes' : 'no'}`);
    return;
  }
  const cp = installClaudeHooks(hccBin);
  let cxp = null;
  try { cxp = installCodexHooks(hccBin); } catch {}
  printResult(ctx, { claude: cp, codex: cxp }, () =>
    `hooks installed: claude → ${cp}${cxp ? `, codex → ${cxp}` : ''}`);
}

// ─── hcc shim ────────────────────────────────────────────────────────────────

async function cmdShim(ctx, args) {
  const sub = args[0];
  const { installShims, uninstallShims, verifyShims, installPathEntry, SHIM_DIR } = await loadSetup();

  if (sub === 'ensure') {
    const name = args[1];
    const target = args[2] ? path.resolve(args[2]) : (name ? path.join(SHIM_DIR, name) : null);
    if (!['claude', 'codex'].includes(name) || !target) {
      throw new CliError('BAD_ARGS', 'Usage: hcc shim ensure claude|codex PATH');
    }
    const result = installShims(commandPath());
    const changed = (result.changed || []).map((p) => path.resolve(p));
    if (changed.includes(target)) {
      process.exitCode = 75;
      return;
    }
    return;
  }

  if (!sub || sub === 'install') {
    const hccBin = commandPath();
    const result = installShims(hccBin);
    const { alreadyPresent, rcFile } = installPathEntry();
    const lines = [
      result.installed.length
        ? `shims installed:\n${result.installed.map((p) => `  ${p}`).join('\n')}`
        : 'no shims installed (claude/codex not found on PATH)',
    ];
    if (result.skipped.length) lines.push(`skipped: ${result.skipped.join(', ')}`);
    if (!alreadyPresent) {
      lines.push(`PATH updated in ${rcFile}`);
      lines.push(`run: source ${rcFile}  (or open a new terminal)`);
    } else {
      lines.push(`PATH entry already present in ${rcFile}`);
    }
    printResult(ctx, result, () => lines.join('\n'));
    return;
  }
  if (sub === 'uninstall') {
    const removed = uninstallShims();
    printResult(ctx, { removed }, () => removed.length ? `removed: ${removed.join(', ')}` : 'no shims to remove');
    return;
  }
  if (sub === 'status') {
    const installed = verifyShims();
    printResult(ctx, { installed, shim_dir: SHIM_DIR }, () =>
      installed ? `shims installed in ${SHIM_DIR} ✓` : `shims not installed (run: hcc web)`
    );
    return;
  }
  throw new CliError('BAD_ARGS', `Unknown shim subcommand: ${sub}`);
}

// ─── hcc setup (maintenance bootstrap) ───────────────────────────────────────

async function cmdSetup(ctx, args) {
  const opts = parseOpts(args, { booleans: ['quiet'] });
  const log = opts.quiet ? () => {} : console.log;

  log('hello-cc setup\n');

  // 1. Init project if needed
  if (!fs.existsSync(ctx.dbPath)) {
    const db = connect(ctx);
    db.close();
    writeGuidance(ctx);
    log(`✓  project initialized: ${ctx.root}`);
  } else {
    log(`✓  project already initialized`);
  }

  // 2. Install Claude Code + Codex hooks
  const { installClaudeHooks, verifyClaudeHooks, installCodexHooks, verifyCodexHooks,
          installShims, verifyShims, installPathEntry } = await loadSetup();
  const hccBin = commandPath();

  if (!verifyClaudeHooks()) {
    installClaudeHooks(hccBin);
    log('✓  Claude Code hooks installed → ~/.claude/settings.json');
  } else {
    log('✓  Claude Code hooks already installed');
  }

  if (!verifyCodexHooks()) {
    try { installCodexHooks(hccBin); log('✓  Codex hooks installed → ~/.codex/hooks.json'); }
    catch { log('⚠  Codex hooks installation failed (ignored)'); }
  } else {
    log('✓  Codex hooks already installed');
  }

  // 3. Install shims
  if (!verifyShims()) {
    const result = installShims(hccBin);
    if (result.installed.length) {
      log(`✓  shims installed → ${result.installed.join(', ')}`);
    } else {
      log('⚠  shims: claude/codex not found on PATH — skipped');
    }
    const { alreadyPresent, rcFile } = installPathEntry();
    if (!alreadyPresent) {
      log(`✓  PATH updated in ${rcFile}`);
      log(`   run: source ${rcFile}  (or open a new terminal)`);
    }
  } else {
    log('✓  shims already installed');
  }

  log('\nDone. Run `hcc web` for the default coordinated terminal experience.');
}

// ─── hcc uninstall ───────────────────────────────────────────────────────────

async function cmdUninstall(ctx, args) {
  if (args[0] === '--help' || args[0] === '-h') {
    console.log(`${CLI_NAME} uninstall

Usage:
  ${CLI_NAME} uninstall [--purge --yes]

Stops the current project runtime and removes user-level hello-cc integrations:
Claude/Codex hooks and claude/codex shims.

With --purge --yes, also removes current project data:
  .hello-cc/
  hello-cc blocks from CLAUDE.md and AGENTS.md
`);
    return;
  }

  const opts = parseOpts(args, { booleans: ['purge', 'yes'] });
  if (opts.purge && !opts.yes) {
    throw new CliError('CONFIRM_REQUIRED', 'Refusing to purge project data without --yes');
  }

  const lines = [];

  let runtime = null;
  try {
    runtime = readRuntime(ctx);
  } catch (err) {
    if (!(err instanceof CliError && err.code === 'RUNTIME_NOT_RUNNING')) throw err;
  }
  if (runtime) {
    try {
      await runtimeRequest(ctx, 'POST', '/api/runtime/stop', {}, runtime);
      lines.push('runtime stopped');
    } catch (err) {
      if (!(err instanceof CliError && err.code === 'RUNTIME_UNREACHABLE')) throw err;
      try { fs.rmSync(runtimePath(ctx), { force: true }); } catch {}
      lines.push('stale runtime file removed');
    }
  } else {
    lines.push('runtime not running');
  }

  const { uninstallClaudeHooks, uninstallCodexHooks, uninstallShims } = await loadSetup();
  const claude = uninstallClaudeHooks();
  const codex = uninstallCodexHooks();
  const shims = uninstallShims();
  lines.push(claude ? 'Claude Code hooks removed' : 'Claude Code hooks not found');
  lines.push(codex ? 'Codex hooks removed' : 'Codex hooks not found');
  lines.push(shims.length ? `shims removed: ${shims.join(', ')}` : 'shims not found');

  let guidance = [];
  let purged = false;
  if (opts.purge) {
    guidance = removeGuidanceBlocks(ctx);
    try {
      fs.rmSync(path.join(ctx.root, '.hello-cc'), { recursive: true, force: true });
      purged = true;
      lines.push(`project data removed: ${path.join(ctx.root, '.hello-cc')}`);
    } catch (err) {
      throw new CliError('PURGE_FAILED', `Could not remove .hello-cc: ${err.message}`);
    }
    if (guidance.length) lines.push(`guidance blocks removed: ${guidance.join(', ')}`);
  } else {
    lines.push('project data kept; run hcc uninstall --purge --yes to remove .hello-cc and guidance blocks');
  }

  printResult(ctx, { runtime: Boolean(runtime), claude, codex, shims, purge: purged, guidance }, () => lines.join('\n'));
}

// ─── hcc scan ────────────────────────────────────────────────────────────────

async function cmdScan(ctx, args) {
  const opts = parseOpts(args, { booleans: ['register'] });
  const { scanClaudeSessions, scanCodexSessions, scanProcesses } = await loadDiscover();

  const found = [
    ...scanClaudeSessions(),
    ...scanCodexSessions(),
    ...scanProcesses(),
  ].filter((s) => s.hccRoot === ctx.root);

  // Deduplicate by peerId
  const byId = new Map();
  for (const s of found) {
    if (!byId.has(s.peerId)) byId.set(s.peerId, s);
  }
  const results = [...byId.values()];

  if (opts.register && results.length) {
    registerProjectActivity(ctx);
    const db = connect(ctx);
    try {
      for (const s of results) {
        upsertPeer(db, {
          id: s.peerId, kind: s.kind, role: 'peer',
          worktree: s.cwd,
          branch: detectBranch(s.cwd),
          pid: s.pid,
          status: s.status || 'running',
          capabilities: 'detected'
        });
        upsertPeerBinding(db, bindingFromDetected(s, s.transport || 'detected'), true);
      }
    } finally {
      db.close();
    }
  }

  printResult(ctx, results, (rows) => {
    if (!rows.length) return 'no active sessions found in this project';
    return table(rows, [
      { label: 'peer',      value: (r) => r.peerId },
      { label: 'kind',      value: (r) => r.kind },
      { label: 'pid',       value: (r) => r.pid || '' },
      { label: 'cwd',       value: (r) => r.cwd },
      { label: 'session',   value: (r) => (r.sessionId || '').slice(0, 16) },
      { label: 'transport', value: (r) => r.transport },
    ]);
  });
}

// ─── hcc gc ───────────────────────────────────────────────────────────────────

async function cmdGc(ctx, args) {
  const opts = parseOpts(args, { booleans: ['yes', 'force'] });
  const olderThanDays = intOpt(opts, 'older-than', 7);
  const dryRun = !opts.yes && !opts.force;
  const cutoff = now() - olderThanDays * 86400;
  const db = connect(ctx);
  const results = { buf_files: 0, stale_peers: 0, old_events: 0, old_tasks: 0 };

  try {
    // 1. Clean stale buffer files
    const bufsDir = path.join(ctx.root, '.hello-cc', BUFS_DIR_NAME);
    try {
      for (const f of fs.readdirSync(bufsDir)) {
        const fp = path.join(bufsDir, f);
        try {
          const st = fs.statSync(fp);
          if (st.mtimeMs < Date.now() - olderThanDays * 86400000) {
            if (!dryRun) fs.unlinkSync(fp);
            results.buf_files++;
          }
        } catch {}
      }
    } catch {}

    // 2. Remove stale peers (no heartbeat in N days)
    const stalePeers = db.prepare('SELECT id FROM peers WHERE last_seen_at < ?').all(cutoff);
    for (const p of stalePeers) {
      if (!dryRun) {
        db.prepare('DELETE FROM peer_bindings WHERE peer = ?').run(p.id);
        db.prepare('DELETE FROM peers WHERE id = ?').run(p.id);
      }
      results.stale_peers++;
    }

    // 3. Remove old events (avoid unbounded growth)
    const oldEvents = db.prepare('SELECT COUNT(*) AS n FROM events WHERE created_at < ?').get(cutoff);
    if (!dryRun) db.prepare('DELETE FROM events WHERE created_at < ?').run(cutoff);
    results.old_events = oldEvents.n;

    // 4. Remove old completed tasks
    const oldTasks = db.prepare(
      "SELECT COUNT(*) AS n FROM tasks WHERE status IN ('done', 'abandoned') AND updated_at < ?"
    ).get(cutoff);
    if (!dryRun) db.prepare(
      "DELETE FROM tasks WHERE status IN ('done', 'abandoned') AND updated_at < ?"
    ).run(cutoff);
    results.old_tasks = oldTasks.n;

  } finally {
    db.close();
  }

  printResult(ctx, results, (r) => {
    const lines = [`gc completed${dryRun ? ' (dry-run, add --yes to apply)' : ''}:`];
    if (r.buf_files)    lines.push(`  buffer files:   ${r.buf_files}`);
    if (r.stale_peers)  lines.push(`  stale peers:    ${r.stale_peers}`);
    if (r.old_events)   lines.push(`  old events:     ${r.old_events}`);
    if (r.old_tasks)    lines.push(`  old tasks:      ${r.old_tasks}`);
    if (!r.buf_files && !r.stale_peers && !r.old_events && !r.old_tasks) {
      lines.push('  nothing to clean');
    }
    return lines.join('\n');
  });
}

// ─── hcc find-root ───────────────────────────────────────────────────────────
// Used by shim scripts: prints the current hcc project path.

async function cmdFindRoot(ctx, args) {
  const opts = parseOpts(args);
  if (process.env.HCC_ROOT) {
    process.stdout.write(path.resolve(process.env.HCC_ROOT) + '\n');
    return;
  }
  const root = ctx.explicitRoot ? ctx.root : path.resolve(opts.cwd || process.cwd());
  process.stdout.write(root + '\n');
}

// ─── hcc which-real ─────────────────────────────────────────────────────────
// Used by shim scripts: prints the real (non-shim) path for a binary.

async function cmdWhichReal(ctx, args) {
  const name = args[0];
  if (!name) throw new CliError('BAD_ARGS', 'Usage: hcc which-real <binary>');
  const { findRealBinary } = await loadSetup();
  const p = findRealBinary(name);
  if (!p) { process.exitCode = 1; return; }
  process.stdout.write(p + '\n');
}

async function dispatch(ctx, rest) {
  const command = rest[0];
  const args = rest.slice(1);
  if (!command || command === '--help' || command === '-h' || command === 'help') return helpMain();
  if (command === '--version' || command === 'version') return console.log(VERSION);
  if (command === 'up') return cmdUp(ctx, args);
  if (command === 'down') return cmdDown(ctx, args);
  if (command === 'uninstall') return cmdUninstall(ctx, args);
  if (command === 'init') return cmdInit(ctx, args);
  if (command === 'register') return cmdRegister(ctx, args);
  if (command === 'join') return cmdJoin(ctx, args);
  if (command === 'env') return cmdEnv(ctx, args);
  if (command === 'heartbeat') return cmdHeartbeat(ctx, args);
  if (command === 'peers') return cmdPeers(ctx, args);
  if (command === 'status') return cmdStatus(ctx, args);
  if (command === 'prompt') return cmdPrompt(ctx, args);
  if (command === 'run') return cmdRun(ctx, args);
  if (command === 'peer') return cmdPeer(ctx, args);
  if (command === 'inject') return cmdInject(ctx, args);
  if (command === 'ask') return cmdAsk(ctx, args);
  if (command === 'broadcast') return cmdBroadcast(ctx, args);
  if (command === 'task') return cmdTask(ctx, args);
  if (command === 'msg') return cmdMsg(ctx, args);
  if (command === 'lock') return cmdLock(ctx, args);
  if (command === 'handoff') return cmdHandoff(ctx, args);
  if (command === 'event') return cmdEvent(ctx, args);
  if (command === 'web') return cmdWeb(ctx, args);
  if (command === 'hook') return cmdHook(ctx, args);
  if (command === 'install-hooks') return cmdInstallHooks(ctx, args);
  if (command === 'shim') return cmdShim(ctx, args);
  if (command === 'setup') return cmdSetup(ctx, args);
  if (command === 'scan') return cmdScan(ctx, args);
  if (command === 'gc') return cmdGc(ctx, args);
  if (command === 'find-root') return cmdFindRoot(ctx, args);
  if (command === 'which-real') return cmdWhichReal(ctx, args);
  throw new CliError('BAD_ARGS', `Unknown command: ${command}`);
}

async function main() {
  const { global, rest } = splitGlobalArgs(process.argv.slice(2));
  const ctx = createContext(global);
  try {
    await dispatch(ctx, rest);
  } catch (err) {
    if (err instanceof CliError) {
      if (ctx.json) {
        console.error(formatJson(false, { code: err.code, message: err.message, ...err.extra }));
      } else {
        console.error(`${CLI_NAME}: ${err.message}`);
        if (Object.keys(err.extra).length) console.error(JSON.stringify(err.extra));
      }
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

main();
