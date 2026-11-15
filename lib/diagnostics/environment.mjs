import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { loadWindowsNative } from '../platform/windows-native.mjs';
import { resolveWindowsCommand } from '../platform/windows-command.mjs';
import { inspectWindowsHomeAncestry, inspectWindowsPrivateDirectory } from '../platform/windows-private-state.mjs';

function inspectExistingWindowsState(home) {
  const root = path.join(home, '.hello-cc');
  let current = root, checked = 0;
  const forbidden = () => Object.assign(new Error('Untrusted state object'), { code: 'PROJECT_PATH_FORBIDDEN' });
  try {
    try { fs.lstatSync(root); }
    catch (error) { if (error.code === 'ENOENT') return { status: 'absent', path: root, checked: true }; throw error; }
    const native = loadWindowsNative();
    function inspect(target, depth = 0) {
      current = target;
      if (++checked > 10000 || depth > 32) {
        throw Object.assign(new Error('State inspection limit reached'), { code: 'STATE_INSPECTION_LIMIT' });
      }
      const stat = fs.lstatSync(target);
      const requiredDirectory = target === root ||
        (path.dirname(target) === root && ['projects', 'tls'].includes(path.basename(target).toLowerCase()));
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) ||
          (requiredDirectory && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) throw forbidden();
      if (stat.isDirectory()) {
        // No scope/pin is acquired: inspection must not create sentinel files.
        inspectWindowsPrivateDirectory(target);
        const directory = fs.opendirSync(target);
        try {
          let entry;
          while ((entry = directory.readSync())) inspect(path.join(target, entry.name), depth + 1);
        } finally { directory.closeSync(); }
      } else if (native.inspectPathSecurity(target).private !== true) throw forbidden();
    }
    inspect(root);
    return { status: 'trusted', path: root, checked: true, entries_checked: checked };
  } catch (error) {
    return { status: 'unavailable', path: current, checked: true, code: error.code || 'PROJECT_PATH_FORBIDDEN' };
  }
}

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
      try {
        const home = os.homedir();
        inspectWindowsHomeAncestry(home);
        permissions = { profile: 'trusted', filesystem: 'NTFS', checked: true, state: inspectExistingWindowsState(home) };
      }
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
  const ready = node.ok && supportedPlatform && terminal.available && permissions?.profile !== 'unavailable' &&
    permissions?.state?.status !== 'unavailable';
  const actions = [];
  if (!node.ok) actions.push('Install Node.js 24 or later in the environment used to run hcc.');
  if (!supportedPlatform) actions.push('This operating system is not supported.');
  if (permissions?.profile === 'unavailable') actions.push('Use an owned local NTFS profile with trusted directory ancestry; inspect its permissions before initializing state.');
  if (permissions?.state?.status === 'unavailable') {
    actions.push(permissions.state.code === 'STATE_INSPECTION_LIMIT'
      ? `State inspection exceeded its directory/entry limit at ${permissions.state.path}; inspect and archive old state before retrying.`
      : `Inspect existing state at ${permissions.state.path}: require owned private permissions, ordinary directories and single-link files without reparse points. Back up existing data before repairing permissions or restoring damaged entries.`);
  }
  if (process.platform === 'win32' && !terminal.available) {
    if (native.status === 'unavailable') actions.push(native.reason === 'target_unsupported'
      ? 'This build requires Windows x64.'
      : 'Reinstall a complete Windows package whose native component matches its source and manifest.');
    else actions.push('Install a complete package containing the Windows terminal service and its dependencies.');
  } else if (!terminal.available) actions.push('Install tmux and ensure it is on PATH.');
  return { ready, node, platform, terminal, native, permissions, providers, database_checked: false, actions };
}
