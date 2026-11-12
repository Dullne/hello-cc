import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { JsonRpcProcess } from './jsonrpc.mjs';
import { CliError } from '../../shared/errors.mjs';
import { captureSelectedCwdIdentity } from '../../process/selected-cwd-identity.mjs';
import { windowsEnvironment } from '../../platform/windows-command.mjs';
import { helperJson, CLAUDE_HELPER_PROTOCOL, CLAUDE_HELPER_MAX_FRAME,
  CLAUDE_HELPER_MAX_PENDING, CLAUDE_HELPER_MAX_BUFFERED } from './claude-helper-protocol.mjs';

// Windows cannot infer ownership of subprocesses created by the SDK. Running
// the complete SDK adapter inside the pinned owned Job establishes ownership
// before SDK module initialization, including transcript forks and descendants.
export function createClaudeProcessAdapter(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const binding = captureSelectedCwdIdentity(cwd, options.expectedCwdIdentity);
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    binding.release(); throw new CliError('BAD_ARGS', 'Claude helper timeout must be 1..60000ms');
  }
  const capabilities = Object.freeze({ create: true, resume: true, send: true, observe: true,
    interrupt: true, close: true, steer: false, fork: true,
    approvals: Boolean(options.interactive), mcp: Boolean(options.mcpServers) });
  let current = { provider: 'claude', status: 'created', sessionId: null, turnId: null,
    submissionId: null, metrics: null, runtimeMetadata: {}, capabilities,
    executorId: options.executorId || randomUUID(), pendingApprovals: [] };
  let rpc, starting, closePromise, closed = false, pendingBytes = 0, pendingCount = 0;

  function snapshot() { return structuredClone(current); }
  function emit(event) {
    try { options.onEvent?.(event)?.catch?.(() => {}); } catch {}
  }
  function failure(error) {
    if (closed) return;
    current = { ...current, status: 'error', pendingApprovals: [] };
    emit({ type: 'error', provider: 'claude', sessionId: current.sessionId,
      turnId: current.turnId, code: error.code || 'NATIVE_SDK_ERROR', message: error.message });
    // A helper root may exit while an SDK grandchild remains alive. The Job,
    // rather than SDK close() or root exit, is the authoritative cleanup scope.
    void rpc?.close().then(() => binding.release()).catch(closeError => emit({ type: 'error', provider: 'claude',
      code: closeError.code, message: closeError.message }));
  }
  async function request(method, params) {
    const bytes = Buffer.byteLength(helperJson({ method, params })) + 128;
    if (bytes > CLAUDE_HELPER_MAX_FRAME || pendingCount >= CLAUDE_HELPER_MAX_PENDING ||
        pendingBytes + bytes > CLAUDE_HELPER_MAX_BUFFERED) {
      throw new CliError('NATIVE_PROTOCOL_LIMIT', 'Claude helper request queue exceeds its limit');
    }
    pendingBytes += bytes; pendingCount++;
    try {
      const reply = await rpc.request(method, params, { timeoutMs });
      if (reply?.snapshot) current = reply.snapshot;
      if (reply?.error) throw new CliError(reply.error.code, reply.error.message, reply.error.extra);
      if (!reply || !Object.hasOwn(reply, 'value')) throw new CliError('NATIVE_PROTOCOL_ERROR', 'Invalid Claude helper response');
      return reply.value;
    } finally { pendingBytes -= bytes; pendingCount--; }
  }
  function start() {
    if (starting) return starting;
    starting = (async () => {
      binding.assertUnchanged();
      const helperEnv = windowsEnvironment(options.env || process.env);
      // Node preloads must not replace the trusted helper entry point. The
      // requested provider environment is delivered as data after admission.
      delete helperEnv.NODE_OPTIONS;
      rpc = new JsonRpcProcess({ binary: process.execPath,
        args: [fileURLToPath(new URL('./claude-helper.mjs', import.meta.url))], cwd,
        env: helperEnv, expectedIdentity: binding, timeoutMs,
        maxFrameBytes: CLAUDE_HELPER_MAX_FRAME, closeEofGraceMs: 25, closeKillTimeoutMs: 5000,
        onNotification(method, params) {
          if (closed || method !== 'claude/event' || !params?.snapshot || !params?.event) return;
          current = params.snapshot; emit(params.event);
        },
        onExit: ({ expected }) => { if (!expected) failure(new CliError('NATIVE_PROCESS_EXITED', 'Claude SDK helper exited unexpectedly', { uncertain: true })); },
        onError: failure
      });
      try {
        await rpc.start();
        if (closed) throw new CliError('NATIVE_CLOSED', 'Claude native session is closed');
        await request('claude/init', { protocol: CLAUDE_HELPER_PROTOCOL, options: {
          cwd, env: options.env, coordinationEnv: options.env, timeoutMs,
          expectedCwdIdentity: { canonical: binding.canonical, identity: binding.identity },
          interactive: Boolean(options.interactive), executorId: current.executorId,
          ...(options.mcpServers ? { mcpServers: options.mcpServers } : {})
        } });
      } catch (error) {
        failure(error); await rpc.close(); throw error;
      }
    })();
    return starting;
  }
  async function invoke(method, params = {}) {
    if (closed) throw new CliError('NATIVE_CLOSED', 'Claude native session is closed');
    helperJson({ method, params });
    await start();
    if (closed) throw new CliError('NATIVE_CLOSED', 'Claude native session is closed');
    binding.assertUnchanged();
    try { return await request(method, params); }
    catch (error) {
      if (method === 'claude/open' || ['NATIVE_REQUEST_TIMEOUT', 'NATIVE_PROTOCOL_ERROR', 'NATIVE_PROCESS_EXITED', 'NATIVE_TRANSPORT_CLOSED'].includes(error.code)) failure(error);
      throw error;
    }
  }
  function close() {
    if (closePromise) return closePromise;
    closed = true;
    const closing = (async () => {
      current = { ...current, status: 'closing', pendingApprovals: [] };
      if (starting) await starting.catch(() => {});
      if (rpc && !rpc.closed) {
        // A stuck SDK teardown is bounded; native Job cleanup follows in all
        // cases and must succeed before this adapter reports closed.
        await request('claude/close', {}).catch(() => {});
      }
      if (rpc) await rpc.close();
      binding.release();
      current = { ...current, status: 'closed', turnId: null, submissionId: null, pendingApprovals: [] };
      emit({ type: 'status', provider: 'claude', sessionId: current.sessionId, status: 'closed' });
      return snapshot();
    })();
    closePromise = closing;
    void closing.catch(error => {
      current = { ...current, status: 'error' };
      closePromise = null;
      emit({ type: 'error', provider: 'claude', code: error.code, message: error.message });
    });
    return closing;
  }
  return { capabilities, snapshot, close,
    open: params => invoke('claude/open', params), send: params => invoke('claude/send', params),
    interrupt: params => invoke('claude/interrupt', params), respond: params => invoke('claude/respond', params) };
}
