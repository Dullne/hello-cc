import os from 'node:os';
import path from 'node:path';
import { readJsonSafe, writeJsonSafe } from '../shared/json-file.mjs';

const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const CODEX_HOOKS_PATH = path.join(os.homedir(), '.codex', 'hooks.json');

/**
 * Hook events we install handlers for.
 * - SessionStart     : Inject initial coordination context
 * - UserPromptSubmit : Inject fresh coordination context before the model answers
 * - Stop             : Claude goes idle after a turn -> deliver inbox messages
 * - PostToolUse      : After every tool call -> heartbeat + inbox check
 * - PreToolUse       : Before every tool call -> register peer if not yet registered
 */
const CLAUDE_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'PostToolUse', 'PreToolUse'];
const CODEX_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'];

/**
 * Install (or update) hello-cc hooks in ~/.claude/settings.json.
 * Non-destructive: only adds hcc entries, never removes existing ones.
 * Returns the settings file path.
 */
export function installClaudeHooks(hccBin) {
  const settings = readJsonSafe(CLAUDE_SETTINGS_PATH) || {};

  if (!settings.hooks) settings.hooks = {};

  const hookCmd = `${hccBin} hook`;

  for (const event of CLAUDE_HOOK_EVENTS) {
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
  return CLAUDE_HOOK_EVENTS.every(event => hasHookEntry(settings.hooks[event]));
}

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
  // PreToolUse: fires before every Bash tool call - heartbeat + peer registration
  hooks.hooks.PreToolUse = mergeCodexHookEntry(
    hooks.hooks.PreToolUse,
    `${hookCmd} pretooluse`,
    'Bash'
  );
  // Stop: fires when Codex goes idle - deliver inbox messages
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
  return CODEX_HOOK_EVENTS.every(event => hasHookEntry(hooks.hooks[event]));
}

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
