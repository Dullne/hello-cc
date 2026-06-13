import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export function sanitizePeerPart(value, fallback = 'peer') {
  const text = String(value || '').toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return text || fallback;
}

export function shortHash(value) {
  return createHash('sha1').update(String(value)).digest('hex').slice(0, 8);
}

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

export function readAncestorCliInfo() {
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

export function autoPeerProviderSession(kind) {
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

export function autoPeerSessionId(kind) {
  return autoPeerProviderSession(kind).sessionId;
}

export function autoPeerResumeId(kind) {
  return autoPeerProviderSession(kind).resumeId;
}

export function autoPeerKind(kindHint = 'shell') {
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

export function autoPeerBasis(kind = null) {
  const ancestor = readAncestorCliInfo();
  if (ancestor && (!kind || ancestor.kind === kind)) return `cli:${ancestor.kind}:${ancestor.pid}`;
  const ttyName = currentTtyName();
  if (process.env.TMUX_PANE) return `tmux:${process.env.TMUX_PANE}`;
  if (ttyName) return `tty:${ttyName}`;
  return `ppid:${process.ppid}`;
}

export function autoPeerId(ctx, kindHint = 'shell') {
  const kind = autoPeerKind(kindHint);
  const { sessionId, resumeId } = autoPeerProviderSession(kind);
  const providerId = resumeId || sessionId;
  if (providerId) return `${kind}-${sanitizePeerPart(providerId.slice(0, 8), shortHash(providerId))}`;

  const basis = autoPeerBasis(kind);
  return `${kind}-${shortHash(`${ctx.root}:${basis}`)}`;
}

export function resolveCurrentPeer(ctx, opts = {}, key = 'peer', kindHint = 'shell') {
  if (opts[key]) return { id: opts[key], auto: false };
  if (process.env.HCC_PEER) return { id: process.env.HCC_PEER, auto: false };
  return { id: autoPeerId(ctx, kindHint), auto: true };
}

export function currentPeer(ctx, opts = {}, key = 'peer', kindHint = 'shell') {
  return resolveCurrentPeer(ctx, opts, key, kindHint).id;
}
