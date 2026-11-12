import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { loadWindowsNative } from './windows-native.mjs';
import { windowsEnvironment } from './windows-command.mjs';
import { CliError } from '../shared/errors.mjs';

const hccEntry = fileURLToPath(new URL('../../bin/hcc.mjs', import.meta.url));
const terminalHostEntry = fileURLToPath(new URL('../../bin/windows-terminal-host.mjs', import.meta.url));
function sameFile(left, right) {
  try { return fs.realpathSync.native(left).toLowerCase() === fs.realpathSync.native(right).toLowerCase(); }
  catch { return false; }
}

// This handoff is reserved for this installation's own service roots. Arbitrary
// provider commands use owned Jobs and cannot select this detached lifecycle.
export function spawnWindowsServiceHost(file, args, { cwd, env = process.env, lease, log } = {}) {
  const environment = windowsEnvironment(env);
  const valid = process.platform === 'win32' && typeof cwd === 'string' && path.isAbsolute(cwd) &&
    sameFile(file, process.execPath) && Array.isArray(args) && args.every(arg => typeof arg === 'string' && !arg.includes('\0')) &&
    ((sameFile(args[0], terminalHostEntry) && args.length === 3 && args[1] === '--state-dir' && args[2] === cwd) ||
    (sameFile(args[0], hccEntry) && args[1] === '--root' && args[2] === cwd && args[3] === '--db' &&
    typeof args[4] === 'string' && path.isAbsolute(args[4]) &&
    ((args.length === 7 && args[5] === 'native' && args[6] === 'serve') ||
      (args[5] === 'web' && environment.HCC_WEB_CHILD === '1'))));
  if (!valid) throw new CliError('WINDOWS_SERVICE_ENTRY_INVALID',
    'Detached Windows launch is restricted to this installation’s HCC service entry');
  if (!lease || !log?.native) throw new CliError('WINDOWS_SERVICE_RESOURCES_REQUIRED',
    'HCC service launch requires a selected-directory lease and private append resource');
  log.assertUnchanged();
  const controller = loadWindowsNative().startDetachedHost({ file: process.execPath, args: [...args], cwd,
    env: environment, lease, log: log.native });
  return new WindowsServiceChild(controller);
}

class WindowsServiceChild extends EventEmitter {
  constructor(controller) {
    super();
    this.pid = controller.pid; this.creationTime = controller.creationTime;
    this.exitCode = null; this.signalCode = null; this.killed = false;
    this._controller = controller; this._closed = false; this._detached = false; this._failure = null;
    this._completion = new Promise(resolve => { this._resolveCompletion = resolve; });
    this._timer = setInterval(() => this._poll(), 20);
    queueMicrotask(() => { this.emit('spawn'); this._poll(); });
  }

  _poll() {
    if (this._closed) return;
    try {
      const status = this._controller.poll();
      if (!status.exited) return;
      this.exitCode = status.exitCode;
      this.emit('exit', this.exitCode, null);
      this._finish();
    } catch (error) { this._finish(error); }
  }

  _finish(error) {
    if (this._closed) return;
    this._closed = true; clearInterval(this._timer);
    try { this._controller.close(); } catch (cleanupError) { error ||= cleanupError; }
    if (error) this._failure = new CliError('WINDOWS_SERVICE_CLOSE_UNCONFIRMED',
      'Cannot confirm HCC service-root exit', { cause: error.code || error.message });
    this._resolveCompletion(this._failure);
    if (error) this.emit('error', error);
    this.emit('close', this.exitCode, null);
  }

  kill(...args) {
    if (args.length) throw new CliError('WINDOWS_SIGNAL_UNSUPPORTED', 'Use kill() to cancel this owned HCC service startup');
    if (this._closed) return false;
    this._controller.terminate(); this.killed = true; return true;
  }

  async close({ timeoutMs = 5000 } = {}) {
    if (this._detached) throw new CliError('WINDOWS_SERVICE_ALREADY_DETACHED', 'HCC service ownership was already handed off');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new CliError('BAD_ARGS', 'Service close timeout must be 1..60000ms');
    if (this._closed) { if (this._failure) throw this._failure; return; }
    this.kill();
    let timer;
    try {
      const failure = await Promise.race([this._completion, new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new CliError('WINDOWS_SERVICE_CLOSE_UNCONFIRMED',
          'The HCC service root did not confirm exit before the deadline')), timeoutMs);
      })]);
      if (failure) throw failure;
    } finally { clearTimeout(timer); }
  }

  // The caller invokes this only after authenticating the service's published
  // identity and readiness. The root retains all inherited protection handles.
  detach() {
    if (this._detached) return;
    if (this._closed) throw new CliError('WINDOWS_SERVICE_EXITED', 'HCC service exited before ownership handoff');
    this._controller.detach();
    this._detached = true; this._closed = true; clearInterval(this._timer);
  }

  unref() {
    if (!this._detached) throw new CliError('WINDOWS_SERVICE_HANDOFF_REQUIRED', 'Authenticate HCC service readiness before detaching its launcher');
    return this;
  }
}
