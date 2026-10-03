import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandPath } from '../cli-runtime.mjs';
import { shellQuoteArg } from '../format.mjs';
import { CliError } from '../shared/errors.mjs';
import { writeJsonSafe } from '../shared/json-file.mjs';

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
 * Replaces stale hcc entries while retaining unrelated hooks.
 * Returns the settings file path.
 */
export function installClaudeHooks(hccBin) {
  const settings = readHookConfig(CLAUDE_SETTINGS_PATH) || {};

  if (!settings.hooks) settings.hooks = {};

  const hookCmd = `${shellQuoteArg(hccBin)} hook`;

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
  const settings = readHookConfig(CLAUDE_SETTINGS_PATH);
  if (!settings?.hooks) return false;

  let removed = false;
  for (const event of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[event])) continue;
    const result = removeHccHooks(settings.hooks[event]);
    settings.hooks[event] = result.entries;
    removed ||= result.removed;
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }

  if (removed) writeJsonSafe(CLAUDE_SETTINGS_PATH, settings);
  return removed;
}

/**
 * Returns true if hello-cc hooks are present in ~/.claude/settings.json.
 */
export function verifyClaudeHooks(hccBin = commandPath()) {
  const settings = readHookConfig(CLAUDE_SETTINGS_PATH);
  if (!settings?.hooks) return false;
  const hookCmd = `${shellQuoteArg(hccBin)} hook`;
  return CLAUDE_HOOK_EVENTS.every(event =>
    hasHookEntry(settings.hooks[event], `${hookCmd} ${event.toLowerCase()}`));
}

/**
 * Install hello-cc hooks in ~/.codex/hooks.json.
 *
 * Codex hooks.json format:
 *   { "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [...] }], "Stop": [...] } }
 */
export function installCodexHooks(hccBin) {
  const hooks = readHookConfig(CODEX_HOOKS_PATH) || {};

  if (!hooks.hooks) hooks.hooks = {};

  const hookCmd = `${shellQuoteArg(hccBin)} hook`;

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
  const hooks = readHookConfig(CODEX_HOOKS_PATH);
  if (!hooks?.hooks) return false;

  let removed = false;
  for (const event of Object.keys(hooks.hooks)) {
    if (!Array.isArray(hooks.hooks[event])) continue;
    const result = removeHccHooks(hooks.hooks[event]);
    hooks.hooks[event] = result.entries;
    removed ||= result.removed;
    if (hooks.hooks[event].length === 0) delete hooks.hooks[event];
  }

  if (removed) writeJsonSafe(CODEX_HOOKS_PATH, hooks);
  return removed;
}

export function verifyCodexHooks(hccBin = commandPath()) {
  const hooks = readHookConfig(CODEX_HOOKS_PATH);
  if (!hooks?.hooks) return false;
  const hookCmd = `${shellQuoteArg(hccBin)} hook`;
  return CODEX_HOOK_EVENTS.every(event =>
    hasHookEntry(hooks.hooks[event], `${hookCmd} ${event.toLowerCase()}`,
      event === 'PreToolUse' ? 'Bash' : undefined));
}

function mergeHookEntry(existing, command) {
  const entries = removeHccHooks(hookEntries(existing)).entries;
  entries.push({ hooks: [{ type: 'command', command }] });
  return entries;
}

function hasHookEntry(entries, command, matcher) {
  if (!Array.isArray(entries)) return false;
  return entries.some(e =>
    (matcher === undefined || e?.matcher === matcher) &&
    Array.isArray(e?.hooks) && e.hooks.some(h => h?.type === 'command' && h.command === command)
  );
}

function isHccHookCmd(cmd) {
  const words = shellWords(cmd);
  if (words?.length) {
    const offset = ['node', 'nodejs', 'node.exe'].includes(path.basename(words[0])) ? 1 : 0;
    if (['hcc', 'hello-cc', 'hcc.mjs'].includes(path.basename(words[offset] || '')) &&
        words[offset + 1] === 'hook') return true;
  }
  // Older installers wrote the absolute script path without shell quoting.
  // Match only that entire generated form, not a command that merely mentions hcc.
  const legacy = typeof cmd === 'string' &&
    /^(\/[^\r\n;&|<>$`()\\]*\/hcc\.mjs) hook (?:sessionstart|userpromptsubmit|pretooluse|posttooluse|stop)$/i.exec(cmd);
  return Boolean(legacy && !/\s\//.test(legacy[1]));
}

function mergeCodexHookEntry(existing, command, matcher) {
  const entries = removeHccHooks(hookEntries(existing)).entries;

  const entry = {
    hooks: [{ type: 'command', command }],
  };
  if (matcher) entry.matcher = matcher;
  entries.push(entry);
  return entries;
}

function readHookConfig(filePath) {
  let contents;
  try { contents = fs.readFileSync(filePath, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let config;
  try { config = JSON.parse(contents); }
  catch { throw new CliError('INVALID_HOOK_CONFIG', `Invalid JSON in ${filePath}; hooks were not changed`); }
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      (config.hooks !== undefined && (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)))) {
    throw new CliError('INVALID_HOOK_CONFIG', `Invalid hooks structure in ${filePath}; hooks were not changed`);
  }
  if (config.hooks && Object.values(config.hooks).some(entries => !Array.isArray(entries))) {
    throw new CliError('INVALID_HOOK_CONFIG', `Invalid hook event in ${filePath}; hooks were not changed`);
  }
  return config;
}

function hookEntries(existing) {
  if (existing === undefined) return [];
  if (Array.isArray(existing)) return existing;
  throw new CliError('INVALID_HOOK_CONFIG', 'Hook event must be an array; hooks were not changed');
}

function removeHccHooks(entries) {
  let removed = false;
  const kept = [];
  for (const entry of entries) {
    if (!Array.isArray(entry?.hooks)) {
      kept.push(entry);
      continue;
    }
    const hooks = entry.hooks.filter(hook => {
      if (!isHccHookCmd(hook?.command)) return true;
      removed = true;
      return false;
    });
    if (hooks.length === entry.hooks.length) kept.push(entry);
    else if (hooks.length) kept.push({ ...entry, hooks });
  }
  return { entries: kept, removed };
}

function shellWords(command) {
  if (typeof command !== 'string') return null;
  const words = [];
  let word = '';
  let started = false;
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
    } else if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === '\\') word += command[++i] || '';
      else if (char === '$' || char === '`') return null;
      else word += char;
    } else if (/\s/.test(char)) {
      if (started) { words.push(word); word = ''; started = false; }
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === '\\') {
      word += command[++i] || '';
      started = true;
    } else if (';&|<>$`()'.includes(char)) {
      return null;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}
