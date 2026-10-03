import fs from 'node:fs';
import path from 'node:path';
import { CliError } from '../../shared/errors.mjs';
import { spawnPinnedCwdProcess } from '../../process/pinned-cwd.mjs';

function assertExecutableAvailable(binary, cwd, env) {
  const searchPath = env === undefined ? process.env.PATH : env.PATH;
  const candidates = binary.includes('/')
    ? [path.resolve(cwd, binary)]
    : String(searchPath === undefined ? '/usr/bin:/bin' : searchPath)
      .split(path.delimiter).map(entry => path.resolve(cwd, entry || '.', binary));
  let inaccessible = false;
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return;
    } catch (error) {
      if (error?.code === 'EACCES') inaccessible = true;
    }
  }
  const code = inaccessible ? 'EACCES' : 'ENOENT';
  throw Object.assign(new Error('Cannot start ' + binary + ': ' + code), {
    code, path: binary, syscall: 'spawn'
  });
}

// Each transport owns the child it starts. It never connects to a desktop
// application's private server or signals a process supplied by the caller.
export class JsonRpcProcess {
  constructor(options = {}) {
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.closed = false;
    this.child = null;
    this.closePromise = null;
    this.lastCloseError = null;
  }

  async start() {
    if (this.child || this.closed) throw new CliError('NATIVE_TRANSPORT_STATE', 'Transport cannot be started twice');
    const { binary, args = [], cwd, env } = this.options;
    assertExecutableAvailable(binary, cwd || process.cwd(), env);
    this.child = spawnPinnedCwdProcess(binary, args, {
      cwd: cwd || process.cwd(), env, shell: false, stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.read(chunk));
    // Drain stderr without putting credentials or unbounded provider logs into
    // the shared message bus. Protocol errors are reported through requests.
    this.child.stderr.resume();
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.on('error', (error) => this.fail(new CliError('NATIVE_SPAWN_FAILED', `Cannot start ${binary}: ${error.message}`)));
    this.child.once('exit', (code, signal) => {
      const error = new CliError('NATIVE_PROCESS_EXITED', 'Native provider process exited', { code, signal, uncertain: true });
      this.fail(error);
      this.options.onExit?.({ code, signal, expected: this.closed });
    });
    await new Promise((resolve, reject) => {
      this.child.once('spawn', resolve);
      this.child.once('error', reject);
    });
    return this;
  }

  read(chunk) {
    this.buffer += chunk;
    const maxBytes = this.options.maxFrameBytes || 4 * 1024 * 1024;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line) > maxBytes) return this.protocolFailure('Native protocol frame is too large');
      let frame;
      try { frame = JSON.parse(line); } catch { return this.protocolFailure('Invalid JSON from native provider'); }
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return this.protocolFailure('Invalid native protocol frame');
      if (frame.method) {
        if (Object.hasOwn(frame, 'id')) void this.handleRequest(frame);
        else Promise.resolve().then(() => this.options.onNotification?.(frame.method, frame.params || {}))
          .catch(() => this.protocolFailure('Native notification handler failed'));
      } else if (Object.hasOwn(frame, 'id')) {
        const request = this.pending.get(frame.id);
        if (!request) continue; // Late response to an uncertain, timed-out request.
        this.pending.delete(frame.id);
        clearTimeout(request.timer);
        if (frame.error) request.reject(new CliError('NATIVE_RPC_ERROR', frame.error.message || 'Native provider rejected request', {
          method: request.method, rpc_code: frame.error.code, data: frame.error.data
        }));
        else if (Object.hasOwn(frame, 'result')) request.resolve(frame.result);
        else request.reject(new CliError('NATIVE_PROTOCOL_ERROR', 'Native response contains neither result nor error'));
      }
    }
    if (Buffer.byteLength(this.buffer) > maxBytes) this.protocolFailure('Native protocol frame is too large');
  }

  async handleRequest(frame) {
    try {
      if (!this.options.onRequest) throw new Error('Unsupported native server request');
      const result = await this.options.onRequest(frame.method, frame.params || {}, frame.id);
      this.write({ id: frame.id, result: result ?? null });
    } catch (error) {
      if (!this.closed) {
        try { this.write({ id: frame.id, error: { code: -32601, message: error.message || 'Unsupported server request' } }); } catch {}
      }
    }
  }

  protocolFailure(message) {
    if (this.closed) return;
    const error = new CliError('NATIVE_PROTOCOL_ERROR', message, { uncertain: true });
    this.fail(error);
    this.reportError(error);
    // Report failed cleanup without an unhandled rejection. Explicit callers
    // may retry termination; the original attempt keeps its failure receipt.
    void this.close().catch((closeError) => {
      this.lastCloseError = closeError;
      this.reportError(closeError);
    });
  }

  reportError(error) {
    try {
      const delivery = this.options.onError?.(error);
      delivery?.catch?.(() => {});
    } catch {}
  }

  fail(error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  write(frame) {
    if (this.closed || !this.child || this.child.exitCode !== null || this.child.signalCode !== null || !this.child.stdin.writable) {
      throw new CliError('NATIVE_TRANSPORT_CLOSED', 'Native provider connection is closed');
    }
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
  }

  request(method, params = {}, options = {}) {
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? 30000;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new CliError('NATIVE_REQUEST_TIMEOUT', `Native request timed out: ${method}`, { method, uncertain: true }));
      }, timeoutMs) : null;
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.write({ id, method, params }); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }

  notify(method, params = {}) { this.write({ method, params }); }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.fail(new CliError('NATIVE_TRANSPORT_CLOSED', 'Native provider connection closed', { uncertain: true }));
    const child = this.child;
    // A failed spawn has no PID and emits close/error, but never exit.
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
      this.closePromise = Promise.resolve();
      return this.closePromise;
    }
    this.closePromise = new Promise((resolve, reject) => {
      let termTimer;
      let killTimer;
      const cleanup = () => {
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        child.removeListener('exit', exited);
        child.removeListener('error', failed);
      };
      const exited = () => { cleanup(); resolve(); };
      const failed = (error) => {
        cleanup();
        this.lastCloseError = new CliError('NATIVE_CLOSE_FAILED', 'Cannot confirm native provider process termination', {
          pid: child.pid, uncertain: true, cause: error.code || error.message
        });
        reject(this.lastCloseError);
      };
      const signal = (name) => {
        try {
          if (!child.kill(name)) {
            failed(new CliError('NATIVE_SIGNAL_FAILED', `Native process did not accept ${name}`));
            return false;
          }
          return true;
        } catch (error) { failed(error); return false; }
      };
      child.once('exit', exited);
      child.once('error', failed);
      termTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return exited();
        // Sending SIGKILL is not an exit receipt. Continue waiting for exit.
        killTimer = setTimeout(() => failed(new CliError('NATIVE_EXIT_TIMEOUT',
          'Native provider did not report exit after SIGKILL')), this.options.closeKillTimeoutMs ?? 2000);
        signal('SIGKILL');
      }, this.options.closeGraceMs ?? 2000);
      try { child.stdin.end(); } catch {}
      signal('SIGTERM');
    });
    const closing = this.closePromise;
    void closing.catch(() => {
      // Share a pending attempt, but do not pin a transient signal/exit failure
      // forever. A retry must still confirm this owned child's actual exit.
      if (this.closePromise === closing) this.closePromise = null;
    });
    return closing;
  }
}
