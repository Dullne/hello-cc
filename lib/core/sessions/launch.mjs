import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { shortHash } from '../peers/format.mjs';

export const WEB_CHILD_ENV = 'HCC_WEB_CHILD';
export const LAUNCH_FINGERPRINT_ENV = 'HCC_LAUNCH_FINGERPRINT';
export const PROVIDER_STATE_ENV = 'HCC_PROVIDER_STATE';

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

export function childSessionEnv(extra = {}, baseEnv = process.env) {
  const env = { ...(baseEnv || {}), ...extra };
  delete env[WEB_CHILD_ENV];
  return env;
}

export function launchEnvironmentFingerprint(env) {
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

export function launchFingerprint({ command, cwd, env }) {
  return shortHash(JSON.stringify({
    command: command || '',
    cwd: cwd || '',
    env: launchEnvironmentFingerprint(env || {})
  }));
}

export function isLikelyShellCommand(command) {
  const base = path.basename(String(command || '')).replace(/^-/, '');
  return new Set(['bash', 'dash', 'fish', 'ksh', 'mksh', 'sh', 'zsh']).has(base);
}

export function isProviderFallbackWrapper(command) {
  const text = String(command || '');
  return text.includes(PROVIDER_STATE_ENV) || /\bexec\s+(?:bash|dash|fish|ksh|mksh|sh|zsh)\b/.test(text);
}

export function isRelaunchableProviderSession(kind, command, binding = {}) {
  const provider = binding.provider || kind;
  return ['claude', 'codex'].includes(provider) && isProviderFallbackWrapper(command);
}

export function isolatedEnvCommandArgs(env) {
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
