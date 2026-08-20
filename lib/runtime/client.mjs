import { CliError } from '../shared/errors.mjs';
import { readRuntime } from './state.mjs';
import { runtimeApiUrl, runtimeHttpRequest } from '../web/runtime.mjs';
import { withRuntimeApiVersionHeader } from '../web/api-version.mjs';

const DEFAULT_CLI_NAME = 'hcc';

function requestAbortScope(signal, timeoutMs) {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener('abort', forwardAbort, { once: true });

  const timeout = Number(timeoutMs);
  const timer = Number.isFinite(timeout) && timeout >= 0
    ? setTimeout(() => controller.abort(new Error('runtime request deadline exceeded')), timeout)
    : null;
  return {
    signal: controller.signal,
    cleanup() {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    }
  };
}

function waitForAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason || new Error('runtime request aborted'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('runtime request aborted'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
  });
}

export async function runtimeRequest(ctx, method, route, body = null, runtime = null, opts = {}) {
  const cliName = opts.cliName || DEFAULT_CLI_NAME;
  const rt = runtime || readRuntime(ctx, { cliName, localOnly: Boolean(opts.localOnly) });
  const url = runtimeApiUrl(rt, route);
  const headers = withRuntimeApiVersionHeader({ 'Content-Type': 'application/json' });
  headers['X-HCC-Root'] = ctx.root;
  headers['X-HCC-DB'] = ctx.dbPath;
  if (rt.token) headers.Authorization = `Bearer ${rt.token}`;
  let res;
  let text;
  const abortScope = requestAbortScope(opts.signal, opts.timeoutMs);
  try {
    res = await waitForAbort(runtimeHttpRequest(rt, route, {
      method,
      headers,
      body: body === null ? null : JSON.stringify(body),
      timeoutMs: opts.timeoutMs,
      signal: abortScope.signal
    }), abortScope.signal);
    text = res.text;
  } catch (err) {
    throw new CliError('RUNTIME_UNREACHABLE', `Runtime is not reachable at ${rt.base_url}. Start ${cliName} web again.`, {
      runtime: rt.source || rt.base_url,
      message: err.message
    });
  } finally {
    abortScope.cleanup();
  }
  let json = null;
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new CliError('RUNTIME_BAD_RESPONSE', `Runtime returned non-JSON response from ${url.pathname}`);
    }
  }
  if (!res.ok) {
    const error = json && json.error ? json.error : { code: 'RUNTIME_ERROR', message: `Runtime request failed: ${res.status}` };
    throw new CliError(error.code || 'RUNTIME_ERROR', error.message || `Runtime request failed: ${res.status}`, {
      ...error,
      status: res.status
    });
  }
  return json || {};
}

export function runtimeBufferGcUnavailable(error) {
  return error?.code === 'RUNTIME_UNREACHABLE' ||
    Number(error?.extra?.status) === 404 ||
    Number(error?.extra?.status) === 426;
}
