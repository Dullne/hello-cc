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
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { providerSessionPeerId } from './core/peers/session.mjs';
import { inspectProcessIdentity } from './process/identity.mjs';
import { assertSelectedCwdSnapshot, captureSelectedCwdSnapshot } from './process/selected-cwd-identity.mjs';

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
 *   - provider session ID/name → the same full-value hash used by hooks/shims
 *   - fresh session            → the same stable provider identity
 */
export function derivePeerId(kind, sessionId, resumeId, explicitPeer = null) {
  if (explicitPeer) return explicitPeer;

  // If HCC_PEER is already set (set by shim or hcc run), respect it
  if (process.env.HCC_PEER) return process.env.HCC_PEER;

  const base = resumeId || sessionId;
  if (base) return providerSessionPeerId(kind, base);

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

// Session files contain a historical cwd and PID, not a root-bound proof of
// which directory inode owned the provider session. A reused PID or pathname
// can make an old session appear to belong to a replacement project.
export function scanClaudeSessions() {
  return [];
}

// Keep the exported watcher interface inert until session files carry a
// verifiable root/session receipt. Watching must not reintroduce attribution.
export function watchClaudeSessions(_onNew) {
  return null;
}

// ─── Codex session discovery ──────────────────────────────────────────────────

// Provider history may only be attributed by a separately persisted,
// root-bound receipt; a live process with the same cwd or resume ID is not one.
export function scanCodexSessions() {
  return [];
}

// The same boundary applies to newly created session files.
export function watchCodexSessions(_onNew) {
  return null;
}

// ─── Live process-only discovery ───────────────────────────────────────────────

function sameProcessIdentity(left, right) {
  return left?.pid === right?.pid && left?.startToken === right?.startToken &&
    left?.commandHash === right?.commandHash;
}

function sameDirectoryStat(left, right) {
  return left.isDirectory() && right.isDirectory() && left.dev === right.dev &&
    left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

function matchesSnapshot(stat, snapshot) {
  return stat.isDirectory() && stat.dev.toString() === snapshot.identity.dev &&
    stat.ino.toString() === snapshot.identity.ino &&
    (stat.birthtimeNs?.toString() || null) === snapshot.identity.birthtimeNs;
}

function processPeerId(kind, pid, identity) {
  const suffix = createHash('sha256').update(`${pid}\0${identity.startToken}`).digest('hex').slice(0, 20);
  return `${kind}-process-${suffix}`;
}

// Recheck immediately before registration. Historical paths and provider IDs
// are not authority: the same pathname can now name a different directory.
// The proc cwd itself, its current canonical name, and its parent chain must
// all lead to the selected root inode. A changed/reused PID is rejected too.
export function verifiedLiveProcessForRoot(record, ctx, { procRoot = '/proc', observeProcess = inspectProcessIdentity } = {}) {
  if (record?.source !== 'process' || !Number.isSafeInteger(record.pid) || record.pid < 1 ||
      !record.processIdentity || record.sessionId || record.resumeId) return null;
  const selected = ctx.rootIdentity || ctx.initialRootIdentity || captureSelectedCwdSnapshot(ctx.root);
  assertSelectedCwdSnapshot(selected);
  try {
    const before = observeProcess(record.pid);
    if (before.state !== 'live' || !sameProcessIdentity(record.processIdentity, before.identity)) return null;
    const procCwd = `${procRoot}/${record.pid}/cwd`;
    const liveCwd = fs.realpathSync.native(procCwd);
    const relative = path.relative(selected.canonical, liveCwd);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    const procStat = fs.statSync(procCwd, { bigint: true });
    if (!sameDirectoryStat(procStat, fs.statSync(liveCwd, { bigint: true }))) return null;
    // Keep the /proc magic link in the path while walking upwards: path.join
    // would erase "cwd/.." before the kernel could resolve the live inode.
    let ancestor = procCwd;
    for (let level = 0, depth = relative ? relative.split(path.sep).length : 0; level < depth; level++) {
      ancestor += '/..';
    }
    if (!matchesSnapshot(fs.statSync(ancestor, { bigint: true }), selected)) return null;
    const after = observeProcess(record.pid);
    if (after.state !== 'live' || !sameProcessIdentity(before.identity, after.identity)) return null;
    assertSelectedCwdSnapshot(selected);
    return { ...record, cwd: liveCwd, hccRoot: selected.canonical, processIdentity: after.identity };
  } catch (error) {
    if (error?.code === 'PROJECT_PATH_CHANGED') throw error;
    return null;
  }
}

// Binding updates merge an existing provider session ID when the incoming
// record omits one. Process-only discovery must never inherit that history.
export function canRegisterProcessOnly(db, record) {
  const binding = db.prepare('SELECT transport, provider_session_id, provider_session_name, resume_mode, resume_arg, runtime_target FROM peer_bindings WHERE peer=?')
    .get(record.peerId);
  if (binding) return binding.transport === 'detected' && !binding.provider_session_id &&
    !binding.provider_session_name && !binding.resume_arg && !binding.runtime_target &&
    binding.resume_mode === 'unknown';
  return !db.prepare('SELECT id FROM peers WHERE id=?').get(record.peerId);
}

/**
 * Scan /proc for live claude/codex processes. This does not infer ownership of
 * provider history from argv, stale session files, or pathname equality.
 * Call verifiedLiveProcessForRoot before registering a result to a project.
 */
export function scanProcesses({ procRoot = '/proc', platform = process.platform,
  observeProcess = inspectProcessIdentity } = {}) {
  const results = [];
  if (platform !== 'linux') return results;

  let pids;
  try { pids = fs.readdirSync(procRoot).filter(e => /^\d+$/.test(e)); }
  catch { return results; }

  const seen = new Set();

  for (const pidStr of pids) {
    try {
      const pid = Number(pidStr);
      const cmdline = readFileSafe(`${procRoot}/${pidStr}/cmdline`).split('\0');
      const hasClaude = cmdline.some(a => /claude/.test(a) && !a.includes('hcc'));
      const hasCodex  = cmdline.some(a => /\bcodex\b/.test(a));
      if (!hasClaude && !hasCodex) continue;

      const cwd = fs.readlinkSync(`${procRoot}/${pidStr}/cwd`);
      const env = readEnvFile(`${procRoot}/${pidStr}/environ`);
      const observed = observeProcess(pid);
      if (observed.state !== 'live' || !observed.identity) continue;
      const commandHash = createHash('sha256').update(cmdline.filter(Boolean).join(' ').trim()).digest('hex');
      if (observed.identity.commandHash !== commandHash) continue;

      const kind = hasClaude ? 'claude' : 'codex';

      // Skip subagent/helper processes (they share CLAUDE_CODE_SESSION_ID
      // with the main session but are not the interactive terminal)
      if (kind === 'claude') {
        const entrypoint = env.CLAUDE_CODE_ENTRYPOINT || '';
        if (entrypoint && entrypoint !== 'cli') continue;
      }

      const peerId = processPeerId(kind, pid, observed.identity);
      if (seen.has(peerId)) continue;
      seen.add(peerId);

      const hccRoot = findHccRoot(cwd);
      if (!hccRoot) continue;

      results.push({
        kind,
        sessionId: '',
        resumeId: null,
        peerId,
        pid,
        cwd,
        hccRoot,
        status: 'running',
        transport: 'detected',
        source: 'process',
        processIdentity: observed.identity,
      });
    } catch {}
  }

  return results;
}
