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
import { readJsonSafe, writeJsonSafe } from './shared/json-file.mjs';
import { generateShim } from './shim-script.mjs';
export { installPathEntry, uninstallPathEntry } from './shell-path.mjs';

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
