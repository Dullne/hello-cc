import { CliError } from '../shared/errors.mjs';
import { readRuntime } from './state.mjs';
import { runtimeApiUrl } from '../web/runtime.mjs';

const DEFAULT_CLI_NAME = 'hcc';

export async function runtimeRequest(ctx, method, route, body = null, runtime = null, opts = {}) {
  const cliName = opts.cliName || DEFAULT_CLI_NAME;
  const rt = runtime || readRuntime(ctx, { cliName, localOnly: Boolean(opts.localOnly) });
  const url = runtimeApiUrl(rt, route);
  const headers = { 'Content-Type': 'application/json' };
  headers['X-HCC-Root'] = ctx.root;
  headers['X-HCC-DB'] = ctx.dbPath;
  if (rt.token) headers.Authorization = `Bearer ${rt.token}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body)
    });
  } catch (err) {
    throw new CliError('RUNTIME_UNREACHABLE', `Runtime is not reachable at ${rt.base_url}. Start ${cliName} web again.`, {
      runtime: rt.source || rt.base_url,
      message: err.message
    });
  }
  let json = null;
  const text = await res.text();
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new CliError('RUNTIME_BAD_RESPONSE', `Runtime returned non-JSON response from ${url.pathname}`);
    }
  }
  if (!res.ok) {
    const error = json && json.error ? json.error : { code: 'RUNTIME_ERROR', message: `Runtime request failed: ${res.status}` };
    throw new CliError(error.code || 'RUNTIME_ERROR', error.message || `Runtime request failed: ${res.status}`, error);
  }
  return json || {};
}
