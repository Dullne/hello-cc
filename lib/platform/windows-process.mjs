import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { loadWindowsNative } from './windows-native.mjs';
import { windowsEnvironment } from './windows-command.mjs';
import { CliError } from '../shared/errors.mjs';

const TRANSFER_BYTES = 64 * 1024;

// Selected-directory callers supply an opaque pinned lease. Native startup
// inherits its handles into the suspended root before any provider code runs;
// the controller also retains them until its Job and output finish draining.
export function spawnWindowsOwnedProcess(file, args = [], { cwd = process.cwd(), env = process.env, lease } = {}) {
  if (process.platform !== 'win32') throw new CliError('WINDOWS_PROCESS_UNAVAILABLE', 'Owned Windows processes require Windows');
  if (typeof file !== 'string' || !path.isAbsolute(file) || !Array.isArray(args) ||
      args.some(value => typeof value !== 'string') || typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    throw new CliError('WINDOWS_PROCESS_ARGUMENT_INVALID', 'Owned process launch requires absolute executable/cwd paths and string arguments');
  }
  const native = loadWindowsNative();
  if (typeof native.startOwnedProcess !== 'function') throw new CliError('WINDOWS_PROCESS_UNAVAILABLE', 'The native process component is unavailable');
  const controller = native.startOwnedProcess({ file, args, cwd, env: windowsEnvironment(env),
    ...(lease === undefined ? {} : { lease }) });
  return new OwnedWindowsChild(controller);
}

export function createWindowsPtyProcess(file, args, { cwd, env, lease, cols, rows }) {
  if (!lease) throw new CliError('WINDOWS_PTY_LEASE_REQUIRED', 'Windows terminals require a selected-directory lease');
  const native = loadWindowsNative();
  if (typeof native?.startOwnedPty !== 'function') throw new CliError('WINDOWS_PTY_UNAVAILABLE', 'The native Windows terminal component is unavailable');
  return new OwnedWindowsChild(native.startOwnedPty({ file, args, cwd, env: windowsEnvironment(env), lease, cols, rows }));
}

class OwnedWindowsChild extends EventEmitter {
  constructor(controller) {
    super();
    this.pid = controller.pid;
    this.creationTime = controller.creationTime;
    this.imagePath = controller.imagePath;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this._controller = controller;
    this._closed = false;
    this._closeFailure = null;
    this._write = null;
    this._final = null;
    this._stdinClosing = false;
    this._output = ['Stdout', 'Stderr'].map(name => ({
      name, ended: false, paused: false,
      stream: new Readable({ highWaterMark: TRANSFER_BYTES,
        read: () => { const output = this._output.find(item => item.name === name); if (output) output.paused = false; } })
    }));
    [this.stdout, this.stderr] = this._output.map(output => output.stream);
    this.stdin = new Writable({ highWaterMark: TRANSFER_BYTES,
      write: (buffer, encoding, callback) => { this._write = { buffer, offset: 0, callback }; },
      final: callback => { this._final = callback; },
      destroy: (error, callback) => {
        if (!this._closed) {
          try { this._controller.closeStdin(); } catch {}
        }
        callback(error);
      }
    });
    // Child stdin failures are stream errors; consumers may subscribe without
    // turning an expected broken pipe during termination into an uncaught error.
    this.stdin.on('error', () => {});
    this._completion = new Promise(resolve => { this._resolveCompletion = resolve; });
    this._timer = setInterval(() => this._poll(), 10);
    queueMicrotask(() => { this.emit('spawn'); this._poll(); });
  }

  _pumpOutput(output) {
    if (output.stream.destroyed) output.paused = false;
    if (output.ended || output.paused) return;
    for (let i = 0; i < 4; i++) {
      const data = this._controller['read' + output.name](TRANSFER_BYTES);
      if (data === null) { output.ended = true; output.stream.push(null); return; }
      if (data.length === 0) return;
      if (!output.stream.destroyed && !output.stream.push(data)) { output.paused = true; return; }
    }
  }

  _pumpInput(status) {
    if (this._write) {
      const pending = this._write;
      if (status.stdinError || status.stdinClosed) {
        this._write = null;
        const error = new Error('Owned process stdin is closed');
        error.code = 'EPIPE';
        pending.callback(error);
      } else {
        if (pending.offset < pending.buffer.length) {
          const end = Math.min(pending.offset + TRANSFER_BYTES, pending.buffer.length);
          if (this._controller.writeStdin(pending.buffer.subarray(pending.offset, end))) pending.offset = end;
        }
        // Report write completion after the native writer has written bytes,
        // rather than acknowledging data merely accepted into its bounded queue.
        if (pending.offset === pending.buffer.length && this._controller.poll().pendingBytes === 0) {
          this._write = null;
          pending.callback();
        }
      }
    }
    if (this._final && !this._write) {
      if (!this._stdinClosing) { this._controller.closeStdin(); this._stdinClosing = true; }
      if (this._controller.poll().stdinClosed) {
        const callback = this._final; this._final = null; callback();
      }
    }
  }

  _poll() {
    if (this._closed) return;
    try {
      let status = this._controller.poll();
      this._pumpInput(status);
      for (const output of this._output) this._pumpOutput(output);
      status = this._controller.poll();
      if (status.ptyError) throw new CliError('WINDOWS_PTY_ERROR', 'The Windows terminal control operation failed', { win32Error: status.ptyError });
      if (status.ptyClosed === false && status.exited && status.activeProcesses === 0) this._controller.endPty();
      if (status.exited && this.exitCode === null) {
        this.exitCode = status.exitCode;
        this.emit('exit', this.exitCode, null);
      }
      if (status.exited && status.activeProcesses === 0 && status.ptyClosed !== false && this._output.every(output =>
        output.ended && (output.stream.readableEnded || output.stream.destroyed))) {
        this._finish();
      }
    } catch (error) {
      try { this._controller.terminate(); } catch {}
      this._finish(error);
    }
  }

  _finish(error) {
    if (this._closed) return;
    this._closed = true;
    clearInterval(this._timer);
    try { this._controller.close(); } catch (cleanupError) { error ||= cleanupError; }
    if (error) this._closeFailure = new CliError('WINDOWS_PROCESS_CLOSE_UNCONFIRMED',
      'Owned process cleanup could not confirm process-tree exit and complete output',
      { cause: error.code || error.message });
    if (this._write) {
      const callback = this._write.callback; this._write = null;
      callback(error || Object.assign(new Error('Owned process stdin is closed'), { code: 'EPIPE' }));
    }
    if (this._final) { const callback = this._final; this._final = null; callback(error); }
    this.stdin.destroy();
    for (const output of this._output) if (!output.ended) { output.ended = true; output.stream.push(null); }
    this._resolveCompletion(this._closeFailure);
    if (error) this.emit('error', error);
    this.emit('close', this.exitCode, null);
  }

  // Explicit Job termination has no POSIX signal semantics.
  resize(cols, rows) { this._controller.resize(cols, rows); }

  kill(...args) {
    if (args.length) throw new CliError('WINDOWS_SIGNAL_UNSUPPORTED', 'Use kill() to terminate the owned Windows Job; signal arguments are unsupported');
    if (this._closed) return false;
    this._controller.terminate();
    this.killed = true;
    return true;
  }

  async closeOwned({ eofGraceMs = 1000, timeoutMs = 5000 } = {}) {
    if (!Number.isSafeInteger(eofGraceMs) || eofGraceMs < 0 || eofGraceMs > 60000) {
      throw new CliError('BAD_ARGS', 'Owned process EOF grace must be 0..60000ms');
    }
    this.stdout.resume(); this.stderr.resume();
    let timer;
    try {
      if (!this._closed) {
        this.stdin.end();
        await Promise.race([this._completion, new Promise(resolve => { timer = setTimeout(resolve, eofGraceMs); })]);
      }
    } finally { clearTimeout(timer); }
    // close() checks an earlier observation failure too. A close event by
    // itself must never turn uncertain native cleanup into success.
    await this.close({ timeoutMs });
  }

  async close({ timeoutMs = 5000 } = {}) {
    if (this._closed) {
      if (this._closeFailure) throw this._closeFailure;
      return;
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
      throw new CliError('BAD_ARGS', 'Owned process close timeout must be 1..60000ms');
    }
    this.stdout.resume(); this.stderr.resume();
    this.kill();
    let timeout;
    try {
      const failure = await Promise.race([this._completion, new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new CliError('WINDOWS_PROCESS_CLOSE_UNCONFIRMED',
          'The owned process tree did not confirm exit before the deadline')), timeoutMs);
      })]);
      if (failure) throw failure;
    } finally { clearTimeout(timeout); }
  }
}
