#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { URL, fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { CliError } from '../lib/errors.mjs';
import {
  DB_SCHEMA_VERSION,
  execWithBusyRetry,
  initSchema,
  tx
} from '../lib/db-schema.mjs';
import {
  intOpt,
  parseOpts,
  required,
  splitGlobalArgs,
  validateOpts,
  wantsHelp
} from '../lib/cli-args.mjs';
import {
  compactText,
  formatJson,
  printResult,
  shellExports,
  shellQuoteArg,
  table
} from '../lib/format.mjs';
import { readPackageMeta } from '../lib/package-meta.mjs';
import {
  removeGuidanceBlocks as removeGuidanceBlocksForRoot,
  writeGuidance as writeGuidanceForRoot
} from '../lib/guidance.mjs';
import {
  contextForProject,
  globalRuntimePath,
  projectDbPath,
  projectRegistryPath,
  runtimePath,
  webLogPath
} from '../lib/runtime-paths.mjs';
import {
  expectedWebHost,
  localRuntimeUrl,
  makeWebToken,
  publicRuntimeUrl,
  rememberRuntimeToken,
  requestUrl,
  runtimeApiUrl,
  runtimeBaseUrl,
  validateWebTokenOpts,
  webRuntimeMatchesRequest
} from '../lib/web-runtime.mjs';
import { webIndexHtml } from '../lib/web-ui-template.mjs';

// Lazy-load lib modules (they may import node-pty which needs to be optional)
const _libDir = path.resolve(fileURLToPath(import.meta.url), '..', '..', 'lib');
async function loadDiscover() { return import(path.join(_libDir, 'discover.mjs')); }
async function loadSetup()    { return import(path.join(_libDir, 'setup.mjs')); }

const PACKAGE_META = readPackageMeta(path.resolve(fileURLToPath(import.meta.url), '..', '..'));
const VERSION = PACKAGE_META.version;
const PRODUCT_NAME = 'hello-cc';
const CLI_NAME = 'hcc';
const NPM_PACKAGE_NAME = PACKAGE_META.name;
const DEFAULT_LOCK_TTL = 900;
const ACTIVE_PEER_TTL = 600;
// Directory under .hello-cc/ for optional external PTY buffer files.
const BUFS_DIR_NAME = 'bufs';
const WEB_CHILD_ENV = 'HCC_WEB_CHILD';

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

function providerSessionPeerId(kind, providerId) {
  return `${kind}-${sanitizePeerPart(String(providerId || '').slice(0, 8), shortHash(providerId))}`;
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

function createContext(global) {
  const cwd = process.cwd();
  const root = detectRoot(cwd, global.root);
  const dbPath = path.resolve(global.db || process.env.HCC_DB || projectDbPath(root));
  return { cwd, root, dbPath, json: global.json, explicitRoot: Boolean(global.root || process.env.HCC_ROOT) };
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
        db: path.resolve(p.db || projectDbPath(p.root)),
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
      db: path.resolve(project.db || projectDbPath(project.root)),
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
  const url = runtimeApiUrl(runtime, '/api/runtime');
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

function shellCommand(args) {
  return args.map(shellQuoteArg).join(' ');
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
  // A tmux argument consisting solely of ';' is swallowed as a command
  // separator even after '--', so a typed lone semicolon would vanish. Paste
  // such runs through a buffer (which is parsed as data, not command args).
  if (/^;+$/.test(text)) {
    tmuxPasteBuffer(pane, text, { raw: true });
    return;
  }
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

  // Typed characters must arrive as real key presses, not clipboard pastes:
  // send-keys -l is ~3x cheaper than the load-buffer/paste-buffer/delete-buffer
  // cycle (one tmux spawn vs three) and the target program sees keystrokes
  // rather than paste events — which bracketed-paste-aware TUIs (claude, codex)
  // otherwise mishandle. paste-buffer is reserved for genuine bracketed pastes.
  // Exit copy-mode once up front so send-keys isn't interpreted as copy commands.
  if (tmuxInCopyMode(pane)) tmuxExitCopyMode(pane);

  let pendingText = '';
  for (const chunk of chunks) {
    if (chunk.type === 'literal') {
      pendingText += chunk.text;
    } else {
      if (pendingText) { tmuxSendRawLiteral(pane, pendingText); pendingText = ''; }
      if (chunk.type === 'key') tmuxSendKeys(pane, [chunk.key]);
      else if (chunk.type === 'paste') tmuxPasteBuffer(pane, chunk.text, { bracketed: true, raw: true });
      else tmuxSendRawLiteral(pane, chunk.text);
    }
  }
  if (pendingText) tmuxSendRawLiteral(pane, pendingText);
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
  const url = runtimeApiUrl(rt, route);
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

let projectMigrationFanoutDepth = 0;
const migratedRegisteredProjectDbs = new Set();

function connect(ctx) {
  fs.mkdirSync(path.dirname(ctx.dbPath), { recursive: true });
  const db = new DatabaseSync(ctx.dbPath, { timeout: 5000 });
  db.exec('PRAGMA busy_timeout = 5000;');
  execWithBusyRetry(db, 'PRAGMA journal_mode = WAL;', { ignoreBusy: true });
  db.exec('PRAGMA foreign_keys = ON;');
  initSchema(db, { beforePostMigrationIndexes: dedupePeerBindings });
  migrateRegisteredProjectDbs(ctx);
  return db;
}

function migrateRegisteredProjectDbs(ctx) {
  if (projectMigrationFanoutDepth > 0) return;
  projectMigrationFanoutDepth += 1;
  try {
    const currentDb = path.resolve(ctx.dbPath);
    const seen = new Set([currentDb]);
    for (const project of readProjectRegistry()) {
      const root = path.resolve(project.root);
      const dbPath = path.resolve(project.db || path.join(root, '.hello-cc', 'mesh.db'));
      if (seen.has(dbPath)) continue;
      seen.add(dbPath);
      const cacheKey = `${dbPath}:${DB_SCHEMA_VERSION}`;
      if (migratedRegisteredProjectDbs.has(cacheKey)) continue;
      if (!fs.existsSync(root) || !fs.existsSync(dbPath)) continue;
      let db = null;
      try {
        db = new DatabaseSync(dbPath, { timeout: 5000 });
        db.exec('PRAGMA busy_timeout = 5000;');
        execWithBusyRetry(db, 'PRAGMA journal_mode = WAL;', { ignoreBusy: true });
        db.exec('PRAGMA foreign_keys = ON;');
        initSchema(db, { beforePostMigrationIndexes: dedupePeerBindings });
        migratedRegisteredProjectDbs.add(cacheKey);
      } catch (err) {
        throw new CliError('REGISTERED_DB_MIGRATION_FAILED', `Failed to migrate registered project database ${dbPath}: ${err?.message || err}`, {
          db: dbPath,
          code: err instanceof CliError ? err.code : undefined
        });
      } finally {
        try { db?.close(); } catch {}
      }
    }
  } finally {
    projectMigrationFanoutDepth -= 1;
  }
}

function peerBindingRuntimeRank(row) {
  if (row?.runtime_target && row.transport === 'tmux') return 50;
  if (row?.runtime_target) return 40;
  if (['tmux', 'web-pty'].includes(row?.transport)) return 30;
  if (row?.transport === 'hcc-run') return 20;
  if (row?.transport === 'hook') return 10;
  if (row?.transport === 'detected') return 5;
  return 0;
}

function comparePeerBindings(a, b) {
  return peerBindingRuntimeRank(b) - peerBindingRuntimeRank(a) ||
    Number(b.updated_at || 0) - Number(a.updated_at || 0) ||
    Number(b.created_at || 0) - Number(a.created_at || 0) ||
    String(a.peer || '').localeCompare(String(b.peer || ''));
}

function dedupePeerBindingRows(db, rows, eventType, payload = {}) {
  if (!rows || rows.length < 2) return 0;
  const ordered = [...rows].sort(comparePeerBindings);
  const survivor = ordered[0];
  let deleted = 0;
  for (const row of ordered.slice(1)) {
    db.prepare('DELETE FROM peer_bindings WHERE peer = ?').run(row.peer);
    deleted += 1;
    addEvent(db, eventType, survivor.peer, null, {
      ...payload,
      kept_peer: survivor.peer,
      removed_peer: row.peer,
      removed_transport: row.transport || null,
      removed_runtime_target: row.runtime_target || null
    });
  }
  return deleted;
}

function dedupeProviderSessionColumn(db, column) {
  const groups = db.prepare(`
    SELECT provider, ${column} AS session_value
    FROM peer_bindings
    WHERE ${column} IS NOT NULL
    GROUP BY provider, ${column}
    HAVING COUNT(*) > 1
  `).all();
  let deleted = 0;
  for (const group of groups) {
    const rows = db.prepare(`
      SELECT *
      FROM peer_bindings
      WHERE provider = ? AND ${column} = ?
    `).all(group.provider, group.session_value);
    deleted += dedupePeerBindingRows(db, rows, 'provider.session.deduped', {
      provider: group.provider,
      provider_session: group.session_value,
      provider_session_column: column
    });
  }
  return deleted;
}

function dedupeRuntimeTargets(db) {
  const groups = db.prepare(`
    SELECT runtime_target
    FROM peer_bindings
    WHERE runtime_target IS NOT NULL
    GROUP BY runtime_target
    HAVING COUNT(*) > 1
  `).all();
  let deleted = 0;
  for (const group of groups) {
    const rows = db.prepare(`
      SELECT *
      FROM peer_bindings
      WHERE runtime_target = ?
    `).all(group.runtime_target);
    deleted += dedupePeerBindingRows(db, rows, 'runtime.target.deduped', {
      runtime_target: group.runtime_target
    });
  }
  return deleted;
}

function dedupePeerBindings(db) {
  for (let i = 0; i < 5; i += 1) {
    const deleted =
      dedupeProviderSessionColumn(db, 'provider_session_id') +
      dedupeProviderSessionColumn(db, 'provider_session_name') +
      dedupeRuntimeTargets(db);
    if (!deleted) return;
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

function bindingHasProviderSession(binding) {
  return Boolean(binding?.provider_session_id || binding?.provider_session_name);
}

function bindingProviderSessionValue(binding) {
  return binding?.provider_session_id || binding?.provider_session_name || null;
}

function bindingHasRuntime(binding) {
  return Boolean(binding?.runtime_target) || ['tmux', 'web-pty'].includes(binding?.transport);
}

function mergeRuntimeBinding(existing, binding) {
  if (!existing || !bindingHasRuntime(existing) || bindingHasRuntime(binding)) return binding;
  return {
    ...binding,
    command: existing.command || binding.command || null,
    transport: existing.transport,
    runtime_session_id: existing.runtime_session_id || binding.runtime_session_id || binding.peer,
    runtime_target: existing.runtime_target || null
  };
}

function findProviderSessionBinding(db, binding) {
  if (!bindingHasProviderSession(binding)) return null;
  return db.prepare(`
    SELECT *
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
  ) || null;
}

function canonicalizePeerBinding(db, binding, options = {}) {
  const existing = db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get(binding.peer);
  let next = mergeRuntimeBinding(existing, binding);
  const conflict = findProviderSessionBinding(db, next);
  if (!conflict) return { peer: next.peer, binding: next, merged_from: null };

  const incomingRuntime = bindingHasRuntime(next);
  const conflictRuntime = bindingHasRuntime(conflict);
  const providerSession = bindingProviderSessionValue(next);
  const override = Boolean(options.override);

  if (override && incomingRuntime) {
    db.prepare('DELETE FROM peer_bindings WHERE peer = ?').run(conflict.peer);
    return { peer: next.peer, binding: next, merged_from: conflict.peer };
  }

  if (conflictRuntime && !incomingRuntime) {
    next = mergeRuntimeBinding(conflict, { ...next, peer: conflict.peer });
    return { peer: conflict.peer, binding: next, merged_from: binding.peer };
  }

  if (!conflictRuntime && incomingRuntime) {
    db.prepare('DELETE FROM peer_bindings WHERE peer = ?').run(conflict.peer);
    return { peer: next.peer, binding: next, merged_from: conflict.peer };
  }

  if (!conflictRuntime && !incomingRuntime) {
    next = {
      ...next,
      peer: conflict.peer,
      command: conflict.command || next.command || null,
      runtime_session_id: conflict.runtime_session_id || next.runtime_session_id || conflict.peer
    };
    return { peer: conflict.peer, binding: next, merged_from: binding.peer };
  }

  if (conflict.runtime_target && next.runtime_target && conflict.runtime_target === next.runtime_target) {
    next = mergeRuntimeBinding(conflict, { ...next, peer: conflict.peer });
    return { peer: conflict.peer, binding: next, merged_from: binding.peer };
  }

  throw new CliError('PROVIDER_SESSION_IN_USE', `${next.provider} session ${providerSession} is already bound to ${conflict.peer}`, {
    peer: conflict.peer,
    provider: conflict.provider,
    provider_session: providerSession,
    runtime_target: conflict.runtime_target || null
  });
}

function upsertPeerBinding(db, binding, force = false) {
  const t = now();
  const existing = db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get(binding.peer);
  binding = mergeRuntimeBinding(existing, binding);
  if ((binding.provider_session_id || binding.provider_session_name) && !force) {
    const conflict = findProviderSessionBinding(db, binding);
    if (conflict) {
      const providerSession = bindingProviderSessionValue(conflict);
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

function upsertCanonicalPeerBinding(db, binding, force = false, options = {}) {
  const result = canonicalizePeerBinding(db, binding, options);
  upsertPeerBinding(db, result.binding, force);
  return result;
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
  upsertCanonicalPeerBinding(db, {
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

function sendMessage(db, sender, recipient, taskId, kind, body, meta = {}) {
  const replyTo = meta.reply_to || null;
  const threadId = meta.thread_id || null;
  const info = db.prepare(`
    INSERT INTO messages(sender, recipient, task_id, kind, body, reply_to, thread_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sender, recipient || 'all', taskId || null, kind || 'note', body, replyTo, threadId, now());
  const messageId = Number(info.lastInsertRowid);
  if (!threadId) {
    db.prepare('UPDATE messages SET thread_id = ? WHERE id = ?').run(messageId, messageId);
  }
  addEvent(db, 'message.sent', sender, taskId || null, {
    message_id: messageId,
    recipient: recipient || 'all',
    kind: kind || 'note',
    reply_to: replyTo,
    thread_id: threadId || messageId
  });
  return messageId;
}

function queryInbox(db, peer, includeAll, limit) {
  return db.prepare(`
    SELECT
      m.id, m.sender, m.recipient, m.task_id, m.kind, m.body,
      m.reply_to, m.thread_id, m.created_at, r.read_at
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

function queryTimelineMessages(db, peer, limit) {
  if (!peer) {
    return db.prepare(`
      SELECT id, sender, recipient, task_id, kind, body, reply_to, thread_id, created_at
      FROM messages
      ORDER BY id DESC
      LIMIT ?
    `).all(limit).reverse();
  }
  return db.prepare(`
    SELECT
      m.id, m.sender, m.recipient, m.task_id, m.kind, m.body,
      m.reply_to, m.thread_id, m.created_at, r.read_at
    FROM messages m
    LEFT JOIN message_reads r
      ON r.message_id = m.id AND r.peer = ?
    WHERE
      m.sender = ?
      OR m.recipient IS NULL
      OR m.recipient = ''
      OR m.recipient = 'all'
      OR m.recipient = ?
    ORDER BY m.id DESC
    LIMIT ?
  `).all(peer, peer, peer, limit).reverse();
}

function getMessage(db, id) {
  return db.prepare(`
    SELECT id, sender, recipient, task_id, kind, body, reply_to, thread_id, created_at
    FROM messages
    WHERE id = ?
  `).get(id);
}

function queryMessageThread(db, messageId, limit) {
  const message = getMessage(db, messageId);
  if (!message) throw new CliError('NOT_FOUND', `Message #${messageId} does not exist`);
  const threadId = message.thread_id || message.id;
  const rows = db.prepare(`
    SELECT id, sender, recipient, task_id, kind, body, reply_to, thread_id, created_at
    FROM messages
    WHERE id = ? OR thread_id = ?
    ORDER BY id ASC
    LIMIT ?
  `).all(message.id, threadId, limit);
  return { message, thread_id: threadId, messages: rows };
}

function parseEventPayload(row) {
  try {
    return row?.payload ? JSON.parse(row.payload) : {};
  } catch {
    return {};
  }
}

function uniqueList(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function messageParticipants(message) {
  const participants = [message.sender];
  if (message.recipient && !['all', ''].includes(message.recipient)) participants.push(message.recipient);
  return uniqueList(participants);
}

function taskParticipants(task) {
  return uniqueList([task.created_by, task.owner, task.assignee]);
}

function payloadParticipants(payload) {
  const values = [];
  for (const key of ['peer', 'from_peer', 'to_peer', 'assignee', 'owner', 'recipient', 'kept_peer', 'removed_peer', 'previous_owner']) {
    if (payload?.[key] && payload[key] !== 'all') values.push(payload[key]);
  }
  return uniqueList(values);
}

function peerMatchesTimelineItem(item, peer) {
  if (!peer) return true;
  if (item.broadcast) return true;
  return (item.peers || []).includes(peer);
}

function shouldHideTimelineMessage(message) {
  if (message.kind === 'task' && /^Task #\d+ assigned: /.test(message.body || '')) return true;
  if (message.kind === 'handoff' && /^Handoff #\d+: /.test(message.body || '')) return true;
  return false;
}

const TIMELINE_EVENT_ALLOW = new Set([
  'task.created',
  'task.claimed',
  'task.pending',
  'task.running',
  'task.review',
  'task.blocked',
  'task.done',
  'task.abandoned',
  'task.takeover',
  'team.started',
  'lock.acquired',
  'lock.released',
  'peer.registered',
  'peer.joined',
  'peer.auto_joined',
  'peer.stopped',
  'provider.session.merged',
  'web.session.started',
  'web.session.exited',
  'tmux.session.attached',
  'tmux.session.detached',
  'tmux.session.exited',
  'run.session.started',
  'run.session.exited'
]);

function shouldHideTimelineEvent(event) {
  if (['message.sent', 'message.ack', 'handoff.created', 'lock.renewed'].includes(event.type)) return true;
  if (event.type && event.type.startsWith('hook.')) return true;
  if (event.type && event.type.startsWith('web.session.input')) return true;
  return !TIMELINE_EVENT_ALLOW.has(event.type);
}

function timelineDirection(message, peer) {
  if (!peer) return message.recipient === 'all' ? 'broadcast' : 'project';
  if (message.sender === peer && message.recipient === peer) return 'self';
  if (message.sender === peer) return 'out';
  if (message.recipient === 'all') return 'broadcast';
  if (message.recipient === peer) return 'in';
  return 'project';
}

function timelineFromRows({ messages = [], handoffs = [], tasks = [], locks = [], events = [] }, peer = null) {
  const items = [];
  for (const message of messages) {
    if (shouldHideTimelineMessage(message)) continue;
    const item = {
      id: `message:${message.id}`,
      source: 'message',
      source_id: message.id,
      ts: message.created_at,
      actor: message.sender,
      peers: messageParticipants(message),
      task_id: message.task_id || null,
      kind: message.kind || 'note',
      title: `${message.sender} -> ${message.recipient || 'all'}`,
      text: compactText(message.body),
      unread: message.read_at === null || message.read_at === undefined,
      direction: timelineDirection(message, peer),
      thread_id: message.thread_id || message.id,
      reply_to: message.reply_to || null,
      broadcast: !message.recipient || message.recipient === 'all'
    };
    if (peerMatchesTimelineItem(item, peer)) items.push(item);
  }
  for (const handoff of handoffs) {
    const item = {
      id: `handoff:${handoff.id}`,
      source: 'handoff',
      source_id: handoff.id,
      ts: handoff.created_at,
      actor: handoff.from_peer,
      peers: uniqueList([handoff.from_peer, handoff.to_peer]),
      task_id: handoff.task_id || null,
      kind: 'handoff',
      title: `handoff ${handoff.from_peer}${handoff.to_peer ? ` -> ${handoff.to_peer}` : ''}`,
      text: compactText(handoff.summary),
      direction: 'project',
      broadcast: !handoff.to_peer,
      tests: handoff.tests || '',
      risks: handoff.risks || ''
    };
    if (peerMatchesTimelineItem(item, peer)) items.push(item);
  }
  for (const task of tasks) {
    const item = {
      id: `task:${task.id}`,
      source: 'task',
      source_id: task.id,
      ts: task.updated_at || task.created_at,
      actor: task.owner || task.created_by || task.assignee || '',
      peers: taskParticipants(task),
      task_id: task.id,
      kind: task.status,
      title: `task #${task.id} ${task.status}${task.parent_id ? ` child of #${task.parent_id}` : ''}`,
      text: compactText(task.title),
      direction: 'project'
    };
    if (peerMatchesTimelineItem(item, peer)) items.push(item);
  }
  for (const lock of locks) {
    const item = {
      id: `lock:${lock.resource}`,
      source: 'lock',
      source_id: lock.resource,
      ts: lock.created_at,
      actor: lock.owner,
      peers: uniqueList([lock.owner]),
      task_id: lock.task_id || null,
      kind: 'active',
      title: `lock ${lockLabel(lock)}`,
      text: compactText(lock.reason || `owner=${lock.owner}`),
      direction: 'project'
    };
    if (peerMatchesTimelineItem(item, peer)) items.push(item);
  }
  for (const event of events) {
    if (shouldHideTimelineEvent(event)) continue;
    const payload = parseEventPayload(event);
    const item = {
      id: `event:${event.id}`,
      source: 'event',
      source_id: event.id,
      ts: event.created_at,
      actor: event.actor || '',
      peers: uniqueList([event.actor, ...payloadParticipants(payload)]),
      task_id: event.task_id || null,
      kind: event.type,
      title: event.type,
      text: compactText(payload.summary || payload.reason || payload.title || payload.resource || payload.peer || ''),
      direction: 'project'
    };
    if (peerMatchesTimelineItem(item, peer)) items.push(item);
  }
  const order = { message: 10, handoff: 20, task: 30, lock: 40, event: 50 };
  items.sort((a, b) =>
    (a.ts || 0) - (b.ts || 0) ||
    (order[a.source] || 99) - (order[b.source] || 99) ||
    String(a.source_id).localeCompare(String(b.source_id), undefined, { numeric: true }));
  return items.slice(-120);
}

function actionCommand(argv) {
  if (!argv?.length) return '';
  return [CLI_NAME, ...argv].map(shellQuoteArg).join(' ');
}

function makeAction(kind, argv, reason, mutates = true, extra = {}) {
  return {
    kind,
    reason,
    mutates,
    argv,
    command: actionCommand(argv),
    ...extra
  };
}

const WHOLE_LOCK_SCOPE = '*';

function normalizeLockScope(scope) {
  const text = String(scope || '').trim();
  return text || WHOLE_LOCK_SCOPE;
}

function scopedLockResource(resource, scope = WHOLE_LOCK_SCOPE) {
  const baseResource = String(resource || '').trim();
  const normalizedScope = normalizeLockScope(scope);
  if (!baseResource) throw new CliError('BAD_ARGS', 'Missing --resource');
  return {
    resource: normalizedScope === WHOLE_LOCK_SCOPE
      ? baseResource
      : `scoped:${Buffer.from(JSON.stringify([baseResource, normalizedScope]), 'utf8').toString('base64url')}`,
    base_resource: baseResource,
    scope: normalizedScope
  };
}

function lockBaseResource(lock) {
  return lock?.base_resource || lock?.resource || '';
}

function lockScope(lock) {
  return normalizeLockScope(lock?.scope);
}

function lockLabel(lock) {
  const base = lockBaseResource(lock);
  const scope = lockScope(lock);
  return scope === WHOLE_LOCK_SCOPE ? base : `${base} [${scope}]`;
}

function lockArgv(resource, scope) {
  const argv = ['--resource', resource];
  if (normalizeLockScope(scope) !== WHOLE_LOCK_SCOPE) argv.push('--scope', normalizeLockScope(scope));
  return argv;
}

function locksConflict(a, b) {
  return lockBaseResource(a) === lockBaseResource(b) &&
    (lockScope(a) === WHOLE_LOCK_SCOPE || lockScope(b) === WHOLE_LOCK_SCOPE || lockScope(a) === lockScope(b));
}

function looksLikeMultiTask(task) {
  if (!task) return false;
  const text = `${task.title || ''}\n${task.body || ''}`;
  const bullets = text.split('\n').filter((line) => /^\s*(?:[-*]|\d+[.)])\s+\S+/.test(line)).length;
  const separators = (text.match(/[,，;；、]/g) || []).length;
  return bullets >= 2 || separators >= 3 || /多任务|并行|团队|分工|several tasks|multiple tasks|parallel|team/i.test(text);
}

function selectCurrentTask(tasks, peerId) {
  if (!peerId) return null;
  const statusRank = { running: 0, claimed: 1, review: 2, blocked: 3 };
  const openTasks = (tasks || []).filter((task) => !['done', 'abandoned'].includes(task.status));
  const ownedTasks = openTasks
    .filter((task) => task.owner === peerId)
    .sort((a, b) =>
      (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9) ||
      Number(a.priority || 0) - Number(b.priority || 0) ||
      Number(a.id || 0) - Number(b.id || 0));
  return ownedTasks.find((task) => ['running', 'claimed', 'review', 'blocked'].includes(task.status)) || ownedTasks[0] || null;
}

function taskRelatedLocks(task, locks) {
  const taskId = Number(task?.id || 0);
  const owner = task?.owner || '';
  return (locks || []).filter((lock) => {
    if (taskId && Number(lock.task_id || 0) === taskId) return true;
    return Boolean(owner && lock.owner === owner);
  });
}

function taskOwnerLiveness(task, peers, locks, t = now()) {
  const owner = task?.owner || null;
  const relatedLocks = taskRelatedLocks(task, locks);
  if (!owner) {
    return {
      owner_known: false,
      owner_active: null,
      owner_stale: false,
      owner_age_sec: null,
      related_lock_count: relatedLocks.length,
      takeover_ready: false
    };
  }
  const ownerRow = (peers || []).find((row) => row.id === owner) || null;
  const ownerAge = ownerRow
    ? Number(ownerRow.age_sec ?? (t - Number(ownerRow.last_seen_at || 0)))
    : null;
  const ownerActive = Boolean(ownerRow && Number.isFinite(ownerAge) && ownerAge <= ACTIVE_PEER_TTL);
  const ownerStale = !ownerActive;
  const takeoverStatus = ['claimed', 'running', 'review', 'blocked'].includes(task.status);
  return {
    owner_known: Boolean(ownerRow),
    owner_active: ownerActive,
    owner_stale: ownerStale,
    owner_age_sec: Number.isFinite(ownerAge) ? ownerAge : null,
    related_lock_count: relatedLocks.length,
    takeover_ready: Boolean(takeoverStatus && ownerStale && relatedLocks.length === 0)
  };
}

function annotateTasksWithLiveness(tasks, peers, locks, t = now()) {
  return (tasks || []).map((task) => ({
    ...task,
    ...taskOwnerLiveness(task, peers, locks, t)
  }));
}

function taskOwnerStateText(task) {
  if (!task?.owner) return '';
  if (task.owner_stale) {
    if (task.takeover_ready) return 'stale/no-lock';
    const locks = Number(task.related_lock_count || 0);
    return locks ? `stale/locks=${locks}` : 'stale';
  }
  if (task.owner_active) return 'active';
  return '';
}

function summarizeTask(task) {
  if (!task) return null;
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    owner: task.owner || null,
    assignee: task.assignee || null,
    parent_id: task.parent_id || null,
    team_role: task.team_role || null,
    priority: task.priority,
    owner_active: task.owner_active ?? null,
    owner_stale: Boolean(task.owner_stale),
    owner_age_sec: task.owner_age_sec ?? null,
    related_lock_count: Number(task.related_lock_count || 0),
    takeover_ready: Boolean(task.takeover_ready)
  };
}

function parseTaskIds(opts) {
  const values = [];
  const addValue = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) addValue(item);
      return;
    }
    if (value === undefined || value === null || value === '') return;
    for (const part of String(value).split(',')) {
      const text = part.trim();
      if (text) values.push(text);
    }
  };
  addValue(opts.id);
  addValue(opts.ids);
  addValue(opts._ || []);
  const seen = new Set();
  const ids = [];
  for (const value of values) {
    if (!/^\d+$/.test(value)) throw new CliError('BAD_ARGS', `task id must be an integer: ${value}`);
    const id = Number.parseInt(value, 10);
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  if (!ids.length) throw new CliError('BAD_ARGS', 'Missing --id');
  return ids;
}

function positiveIntOpt(opts, key, fallback, { max = 50 } = {}) {
  const value = intOpt(opts, key, fallback);
  if (value < 1) throw new CliError('BAD_ARGS', `--${key} must be >= 1`);
  if (value > max) throw new CliError('BAD_ARGS', `--${key} must be <= ${max}`);
  return value;
}

function taskRowsText(tasks, verb = 'claimed') {
  const rows = Array.isArray(tasks) ? tasks : [tasks].filter(Boolean);
  if (!rows.length) return 'no pending task';
  return rows.map((task) => `${verb} task #${task.id}: ${task.title}`).join('\n');
}

function claimTaskRowsForPeer(db, peer, ids, { force = false, source = null } = {}) {
  return tx(db, () => {
    const tasks = [];
    for (const id of ids) {
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      if (!row) throw new CliError('NOT_FOUND', `Task #${id} does not exist`);
      if (row.owner && row.owner !== peer && !force) {
        throw new CliError('TASK_OWNED', `Task #${id} is owned by ${row.owner}`, { owner: row.owner });
      }
      if (row.assignee && row.assignee !== peer && !force) {
        throw new CliError('TASK_ASSIGNED', `Task #${id} is assigned to ${row.assignee}`, { assignee: row.assignee });
      }
      if (!['pending', 'blocked', 'claimed', 'running'].includes(row.status) && !force) {
        throw new CliError('BAD_STATE', `Task #${id} is ${row.status}`);
      }
      const t = now();
      db.prepare(`
        UPDATE tasks
        SET owner = ?, status = 'claimed', claimed_at = COALESCE(claimed_at, ?), updated_at = ?
        WHERE id = ?
      `).run(peer, t, t, id);
      addEvent(db, 'task.claimed', peer, id, {
        previous_owner: row.owner,
        force,
        ...(source ? { source } : {})
      });
      tasks.push(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
    }
    return tasks;
  });
}

function takeoverPolicyDetails(db, row, peer, { policy = 'any', staleAfter = ACTIVE_PEER_TTL } = {}) {
  const normalized = String(policy || 'any').toLowerCase();
  const allowed = new Set(['any', 'blocked', 'stale', 'blocked-or-stale']);
  if (!allowed.has(normalized)) {
    throw new CliError('BAD_ARGS', `Unsupported takeover policy: ${policy}`);
  }
  const previousOwner = row.owner || null;
  const blocked = row.status === 'blocked';
  const ownerRow = previousOwner ? db.prepare('SELECT id, last_seen_at FROM peers WHERE id = ?').get(previousOwner) : null;
  const ownerAge = ownerRow ? now() - Number(ownerRow.last_seen_at || 0) : null;
  const ownerStale = Boolean(previousOwner && previousOwner !== peer && (!ownerRow || ownerAge > staleAfter));
  const alreadyOwner = previousOwner === peer;
  const ok = alreadyOwner ||
    normalized === 'any' ||
    (normalized === 'blocked' && blocked) ||
    (normalized === 'stale' && ownerStale) ||
    (normalized === 'blocked-or-stale' && (blocked || ownerStale));
  return { policy: normalized, blocked, owner_stale: ownerStale, owner_age_sec: ownerAge, stale_after_sec: staleAfter, ok };
}

function takeOverTaskForPeer(db, peer, id, { reason, policy = 'any', staleAfter = ACTIVE_PEER_TTL, source = null } = {}) {
  return tx(db, () => {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!row) throw new CliError('NOT_FOUND', `Task #${id} does not exist`);
    if (['done', 'abandoned'].includes(row.status)) {
      throw new CliError('BAD_STATE', `Task #${id} is ${row.status}`);
    }
    const policyDetails = takeoverPolicyDetails(db, row, peer, { policy, staleAfter });
    if (!policyDetails.ok) {
      throw new CliError('TAKEOVER_POLICY', `Task #${id} does not match takeover policy ${policyDetails.policy}`, {
        task_id: id,
        status: row.status,
        owner: row.owner || null,
        policy: policyDetails.policy,
        owner_stale: policyDetails.owner_stale,
        owner_age_sec: policyDetails.owner_age_sec,
        stale_after_sec: policyDetails.stale_after_sec
      });
    }
    const previousOwner = row.owner || null;
    const previousAssignee = row.assignee || null;
    const t = now();
    db.prepare(`
      UPDATE tasks
      SET owner = ?, status = 'claimed', claimed_at = COALESCE(claimed_at, ?), updated_at = ?
      WHERE id = ?
    `).run(peer, t, t, id);
    addEvent(db, 'task.takeover', peer, id, {
      previous_owner: previousOwner,
      previous_assignee: previousAssignee,
      reason,
      policy: policyDetails.policy,
      owner_stale: policyDetails.owner_stale,
      stale_after_sec: staleAfter,
      ...(source ? { source } : {})
    });
    if (previousOwner && previousOwner !== peer) {
      sendMessage(db, peer, previousOwner, id, 'task.takeover', `Task #${id} taken over by ${peer}: ${reason}`);
    }
    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  });
}

function deriveAutomation(snapshot, peer = null, opts = {}) {
  const peerId = peer || '';
  const t = Number(snapshot.now || now());
  const peerRow = peerId ? snapshot.peers.find((row) => row.id === peerId) : null;
  const openTasks = (snapshot.tasks || []).filter((task) => !['done', 'abandoned'].includes(task.status));
  const assignedTasks = peerId ? openTasks.filter((task) => !task.owner && task.assignee === peerId) : [];
  const availableTasks = openTasks.filter((task) => !task.owner && !task.assignee);
  const ownedTask = selectCurrentTask(openTasks, peerId);
  const takeoverReadyTasks = peerId
    ? openTasks.filter((task) => task.owner && task.owner !== peerId && task.takeover_ready)
    : [];
  const intent = String(opts.intent || 'work').toLowerCase();
  const scope = normalizeLockScope(opts.scope || opts.lock_scope);
  const resources = uniqueList(Array.isArray(opts.resources) ? opts.resources : (opts.resource ? [opts.resource] : []));
  const ownLocks = peerId ? (snapshot.locks || []).filter((lock) => lock.owner === peerId) : [];
  const requestedLocks = resources.map((resource) => {
    const requested = scopedLockResource(resource, scope);
    const lock = (snapshot.locks || []).find((row) => Number(row.expires_at || 0) > t && locksConflict(row, requested));
    const exact = (snapshot.locks || []).find((row) => Number(row.expires_at || 0) > t && lockBaseResource(row) === requested.base_resource && lockScope(row) === requested.scope);
    return { ...requested, lock, exact };
  });
  const conflict = requestedLocks.find((entry) => entry.lock && entry.lock.owner !== peerId);
  const missingLock = requestedLocks.find((entry) => !entry.lock);
  const unread = peerId ? (snapshot.messages || []).filter((message) =>
    message.read_at === null || message.read_at === undefined) : [];
  const warnings = [];
  if (peerId && !peerRow) warnings.push(`peer ${peerId} is not registered in this project`);
  const lockActions = [];
  const messageActions = [];
  const taskActions = [];
  const automation = {
    schema_version: 1,
    peer: peerId ? {
      id: peerId,
      known: Boolean(peerRow),
      active: Boolean(peerRow && Number(peerRow.age_sec || 0) <= ACTIVE_PEER_TTL),
      age_sec: peerRow ? Number(peerRow.age_sec || 0) : null
    } : null,
    current_task: summarizeTask(ownedTask),
    phase: 'idle',
    next_action: makeAction('none', [], 'no immediate coordination action', false),
    actions: [],
    finish_actions: [],
    warnings
  };

  const orderedUnread = unread
    .filter((message) => message.sender !== peerId)
    .filter((message) => !shouldHideTimelineMessage(message))
    .sort((a, b) => (a.kind === 'task' ? 1 : 0) - (b.kind === 'task' ? 1 : 0) || a.id - b.id);
  for (const message of orderedUnread) {
    if (ownedTask && message.kind === 'task') continue;
    const kind = message.kind === 'task' ? 'msg.inbox' : 'msg.reply';
    const argv = kind === 'msg.reply'
      ? ['msg', 'reply', '--from', peerId, '--id', String(message.id), '--body', '<answer>']
      : ['msg', 'inbox', '--peer', peerId];
    messageActions.push(makeAction(kind, argv, `unread message #${message.id} from ${message.sender}`, kind !== 'msg.inbox', {
      message_id: message.id,
      task_id: message.task_id || null
    }));
  }

  if (!ownedTask && assignedTasks.length) {
    const task = assignedTasks[0];
    taskActions.push(makeAction('task.claim', ['task', 'claim', '--peer', peerId, '--id', String(task.id)], `assigned task #${task.id}`, true, { task_id: task.id }));
  } else if (!ownedTask && takeoverReadyTasks.length) {
    const task = takeoverReadyTasks[0];
    taskActions.push(makeAction(
      'task.takeover',
      ['task', 'takeover', '--peer', peerId, '--id', String(task.id), '--reason', 'owner stale and no active related locks', '--policy', 'stale'],
      `task #${task.id} owner ${task.owner} is stale and has no active related locks`,
      true,
      { task_id: task.id, owner: task.owner, owner_age_sec: task.owner_age_sec ?? null }
    ));
  } else if (!ownedTask && availableTasks.length) {
    taskActions.push(makeAction('task.next', ['task', 'next', '--peer', peerId], 'available pending task exists', true));
  }

  if (ownedTask) {
    const readOnlyIntent = ['read', 'review', 'inspect'].includes(intent);
    if (readOnlyIntent && resources.length) {
      warnings.push(`intent=${intent} is read-only; do not acquire file locks for snapshot inspection`);
    } else if (conflict) {
      const requestedLabel = lockLabel(conflict);
      const heldLabel = lockLabel(conflict.lock);
      lockActions.push(makeAction(
        'msg.send',
        ['msg', 'send', '--from', peerId, '--to', conflict.lock.owner, '--task', String(ownedTask.id), '--body', `Please coordinate ${requestedLabel}; ${heldLabel} is locked by ${conflict.lock.owner}. If our edits are separate, split to scoped locks before final tests/commit.`],
        `${requestedLabel} conflicts with ${heldLabel} held by ${conflict.lock.owner}`,
        true,
        { task_id: ownedTask.id, resource: conflict.base_resource, scope: conflict.scope, lock_owner: conflict.lock.owner, lock_resource: conflict.lock.resource, lock_scope: lockScope(conflict.lock) }
      ));
    } else if (missingLock) {
      lockActions.push(makeAction(
        'lock.acquire',
        ['lock', 'acquire', '--peer', peerId, '--task', String(ownedTask.id), ...lockArgv(missingLock.base_resource, missingLock.scope), '--ttl', String(DEFAULT_LOCK_TTL), '--reason', '<work>'],
        `task #${ownedTask.id} needs ${lockLabel(missingLock)} lock`,
        true,
        { task_id: ownedTask.id, resource: missingLock.base_resource, scope: missingLock.scope }
      ));
    }
    if (ownedTask.status === 'claimed') {
      taskActions.push(makeAction('task.update', ['task', 'update', '--peer', peerId, '--id', String(ownedTask.id), '--status', 'running', '--summary', '<started>'], `task #${ownedTask.id} is claimed but not running`, true, { task_id: ownedTask.id }));
    }
    if (!ownedTask.parent_id && looksLikeMultiTask(ownedTask)) {
      const childCount = openTasks.filter((task) => task.parent_id === ownedTask.id && !['done', 'abandoned'].includes(task.status)).length;
      if (!childCount) {
        taskActions.push(makeAction('team.plan', ['team', 'plan', '--from-task', String(ownedTask.id)], `task #${ownedTask.id} looks splittable; plan explicit team subtasks`, false, { task_id: ownedTask.id }));
      }
    }
    automation.finish_actions.push(makeAction('handoff.create', ['handoff', 'create', '--from', peerId, '--task', String(ownedTask.id), '--summary', '<summary>', '--tests', '<tests>', '--risks', '<risks>'], `handoff task #${ownedTask.id} before stopping`, true, { task_id: ownedTask.id }));
    automation.finish_actions.push(makeAction('task.done', ['task', 'done', '--peer', peerId, '--id', String(ownedTask.id), '--summary', '<summary>'], `mark task #${ownedTask.id} done after handoff`, true, { task_id: ownedTask.id }));
    for (const lock of ownLocks) {
      automation.finish_actions.push(makeAction('lock.release', ['lock', 'release', '--peer', peerId, ...lockArgv(lockBaseResource(lock), lockScope(lock))], `release ${lockLabel(lock)}`, true, { task_id: lock.task_id || null, resource: lockBaseResource(lock), scope: lockScope(lock) }));
    }
  }
  automation.actions.push(...lockActions, ...messageActions, ...taskActions);

  if (opts.intent === 'finish' || opts.intent === 'stop') {
    automation.phase = ownedTask ? 'handoff' : 'idle';
    automation.next_action = automation.finish_actions[0] || automation.next_action;
    return automation;
  }
  automation.next_action = automation.actions[0] || (ownedTask
    ? makeAction('none', [], `continue task #${ownedTask.id}`, false, { task_id: ownedTask.id })
    : automation.next_action);
  if (automation.next_action.kind === 'msg.reply' || automation.next_action.kind === 'msg.inbox') automation.phase = 'reply_message';
  else if (automation.next_action.kind === 'task.claim' || automation.next_action.kind === 'task.next') automation.phase = 'claim_task';
  else if (automation.next_action.kind === 'task.takeover') automation.phase = 'takeover_task';
  else if (automation.next_action.kind === 'lock.acquire') automation.phase = 'acquire_lock';
  else if (automation.next_action.kind === 'msg.send') automation.phase = 'coordinate_lock';
  else if (automation.next_action.kind === 'team.plan') automation.phase = 'team_plan';
  else if (ownedTask) automation.phase = ownedTask.status === 'review' ? 'handoff' : 'work';
  return automation;
}

function renderAutomationContext(automation) {
  if (!automation) return '';
  const lines = [
    '[hello-cc next action]',
    `phase: ${automation.phase}`,
    automation.current_task ? `current_task: #${automation.current_task.id} ${automation.current_task.status} ${automation.current_task.title}` : null,
    `next: ${automation.next_action.command || automation.next_action.kind}`,
    `why: ${automation.next_action.reason}`
  ].filter(Boolean);
  if (automation.finish_actions?.length) {
    lines.push('finish:');
    for (const action of automation.finish_actions.slice(0, 4)) lines.push(`- ${action.command}`);
  }
  if (automation.warnings?.length) {
    lines.push('warnings:');
    for (const warning of automation.warnings.slice(0, 4)) lines.push(`- ${warning}`);
  }
  return lines.join('\n');
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
  const ownerState = taskOwnerStateText(task);
  if (ownerState) parts.push(`owner_state=${ownerState}`);
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

function collectStateSnapshot(db, ctx, peer = null, opts = {}) {
  const t = now();
  const peers = db.prepare(`
    SELECT id, kind, role, status, worktree, branch, pid, capabilities,
           created_at, last_seen_at, (? - last_seen_at) AS age_sec
    FROM peers
    ORDER BY last_seen_at DESC, id ASC
    LIMIT 200
  `).all(t);
  const taskRows = queryOpenTasks(db, 200);
  const locks = db.prepare(`
    SELECT resource, base_resource, scope, owner, task_id, reason, expires_at, created_at
    FROM locks
    WHERE expires_at > ?
    ORDER BY resource ASC
    LIMIT 200
  `).all(t);
  const tasks = annotateTasksWithLiveness(taskRows, peers, locks, t);
  const messages = peer
    ? queryInbox(db, peer, false, 50)
    : db.prepare(`
        SELECT id, sender, recipient, task_id, kind, body, reply_to, thread_id, created_at
        FROM messages
        ORDER BY id DESC
        LIMIT 50
      `).all().reverse();
  const timelineMessages = queryTimelineMessages(db, peer, 80);
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
  const snapshot = {
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
  snapshot.timeline = timelineFromRows({ messages: timelineMessages, handoffs, tasks, locks, events }, peer);
  snapshot.automation = deriveAutomation(snapshot, peer, opts);
  return snapshot;
}

function buildHookCoordinationContext(db, ctx, peerId) {
  const snapshot = collectStateSnapshot(db, ctx, peerId);
  const openTasks = snapshot.tasks.slice(0, 8);
  const unread = snapshot.messages.slice(0, 5);
  const peers = snapshot.peers.slice(0, 8);
  const parts = [
    '[hello-cc coordination]',
    `peer: ${peerId}`,
    'This is live project coordination context injected by hello-cc.',
    'You are not isolated for project coordination: hcc is the source of truth for other Claude/Codex/shell sessions in this project.',
    'If the user asks what other sessions are doing, what tasks exist, or whether you can see other sessions, do not answer from generic model knowledge and do not say sessions are isolated. Run hcc status, hcc state, hcc peers, hcc task list, hcc msg inbox, and hcc lock list, then answer from those results.',
    'Tasks are project work facts, not read/unread items. Open tasks stay relevant to every session until they are marked done or abandoned. Messages are the unread/ack notification channel.',
    'If you already own a current task, continue that task until handoff/done/blocked; do not claim a different task just because a new prompt arrived.',
    'When a hello-cc message asks for a response, reply with hcc msg reply --id <message-id> --body "<answer>" so the answer stays in the same thread.'
  ];

  if (peers.length > 0) {
    parts.push('[hello-cc known peers]');
    parts.push(...peers.map((peer) => {
      const age = Math.max(0, snapshot.now - Number(peer.last_seen_at || 0));
      const active = age <= ACTIVE_PEER_TTL ? 'active' : 'stale';
      return `- ${peer.id} ${peer.kind || 'other'} ${peer.status || 'idle'} ${active}`;
    }));
  } else {
    parts.push('[hello-cc known peers]\n(none)');
  }

  if (snapshot.automation.current_task) {
    const task = snapshot.automation.current_task;
    parts.push('[hello-cc current task]');
    parts.push(`#${task.id} ${task.status}: ${task.title}`);
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
      `- #${m.id} from ${m.sender}${m.task_id ? ` task #${m.task_id}` : ''}${m.reply_to ? ` reply #${m.reply_to}` : ''}: ${m.body}`
    ));
  } else {
    parts.push('[hello-cc unread messages]\n(none)');
  }

  if (snapshot.locks.length > 0) {
    parts.push('[hello-cc active locks]');
    parts.push(...snapshot.locks.slice(0, 8).map((lock) =>
      `- ${lockLabel(lock)} owner=${lock.owner}${lock.task_id ? ` task #${lock.task_id}` : ''}`));
  } else {
    parts.push('[hello-cc active locks]\n(none)');
  }

  parts.push(renderAutomationContext(snapshot.automation));

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

function writeGuidance(ctx) {
  return writeGuidanceForRoot(ctx.root);
}

function removeGuidanceBlocks(ctx) {
  return removeGuidanceBlocksForRoot(ctx.root);
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
    upsertCanonicalPeerBinding(db, {
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
  if (!sub || wantsHelp(args)) return helpTask();
  if (sub === 'create') return taskCreate(ctx, args.slice(1));
  if (sub === 'list') return taskList(ctx, args.slice(1));
  if (sub === 'claim') return taskClaim(ctx, args.slice(1));
  if (sub === 'takeover') return taskTakeover(ctx, args.slice(1));
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
  const parentId = intOpt(opts, 'parent', null);
  const teamRole = opts.role || opts['team-role'] || null;
  const db = connect(ctx);
  touchCurrentPeer(db, ctx, identity, null, 'shell');
  const t = now();
  const id = tx(db, () => {
    if (parentId && !db.prepare('SELECT id FROM tasks WHERE id = ?').get(parentId)) {
      throw new CliError('NOT_FOUND', `Parent task #${parentId} does not exist`);
    }
    const info = db.prepare(`
      INSERT INTO tasks(title, body, status, assignee, owner, parent_id, team_role, priority, created_by, created_at, updated_at)
      VALUES (?, ?, 'pending', ?, NULL, ?, ?, ?, ?, ?, ?)
    `).run(title, body, assignee, parentId, teamRole, priority, createdBy, t, t);
    const taskId = Number(info.lastInsertRowid);
    addEvent(db, 'task.created', createdBy, taskId, { title, assignee, priority, parent_id: parentId, team_role: teamRole });
    if (assignee) {
      sendMessage(db, createdBy, assignee, taskId, 'task', `Task #${taskId} assigned: ${title}`);
    }
    return taskId;
  });
  printResult(ctx, { id, title, assignee, priority, parent_id: parentId, team_role: teamRole },
    (data) => `created task #${data.id}: ${data.title}${data.assignee ? ` -> ${data.assignee}` : ''}${data.parent_id ? ` (child of #${data.parent_id})` : ''}`);
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
  const t = now();
  const peers = db.prepare(`
    SELECT id, last_seen_at, (? - last_seen_at) AS age_sec
    FROM peers
  `).all(t);
  const locks = db.prepare('SELECT * FROM locks WHERE expires_at > ?').all(t);
  rows = annotateTasksWithLiveness(rows, peers, locks, t);
  printResult(ctx, rows, (data) => table(data, [
    { label: 'id', value: (r) => `#${r.id}` },
    { label: 'status', value: (r) => r.status },
    { label: 'prio', value: (r) => r.priority },
    { label: 'assignee', value: (r) => r.assignee || '' },
    { label: 'owner', value: (r) => r.owner || '' },
    { label: 'owner_state', value: (r) => taskOwnerStateText(r) },
    { label: 'parent', value: (r) => r.parent_id ? `#${r.parent_id}` : '' },
    { label: 'role', value: (r) => r.team_role || '' },
    { label: 'title', value: (r) => r.title }
  ]));
}

async function taskClaim(ctx, args) {
  const opts = parseOpts(args, { booleans: ['force'], arrays: ['id', 'ids'] });
  const identity = resolveCurrentPeer(ctx, opts, 'peer', 'shell');
  const peer = identity.id;
  const ids = parseTaskIds(opts);
  const db = connect(ctx);
  touchCurrentPeer(db, ctx, identity, 'working', 'shell');
  const tasks = claimTaskRowsForPeer(db, peer, ids, { force: Boolean(opts.force) });
  printResult(ctx, ids.length === 1 ? tasks[0] : tasks, (data) => taskRowsText(Array.isArray(data) ? data : [data], 'claimed'));
}

async function taskTakeover(ctx, args) {
  const opts = parseOpts(args);
  const identity = resolveCurrentPeer(ctx, opts, 'peer', 'shell');
  const peer = identity.id;
  const id = intOpt(opts, 'id', intOpt({ id: opts._[0] }, 'id'));
  if (!id) throw new CliError('BAD_ARGS', 'Missing --id');
  const reason = required(opts, 'reason');
  const policy = opts.policy || 'any';
  const staleAfter = positiveIntOpt(opts, 'stale-after', ACTIVE_PEER_TTL, { max: 86400 * 30 });
  const db = connect(ctx);
  touchCurrentPeer(db, ctx, identity, 'working', 'shell');
  const task = takeOverTaskForPeer(db, peer, id, { reason, policy, staleAfter });
  printResult(ctx, task, (data) => `took over task #${data.id}: ${data.title}`);
}

async function taskNext(ctx, args) {
  const opts = parseOpts(args, { booleans: ['force'] });
  const identity = resolveCurrentPeer(ctx, opts, 'peer', 'shell');
  const peer = identity.id;
  const count = positiveIntOpt(opts, 'count', 1, { max: 50 });
  const db = connect(ctx);
  touchCurrentPeer(db, ctx, identity, 'working', 'shell');
  const result = claimNextTasksForPeer(db, peer, { force: Boolean(opts.force), count });
  printResult(ctx, count === 1 ? (result.current || result.tasks[0] || null) : result, (data) => {
    if (!data) return 'no pending task';
    if (data.current === true) return `current task #${data.id}: ${data.title} (${data.status})`;
    if (data.current) return `current task #${data.current.id}: ${data.current.title} (${data.current.status})`;
    if (data.tasks) return data.tasks.length ? taskRowsText(data.tasks, 'claimed') : 'no pending task';
    return `claimed task #${data.id}: ${data.title}`;
  });
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

function splitCsvList(value) {
  if (Array.isArray(value)) return value.flatMap((item) => splitCsvList(item));
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function parseTeamItems(opts) {
  const rawItems = [
    ...splitCsvList(opts.item || []),
    ...splitCsvList(opts.items || [])
  ];
  return rawItems.map((raw, index) => {
    const parts = String(raw).split(':').map((part) => part.trim());
    let assignee = null;
    let role = null;
    let title = raw.trim();
    if (parts.length >= 3) {
      assignee = parts.shift() || null;
      role = parts.shift() || null;
      title = parts.join(':').trim();
    } else if (parts.length === 2) {
      role = parts[0] || null;
      title = parts[1] || title;
    }
    if (!title) title = `subtask ${index + 1}`;
    return { title, role: role || `worker-${index + 1}`, assignee };
  });
}

function inferTeamItems(task, opts) {
  const explicit = parseTeamItems(opts);
  if (explicit.length) return explicit;
  const count = Math.max(1, intOpt(opts, 'count', 3));
  const baseTitle = task?.title || 'team task';
  return Array.from({ length: count }, (_, index) => ({
    title: `${baseTitle} / subtask ${index + 1}`,
    role: `worker-${index + 1}`,
    assignee: null
  }));
}

function expandTeamWorkers(workers, parentId) {
  const expanded = [];
  for (const token of splitCsvList(workers || [])) {
    const match = token.match(/^([A-Za-z][A-Za-z0-9._-]*):([1-9][0-9]*)$/);
    if (!match) {
      expanded.push(token);
      continue;
    }
    const kind = sanitizePeerPart(match[1], 'peer');
    const count = Number.parseInt(match[2], 10);
    for (let i = 1; i <= count; i += 1) expanded.push(`${kind}-team-${parentId}-${i}`);
  }
  return expanded;
}

function assignTeamWorkers(items, workers, parentId) {
  const workerList = expandTeamWorkers(workers, parentId);
  if (!workerList.length) return items;
  return items.map((item, index) => ({
    ...item,
    assignee: item.assignee || workerList[index % workerList.length]
  }));
}

function teamChildren(db, parentId) {
  return db.prepare(`
    SELECT *
    FROM tasks
    WHERE parent_id = ?
    ORDER BY priority ASC, id ASC
  `).all(parentId);
}

function taskById(db, id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

function teamSummary(db, parentId) {
  const parent = taskById(db, parentId);
  if (!parent) throw new CliError('NOT_FOUND', `Task #${parentId} does not exist`);
  const children = teamChildren(db, parentId);
  const handoffs = db.prepare(`
    SELECT *
    FROM handoffs
    WHERE task_id = ? OR task_id IN (SELECT id FROM tasks WHERE parent_id = ?)
    ORDER BY id ASC
  `).all(parentId, parentId);
  const counts = {};
  for (const child of children) counts[child.status] = (counts[child.status] || 0) + 1;
  return { parent, children, handoffs, counts };
}

async function cmdTeam(ctx, args) {
  const sub = args[0];
  if (!sub || wantsHelp(args)) return helpTeam();
  if (sub === 'plan') return teamPlan(ctx, args.slice(1));
  if (sub === 'start') return teamStart(ctx, args.slice(1));
  if (sub === 'status') return teamStatus(ctx, args.slice(1));
  throw new CliError('BAD_ARGS', `Unknown team command: ${sub}`);
}

async function teamPlan(ctx, args) {
  const opts = parseOpts(args, { arrays: ['item'] });
  const parentId = intOpt(opts, 'from-task', intOpt(opts, 'task', intOpt({ task: opts._[0] }, 'task')));
  if (!parentId) throw new CliError('BAD_ARGS', 'Missing --from-task');
  const db = connect(ctx);
  const parent = taskById(db, parentId);
  if (!parent) throw new CliError('NOT_FOUND', `Task #${parentId} does not exist`);
  const items = assignTeamWorkers(inferTeamItems(parent, opts), opts.workers, parentId);
  const data = { parent, items };
  printResult(ctx, data, (plan) => {
    const lines = [`team plan for task #${plan.parent.id}: ${plan.parent.title}`];
    plan.items.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.role}: ${item.title}${item.assignee ? ` -> ${item.assignee}` : ''}`);
    });
    lines.push('', `start: ${CLI_NAME} team start --from-task ${plan.parent.id} ${plan.items.map((item) => `--item ${shellQuoteArg(`${item.assignee ? `${item.assignee}:` : ''}${item.role}:${item.title}`)}`).join(' ')}`.trim());
    return lines.join('\n');
  });
}

async function teamStart(ctx, args) {
  const opts = parseOpts(args, { arrays: ['item'], booleans: ['force'] });
  const identity = resolveCurrentPeer(ctx, opts, 'from', 'shell');
  const actor = identity.id;
  const parentId = intOpt(opts, 'from-task', intOpt(opts, 'task', intOpt({ task: opts._[0] }, 'task')));
  if (!parentId) throw new CliError('BAD_ARGS', 'Missing --from-task');
  const priorityBase = intOpt(opts, 'priority', 100);
  const db = connect(ctx);
  touchCurrentPeer(db, ctx, identity, null, 'shell');
  const result = tx(db, () => {
    const parent = taskById(db, parentId);
    if (!parent) throw new CliError('NOT_FOUND', `Task #${parentId} does not exist`);
    const existing = teamChildren(db, parentId);
    if (existing.length && !opts.force) {
      throw new CliError('TEAM_EXISTS', `Task #${parentId} already has ${existing.length} team subtask(s); use --force to add more`, {
        parent_id: parentId,
        children: existing.map((task) => task.id)
      });
    }
    const items = assignTeamWorkers(inferTeamItems(parent, opts), opts.workers, parentId);
    const t = now();
    const children = [];
    items.forEach((item, index) => {
      const info = db.prepare(`
        INSERT INTO tasks(title, body, status, assignee, owner, parent_id, team_role, priority, created_by, created_at, updated_at)
        VALUES (?, ?, 'pending', ?, NULL, ?, ?, ?, ?, ?, ?)
      `).run(
        item.title,
        opts.body || `Subtask for #${parentId}: ${parent.title}`,
        item.assignee || null,
        parentId,
        item.role || `worker-${index + 1}`,
        priorityBase + index,
        actor,
        t,
        t
      );
      const taskId = Number(info.lastInsertRowid);
      addEvent(db, 'task.created', actor, taskId, {
        title: item.title,
        assignee: item.assignee || null,
        priority: priorityBase + index,
        parent_id: parentId,
        team_role: item.role || null
      });
      if (item.assignee) sendMessage(db, actor, item.assignee, taskId, 'task', `Task #${taskId} assigned: ${item.title}`);
      children.push(taskById(db, taskId));
    });
    addEvent(db, 'team.started', actor, parentId, {
      child_tasks: children.map((task) => task.id),
      workers: expandTeamWorkers(opts.workers || [], parentId)
    });
    return { parent, children };
  });
  printResult(ctx, result, (data) => {
    const lines = [`started team for task #${data.parent.id}: ${data.children.length} subtask${data.children.length === 1 ? '' : 's'}`];
    for (const child of data.children) {
      lines.push(`- #${child.id} ${child.team_role || 'worker'}${child.assignee ? ` -> ${child.assignee}` : ''}: ${child.title}`);
    }
    return lines.join('\n');
  });
}

async function teamStatus(ctx, args) {
  const opts = parseOpts(args);
  const parentId = intOpt(opts, 'task', intOpt(opts, 'from-task', intOpt({ task: opts._[0] }, 'task')));
  if (!parentId) throw new CliError('BAD_ARGS', 'Missing --task');
  const db = connect(ctx);
  const data = teamSummary(db, parentId);
  printResult(ctx, data, (summary) => {
    const countText = Object.entries(summary.counts).map(([status, count]) => `${status}:${count}`).join(', ') || 'none';
    const lines = [
      `team task #${summary.parent.id}: ${summary.parent.title}`,
      `parent status: ${summary.parent.status}`,
      `subtasks: ${summary.children.length} (${countText})`
    ];
    for (const child of summary.children) {
      lines.push(`- #${child.id} ${child.status} ${child.team_role || 'worker'}${child.owner ? ` owner=${child.owner}` : ''}${child.assignee ? ` assignee=${child.assignee}` : ''}: ${child.title}`);
    }
    if (summary.handoffs.length) {
      lines.push('handoffs:');
      for (const handoff of summary.handoffs.slice(-8)) {
        lines.push(`- #${handoff.id} task #${handoff.task_id || ''} ${handoff.from_peer}${handoff.to_peer ? ` -> ${handoff.to_peer}` : ''}: ${handoff.summary}`);
      }
    }
    return lines.join('\n');
  });
}

async function cmdMsg(ctx, args) {
  const sub = args[0];
  if (!sub || wantsHelp(args)) return helpMsg();
  if (sub === 'send') return msgSend(ctx, args.slice(1));
  if (sub === 'inbox') return msgInbox(ctx, args.slice(1));
  if (sub === 'ack') return msgAck(ctx, args.slice(1));
  if (sub === 'reply') return msgReply(ctx, args.slice(1));
  if (sub === 'thread') return msgThread(ctx, args.slice(1));
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
  printResult(ctx, { id, sender, recipient, task_id: taskId, kind, body, reply_to: null, thread_id: id },
    (data) => `sent message #${data.id} ${data.sender} -> ${data.recipient}`);
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
    { label: 'reply', value: (r) => r.reply_to ? `#${r.reply_to}` : '' },
    { label: 'thread', value: (r) => r.thread_id ? `#${r.thread_id}` : '' },
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
  ackMessage(db, peer, message);
  printResult(ctx, { id, peer }, (data) => `acknowledged message #${data.id} for ${data.peer}`);
}

function ackMessage(db, peer, message) {
  db.prepare(`
    INSERT INTO message_reads(message_id, peer, read_at)
    VALUES (?, ?, ?)
    ON CONFLICT(message_id, peer) DO UPDATE SET read_at = excluded.read_at
  `).run(message.id, peer, now());
  addEvent(db, 'message.ack', peer, message.task_id || null, { message_id: message.id });
}

async function msgReply(ctx, args) {
  const opts = parseOpts(args);
  const id = intOpt(opts, 'id', intOpt({ id: opts._[0] }, 'id'));
  if (!id) throw new CliError('BAD_ARGS', 'Missing --id');
  const body = required(opts, 'body');
  const db = connect(ctx);
  const original = getMessage(db, id);
  if (!original) throw new CliError('NOT_FOUND', `Message #${id} does not exist`);
  const identity = resolveCurrentPeer(ctx, opts, 'from', 'shell');
  const sender = identity.id;
  touchCurrentPeer(db, ctx, identity, null, 'shell');
  const recipient = opts.to || original.sender;
  const taskId = intOpt(opts, 'task', original.task_id || null);
  const kind = opts.kind || 'reply';
  const threadId = original.thread_id || original.id;
  const replyId = sendMessage(db, sender, recipient, taskId, kind, body, {
    reply_to: original.id,
    thread_id: threadId
  });
  ackMessage(db, sender, original);
  printResult(ctx, {
    id: replyId,
    sender,
    recipient,
    task_id: taskId,
    kind,
    body,
    reply_to: original.id,
    thread_id: threadId
  }, (data) => `sent reply #${data.id} to #${data.reply_to} ${data.sender} -> ${data.recipient}`);
}

async function msgThread(ctx, args) {
  const opts = parseOpts(args);
  const id = intOpt(opts, 'id', intOpt({ id: opts._[0] }, 'id'));
  if (!id) throw new CliError('BAD_ARGS', 'Missing --id');
  const limit = intOpt(opts, 'limit', 50);
  const db = connect(ctx);
  const data = queryMessageThread(db, id, limit);
  printResult(ctx, data, (thread) => {
    const lines = [`thread #${thread.thread_id} (${thread.messages.length} message${thread.messages.length === 1 ? '' : 's'})`];
    for (const message of thread.messages) {
      const parts = [
        `#${message.id}`,
        `${message.sender} -> ${message.recipient || 'all'}`,
        message.task_id ? `task #${message.task_id}` : '',
        message.reply_to ? `reply #${message.reply_to}` : '',
        message.kind || 'note',
        iso(message.created_at)
      ].filter(Boolean).join(' ');
      lines.push(`${parts}\n  ${message.body}`);
    }
    return lines.join('\n');
  });
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
  if (!sub || wantsHelp(args)) return helpPeer();
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
    const rows = (data.sessions || []).map((session) => ({
      ...session,
      binding: bindings.get(session.peer_id || session.id) || bindings.get(session.id) || null
    }));
    printResult(ctx, rows, (items) => table(items, [
      { label: 'id', value: (r) => r.id },
      { label: 'peer', value: (r) => r.peer_id && r.peer_id !== r.id ? r.peer_id : '' },
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
      upsertCanonicalPeerBinding(db, binding, Boolean(opts.force), { override: Boolean(opts.force) });
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
  if (!sub || wantsHelp(args)) return helpLock();
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
  const requested = scopedLockResource(required(opts, 'resource'), opts.scope);
  const taskId = intOpt(opts, 'task', null);
  const ttl = intOpt(opts, 'ttl', DEFAULT_LOCK_TTL);
  const reason = opts.reason || '';
  const db = connect(ctx);
  touchCurrentPeer(db, ctx, identity, 'working', 'shell');
  const lock = tx(db, () => {
    const t = now();
    const activeLocks = db.prepare('SELECT * FROM locks WHERE expires_at > ?').all(t);
    const conflict = activeLocks.find((row) => locksConflict(row, requested) && row.owner !== peer);
    if (conflict) {
      throw new CliError('LOCK_HELD', `Resource ${lockLabel(requested)} conflicts with lock ${lockLabel(conflict)} held by ${conflict.owner}`, {
        resource: requested.base_resource,
        scope: requested.scope,
        lock_resource: conflict.resource,
        lock_scope: lockScope(conflict),
        owner: conflict.owner,
        expires_at: iso(conflict.expires_at)
      });
    }
    const existing = db.prepare('SELECT * FROM locks WHERE resource = ?').get(requested.resource);
    db.prepare(`
      INSERT INTO locks(resource, base_resource, scope, owner, task_id, reason, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(resource) DO UPDATE SET
        base_resource = excluded.base_resource,
        scope = excluded.scope,
        owner = excluded.owner,
        task_id = excluded.task_id,
        reason = excluded.reason,
        expires_at = excluded.expires_at
    `).run(requested.resource, requested.base_resource, requested.scope, peer, taskId, reason, t + ttl, existing ? existing.created_at : t);
    addEvent(db, 'lock.acquired', peer, taskId, { resource: requested.base_resource, lock_resource: requested.resource, scope: requested.scope, ttl, previous_owner: existing ? existing.owner : null });
    return db.prepare('SELECT * FROM locks WHERE resource = ?').get(requested.resource);
  });
  printResult(ctx, lock, (data) => `locked ${lockLabel(data)} by ${data.owner} until ${iso(data.expires_at)}`);
}

async function lockRelease(ctx, args) {
  const opts = parseOpts(args, { booleans: ['force'] });
  const identity = resolveCurrentPeer(ctx, opts, 'peer', 'shell');
  const peer = identity.id;
  const requested = scopedLockResource(required(opts, 'resource'), opts.scope);
  const db = connect(ctx);
  touchCurrentPeer(db, ctx, identity, null, 'shell');
  const result = tx(db, () => {
    const existing = db.prepare('SELECT * FROM locks WHERE resource = ?').get(requested.resource);
    if (!existing) return { released: false, ...requested };
    if (existing.owner !== peer && !opts.force) {
      throw new CliError('LOCK_OWNED', `Lock is owned by ${existing.owner}`, { owner: existing.owner });
    }
    db.prepare('DELETE FROM locks WHERE resource = ?').run(requested.resource);
    addEvent(db, 'lock.released', peer, existing.task_id || null, { resource: requested.base_resource, lock_resource: requested.resource, scope: requested.scope, force: Boolean(opts.force) });
    return { released: true, ...requested };
  });
  printResult(ctx, result, (data) => data.released ? `released ${lockLabel(data)}` : `no lock for ${lockLabel(data)}`);
}

async function lockRenew(ctx, args) {
  const opts = parseOpts(args);
  const identity = resolveCurrentPeer(ctx, opts, 'peer', 'shell');
  const peer = identity.id;
  const requested = scopedLockResource(required(opts, 'resource'), opts.scope);
  const ttl = intOpt(opts, 'ttl', DEFAULT_LOCK_TTL);
  const db = connect(ctx);
  touchCurrentPeer(db, ctx, identity, 'working', 'shell');
  const lock = tx(db, () => {
    const existing = db.prepare('SELECT * FROM locks WHERE resource = ?').get(requested.resource);
    if (!existing) throw new CliError('NOT_FOUND', `No lock for ${lockLabel(requested)}`);
    if (existing.owner !== peer) throw new CliError('LOCK_OWNED', `Lock is owned by ${existing.owner}`, { owner: existing.owner });
    db.prepare('UPDATE locks SET expires_at = ? WHERE resource = ?').run(now() + ttl, requested.resource);
    addEvent(db, 'lock.renewed', peer, existing.task_id || null, { resource: requested.base_resource, lock_resource: requested.resource, scope: requested.scope, ttl });
    return db.prepare('SELECT * FROM locks WHERE resource = ?').get(requested.resource);
  });
  printResult(ctx, lock, (data) => `renewed ${lockLabel(data)} until ${iso(data.expires_at)}`);
}

async function lockList(ctx, args) {
  const opts = parseOpts(args, { booleans: ['all'] });
  const db = connect(ctx);
  const rows = opts.all
    ? db.prepare('SELECT * FROM locks ORDER BY resource ASC').all()
    : db.prepare('SELECT * FROM locks WHERE expires_at > ? ORDER BY resource ASC').all(now());
  printResult(ctx, rows, (data) => table(data, [
    { label: 'resource', value: (r) => lockBaseResource(r) },
    { label: 'scope', value: (r) => lockScope(r) },
    { label: 'owner', value: (r) => r.owner },
    { label: 'task', value: (r) => r.task_id ? `#${r.task_id}` : '' },
    { label: 'expires', value: (r) => iso(r.expires_at) },
    { label: 'reason', value: (r) => r.reason || '' }
  ]));
}

async function cmdHandoff(ctx, args) {
  const sub = args[0];
  if (!sub || wantsHelp(args)) return helpHandoff();
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
  if (!sub || wantsHelp(args)) return helpEvent();
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
  const data = statusSummary(ctx, peer, identity);
  printResult(ctx, data, (s) => renderStatusSummary(s, peer));
}

function statusSummary(ctx, peer = null, identity = null) {
  const db = connect(ctx);
  try {
    if (identity) touchCurrentPeer(db, ctx, identity, null, 'shell');
    const t = now();
    const activePeers = db.prepare('SELECT COUNT(*) AS n FROM peers WHERE last_seen_at >= ?').get(t - ACTIVE_PEER_TTL).n;
    const stalePeers = db.prepare('SELECT COUNT(*) AS n FROM peers WHERE last_seen_at < ?').get(t - ACTIVE_PEER_TTL).n;
    const taskRows = db.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status ORDER BY status').all();
    const locks = db.prepare('SELECT COUNT(*) AS n FROM locks WHERE expires_at > ?').get(t).n;
    const unread = peer ? queryInbox(db, peer, false, 1000).length : null;
    const recent = db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 8').all().reverse();
    return { root: ctx.root, db: ctx.dbPath, active_peers: activePeers, stale_peers: stalePeers, tasks: taskRows, active_locks: locks, unread, recent_events: recent };
  } finally {
    db.close();
  }
}

function renderStatusSummary(s, peer = null) {
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
}

function normalizeStateResources(values) {
  const list = Array.isArray(values) ? values : [values];
  return uniqueList(list.flatMap((value) => String(value || '').split(',').map((part) => part.trim())));
}

async function cmdState(ctx, args) {
  if (wantsHelp(args)) return helpState();
  const opts = parseOpts(args, { arrays: ['resource'] });
  const identity = resolveCurrentPeer(ctx, opts, 'peer', 'shell');
  const peer = identity.id;
  const resources = normalizeStateResources(opts.resource || opts.resources || []);
  const snapshot = statusSnapshot(ctx, peer, { resources, intent: opts.intent || null, scope: opts.scope || null });
  printResult(ctx, snapshot, (data) => {
    const automation = data.automation;
    const lines = [
      `root: ${data.root}`,
      `peer: ${peer}`,
      automation.current_task ? `current task: #${automation.current_task.id} ${automation.current_task.status} ${automation.current_task.title}` : null,
      `phase: ${automation.phase}`,
      `next: ${automation.next_action.command || automation.next_action.kind}`,
      `why: ${automation.next_action.reason}`
    ].filter(Boolean);
    if (automation.finish_actions.length) {
      lines.push('', 'finish actions:');
      lines.push(...automation.finish_actions.map((action) => `- ${action.command}`));
    }
    if (automation.warnings.length) {
      lines.push('', 'warnings:');
      lines.push(...automation.warnings.map((warning) => `- ${warning}`));
    }
    if (data.timeline.length) {
      lines.push('', 'timeline:');
      for (const item of data.timeline.slice(-8)) {
        lines.push(`- ${iso(item.ts)} ${item.source}:${item.source_id} ${item.title}${item.text ? ` — ${item.text}` : ''}`);
      }
    }
    return lines.join('\n');
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
${cmd} state --peer ${peer}
${cmd} msg inbox --peer ${peer}
${cmd} task next --peer ${peer}

Coordination rules:
- Claim exactly one task before editing.
- If state shows a current task for ${peer}, continue that task before claiming another pending task.
- Before editing a file, directory, module, or shared test resource, run:
  ${cmd} lock acquire --peer ${peer} --resource <path-or-module> [--scope <scope>] --task <task-id>
- If a lock is held by another peer, message that peer instead of editing:
  ${cmd} msg send --from ${peer} --to <peer-id> --body "<question>"
- Report progress or requests through msg send.
- Before stopping, run tests, create a handoff, and release locks:
  ${cmd} handoff create --from ${peer} --task <task-id> --summary "<what changed>" --tests "<commands/results>" --risks "<known risks>"
  ${cmd} task done --peer ${peer} --id <task-id> --summary "<done summary>"
  ${cmd} lock release --peer ${peer} --resource <path-or-module> [--scope <scope>]
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
            upsertCanonicalPeerBinding(db2, bindingFromDetected(s, s.transport || 'detected'), true);
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
  const opts = parseOpts(args, { booleans: ['local', 'no-token', 'no-guidance', 'no-discover'] });
  validateOpts('web', opts, ['host', 'port', 'token', 'local', 'no-token', 'no-guidance', 'no-discover']);
  validateWebTokenOpts(opts);
  ensureTmuxAvailable({ autoInstall: true });
  const setup = await prepareLocalBus(ctx, { ...opts, installShims: true });
  registerProject(ctx);

  const existing = await readHealthyGlobalRuntime();
  if (existing) {
    if (webRuntimeMatchesRequest(existing, opts)) {
      rememberRuntimeToken(existing, opts);
      try {
        await runtimeRequest(ctx, 'POST', '/api/projects', { root: ctx.root, db: ctx.dbPath }, existing);
      } catch {}
      writeRuntime(ctx, { ...existing, root: ctx.root, db: ctx.dbPath, project_root: ctx.root, global_runtime: true });
      return printWebRuntime(ctx, existing, { already: true, logFile: webLogPath(ctx), setup });
    }
    try { await runtimeRequest(ctx, 'POST', '/api/runtime/stop', {}, existing); } catch {}
    await sleep(250);
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

function statusSnapshot(ctx, peer = null, opts = {}) {
  const db = connect(ctx);
  try {
    return collectStateSnapshot(db, ctx, peer, opts);
  } finally {
    try {
      db.close();
    } catch {
      // Ignore close failures for short-lived snapshots.
    }
  }
}

function webPeerRegister(projectCtx, peer, input = {}) {
  const db = connect(projectCtx);
  const row = {
    id: peer,
    kind: input.kind || 'other',
    role: input.role || 'peer',
    worktree: path.resolve(input.worktree || projectCtx.cwd),
    branch: input.branch || detectBranch(projectCtx.cwd),
    pid: intOpt(input, 'pid', process.ppid),
    status: input.status || 'idle',
    capabilities: Array.isArray(input.cap) ? input.cap.join(',') : (input.cap || input.capabilities || 'web')
  };
  try {
    upsertPeer(db, row);
    addEvent(db, 'peer.registered', peer, null, { ...row, source: 'web' });
  } finally {
    db.close();
  }
  return { peer: row, summary: `registered ${row.id} (${row.kind}${row.role ? `, ${row.role}` : ''})` };
}

function webPeerHeartbeat(projectCtx, peer, input = {}) {
  const ttl = intOpt(input, 'ttl', DEFAULT_LOCK_TTL);
  const status = input.status || null;
  const renewLocks = input['renew-locks'] !== false && input.renew_locks !== false;
  const db = connect(projectCtx);
  const t = now();
  let renewed = 0;
  try {
    touchPeer(db, peer, status);
    if (renewLocks) {
      renewed = db.prepare(`
        UPDATE locks SET expires_at = ?
        WHERE owner = ? AND expires_at > ?
      `).run(t + ttl, peer, t).changes;
    }
    addEvent(db, 'peer.heartbeat', peer, null, { status, renewed, source: 'web' });
  } finally {
    db.close();
  }
  return {
    peer,
    status,
    renewed,
    summary: `heartbeat ${peer}${renewed ? `, renewed locks: ${renewed}` : ''}`
  };
}

function claimNextTasksForPeer(db, peer, { force = false, count = 1 } = {}) {
  return tx(db, () => {
    if (!force) {
      const current = db.prepare(`
        SELECT * FROM tasks
        WHERE owner = ?
          AND status IN ('claimed', 'running', 'review', 'blocked')
        ORDER BY
          CASE status
            WHEN 'running' THEN 0
            WHEN 'claimed' THEN 1
            WHEN 'review' THEN 2
            WHEN 'blocked' THEN 3
            ELSE 4
          END,
          priority ASC,
          id ASC
        LIMIT 1
      `).get(peer);
      if (current) return { current: { ...current, current: true }, tasks: [] };
    }
    const rows = db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'pending'
        AND owner IS NULL
        AND (assignee IS NULL OR assignee = ?)
      ORDER BY CASE WHEN assignee = ? THEN 0 ELSE 1 END, priority ASC, id ASC
      LIMIT ?
    `).all(peer, peer, count);
    if (!rows.length) return { current: null, tasks: [] };
    const t = now();
    const claimed = [];
    for (const row of rows) {
      const changes = db.prepare(`
        UPDATE tasks
        SET owner = ?, status = 'claimed', claimed_at = ?, updated_at = ?
        WHERE id = ? AND owner IS NULL AND status = 'pending'
      `).run(peer, t, t, row.id).changes;
      if (!changes) continue;
      addEvent(db, 'task.claimed', peer, row.id, { next: true, count });
      claimed.push(db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id));
    }
    return { current: null, tasks: claimed };
  });
}

function webPeerTaskNext(projectCtx, peer, input = {}) {
  const db = connect(projectCtx);
  try {
    touchPeer(db, peer, 'working');
    const count = positiveIntOpt(input, 'count', 1, { max: 50 });
    const result = claimNextTasksForPeer(db, peer, { force: Boolean(input.force), count });
    const task = result.current || result.tasks[0] || null;
    if (!task) return { peer, task: null, tasks: [], summary: 'no pending task' };
    return {
      peer,
      task,
      tasks: result.tasks,
      current: Boolean(result.current),
      summary: result.current
        ? `current task #${task.id}: ${task.title} (${task.status})`
        : result.tasks.length === 1
          ? `claimed task #${task.id}: ${task.title}`
          : `claimed ${result.tasks.length} tasks`
    };
  } finally {
    db.close();
  }
}

function webPeerTaskTakeover(projectCtx, peer, input = {}) {
  const id = intOpt(input, 'id', intOpt({ id: input.task }, 'id'));
  if (!id) throw new CliError('BAD_REQUEST', 'task id required');
  const reason = required(input, 'reason');
  const policy = input.policy || 'any';
  const staleAfter = positiveIntOpt(input, 'stale-after', intOpt(input, 'stale_after', ACTIVE_PEER_TTL), { max: 86400 * 30 });
  const db = connect(projectCtx);
  try {
    touchPeer(db, peer, 'working');
    const task = takeOverTaskForPeer(db, peer, id, { reason, policy, staleAfter, source: 'web' });
    return { peer, task, summary: `took over task #${task.id}: ${task.title}` };
  } finally {
    db.close();
  }
}

function webPeerLockAcquire(projectCtx, peer, input = {}) {
  const requested = scopedLockResource(required(input, 'resource'), input.scope);
  const ttl = intOpt(input, 'ttl', DEFAULT_LOCK_TTL);
  const taskId = intOpt(input, 'task', intOpt(input, 'task_id', null));
  const reason = input.reason || '';
  const db = connect(projectCtx);
  try {
    touchPeer(db, peer, 'working');
    const lock = tx(db, () => {
      const t = now();
      const activeLocks = db.prepare('SELECT * FROM locks WHERE expires_at > ?').all(t);
      const conflict = activeLocks.find((row) => locksConflict(row, requested) && row.owner !== peer);
      if (conflict) {
        throw new CliError('LOCK_HELD', `Resource ${lockLabel(requested)} conflicts with lock ${lockLabel(conflict)} held by ${conflict.owner}`, {
          resource: requested.base_resource,
          scope: requested.scope,
          lock_resource: conflict.resource,
          lock_scope: lockScope(conflict),
          owner: conflict.owner,
          expires_at: iso(conflict.expires_at)
        });
      }
      const existing = db.prepare('SELECT * FROM locks WHERE resource = ?').get(requested.resource);
      db.prepare(`
        INSERT INTO locks(resource, base_resource, scope, owner, task_id, reason, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(resource) DO UPDATE SET
          base_resource = excluded.base_resource,
          scope = excluded.scope,
          owner = excluded.owner,
          task_id = excluded.task_id,
          reason = excluded.reason,
          expires_at = excluded.expires_at
      `).run(requested.resource, requested.base_resource, requested.scope, peer, taskId, reason, t + ttl, existing ? existing.created_at : t);
      addEvent(db, 'lock.acquired', peer, taskId, { resource: requested.base_resource, lock_resource: requested.resource, scope: requested.scope, ttl, previous_owner: existing ? existing.owner : null, source: 'web' });
      return db.prepare('SELECT * FROM locks WHERE resource = ?').get(requested.resource);
    });
    return { peer, lock, summary: `locked ${lockLabel(lock)} by ${lock.owner} until ${iso(lock.expires_at)}` };
  } finally {
    db.close();
  }
}

function webPeerLockRelease(projectCtx, peer, input = {}) {
  const requested = scopedLockResource(required(input, 'resource'), input.scope);
  const force = Boolean(input.force);
  const db = connect(projectCtx);
  try {
    touchPeer(db, peer, null);
    const result = tx(db, () => {
      const existing = db.prepare('SELECT * FROM locks WHERE resource = ?').get(requested.resource);
      if (!existing) return { released: false, ...requested };
      if (existing.owner !== peer && !force) {
        throw new CliError('LOCK_OWNED', `Lock is owned by ${existing.owner}`, { owner: existing.owner });
      }
      db.prepare('DELETE FROM locks WHERE resource = ?').run(requested.resource);
      addEvent(db, 'lock.released', peer, existing.task_id || null, { resource: requested.base_resource, lock_resource: requested.resource, scope: requested.scope, force, source: 'web' });
      return { released: true, ...requested };
    });
    return { peer, result, summary: result.released ? `released ${lockLabel(result)}` : `no lock for ${lockLabel(result)}` };
  } finally {
    db.close();
  }
}

function webPeerInbox(projectCtx, peer, input = {}) {
  const db = connect(projectCtx);
  try {
    const messages = queryInbox(db, peer, Boolean(input.all), intOpt(input, 'limit', 20));
    return {
      peer,
      messages,
      summary: messages.length ? `${messages.length} message${messages.length === 1 ? '' : 's'}` : 'no messages'
    };
  } finally {
    db.close();
  }
}

function webPeerAction(projectCtx, peer, action, input = {}) {
  const normalized = String(action || '').replace(/_/g, '-');
  if (!peer) throw new CliError('BAD_REQUEST', 'peer required');
  if (normalized === 'status') {
    const status = statusSummary(projectCtx, peer);
    return { ok: true, action: normalized, peer, summary: `active=${status.active_peers}, stale=${status.stale_peers}, locks=${status.active_locks}, unread=${status.unread ?? 0}`, data: status };
  }
  if (normalized === 'state') {
    const data = statusSnapshot(projectCtx, peer, {
      resources: normalizeStateResources(input.resource || input.resources || []),
      intent: input.intent || null,
      scope: input.scope || null
    });
    return { ok: true, action: normalized, peer, summary: data.automation?.next_action?.reason || 'state loaded', data };
  }
  if (normalized === 'inbox') {
    const data = webPeerInbox(projectCtx, peer, input);
    return { ok: true, action: normalized, peer, summary: data.summary, data };
  }
  if (normalized === 'task-next') {
    const data = webPeerTaskNext(projectCtx, peer, input);
    return { ok: true, action: normalized, peer, summary: data.summary, data };
  }
  if (normalized === 'task-takeover') {
    const data = webPeerTaskTakeover(projectCtx, peer, input);
    return { ok: true, action: normalized, peer, summary: data.summary, data };
  }
  if (normalized === 'lock-acquire') {
    const data = webPeerLockAcquire(projectCtx, peer, input);
    return { ok: true, action: normalized, peer, summary: data.summary, data };
  }
  if (normalized === 'lock-release') {
    const data = webPeerLockRelease(projectCtx, peer, input);
    return { ok: true, action: normalized, peer, summary: data.summary, data };
  }
  if (normalized === 'heartbeat') {
    const data = webPeerHeartbeat(projectCtx, peer, input);
    return { ok: true, action: normalized, peer, summary: data.summary, data };
  }
  if (normalized === 'register') {
    const data = webPeerRegister(projectCtx, peer, input);
    return { ok: true, action: normalized, peer, summary: data.summary, data };
  }
  throw new CliError('BAD_REQUEST', `Unknown peer action: ${action}`);
}

async function cmdWeb(ctx, args, startMeta = {}) {
  if (args[0] === '--help' || args[0] === '-h') return helpWeb();
  if (process.env[WEB_CHILD_ENV] !== '1') return startWebBackground(ctx, args);
  const opts = parseOpts(args, { booleans: ['local', 'no-token', 'no-guidance', 'no-discover'] });
  validateOpts('web', opts, ['host', 'port', 'token', 'local', 'no-token', 'no-guidance', 'no-discover']);
  validateWebTokenOpts(opts);
  const host = expectedWebHost(opts);
  const port = intOpt(opts, 'port', 8787);
  const token = makeWebToken(opts);
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

  function getSession(projectCtx, id, db = null) {
    const direct = sessions.get(sessionKey(projectCtx, id));
    if (direct) return direct;
    for (const session of sessionsForProject(projectCtx)) {
      if (session.peerId === id) return session;
    }
    if (db) {
      for (const session of sessionsForProject(projectCtx)) {
        if (resolveSessionPeerId(db, session) === id) return session;
      }
    }
    return null;
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
      peerId: id,
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
  function resolveSessionPeerId(db, session) {
    if (!session) return null;
    if (!db) return session.peerId || session.id || null;

    if (session.type === 'tmux' && session.pane) {
      const byTarget = db.prepare(`
        SELECT peer
        FROM peer_bindings
        WHERE runtime_target = ?
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
      `).get(session.pane);
      if (byTarget?.peer) {
        session.peerId = byTarget.peer;
        return byTarget.peer;
      }
    }

    if (session.id) {
      const byRuntime = db.prepare(`
        SELECT peer
        FROM peer_bindings
        WHERE runtime_session_id = ?
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
      `).get(session.id);
      if (byRuntime?.peer) {
        session.peerId = byRuntime.peer;
        return byRuntime.peer;
      }

      const byPeer = db.prepare(`
        SELECT peer
        FROM peer_bindings
        WHERE peer = ?
        LIMIT 1
      `).get(session.id);
      if (byPeer?.peer) {
        session.peerId = byPeer.peer;
        return byPeer.peer;
      }
    }

    session.peerId = session.peerId || session.id || null;
    return session.peerId;
  }

  function serializeSession(session, db = null) {
    const peerId = resolveSessionPeerId(db, session);
    return {
      id: session.id,
      peer_id: peerId,
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
      const t = now();
      const peerId = resolveSessionPeerId(db, session) || session.id;
      db.prepare('UPDATE peers SET status = ?, last_seen_at = ? WHERE id IN (?, ?)').run(status, t, session.id, peerId);
      db.prepare(`
        UPDATE peer_bindings
        SET runtime_target = NULL, updated_at = ?
        WHERE peer IN (?, ?)
           OR runtime_session_id = ?
           OR (? IS NOT NULL AND runtime_target = ?)
      `).run(t, session.id, peerId, session.id, session.pane || null, session.pane || null);
      addEvent(db, status === 'exited' ? 'tmux.session.exited' : 'tmux.session.detached', peerId, null, {
        runtime_session_id: session.id,
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

  function tmuxSnapshot(session) {
    const captured = tmuxCapturePane(session.pane);
    return captured + cursorEscape(tmuxCursorPayload(captured, tmuxCursorInfo(session.pane)));
  }

  function refreshTmuxSnapshot(session) {
    if (session.type !== 'tmux' || !session.pane) return session.buffer || '';
    try {
      session.buffer = tmuxSnapshot(session);
    } catch {
      // Keep the previous buffer if the pane disappears during capture.
    }
    return session.buffer || '';
  }

  function scheduleTmuxReplace(session) {
    if (session.type !== 'tmux' || !session.pane) return;
    if (session.replaceTimer) clearTimeout(session.replaceTimer);
    session.replaceTimer = setTimeout(() => {
      session.replaceTimer = null;
      session.lastBroadcastTime = Date.now();
      broadcast(session, { type: 'replace', data: refreshTmuxSnapshot(session) });
    }, 80);
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
    // Restored panes may still have pipe-pane writers from a previous runtime.
    // Disable first so tmux tears down the stale writer before this runtime
    // installs its own FIFO reader.
    try { runTmux(['pipe-pane', '-t', session.pane]); } catch {}
    // Capture the existing screen once for the initial paint; pipe-pane only
    // forwards output produced after it is enabled.
    try {
      session.buffer = tmuxSnapshot(session);
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
        session.lastBroadcastTime = Date.now();
        broadcast(session, { type: 'data', data });
      } catch {
        if (session.streamFd !== null && session.streamFd !== undefined) {
          try { fs.closeSync(session.streamFd); } catch {}
          session.streamFd = null;
        }
      }
    }, 40);

    // Fallback replace poller: if the FIFO produces no data for N seconds
    // (e.g. pipe-pane output is fully buffered), send a fresh capture-pane
    // snapshot so the browser stays current. This also recovers from any
    // silent FIFO-read failures on restored panes.
    session.lastBroadcastTime = Date.now();
    session.replacePoller = setInterval(() => {
      if (session.status !== 'running') return;
      if (Date.now() - (session.lastBroadcastTime || 0) > 4000) {
        session.lastBroadcastTime = Date.now();
        broadcast(session, { type: 'replace', data: refreshTmuxSnapshot(session) });
      }
    }, 1600);
  }

  function stopTmuxStream(session) {
    if (session.streamPoller) { clearInterval(session.streamPoller); session.streamPoller = null; }
    if (session.replacePoller) { clearInterval(session.replacePoller); session.replacePoller = null; }
    if (session.replaceTimer) { clearTimeout(session.replaceTimer); session.replaceTimer = null; }
    if (session.inputRefreshTimer) { clearTimeout(session.inputRefreshTimer); session.inputRefreshTimer = null; }
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
      peerId: id,
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
      replacePoller: null,
      lastBroadcastTime: 0,
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
      const canonical = upsertCanonicalPeerBinding(db, {
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
      session.peerId = canonical.peer;
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
      scheduleTmuxInputRefresh(session);
    } else {
      session.pty.write(data);
    }
  }

  function scheduleTmuxInputRefresh(session) {
    if (session.type !== 'tmux' || !session.pane) return;
    if (session.inputRefreshTimer) return;
    session.inputRefreshTimer = setTimeout(() => {
      session.inputRefreshTimer = null;
      if (session.status === 'running') broadcast(session, { type: 'replace', data: refreshTmuxSnapshot(session) });
    }, 80);
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
      peerId: id,
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
      const canonical = upsertCanonicalPeerBinding(db, {
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
      session.peerId = canonical.peer;
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

  function webSessionBuildOptions(input) {
    const mode = input.mode || 'new';
    if (mode === 'new') return {};
    if (mode === 'resume') {
      const resume = String(input.resume || '').trim();
      if (!resume) throw new CliError('BAD_REQUEST', 'resume session required');
      return { resume };
    }
    if (mode === 'last') return { last: true };
    if (mode === 'continue') return { continue: true };
    throw new CliError('BAD_REQUEST', `Unsupported session mode: ${mode}`);
  }

  function webSessionPeerId(projectCtx, kind, opts, input) {
    if (input.id) return input.id;
    if (opts.resume) return providerSessionPeerId(kind, opts.resume);
    return nextProjectSessionId(projectCtx, kind);
  }

  function normalizeWebSessionInput(input) {
    const pctx = input.projectCtx || ctx;
    const kind = input.kind || 'shell';
    if (!['claude', 'codex', 'shell'].includes(kind)) {
      throw new CliError('BAD_REQUEST', `Unsupported session kind: ${kind}`);
    }
    if (input.command || input.binding) return { ...input, kind, projectCtx: pctx };

    const opts = webSessionBuildOptions(input);
    if (kind === 'shell' && hasResumeOpts(opts)) {
      throw new CliError('BAD_REQUEST', 'Resume modes are only supported for codex and claude sessions');
    }
    if (kind !== 'claude' && opts.continue) {
      throw new CliError('BAD_REQUEST', 'continue is only supported for claude sessions');
    }
    if (kind !== 'codex' && opts.last) {
      throw new CliError('BAD_REQUEST', 'last is only supported for codex sessions');
    }

    const id = webSessionPeerId(pctx, kind, opts, input);
    const built = buildPeerCommand(id, kind, opts, []);
    return {
      ...input,
      id,
      kind,
      command: built.command,
      binding: built.binding,
      projectCtx: pctx
    };
  }

  function startSession(input) {
    const normalized = normalizeWebSessionInput(input);
    if (normalized.backend === 'pty') return startPtySession(normalized);
    return startTmuxManagedSession(normalized);
  }

  for (const projectCtx of projectContexts.values()) {
    restoreTmuxManagedSessions(projectCtx);
  }

  const server = http.createServer(async (req, res) => {
    const url = requestUrl(req);
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
        const resources = normalizeStateResources([
          ...url.searchParams.getAll('resource'),
          url.searchParams.get('resources') || ''
        ]);
        sendJson(res, 200, statusSnapshot(reqCtx, url.searchParams.get('peer'), {
          resources,
          intent: url.searchParams.get('intent') || null,
          scope: url.searchParams.get('scope') || null
        }));
        return;
      }
      const peerActionMatch = url.pathname.match(/^\/api\/peers\/([^/]+)\/actions\/([^/]+)$/);
      if (peerActionMatch) {
        const peer = decodeURIComponent(peerActionMatch[1]);
        const action = decodeURIComponent(peerActionMatch[2]);
        const readOnly = ['status', 'state', 'inbox'].includes(action);
        if (readOnly && req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET for read-only peer actions' } });
          return;
        }
        if (!readOnly && req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST for mutating peer actions' } });
          return;
        }
        const input = readOnly
          ? {
              ...Object.fromEntries(url.searchParams.entries()),
              resource: url.searchParams.getAll('resource')
            }
          : await readJsonRequest(req);
        sendJson(res, 200, webPeerAction(reqCtx, peer, action, input));
        return;
      }
      // Detected sessions: peers registered via hooks/watcher but without PTY
      if (req.method === 'GET' && url.pathname === '/api/detected') {
        const db = connect(reqCtx);
        let detected = [];
        const managedIds = new Set();
        const t = now();
        try {
          detected = db.prepare(`
            SELECT id, kind, role, status, worktree, branch, pid, capabilities,
                   created_at, last_seen_at, (? - last_seen_at) AS age_sec
            FROM peers
            ORDER BY last_seen_at DESC, id ASC
            LIMIT 100
          `).all(t);
          for (const session of sessionsForProject(reqCtx)) {
            managedIds.add(session.id);
            const peerId = resolveSessionPeerId(db, session);
            if (peerId) managedIds.add(peerId);
          }
        } finally {
          db.close();
        }
        // Exclude peers that are already in the managed sessions Map
        sendJson(res, 200, {
          now: t,
          active_peer_ttl: ACTIVE_PEER_TTL,
          detected: detected.filter(p => !managedIds.has(p.id))
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/resumable') {
        // Provider sessions hcc has seen (via hooks/detection) that carry a real
        // provider session id or resumable provider session name.
        const db = connect(reqCtx);
        let rows = [];
        try {
          rows = db.prepare(`
            SELECT b.provider, b.provider_session_id, b.provider_session_name, b.peer,
                   p.last_seen_at
            FROM peer_bindings b
            LEFT JOIN peers p ON p.id = b.peer
            WHERE (b.provider_session_id IS NOT NULL AND b.provider_session_id != '')
               OR (b.provider_session_name IS NOT NULL AND b.provider_session_name != '')
            ORDER BY p.last_seen_at DESC, b.updated_at DESC
          `).all();
        } finally {
          db.close();
        }
        const seen = new Set();
        const resumable = [];
        for (const r of rows) {
          const resumeValue = r.provider_session_id || r.provider_session_name || '';
          if (!resumeValue) continue;
          const key = `${r.provider}:${resumeValue}`;
          if (seen.has(key)) continue;
          seen.add(key);
          resumable.push({
            provider: r.provider,
            session_id: r.provider_session_id,
            session_name: r.provider_session_name || null,
            resume: resumeValue,
            name: r.provider_session_name || null,
            peer: r.peer
          });
        }
        sendJson(res, 200, { resumable });
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
        const db = connect(reqCtx);
        try {
          sendJson(res, 200, {
            sessions: sessionsForProject(reqCtx).map((session) => serializeSession(session, db))
          });
        } finally {
          db.close();
        }
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
        const lookupDb = connect(reqCtx);
        let session;
        try {
          session = getSession(reqCtx, id, lookupDb);
        } finally {
          lookupDb.close();
        }
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
        const lookupDb = connect(reqCtx);
        let session;
        try {
          session = getSession(reqCtx, id, lookupDb);
        } finally {
          lookupDb.close();
        }
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
            let input = {};
            try { input = await readJsonRequest(req); } catch {}
            detachTmuxSession(session, 'detached');
            if (input.kill_tmux) {
              try {
                const sessName = runTmux(['display-message', '-p', '-t', session.pane, '#{session_name}']).trim();
                if (sessName) tmuxKillSession(sessName);
              } catch {
                // Pane or session already gone; no fallback needed.
              }
            }
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
      const detectedStopMatch = url.pathname.match(/^\/api\/detected\/([^/]+)\/stop$/);
      if (req.method === 'POST' && detectedStopMatch) {
        const peerId = decodeURIComponent(detectedStopMatch[1]);
        let input = {};
        try { input = await readJsonRequest(req); } catch {}
        const db = connect(reqCtx);
        try {
          const now_ = now();
          db.prepare('UPDATE peers SET status = ?, last_seen_at = ? WHERE id = ?').run('exited', now_, peerId);
          const binding = db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get(peerId);
          if (binding && input.kill_tmux && binding.runtime_target) {
            try {
              const sessName = runTmux(['display-message', '-p', '-t', binding.runtime_target, '#{session_name}']).trim();
              if (sessName) tmuxKillSession(sessName);
            } catch {
              // Session already gone.
            }
          }
          db.prepare('UPDATE peer_bindings SET runtime_target = NULL, updated_at = ? WHERE peer = ?').run(now_, peerId);
          addEvent(db, 'peer.stopped', 'web', null, { peer: peerId });
        } finally {
          db.close();
        }
        sendJson(res, 200, { ok: true, peer: peerId, status: 'exited' });
        return;
      }
      const detectedRestartMatch = url.pathname.match(/^\/api\/detected\/([^/]+)\/restart$/);
      if (req.method === 'POST' && detectedRestartMatch) {
        const peerId = decodeURIComponent(detectedRestartMatch[1]);
        const db = connect(reqCtx);
        try {
          const now_ = now();
          db.prepare('UPDATE peers SET status = ?, last_seen_at = ? WHERE id = ?').run('running', now_, peerId);
          addEvent(db, 'peer.restarted', 'web', null, { peer: peerId });
        } finally {
          db.close();
        }
        sendJson(res, 200, { ok: true, peer: peerId, status: 'running' });
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
    const url = requestUrl(req);
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
    const lookupDb = connect(reqCtx);
    let session;
    try {
      session = getSession(reqCtx, id, lookupDb);
    } finally {
      lookupDb.close();
    }
    if (!session) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      session.clients.add(ws);
      ws.send(JSON.stringify({ type: 'snapshot', data: refreshTmuxSnapshot(session) }));
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
            scheduleTmuxReplace(session);
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
  console.log(`${PRODUCT_NAME} web listening on ${host}:${actualPort}`);
  console.log(`project: ${ctx.root}`);
  console.log(`database: ${ctx.dbPath}`);
  console.log(`open: ${publicRuntimeUrl(runtime, ctx.root)}`);
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
    upsertCanonicalPeerBinding(db, binding, Boolean(opts.force));
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
    upsertCanonicalPeerBinding(db, binding, force);
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
  update                       Update the global npm install of hello-cc
  uninstall                    Remove hooks, shims, and optional project data
  init                         Initialize .hello-cc/mesh.db and guidance
  register --peer ID           Register or update a peer session identity
  join --peer ID               Register this shell and print eval-able env
  env --peer ID                Print eval-able HCC_PEER/HCC_ROOT/HCC_DB exports
  heartbeat [--peer ID]        Mark the current peer alive, optionally renew locks
  peers                        List known peers
  status [--peer ID]           Show project coordination state
  state [--peer ID]            Show timeline and next coordination action
  scan [--register]            Detect existing Claude/Codex sessions
  prompt --peer ID             Print copy/paste session instructions
  run --peer ID -- COMMAND     Register a peer and run a command in this terminal
  peer <subcommand>            Start, attach, list, and stop tmux-backed peers
  inject PEER TEXT             Write text into an attached terminal
  ask PEER MESSAGE             Send a direct work request to one peer
  broadcast MESSAGE            Send a work request to all peers
  task <subcommand>            Create, list, claim, update, finish tasks
  team <subcommand>            Plan, start, and inspect explicit task teams
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
  HCC_WEB_TOKEN          Replace and save the stable web access token
`);
}

function helpTask() {
  console.log(`${CLI_NAME} task

Usage:
  ${CLI_NAME} task create --title TEXT [--body TEXT] [--from ID] [--to ID] [--priority N]
  ${CLI_NAME} task create --title TEXT --parent N [--team-role ROLE]
  ${CLI_NAME} task list [--status pending|claimed|running|review|blocked|done|abandoned] [--peer ID] [--all]
  ${CLI_NAME} task claim [--peer ID] --id N[,N] [--id N] [--ids N,N] [--force]
  ${CLI_NAME} task takeover [--peer ID] --id N --reason TEXT [--policy any|blocked|stale|blocked-or-stale] [--stale-after SECONDS]
  ${CLI_NAME} task next [--peer ID] [--force] [--count N]
  ${CLI_NAME} task update [--peer ID] --id N --status STATUS [--summary TEXT] [--body TEXT] [--to ID]
  ${CLI_NAME} task done [--peer ID] --id N --summary TEXT

Default task list shows all project tasks that are not done or abandoned.
--peer is an explicit filter; HCC_PEER does not hide other open tasks.
Messages use per-peer unread ack state; tasks do not.
task next returns your existing claimed/running/review/blocked task before
claiming another pending task. Use --force when intentionally taking additional
pending tasks; combine it with --count N for explicit batch claims.
Use task takeover when explicitly taking over a non-complete task from another
owner; it records the previous owner, requires a reason, and notifies them.
Use --policy blocked, stale, or blocked-or-stale to require an auditable
precondition before takeover. The default policy is any for backward
compatibility.

If --peer/--from and HCC_PEER are absent, hcc auto-joins the current terminal
as a stable project-local peer.
`);
}

function helpTeam() {
  console.log(`${CLI_NAME} team

Usage:
  ${CLI_NAME} team plan --from-task N [--item ROLE:TITLE] [--item PEER:ROLE:TITLE] [--workers A,B|codex:2,claude:1]
  ${CLI_NAME} team start --from-task N [--item ROLE:TITLE] [--item PEER:ROLE:TITLE] [--workers A,B|codex:2,claude:1] [--force]
  ${CLI_NAME} team status --task N

team plan is read-only. team start creates explicit child tasks under the parent
task and optionally assigns them to workers. It does not silently spawn model
processes or override the current-task rule.
workers may be explicit peer ids or kind counts such as codex:2,claude:1.
`);
}

function helpState() {
  console.log(`${CLI_NAME} state

Usage:
  ${CLI_NAME} state [--peer ID] [--resource PATH] [--scope SCOPE] [--intent read|review|work|write|stop|finish]

Shows the current collaboration timeline plus a machine-readable coordination
state machine. With --json, the response includes automation.next_action.argv so
agents can execute the suggested hcc command explicitly and leave an audit trail.
automation.current_task shows the peer's active claimed/running/review/blocked
task when one exists.
If a current task looks splittable, automation may suggest hcc team plan; this
is read-only until hcc team start is run explicitly.
With --intent read or --intent review, state treats resources as snapshot
inspection and does not suggest acquiring file locks. With write/work intents,
--scope lets agents coordinate independent regions of the same resource.

State does not execute coordination actions: it does not ack messages, claim
tasks, acquire locks, send messages, create handoffs, or mark tasks done. Opening
state may still perform normal SQLite schema maintenance for known project DBs.
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
  ${CLI_NAME} msg reply [--from ID] --id N --body TEXT [--to ID] [--kind reply]
  ${CLI_NAME} msg thread --id N [--limit N]

If --peer/--from and HCC_PEER are absent, hcc auto-joins the current terminal.
Use msg reply when answering a message so the response stays in the same thread.
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
  ${CLI_NAME} lock acquire [--peer ID] --resource PATH [--scope SCOPE] [--task N] [--ttl SEC] [--reason TEXT]
  ${CLI_NAME} lock renew [--peer ID] --resource PATH [--scope SCOPE] [--ttl SEC]
  ${CLI_NAME} lock release [--peer ID] --resource PATH [--scope SCOPE] [--force]
  ${CLI_NAME} lock list [--all]

Omit --scope to lock the whole resource. Different scopes on the same resource
can be held concurrently, but a whole-resource lock conflicts with every scope.
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

function helpUpdate() {
  console.log(`${CLI_NAME} update

Usage:
  ${CLI_NAME} update [--tag TAG] [--registry URL] [--dry-run]

Examples:
  ${CLI_NAME} update
  ${CLI_NAME} update --tag latest
  ${CLI_NAME} update --dry-run

Updates the global npm install by running:
  npm install -g ${NPM_PACKAGE_NAME}@TAG

The default TAG is latest.
`);
}

function helpWeb() {
  console.log(`${CLI_NAME} web

Usage:
  ${CLI_NAME} web [--host HOST] [--port N] [--token TEXT] [--local] [--no-token] [--no-discover] [--no-guidance]

Examples:
  ${CLI_NAME} web
  HCC_WEB_TOKEN='long-token' ${CLI_NAME} web --port 8787
  ${CLI_NAME} web --local

This is the default one-command entrypoint. It prepares local coordination,
installs Claude/Codex hooks and shims, ensures tmux is available, starts the
browser terminal console as a background runtime, prints the URL, PID, runtime
file, and log file, then returns the terminal to you.

By default, the web runtime listens on 0.0.0.0 and uses a saved token,
generating one on first use. Use HCC_WEB_TOKEN or --token to replace the saved
token, --local to bind only to 127.0.0.1, or --no-token only for a trusted
local/test environment.

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
      peerId = providerSessionPeerId(kind, resumeId);
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
    const hookBinding = {
      peer: peerId,
      provider: kind,
      ...providerSessionParts(resumeId || sessionId),
      resume_mode: resumeId ? 'resume' : (sessionId ? 'detected' : 'unknown'),
      resume_arg: resumeId || null,
      command: null,
      transport: 'hook',
      runtime_session_id: peerId
    };
    const canonical = upsertCanonicalPeerBinding(db, hookBinding, true);
    if (canonical.peer !== peerId) {
      const previousPeer = peerId;
      peerId = canonical.peer;
      db.prepare(`
        UPDATE peers
        SET last_seen_at = ?, status = COALESCE(?, status)
        WHERE id = ?
      `).run(now(), status, peerId);
      addEvent(db, 'provider.session.merged', peerId, null, {
        from_peer: previousPeer,
        provider: kind,
        session_id: sessionId || resumeId || null
      });
    }
    addEvent(db, `hook.${hookKey}`, peerId, null, { session_id: sessionId, cwd: hookCwd });

    if (['sessionstart', 'userpromptsubmit'].includes(hookKey)) {
      const snapshot = buildHookCoordinationContext(db, hookCtx, peerId);
      ackMessages(db, peerId, snapshot.messages);
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName,
          additionalContext: snapshot.text
        }
      }) + '\n');
    } else if (['posttooluse', 'stop'].includes(hookKey)) {
      const snapshot = buildHookCoordinationContext(db, hookCtx, peerId);
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

// ─── hcc update ──────────────────────────────────────────────────────────────

async function cmdUpdate(ctx, args) {
  if (args[0] === '--help' || args[0] === '-h') return helpUpdate();

  const opts = parseOpts(args, { booleans: ['dry-run'] });
  validateOpts('update', opts, ['tag', 'registry', 'dry-run']);
  const tag = opts.tag || 'latest';
  if (!/^[A-Za-z0-9._+-]+$/.test(tag)) {
    throw new CliError('BAD_ARGS', '--tag must be an npm dist-tag or version');
  }

  const packageSpec = `${NPM_PACKAGE_NAME}@${tag}`;
  const npmArgs = ['install', '-g', packageSpec];
  if (opts.registry) npmArgs.push('--registry', opts.registry);
  const command = shellCommand(['npm', ...npmArgs]);
  const data = { package: NPM_PACKAGE_NAME, tag, registry: opts.registry || null, command, dry_run: Boolean(opts['dry-run']) };

  if (opts['dry-run']) {
    printResult(ctx, data, () => `would run: ${command}`);
    return;
  }

  const result = spawnSync('npm', npmArgs, {
    encoding: ctx.json ? 'utf8' : undefined,
    stdio: ctx.json ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  });
  if (result.error) {
    throw new CliError('UPDATE_FAILED', `npm update command failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const output = ctx.json
      ? [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
      : '';
    throw new CliError('UPDATE_FAILED', output || `npm exited with status ${result.status}`);
  }

  printResult(ctx, data, () => `updated ${packageSpec}`);
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
        upsertCanonicalPeerBinding(db, bindingFromDetected(s, s.transport || 'detected'), true);
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
  if (command === 'update') return cmdUpdate(ctx, args);
  if (command === 'uninstall') return cmdUninstall(ctx, args);
  if (command === 'init') return cmdInit(ctx, args);
  if (command === 'register') return cmdRegister(ctx, args);
  if (command === 'join') return cmdJoin(ctx, args);
  if (command === 'env') return cmdEnv(ctx, args);
  if (command === 'heartbeat') return cmdHeartbeat(ctx, args);
  if (command === 'peers') return cmdPeers(ctx, args);
  if (command === 'status') return cmdStatus(ctx, args);
  if (command === 'state') return cmdState(ctx, args);
  if (command === 'prompt') return cmdPrompt(ctx, args);
  if (command === 'run') return cmdRun(ctx, args);
  if (command === 'peer') return cmdPeer(ctx, args);
  if (command === 'inject') return cmdInject(ctx, args);
  if (command === 'ask') return cmdAsk(ctx, args);
  if (command === 'broadcast') return cmdBroadcast(ctx, args);
  if (command === 'task') return cmdTask(ctx, args);
  if (command === 'team') return cmdTeam(ctx, args);
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
