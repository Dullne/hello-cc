import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { loadWindowsNative } from '../platform/windows-native.mjs';
import { resolveWindowsCommand } from '../platform/windows-command.mjs';
import { inspectWindowsHomeAncestry } from '../platform/windows-private-state.mjs';

// Environment diagnosis has no project/database dependency and performs no
// installation, provider login, inference or configuration mutation.
export function diagnoseEnvironment() {
  const node = { version: process.versions.node, required: '>=24.0.0',
    ok: Number(process.versions.node.split('.')[0]) >= 24 };
  const platform = { os: process.platform, arch: process.arch, release: os.release() };
  let terminal, native, permissions = null;
  const providers = {};
  if (process.platform === 'win32') {
    try {
      const component = loadWindowsNative();
      native = { status: 'available', capabilities: { ...component.capabilities } };
      const require = createRequire(import.meta.url);
      let terminalAssets = fs.existsSync(new URL('../../bin/windows-terminal-host.mjs', import.meta.url));
      try { require.resolve('@xterm/headless'); require.resolve('@xterm/addon-serialize'); require.resolve('ws'); }
      catch { terminalAssets = false; }
      native.capabilities.persistentTerminal = terminalAssets && typeof component.startOwnedPty === 'function' &&
        typeof component.startDetachedHost === 'function' && typeof component.captureDirectory === 'function';
    } catch (error) {
      native = { status: 'unavailable', code: 'WINDOWS_NATIVE_UNAVAILABLE',
        reason: error.code === 'WINDOWS_NATIVE_UNAVAILABLE' ? error.extra?.reason || 'load_failed' : 'load_failed' };
    }
    terminal = { backend: 'windows-terminal', available: native.capabilities?.persistentTerminal === true };
    if (native.status === 'available') {
      try { inspectWindowsHomeAncestry(os.homedir()); permissions = { profile: 'trusted', filesystem: 'NTFS', checked: true }; }
      catch (error) { permissions = { profile: 'unavailable', checked: true, code: error.code || 'PROJECT_PATH_FORBIDDEN' }; }
      for (const command of ['claude', 'codex', 'dsh']) {
        try { const resolved = resolveWindowsCommand(command); providers[command] = { available: true, kind: resolved.kind, executable: resolved.file }; }
        catch (error) { providers[command] = { available: false, code: error.code || 'WINDOWS_COMMAND_NOT_FOUND' }; }
      }
    }
  } else {
    const result = spawnSync('tmux', ['-V'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000, maxBuffer: 4096
    });
    terminal = { backend: 'tmux', available: result.status === 0 };
    native = { status: 'not_required' };
  }
  const supportedPlatform = ['linux', 'darwin', 'win32'].includes(process.platform);
  const ready = node.ok && supportedPlatform && terminal.available && permissions?.profile !== 'unavailable';
  const actions = [];
  if (!node.ok) actions.push('Install Node.js 24 or later in the environment used to run hcc.');
  if (!supportedPlatform) actions.push('This operating system is not supported.');
  if (permissions?.profile === 'unavailable') actions.push('Use an owned local NTFS profile with trusted directory ancestry; inspect its permissions before initializing state.');
  if (process.platform === 'win32' && !terminal.available) {
    if (native.status === 'unavailable') actions.push(native.reason === 'target_unsupported'
      ? 'This build requires Windows x64.'
      : 'Reinstall a complete Windows package whose native component matches its source and manifest.');
    else actions.push('Install a complete package containing the Windows terminal service and its dependencies.');
  } else if (!terminal.available) actions.push('Install tmux and ensure it is on PATH.');
  return { ready, node, platform, terminal, native, permissions, providers, database_checked: false, actions };
}
