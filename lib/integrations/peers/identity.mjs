import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import {
  autoPeerBasis as coreAutoPeerBasis,
  autoPeerId as coreAutoPeerId,
  autoPeerKind as coreAutoPeerKind,
  autoPeerProviderSession as coreAutoPeerProviderSession,
  autoPeerResumeId as coreAutoPeerResumeId,
  autoPeerSessionId as coreAutoPeerSessionId,
  currentPeer as coreCurrentPeer,
  resolveCurrentPeer as coreResolveCurrentPeer,
  sanitizePeerPart,
  shortHash
} from '../../core/peers/identity.mjs';

export { sanitizePeerPart, shortHash } from '../../core/peers/identity.mjs';

export function currentTtyName() {
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

export function findLinuxAncestorCliInfo(startPid, options = {}) {
  const read = typeof options.read === 'function'
    ? options.read
    : (pid) => ({
        args: readProcCmdline(pid),
        env: readProcEnv(pid),
        parent: readProcParentPid(pid)
      });
  let pid = Number(startPid);
  const seen = new Set();
  for (let depth = 0; Number.isInteger(pid) && pid > 1 && depth < 12 && !seen.has(pid); depth += 1) {
    seen.add(pid);
    const row = read(pid);
    if (!row) return null;
    const args = Array.isArray(row.args) ? row.args : [];
    const env = row.env && typeof row.env === 'object' && !Array.isArray(row.env) ? row.env : {};
    const kind = detectCliKindFromProcess(args, env);
    if (kind) return { pid, kind, args, env };
    pid = Number(row.parent);
  }
  return null;
}

export function parseMacAncestorLine(text) {
  const line = String(text ?? '').trimEnd();
  if (!line || line.includes('\n') || line.includes('\r')) return null;
  const match = line.match(/^\s*([0-9]+)\s+(.+?)\s*$/);
  if (!match) return null;
  const ppid = Number(match[1]);
  const command = match[2];
  if (!Number.isSafeInteger(ppid) || ppid < 0 || !command) return null;
  return { ppid, command };
}

function inspectMacAncestor(pid) {
  const result = spawnSync('ps', ['-ww', '-o', 'ppid=', '-o', 'command=', '-p', String(pid)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout || '';
}

export function findMacAncestorCliInfo(startPid, options = {}) {
  const inspect = typeof options.inspect === 'function' ? options.inspect : inspectMacAncestor;
  let pid = Number(startPid);
  const seen = new Set();
  for (let depth = 0; Number.isInteger(pid) && pid > 1 && depth < 12 && !seen.has(pid); depth += 1) {
    seen.add(pid);
    const parsed = parseMacAncestorLine(inspect(pid));
    if (!parsed) return null;
    const kind = detectCliKindFromProcess([parsed.command], {});
    // `ps command` is sufficient for provider-kind detection but is not a
    // lossless argv encoding. Do not feed it to resume-ID parsing.
    if (kind) return { pid, kind, args: [], env: {}, command: parsed.command };
    pid = parsed.ppid;
  }
  return null;
}

export function readAncestorCliInfo() {
  if (ancestorCliInfoCache !== undefined) return ancestorCliInfoCache;
  ancestorCliInfoCache = process.platform === 'linux'
    ? findLinuxAncestorCliInfo(process.ppid)
    : process.platform === 'darwin'
      ? findMacAncestorCliInfo(process.ppid)
      : null;
  return ancestorCliInfoCache;
}

export function resumeIdFromArgs(kind, args) {
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

function peerObservation(kind = null) {
  const ancestor = readAncestorCliInfo();
  const ancestorEnv = ancestor?.kind === kind ? ancestor.env || {} : {};
  const sessionId = kind === 'claude'
    ? (process.env.CLAUDE_CODE_SESSION_ID || ancestorEnv.CLAUDE_CODE_SESSION_ID || '')
    : kind === 'codex'
      ? (process.env.CODEX_SESSION_ID || process.env.CODEX_THREAD_ID || ancestorEnv.CODEX_SESSION_ID || ancestorEnv.CODEX_THREAD_ID || '')
      : '';
  const resumeId = ancestor?.kind === kind ? resumeIdFromArgs(kind, ancestor.args) : null;
  return {
    ancestor,
    env: process.env,
    ppid: process.ppid,
    resumeId,
    sessionId,
    tmuxPane: process.env.TMUX_PANE || '',
    tty: currentTtyName()
  };
}

export function autoPeerProviderSession(kind) {
  return coreAutoPeerProviderSession(kind, peerObservation(kind));
}

export function autoPeerSessionId(kind) {
  return coreAutoPeerSessionId(kind, peerObservation(kind));
}

export function autoPeerResumeId(kind) {
  return coreAutoPeerResumeId(kind, peerObservation(kind));
}

export function autoPeerKind(kindHint = 'shell') {
  const ancestor = readAncestorCliInfo();
  let kind = '';
  if (process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDECODE === '1') kind = 'claude';
  else if (
    process.env.CODEX_SESSION_ID ||
    process.env.CODEX_THREAD_ID ||
    process.env.CODEX_MANAGED_BY_NPM === '1' ||
    process.env.CODEX_MANAGED_BY_BUN === '1'
  ) kind = 'codex';
  else kind = ancestor?.kind || '';
  return coreAutoPeerKind(kindHint, { kind });
}

export function autoPeerBasis(kind = null) {
  return coreAutoPeerBasis(kind, peerObservation(kind));
}

export function autoPeerId(ctx, kindHint = 'shell') {
  const kind = autoPeerKind(kindHint);
  return coreAutoPeerId(ctx, kindHint, {
    ...peerObservation(kind),
    kind
  });
}

export function resolveCurrentPeer(ctx, opts = {}, key = 'peer', kindHint = 'shell') {
  const kind = autoPeerKind(kindHint);
  return coreResolveCurrentPeer(ctx, opts, key, kindHint, {
    ...peerObservation(kind),
    kind
  });
}

export function currentPeer(ctx, opts = {}, key = 'peer', kindHint = 'shell') {
  const kind = autoPeerKind(kindHint);
  return coreCurrentPeer(ctx, opts, key, kindHint, {
    ...peerObservation(kind),
    kind
  });
}
