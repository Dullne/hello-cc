/**
 * Zero-config session discovery for Claude Code and Codex.
 *
 * Three layers:
 *   1. File watchers — ~/.claude/sessions/ and ~/.codex/sessions/today/
 *   2. Initial scan — read existing session files + /proc process scan
 *   3. Process env scan — walk /proc to find running claude/codex PIDs
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

// ─── Root detection ──────────────────────────────────────────────────────────

/**
 * Return the exact current hcc project path. Cross-path sharing is explicit via
 * HCC_ROOT/HCC_DB, so discovery does not walk to parent directories.
 */
export function findHccRoot(cwd) {
  if (!cwd) return null;
  return path.resolve(cwd);
}

function fsExists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

// ─── Peer ID derivation ───────────────────────────────────────────────────────

/**
 * Derive a stable peer ID.
 *
 * Stability contract:
 *   - `claude --resume <old-id>`  →  claude-<old-id[:8]>   (same across restarts)
 *   - `codex resume <id>`         →  codex-<id[:8]>         (same across restarts)
 *   - fresh session               →  <kind>-<sessionId[:8]> (unique per session)
 */
export function derivePeerId(kind, sessionId, resumeId, explicitPeer = null) {
  if (explicitPeer) return explicitPeer;

  // If HCC_PEER is already set (set by shim or hcc run), respect it
  if (process.env.HCC_PEER) return process.env.HCC_PEER;

  const base = resumeId || sessionId;
  if (base && base.length >= 4) return `${kind}-${base.slice(0, 8)}`;

  // Fallback: tty device number or pid
  const ttyNum = getTtyNum();
  return `${kind}-${ttyNum || process.ppid || Date.now().toString(36).slice(-6)}`;
}

function getTtyNum() {
  try {
    const r = spawnSync('tty', [], { encoding: 'utf8', timeout: 1000 });
    if (r.status === 0) {
      return r.stdout.trim().replace(/[^0-9]/g, '').slice(-4) || null;
    }
  } catch {}
  return null;
}

// ─── Resume argument parsing ──────────────────────────────────────────────────

/**
 * Extract the session ID from `claude --resume <id>` or `claude -r <id>`.
 * Returns null if no --resume flag found.
 */
export function parseClaudeResumeId(cmdArgs) {
  for (let i = 0; i < cmdArgs.length; i++) {
    const arg = cmdArgs[i];
    if ((arg === '--resume' || arg === '-r') && cmdArgs[i + 1]) return cmdArgs[i + 1] || null;
    if (arg.startsWith('--resume=')) return arg.slice('--resume='.length);
  }
  return null;
}

export function parseClaudeSessionId(cmdArgs) {
  for (let i = 0; i < cmdArgs.length; i += 1) {
    const arg = cmdArgs[i];
    if (arg === '--session-id' && cmdArgs[i + 1]) return cmdArgs[i + 1] || null;
    if (arg.startsWith('--session-id=')) return arg.slice('--session-id='.length);
  }
  return null;
}

export function parseClaudeFork(cmdArgs) {
  return cmdArgs.includes('--fork-session');
}

/**
 * Extract the session ID from `codex resume <id>` subcommand.
 */
export function parseCodexResumeId(cmdArgs) {
  const parsed = parseCodexCommand(cmdArgs);
  if (parsed.subcommand !== 'resume') return null;
  return parsed.sessionId || null;
}

export function parseCodexCommand(cmdArgs) {
  const idx = cmdArgs.findIndex(a => a === 'resume' || a === 'fork');
  if (idx < 0) return { subcommand: null, sessionId: null, last: false };
  const subcommand = cmdArgs[idx];
  let sessionId = null;
  let last = false;
  for (let i = idx + 1; i < cmdArgs.length; i += 1) {
    const arg = cmdArgs[i];
    if (arg === '--last') { last = true; continue; }
    if (arg.startsWith('-')) {
      if (codexOptionTakesValue(arg)) i += 1;
      continue;
    }
    sessionId = arg;
    break;
  }
  return { subcommand, sessionId, last };
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

export function parseCodexForkSourceId(cmdArgs) {
  const parsed = parseCodexCommand(cmdArgs);
  if (parsed.subcommand !== 'fork') return null;
  return parsed.sessionId || null;
}

export function parseCodexLast(cmdArgs) {
  const parsed = parseCodexCommand(cmdArgs);
  return Boolean(parsed.subcommand && parsed.last && !parsed.sessionId);
}

// ─── Process utilities ────────────────────────────────────────────────────────

export function isAlive(pid) {
  if (!pid) return false;
  // Linux /proc fast check
  if (process.platform === 'linux') {
    try { fs.accessSync(`/proc/${pid}`); return true; } catch { return false; }
  }
  // POSIX kill(pid, 0)
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function readEnvFile(envPath) {
  const result = {};
  const raw = readFileSafe(envPath);
  if (!raw) return result;
  for (const entry of raw.split('\0')) {
    const eq = entry.indexOf('=');
    if (eq > 0) result[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return result;
}

// ─── Claude Code session discovery ───────────────────────────────────────────

const CLAUDE_SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');

/**
 * Read existing Claude Code session files and return info about live sessions
 * that belong to a hello-cc project.
 */
export function scanClaudeSessions() {
  const results = [];
  let files;
  try { files = fs.readdirSync(CLAUDE_SESSIONS_DIR); }
  catch { return results; }

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const content = JSON.parse(
        fs.readFileSync(path.join(CLAUDE_SESSIONS_DIR, file), 'utf8')
      );
      const { pid, sessionId, cwd, status } = content;
      if (!pid || !sessionId || !cwd) continue;
      if (!isAlive(pid)) continue;
      const env = readEnvFile(`/proc/${pid}/environ`);

      const hccRoot = findHccRoot(cwd);
      if (!hccRoot) continue;

      results.push({
        kind: 'claude',
        sessionId,
        peerId: derivePeerId('claude', sessionId, null, env.HCC_PEER),
        pid,
        cwd,
        hccRoot,
        status: status || 'unknown',
        transport: 'detected',
      });
    } catch { /* ignore malformed files */ }
  }
  return results;
}

/**
 * Watch ~/.claude/sessions/ for new session files.
 * Calls `onNew(sessionInfo)` for each new live session in an HCC project.
 * Returns the fs.FSWatcher or null.
 */
export function watchClaudeSessions(onNew) {
  try {
    fs.mkdirSync(CLAUDE_SESSIONS_DIR, { recursive: true });
  } catch {}

  try {
    return fs.watch(CLAUDE_SESSIONS_DIR, { persistent: false }, (event, filename) => {
      if (event !== 'rename' || !filename?.endsWith('.json')) return;
      // Small delay so Claude Code finishes writing the file
      setTimeout(() => {
        try {
          const content = JSON.parse(
            fs.readFileSync(path.join(CLAUDE_SESSIONS_DIR, filename), 'utf8')
          );
          const { pid, sessionId, cwd, status } = content;
          if (!pid || !sessionId || !cwd) return;
          if (!isAlive(pid)) return;
          const env = readEnvFile(`/proc/${pid}/environ`);
          const hccRoot = findHccRoot(cwd);
          if (!hccRoot) return;
          onNew({
            kind: 'claude',
            sessionId,
            peerId: derivePeerId('claude', sessionId, null, env.HCC_PEER),
            pid,
            cwd,
            hccRoot,
            status: status || 'unknown',
            transport: 'detected',
          });
        } catch {}
      }, 300);
    });
  } catch {
    return null;
  }
}

// ─── Codex session discovery ──────────────────────────────────────────────────

function codexSessionsDir() {
  const d = new Date();
  return path.join(
    os.homedir(), '.codex', 'sessions',
    String(d.getFullYear()),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')
  );
}

function parseCodexSessionFile(filePath) {
  try {
    const firstLine = fs.readFileSync(filePath, 'utf8').split('\n')[0];
    if (!firstLine) return null;
    const parsed = JSON.parse(firstLine);
    if (parsed.type !== 'session_meta') return null;
    const { id, cwd } = parsed.payload || {};
    if (!id || !cwd) return null;
    return { sessionId: id, cwd };
  } catch { return null; }
}

/**
 * Scan today's Codex session files.  Match to running processes via cmdline.
 */
export function scanCodexSessions() {
  const results = [];
  const dir = codexSessionsDir();
  let files;
  try { files = fs.readdirSync(dir); } catch { return results; }

  // Build maps from /proc. Fresh sessions and --last/fork launches usually do
  // not expose the new session id in argv, so cwd is the fallback.
  const runningCodex = getRunningCodexSessions();

  for (const file of files.sort().reverse().slice(0, 30)) {
    if (!file.endsWith('.jsonl')) continue;
    const info = parseCodexSessionFile(path.join(dir, file));
    if (!info) continue;

    const proc = runningCodex.bySessionId.get(info.sessionId) || firstProcessForCwd(runningCodex.byCwd, info.cwd);
    if (!proc) continue;

    const hccRoot = findHccRoot(info.cwd);
    if (!hccRoot) continue;

    results.push({
      kind: 'codex',
      sessionId: info.sessionId,
      peerId: derivePeerId('codex', info.sessionId, null, proc.peerId),
      pid: proc.pid,
      cwd: info.cwd,
      hccRoot,
      status: 'running',
      transport: 'detected',
    });
  }
  return results;
}

/**
 * Walk /proc to find all running `codex` Node processes and map session ID → PID.
 * Codex launches as: `node /path/to/codex [resume] <session-id>` or similar.
 */
function getRunningCodexSessions() {
  const bySessionId = new Map();
  const byCwd = new Map();
  if (process.platform !== 'linux') return { bySessionId, byCwd };

  let pids;
  try { pids = fs.readdirSync('/proc').filter(e => /^\d+$/.test(e)); }
  catch { return { bySessionId, byCwd }; }

  for (const pid of pids) {
    try {
      const cmdline = readFileSafe(`/proc/${pid}/cmdline`).split('\0');
      if (!cmdline.some(a => a.includes('codex'))) continue;
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      const env = readEnvFile(`/proc/${pid}/environ`);
      const procInfo = { pid: parseInt(pid), peerId: env.HCC_PEER || null };
      if (!byCwd.has(cwd)) byCwd.set(cwd, []);
      byCwd.get(cwd).push(procInfo);

      // codex resume <uuid>
      const resumeId = parseCodexResumeId(cmdline);
      if (resumeId) {
        bySessionId.set(resumeId, procInfo);
      }
    } catch {}
  }
  return { bySessionId, byCwd };
}

function firstProcessForCwd(byCwd, cwd) {
  const direct = byCwd.get(cwd);
  if (direct?.length) return direct[0];
  for (const [procCwd, pids] of byCwd.entries()) {
    if ((procCwd === cwd || procCwd.startsWith(`${cwd}${path.sep}`) || cwd.startsWith(`${procCwd}${path.sep}`)) && pids.length) {
      return pids[0];
    }
  }
  return null;
}

/**
 * Watch today's Codex sessions directory for new session files.
 */
export function watchCodexSessions(onNew) {
  const dir = codexSessionsDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}

  try {
    return fs.watch(dir, { persistent: false }, (event, filename) => {
      if (event !== 'rename' || !filename?.endsWith('.jsonl')) return;
      setTimeout(() => {
        const info = parseCodexSessionFile(path.join(dir, filename));
        if (!info) return;

        const running = getRunningCodexSessions();
        const proc = running.bySessionId.get(info.sessionId) || firstProcessForCwd(running.byCwd, info.cwd);

        const hccRoot = findHccRoot(info.cwd);
        if (!hccRoot) return;

        onNew({
          kind: 'codex',
          sessionId: info.sessionId,
          peerId: derivePeerId('codex', info.sessionId, null, proc?.peerId),
          pid: proc?.pid || null,
          cwd: info.cwd,
          hccRoot,
          status: 'running',
          transport: 'detected',
        });
      }, 500);
    });
  } catch {
    return null;
  }
}

// ─── Generic process scan (fallback) ─────────────────────────────────────────

/**
 * Scan /proc for any running claude/codex processes that belong to an HCC
 * project.  Used as a fallback when session files are not available.
 * Returns an array of discovered session info objects.
 */
export function scanProcesses() {
  const results = [];
  if (process.platform !== 'linux') return results;

  let pids;
  try { pids = fs.readdirSync('/proc').filter(e => /^\d+$/.test(e)); }
  catch { return results; }

  const seen = new Set();

  for (const pidStr of pids) {
    try {
      const cmdline = readFileSafe(`/proc/${pidStr}/cmdline`).split('\0');
      const hasClaude = cmdline.some(a => /claude/.test(a) && !a.includes('hcc'));
      const hasCodex  = cmdline.some(a => /\bcodex\b/.test(a));
      if (!hasClaude && !hasCodex) continue;

      const cwd = fs.readlinkSync(`/proc/${pidStr}/cwd`);
      const env = readEnvFile(`/proc/${pidStr}/environ`);

      const kind = hasClaude ? 'claude' : 'codex';

      // Skip subagent/helper processes (they share CLAUDE_CODE_SESSION_ID
      // with the main session but are not the interactive terminal)
      if (kind === 'claude') {
        const entrypoint = env.CLAUDE_CODE_ENTRYPOINT || '';
        if (entrypoint && entrypoint !== 'cli') continue;
      }

      const explicitClaudeSession = kind === 'claude' ? parseClaudeSessionId(cmdline) : '';
      const sessionId = kind === 'claude'
        ? (env.CLAUDE_CODE_SESSION_ID || explicitClaudeSession || '')
        : parseCodexResumeId(cmdline) || '';

      let resumeId = null;
      if (kind === 'claude') {
        resumeId = parseClaudeFork(cmdline) ? null : parseClaudeResumeId(cmdline);
      } else {
        resumeId = parseCodexResumeId(cmdline);
      }

      const peerId = derivePeerId(kind, sessionId, resumeId, env.HCC_PEER);
      if (seen.has(peerId)) continue;
      seen.add(peerId);

      const hccRoot = findHccRoot(cwd);
      if (!hccRoot) continue;

      results.push({
        kind,
        sessionId,
        resumeId,
        peerId,
        pid: parseInt(pidStr),
        cwd,
        hccRoot,
        status: 'running',
        transport: 'detected',
      });
    } catch {}
  }

  return results;
}
