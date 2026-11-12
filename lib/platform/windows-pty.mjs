import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { preparePinnedCwdLaunch } from '../process/pinned-cwd.mjs';
import { CliError } from '../shared/errors.mjs';

export function spawnWindowsPty(command, args = [], { cwd = process.cwd(), env = process.env,
  expectedIdentity, cols = 80, rows = 24 } = {}) {
  if (process.platform !== 'win32') throw new CliError('WINDOWS_PTY_UNAVAILABLE', 'Windows terminals require Windows');
  const binding = preparePinnedCwdLaunch(cwd, command, args, { env, expectedIdentity });
  try { return new WindowsPty(binding.spawnPty({ cols, rows })); }
  finally { binding.release(); }
}

class WindowsPty {
  constructor(child) {
    this.pid = child.pid; this.creationTime = child.creationTime;
    Object.defineProperty(this, 'processIdentity', { enumerable: true, value: Object.freeze({
      pid: child.pid, startToken: `win32:v1:${child.creationTime}`,
      commandHash: createHash('sha256').update('win32:image-path:v1\0').update(child.imagePath).digest('hex')
    }) });
    this._child = child; this._events = new EventEmitter(); this._exit = null; this._error = null;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => this._events.emit('data', data));
    child.stderr.resume();
    child.on('error', error => { this._error = error; this._events.emit('failure', error); });
    child.once('close', code => {
      this._exit = { exitCode: code, signal: 0, ...(this._error ? { uncertain: true, error: this._error.code || 'WINDOWS_PTY_ERROR' } : {}) };
      this._events.emit('exit', this._exit);
    });
  }

  onData(callback) { return this._subscribe('data', callback); }
  onExit(callback) {
    if (typeof callback !== 'function') throw new TypeError('Terminal exit handler must be a function');
    if (this._exit) {
      let disposed = false; queueMicrotask(() => { if (!disposed) callback(this._exit); });
      return { dispose() { disposed = true; } };
    }
    return this._subscribe('exit', callback);
  }
  onError(callback) { return this._subscribe('failure', callback); }
  _subscribe(name, callback) {
    if (typeof callback !== 'function') throw new TypeError('Terminal handler must be a function');
    this._events.on(name, callback);
    return { dispose: () => this._events.off(name, callback) };
  }

  write(value) {
    if (typeof value !== 'string' || !value.isWellFormed()) throw new CliError('BAD_ARGS', 'Terminal input must be valid Unicode text');
    const bytes = Buffer.from(value);
    if (bytes.length > 65536) throw new CliError('WINDOWS_PTY_INPUT_TOO_LARGE', 'A terminal input frame may contain at most 64 KiB');
    if (!this._child._controller.writeStdin(bytes)) throw new CliError('WINDOWS_PTY_BACKPRESSURE', 'The terminal input queue is full; retry after it drains');
    return true;
  }
  resize(cols, rows) { this._child._controller.resize(cols, rows); }
  pause() { this._child.stdout.pause(); }
  resume() { this._child.stdout.resume(); }
  terminateOwned() { return this._child.kill(); }
  kill(...args) { return this._child.kill(...args); }
  closeOwned(options) { return this._child.close(options); }
}
