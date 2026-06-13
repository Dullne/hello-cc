import fs from 'node:fs';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { CliError } from './errors.mjs';
import { shellQuoteArg } from './format.mjs';

export function runTmux(args, opts = {}) {
  const result = spawnSync('tmux', args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    input: opts.input || ''
  });
  if (result.error) {
    throw new CliError('TMUX_ERROR', `tmux failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || '').trim() || `tmux ${args.join(' ')} failed`;
    throw new CliError('TMUX_ERROR', message);
  }
  return result.stdout || '';
}

function tmuxInstallHint() {
  if (process.platform === 'darwin') return 'Install tmux with: brew install tmux';
  if (process.platform === 'linux') {
    if (fs.existsSync('/etc/debian_version')) return 'Install tmux with: sudo apt-get update && sudo apt-get install -y tmux';
    if (fs.existsSync('/etc/alpine-release')) return 'Install tmux with: sudo apk add tmux';
    if (fs.existsSync('/etc/arch-release')) return 'Install tmux with: sudo pacman -S --noconfirm tmux';
    if (fs.existsSync('/etc/fedora-release')) return 'Install tmux with: sudo dnf install -y tmux';
    return 'Install tmux with your system package manager.';
  }
  return 'Install tmux and make sure it is on PATH.';
}

function commandExists(name) {
  return spawnSync('sh', ['-lc', `command -v ${shellQuoteArg(name)} >/dev/null 2>&1`], {
    stdio: ['ignore', 'ignore', 'ignore']
  }).status === 0;
}

function runInstallCommand(command) {
  const result = spawnSync('sh', ['-lc', command], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000
  });
  return {
    ok: result.status === 0,
    output: [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
  };
}

export function tryInstallTmux() {
  if (process.env.HCC_NO_AUTO_INSTALL_TMUX === '1') {
    return { ok: false, output: 'automatic tmux installation disabled by HCC_NO_AUTO_INSTALL_TMUX=1' };
  }
  const sudo = typeof process.getuid === 'function' && process.getuid() === 0 ? '' : (commandExists('sudo') ? 'sudo ' : '');
  if (process.platform === 'darwin' && commandExists('brew')) {
    return runInstallCommand('brew install tmux');
  }
  if (process.platform === 'linux') {
    if (commandExists('apt-get')) {
      const update = runInstallCommand(`${sudo}apt-get update`);
      if (!update.ok) return update;
      return runInstallCommand(`${sudo}apt-get install -y tmux`);
    }
    if (commandExists('dnf')) return runInstallCommand(`${sudo}dnf install -y tmux`);
    if (commandExists('yum')) return runInstallCommand(`${sudo}yum install -y tmux`);
    if (commandExists('apk')) return runInstallCommand(`${sudo}apk add tmux`);
    if (commandExists('pacman')) return runInstallCommand(`${sudo}pacman -S --noconfirm tmux`);
  }
  return { ok: false, output: 'no supported package manager found' };
}

export function ensureTmuxAvailable({ autoInstall = true } = {}) {
  if (spawnSync('tmux', ['-V'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).status === 0) return;
  let install = { ok: false, output: '' };
  if (autoInstall) {
    install = tryInstallTmux();
    if (install.ok && spawnSync('tmux', ['-V'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).status === 0) return;
  }
  const detail = install.output ? `\n\nAutomatic install failed:\n${install.output}` : '';
  throw new CliError('TMUX_REQUIRED', `tmux is required for browser-controllable local terminals. ${tmuxInstallHint()}${detail}`);
}

export function tmuxHasSession(sessionName) {
  const result = spawnSync('tmux', ['has-session', '-t', sessionName], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return result.status === 0;
}

export function tmuxSessionHasClients(sessionName) {
  const result = spawnSync('tmux', ['list-clients', '-t', sessionName], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.status !== 0) return false;
  return Boolean((result.stdout || '').trim());
}

export function tmuxKillSession(sessionName) {
  const result = spawnSync('tmux', ['kill-session', '-t', sessionName], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.status !== 0 && !String(result.stderr || result.stdout || '').includes('can\'t find session')) {
    const message = (result.stderr || result.stdout || '').trim() || `tmux kill-session -t ${sessionName} failed`;
    throw new CliError('TMUX_ERROR', message);
  }
}

export function tmuxSessionEnvironmentValue(sessionName, key) {
  const result = spawnSync('tmux', ['show-environment', '-t', sessionName, key], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.status !== 0) return null;
  const line = (result.stdout || '').trim();
  if (!line || line.startsWith('-')) return null;
  const prefix = `${key}=`;
  return line.startsWith(prefix) ? line.slice(prefix.length) : null;
}
