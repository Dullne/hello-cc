/**
 * Hooks and shim installation for zero-config Claude Code / Codex integration.
 *
 * Claude Code hooks  →  ~/.claude/settings.json
 * Shim scripts       →  ~/.hcc-shims/{claude,codex}
 * PATH entry         →  ~/.bashrc or ~/.zshrc
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

export const SHIM_DIR = path.join(os.homedir(), '.hcc-shims');

// ─── Claude Code hooks ────────────────────────────────────────────────────────

const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

/**
 * Hook events we install handlers for.
 * - SessionStart     : Inject initial coordination context
 * - UserPromptSubmit : Inject fresh coordination context before the model answers
 * - Stop             : Claude goes idle after a turn → deliver inbox messages
 * - PostToolUse      : After every tool call → heartbeat + inbox check
 * - PreToolUse       : Before every tool call → register peer if not yet registered
 */
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'PostToolUse', 'PreToolUse'];

/**
 * Install (or update) hello-cc hooks in ~/.claude/settings.json.
 * Non-destructive: only adds hcc entries, never removes existing ones.
 * Returns the settings file path.
 */
export function installClaudeHooks(hccBin) {
  const settings = readJsonSafe(CLAUDE_SETTINGS_PATH) || {};

  if (!settings.hooks) settings.hooks = {};

  const hookCmd = `${hccBin} hook`;

  for (const event of HOOK_EVENTS) {
    settings.hooks[event] = mergeHookEntry(
      settings.hooks[event],
      `${hookCmd} ${event.toLowerCase()}`
    );
  }

  writeJsonSafe(CLAUDE_SETTINGS_PATH, settings);
  return CLAUDE_SETTINGS_PATH;
}

/**
 * Remove hello-cc hook entries from ~/.claude/settings.json.
 */
export function uninstallClaudeHooks() {
  const settings = readJsonSafe(CLAUDE_SETTINGS_PATH);
  if (!settings?.hooks) return false;

  for (const event of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[event])) continue;
    settings.hooks[event] = settings.hooks[event].filter(entry => {
      if (!Array.isArray(entry?.hooks)) return true;
      return !entry.hooks.some(h => isHccHookCmd(h?.command));
    });
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }

  writeJsonSafe(CLAUDE_SETTINGS_PATH, settings);
  return true;
}

/**
 * Returns true if hello-cc hooks are present in ~/.claude/settings.json.
 */
export function verifyClaudeHooks() {
  const settings = readJsonSafe(CLAUDE_SETTINGS_PATH);
  if (!settings?.hooks) return false;
  return HOOK_EVENTS.every(event => hasHookEntry(settings.hooks[event]));
}

// Append a hook entry, skipping if one already exists for hcc.
function mergeHookEntry(existing, command) {
  const entries = Array.isArray(existing) ? [...existing] : [];
  const alreadyInstalled = entries.some(
    e => Array.isArray(e?.hooks) && e.hooks.some(h => isHccHookCmd(h?.command))
  );
  if (alreadyInstalled) return entries;
  entries.push({ hooks: [{ type: 'command', command }] });
  return entries;
}

function hasHookEntry(entries) {
  if (!Array.isArray(entries)) return false;
  return entries.some(e =>
    Array.isArray(e?.hooks) && e.hooks.some(h => isHccHookCmd(h?.command))
  );
}

function isHccHookCmd(cmd) {
  if (typeof cmd !== 'string') return false;
  return /\bhcc\b.*\bhook\b/.test(cmd) || /hello-cc.*hook/.test(cmd);
}

// ─── Shim scripts ─────────────────────────────────────────────────────────────

/**
 * Install shim scripts for `claude` and `codex` into SHIM_DIR.
 * Returns { shimDir, installed: [paths], changed: [paths], skipped: [names] }.
 */
export function installShims(hccBin) {
  fs.mkdirSync(SHIM_DIR, { recursive: true });

  const tools = [
    { name: 'claude', kind: 'claude', resumeFlag: '--resume' },
    { name: 'codex',  kind: 'codex',  resumeSubcmd: 'resume' },
  ];

  const installed = [];
  const changed = [];
  const skipped = [];

  for (const tool of tools) {
    const realBin = findRealBinary(tool.name);
    if (!realBin) {
      skipped.push(`${tool.name} (not found on PATH)`);
      continue;
    }
    const shimPath = path.join(SHIM_DIR, tool.name);
    const content = generateShim(hccBin, realBin, tool);
    let previous = null;
    try { previous = fs.readFileSync(shimPath, 'utf8'); } catch {}
    if (previous !== content) {
      fs.writeFileSync(shimPath, content, { mode: 0o755 });
      changed.push(shimPath);
    } else {
      try { fs.chmodSync(shimPath, 0o755); } catch {}
    }
    installed.push(shimPath);
  }

  return { shimDir: SHIM_DIR, installed, changed, skipped };
}

/**
 * Remove shim scripts.
 */
export function uninstallShims() {
  const removed = [];
  for (const name of ['claude', 'codex']) {
    const p = path.join(SHIM_DIR, name);
    try { fs.unlinkSync(p); removed.push(p); } catch {}
  }
  try { fs.rmdirSync(SHIM_DIR); } catch {}
  return removed;
}

/**
 * Returns true if at least one shim is installed and in an HCC shim dir.
 */
export function verifyShims() {
  return ['claude', 'codex'].some(name =>
    fsExists(path.join(SHIM_DIR, name))
  );
}

/**
 * Find the real binary for `name`, skipping the SHIM_DIR.
 * Checks PATH, then npm global bin, then common install locations.
 */
export function findRealBinary(name) {
  // which -a lists all matches; pick first one outside SHIM_DIR
  const r = spawnSync('which', ['-a', name], { encoding: 'utf8', timeout: 3000 });
  if (r.status === 0) {
    for (const p of r.stdout.trim().split('\n')) {
      const resolved = p.trim();
      if (resolved && !resolved.startsWith(SHIM_DIR)) return resolved;
    }
  }

  // Try npm global bin
  const npmR = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 3000 });
  if (npmR.status === 0) {
    const npmBin = path.join(path.dirname(npmR.stdout.trim()), 'bin', name);
    if (fsExists(npmBin)) return npmBin;
  }

  // Common locations
  for (const dir of [
    '/usr/local/bin',
    '/usr/bin',
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.nvm', 'current', 'bin'),
  ]) {
    const p = path.join(dir, name);
    if (fsExists(p)) return p;
  }

  return null;
}

// ─── PATH entry in shell rc ───────────────────────────────────────────────────

function pathEntryLine(shellType) {
  if (shellType === 'fish') return 'set -gx PATH $HOME/.hcc-shims $PATH  # hello-cc shims';
  return 'case ":$PATH:" in *":$HOME/.hcc-shims:"*) ;; *) export PATH="$HOME/.hcc-shims:$PATH" ;; esac  # hello-cc shims';
}

function removePathEntryLines(content) {
  return String(content || '')
    .split('\n')
    .filter(line => !line.includes('.hcc-shims'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '');
}

function insertPathEntry(content, shellType) {
  const line = pathEntryLine(shellType);
  const cleaned = removePathEntryLines(content);
  if (shellType === 'fish') return `${cleaned}${cleaned ? '\n' : ''}${line}\n`;

  const lines = cleaned ? cleaned.split('\n') : [];
  let insertAt = 0;
  if (lines[0]?.startsWith('#!')) insertAt = 1;
  for (let i = insertAt; i < lines.length; i += 1) {
    const text = lines[i].trim();
    if (!text || text.startsWith('#')) continue;
    insertAt = i;
    break;
  }
  lines.splice(insertAt, 0, line);
  return `${lines.join('\n').replace(/\s+$/, '')}\n`;
}

/**
 * Install SHIM_DIR in the user's shell rc before common early-return guards.
 * Returns { rcFile, shellType, alreadyPresent }.
 */
export function installPathEntry() {
  const { path: rcFile, type: shellType } = detectShellRc();
  let content = '';
  try { content = fs.readFileSync(rcFile, 'utf8'); } catch {}

  const next = insertPathEntry(content, shellType);
  const alreadyPresent = next === (content.endsWith('\n') ? content : `${content}\n`);
  if (!alreadyPresent) fs.writeFileSync(rcFile, next);
  return { rcFile, shellType, alreadyPresent };
}

/**
 * Remove SHIM_DIR PATH entry from shell rc.
 */
export function uninstallPathEntry() {
  const { path: rcFile } = detectShellRc();
  try {
    const content = fs.readFileSync(rcFile, 'utf8');
    const filtered = content
      .split('\n')
      .filter(line => !line.includes('.hcc-shims'))
      .join('\n');
    fs.writeFileSync(rcFile, filtered);
    return { rcFile };
  } catch {
    return { rcFile, error: 'could not modify shell rc' };
  }
}

function detectShellRc() {
  const shell = process.env.SHELL || '';
  if (shell.includes('zsh')) return { path: path.join(os.homedir(), '.zshrc'), type: 'zsh' };
  if (shell.includes('fish')) return { path: path.join(os.homedir(), '.config', 'fish', 'config.fish'), type: 'fish' };
  return { path: path.join(os.homedir(), '.bashrc'), type: 'bash' };
}

// ─── Shim script generation ───────────────────────────────────────────────────

function generateShim(hccBin, realBin, tool) {
  if (tool.resumeFlag) {
    // Claude: --resume/--continue/--session-id/--fork-session aware wrapper.
    return `#!/usr/bin/env bash
# hello-cc shim for ${tool.name} (auto-generated; do not edit manually)
# Wraps ${tool.name} with hello-cc peer mesh integration.
# Real binary: ${realBin}

set -e
REAL_BIN="${realBin}"
HCC_BIN="${hccBin}"

if [ "\${HCC_SHIM_ENSURED:-}" != "1" ]; then
  set +e
  "$HCC_BIN" shim ensure "${tool.name}" "$0" >/dev/null 2>&1
  ENSURE_STATUS=$?
  set -e
  if [ "$ENSURE_STATUS" = "75" ]; then
    export HCC_SHIM_ENSURED=1
    exec "$0" "$@"
  fi
fi

should_passthrough() {
  for arg in "$@"; do
    case "$arg" in
      -h|--help|-v|--version|-p|--print|--bare|--safe-mode)
        return 0
        ;;
    esac
  done

  case "\${1:-}" in
    agents|auth|auto-mode|doctor|install|mcp|plugin|plugins|project|setup-token|ultrareview|update|upgrade)
      return 0
      ;;
  esac

  return 1
}

if should_passthrough "$@"; then
  exec "$REAL_BIN" "$@"
fi

# Use the current directory as the hello-cc project root unless HCC_ROOT is set.
HCC_ROOT=$("$HCC_BIN" find-root 2>/dev/null || true)

if [ -z "$HCC_ROOT" ]; then
  exec "$REAL_BIN" "$@"
fi

sanitize_peer_part() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]/-/g; s/^-*//; s/-*$//' | cut -c 1-32
}

tty_peer_part() {
  TTY_NUM=$(tty 2>/dev/null | tr -dc '0-9' | tail -c 4)
  PARENT_PID="\${PPID:-$$}"
  if [ -n "$TTY_NUM" ]; then
    printf '%s-%s' "$TTY_NUM" "$PARENT_PID"
  else
    printf '%s' "$PARENT_PID"
  fi
}

RESUME_ID=""
SESSION_ID=""
SESSION_NAME=""
IS_CONTINUE=0
IS_FORK=0
PREV_ARG=""
for arg in "$@"; do
  case "$PREV_ARG" in
    --resume|-r) RESUME_ID="$arg" ;;
    --session-id) SESSION_ID="$arg" ;;
    --name|-n) SESSION_NAME="$arg" ;;
  esac
  case "$arg" in
    --resume=*) RESUME_ID="\${arg#--resume=}" ;;
    --session-id=*) SESSION_ID="\${arg#--session-id=}" ;;
    --name=*) SESSION_NAME="\${arg#--name=}" ;;
    --continue|-c) IS_CONTINUE=1 ;;
    --fork-session) IS_FORK=1 ;;
  esac
  PREV_ARG="$arg"
done

if [ -n "$HCC_PEER" ]; then
  PEER_ID="$HCC_PEER"
elif [ -n "$SESSION_ID" ]; then
  PEER_ID="${tool.kind}-\$(sanitize_peer_part "\${SESSION_ID:0:8}")"
elif [ -n "$RESUME_ID" ] && [ "$IS_FORK" != "1" ]; then
  PEER_ID="${tool.kind}-\$(sanitize_peer_part "\${RESUME_ID:0:8}")"
elif [ -n "$CLAUDE_CODE_SESSION_ID" ]; then
  PEER_ID="${tool.kind}-\$(sanitize_peer_part "\${CLAUDE_CODE_SESSION_ID:0:8}")"
elif [ -n "$SESSION_NAME" ] && [ "$IS_FORK" != "1" ] && [ "$IS_CONTINUE" != "1" ]; then
  PEER_ID="${tool.kind}-\$(sanitize_peer_part "$SESSION_NAME")"
else
  PEER_ID="${tool.kind}-\$(tty_peer_part)"
fi

export HCC_PEER="$PEER_ID"
export HCC_ROOT

set +e
START_OUT=$("$HCC_BIN" web >/dev/null 2>&1 || true; "$HCC_BIN" peer start "$PEER_ID" --kind "${tool.kind}" --restart-env -- "$REAL_BIN" "$@" 2>&1)
START_STATUS=$?
set -e
if [ "$START_STATUS" -ne 0 ]; then
  printf '%s\\n' "$START_OUT" >&2
  exit "$START_STATUS"
fi

PANE=$(printf '%s\\n' "$START_OUT" | sed -n 's/.*pane=\\(%[0-9][0-9]*\\).*/\\1/p' | tail -n 1)
if [ -z "$PANE" ]; then
  printf '%s\\n' "$START_OUT"
  exit 0
fi

if [ "$HCC_SHIM_NO_ATTACH" = "1" ] || [ ! -t 0 ]; then
  printf '%s\\n' "$START_OUT"
  exit 0
fi

SESSION=$(tmux display-message -p -t "$PANE" '#S' 2>/dev/null || true)
if [ -z "$SESSION" ]; then
  printf '%s\\n' "$START_OUT"
  exit 0
fi

if [ -n "$TMUX" ]; then
  exec tmux switch-client -t "$SESSION"
fi

exec tmux attach-session -t "$SESSION"
`;
  } else {
    // Codex: resume/fork subcommand aware wrapper.
    return `#!/usr/bin/env bash
# hello-cc shim for ${tool.name} (auto-generated; do not edit manually)
# Wraps ${tool.name} with hello-cc peer mesh integration.
# Real binary: ${realBin}

set -e
REAL_BIN="${realBin}"
HCC_BIN="${hccBin}"

if [ "\${HCC_SHIM_ENSURED:-}" != "1" ]; then
  set +e
  "$HCC_BIN" shim ensure "${tool.name}" "$0" >/dev/null 2>&1
  ENSURE_STATUS=$?
  set -e
  if [ "$ENSURE_STATUS" = "75" ]; then
    export HCC_SHIM_ENSURED=1
    exec "$0" "$@"
  fi
fi

first_non_option() {
  EXPECT_VALUE=0
  for arg in "$@"; do
    if [ "$EXPECT_VALUE" = "1" ]; then
      EXPECT_VALUE=0
      continue
    fi

    case "$arg" in
      --)
        EXPECT_VALUE=0
        continue
        ;;
      -c|--config|-i|--image|-m|--model|-p|--profile|-s|--sandbox|-C|--cd|--add-dir|-a|--ask-for-approval|--remote|--remote-auth-token-env)
        EXPECT_VALUE=1
        continue
        ;;
      --config=*|--image=*|--model=*|--profile=*|--sandbox=*|--cd=*|--add-dir=*|--ask-for-approval=*|--remote=*|--remote-auth-token-env=*)
        continue
        ;;
      --*)
        continue
        ;;
      -*)
        continue
        ;;
      *)
        printf '%s' "$arg"
        return 0
        ;;
    esac
  done
  return 1
}

should_passthrough() {
  for arg in "$@"; do
    case "$arg" in
      -h|--help|-V|--version)
        return 0
        ;;
    esac
  done

  SUBCOMMAND=$(first_non_option "$@" || true)
  case "$SUBCOMMAND" in
    help|exec|e|review|login|logout|mcp|plugin|mcp-server|app-server|remote-control|completion|update|doctor|sandbox|debug|apply|a|archive|unarchive|cloud|exec-server|features)
      return 0
      ;;
  esac

  return 1
}

if should_passthrough "$@"; then
  exec "$REAL_BIN" "$@"
fi

HCC_ROOT=$("$HCC_BIN" find-root 2>/dev/null || true)

if [ -z "$HCC_ROOT" ]; then
  exec "$REAL_BIN" "$@"
fi

sanitize_peer_part() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]/-/g; s/^-*//; s/-*$//' | cut -c 1-32
}

tty_peer_part() {
  TTY_NUM=$(tty 2>/dev/null | tr -dc '0-9' | tail -c 4)
  PARENT_PID="\${PPID:-$$}"
  if [ -n "$TTY_NUM" ]; then
    printf '%s-%s' "$TTY_NUM" "$PARENT_PID"
  else
    printf '%s' "$PARENT_PID"
  fi
}

SUBCMD=""
RESUME_ID=""
EXPECT_SESSION=0
for arg in "$@"; do
  if [ -z "$SUBCMD" ]; then
    if [ "$arg" = "resume" ] || [ "$arg" = "fork" ]; then
      SUBCMD="$arg"
      EXPECT_SESSION=1
    fi
    continue
  fi
  if [ "$EXPECT_SESSION" = "1" ]; then
    case "$arg" in
      --last) EXPECT_SESSION=0 ;;
      -*) ;;
      *) RESUME_ID="$arg"; EXPECT_SESSION=0 ;;
    esac
  fi
done

if [ -n "$HCC_PEER" ]; then
  PEER_ID="$HCC_PEER"
elif [ "$SUBCMD" = "resume" ] && [ -n "$RESUME_ID" ]; then
  PEER_ID="${tool.kind}-\$(sanitize_peer_part "\${RESUME_ID:0:8}")"
else
  PEER_ID="${tool.kind}-\$(tty_peer_part)"
fi

export HCC_PEER="$PEER_ID"
export HCC_ROOT

set +e
START_OUT=$("$HCC_BIN" web >/dev/null 2>&1 || true; "$HCC_BIN" peer start "$PEER_ID" --kind "${tool.kind}" --restart-env -- "$REAL_BIN" "$@" 2>&1)
START_STATUS=$?
set -e
if [ "$START_STATUS" -ne 0 ]; then
  printf '%s\\n' "$START_OUT" >&2
  exit "$START_STATUS"
fi

PANE=$(printf '%s\\n' "$START_OUT" | sed -n 's/.*pane=\\(%[0-9][0-9]*\\).*/\\1/p' | tail -n 1)
if [ -z "$PANE" ]; then
  printf '%s\\n' "$START_OUT"
  exit 0
fi

if [ "$HCC_SHIM_NO_ATTACH" = "1" ] || [ ! -t 0 ]; then
  printf '%s\\n' "$START_OUT"
  exit 0
fi

SESSION=$(tmux display-message -p -t "$PANE" '#S' 2>/dev/null || true)
if [ -z "$SESSION" ]; then
  printf '%s\\n' "$START_OUT"
  exit 0
fi

if [ -n "$TMUX" ]; then
  exec tmux switch-client -t "$SESSION"
fi

exec tmux attach-session -t "$SESSION"
`;
  }
}

// ─── Codex hooks ─────────────────────────────────────────────────────────────

const CODEX_HOOKS_PATH = path.join(os.homedir(), '.codex', 'hooks.json');

/**
 * Install hello-cc hooks in ~/.codex/hooks.json.
 *
 * Codex hooks.json format:
 *   { "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [...] }], "Stop": [...] } }
 */
export function installCodexHooks(hccBin) {
  const hooks = readJsonSafe(CODEX_HOOKS_PATH) || {};

  if (!hooks.hooks) hooks.hooks = {};

  const hookCmd = `${hccBin} hook`;

  // SessionStart: inject initial coordination context on startup/resume.
  hooks.hooks.SessionStart = mergeCodexHookEntry(
    hooks.hooks.SessionStart,
    `${hookCmd} sessionstart`,
    null
  );
  // UserPromptSubmit: inject fresh coordination context before each model turn.
  hooks.hooks.UserPromptSubmit = mergeCodexHookEntry(
    hooks.hooks.UserPromptSubmit,
    `${hookCmd} userpromptsubmit`,
    null
  );
  // PreToolUse: fires before every Bash tool call — heartbeat + peer registration
  hooks.hooks.PreToolUse = mergeCodexHookEntry(
    hooks.hooks.PreToolUse,
    `${hookCmd} pretooluse`,
    'Bash'
  );
  // Stop: fires when Codex goes idle — deliver inbox messages
  hooks.hooks.Stop = mergeCodexHookEntry(
    hooks.hooks.Stop,
    `${hookCmd} stop`,
    null
  );

  writeJsonSafe(CODEX_HOOKS_PATH, hooks);
  return CODEX_HOOKS_PATH;
}

export function uninstallCodexHooks() {
  const hooks = readJsonSafe(CODEX_HOOKS_PATH);
  if (!hooks?.hooks) return false;

  for (const event of Object.keys(hooks.hooks)) {
    if (!Array.isArray(hooks.hooks[event])) continue;
    hooks.hooks[event] = hooks.hooks[event].filter(entry => {
      if (!Array.isArray(entry?.hooks)) return true;
      return !entry.hooks.some(h => isHccHookCmd(h?.command));
    });
    if (hooks.hooks[event].length === 0) delete hooks.hooks[event];
  }

  writeJsonSafe(CODEX_HOOKS_PATH, hooks);
  return true;
}

export function verifyCodexHooks() {
  const hooks = readJsonSafe(CODEX_HOOKS_PATH);
  if (!hooks?.hooks) return false;
  return ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'].every(event =>
    hasHookEntry(hooks.hooks[event])
  );
}

function mergeCodexHookEntry(existing, command, matcher) {
  const entries = Array.isArray(existing) ? [...existing] : [];
  const alreadyInstalled = entries.some(
    e => Array.isArray(e?.hooks) && e.hooks.some(h => isHccHookCmd(h?.command))
  );
  if (alreadyInstalled) return entries;

  const entry = {
    hooks: [{ type: 'command', command }],
  };
  if (matcher) entry.matcher = matcher;
  entries.push(entry);
  return entries;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function fsExists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function readJsonSafe(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

function writeJsonSafe(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmpPath, filePath);
}
