import fs from 'node:fs';
import path from 'node:path';
import { resumeIdFromArgs } from './identity.mjs';

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

function readProcChildren(pid) {
  if (process.platform !== 'linux' || !pid) return [];
  try {
    return fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isFinite(value) && value > 1);
  } catch {
    return [];
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

function detectKind(args, env, kindHint = null) {
  if (kindHint && argsLookLikeCli(args, kindHint)) return kindHint;
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

function sessionFromEnv(kind, env) {
  if (kind === 'claude') return env.CLAUDE_CODE_SESSION_ID || '';
  if (kind === 'codex') return env.CODEX_SESSION_ID || env.CODEX_THREAD_ID || '';
  return '';
}

export function inspectProviderProcess(pid, kindHint = null, opts = {}) {
  if (process.platform !== 'linux' || !pid) return null;
  const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : 8;
  const queue = [{ pid: Number(pid), depth: 0 }];
  const seen = new Set();

  while (queue.length) {
    const current = queue.shift();
    const currentPid = current?.pid;
    const depth = current?.depth || 0;
    if (!currentPid || currentPid <= 1 || depth > maxDepth || seen.has(currentPid)) continue;
    seen.add(currentPid);
    const args = readProcCmdline(currentPid);
    const env = readProcEnv(currentPid);
    const kind = detectKind(args, env, kindHint);
    if (kind) {
      const envSession = sessionFromEnv(kind, env);
      if (envSession) {
        return {
          pid: currentPid,
          kind,
          provider_session: envSession,
          source: `process.env.${kind}`
        };
      }
      const resumeId = resumeIdFromArgs(kind, args);
      if (resumeId) {
        return {
          pid: currentPid,
          kind,
          provider_session: resumeId,
          source: `process.argv.${kind}`
        };
      }
    }
    for (const childPid of readProcChildren(currentPid)) {
      queue.push({ pid: childPid, depth: depth + 1 });
    }
  }

  let currentPid = Number(pid);
  seen.clear();

  for (let depth = 0; currentPid && currentPid > 1 && depth <= maxDepth && !seen.has(currentPid); depth += 1) {
    seen.add(currentPid);
    const args = readProcCmdline(currentPid);
    const env = readProcEnv(currentPid);
    const kind = detectKind(args, env, kindHint);
    if (kind) {
      const envSession = sessionFromEnv(kind, env);
      if (envSession) {
        return {
          pid: currentPid,
          kind,
          provider_session: envSession,
          source: `process.env.${kind}`
        };
      }
      const resumeId = resumeIdFromArgs(kind, args);
      if (resumeId) {
        return {
          pid: currentPid,
          kind,
          provider_session: resumeId,
          source: `process.argv.${kind}`
        };
      }
    }
    currentPid = readProcParentPid(currentPid);
  }
  return null;
}
