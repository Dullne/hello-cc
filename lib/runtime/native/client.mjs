import http from 'node:http';
import { CliError } from '../../shared/errors.mjs';
import { readNativePointer } from './store.mjs';

export function nativeRequest(ctx, method, route, body = null, { timeoutMs = 35000 } = {}) {
  const pointer = readNativePointer(ctx);
  if (!pointer) return Promise.reject(new CliError('NATIVE_RUNTIME_OFFLINE', 'Native runtime is offline. Run hcc native up.'));
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    let timer;
    const fail = (error) => { clearTimeout(timer); reject(error); };
    const invalid = (message) => new CliError('NATIVE_RESPONSE_INVALID', message, { uncertain: method !== 'GET' });
    const request = http.request({ host: '127.0.0.1', port: pointer.port, method, path: route,
      headers: { authorization: `Bearer ${pointer.token}`, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) }
    }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        data += chunk;
        if (Buffer.byteLength(data) > 8 * 1024 * 1024) response.destroy(invalid('Native response is too large'));
      });
      response.on('error', (error) => fail(error instanceof CliError ? error : invalid('Native response was interrupted; inspect status before retrying.')));
      response.on('end', () => {
        clearTimeout(timer);
        try {
          const result = JSON.parse(data);
          if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.ok !== 'boolean') throw invalid('Invalid native response; inspect status before retrying.');
          if (!result.ok) fail(new CliError(result.error?.code || 'NATIVE_REQUEST_FAILED', result.error?.message || 'Native request failed', result.error?.extra || {}));
          else if (response.statusCode < 200 || response.statusCode >= 300) fail(invalid('Native runtime returned an unsuccessful HTTP response'));
          else resolve(result.data);
        } catch (error) { fail(error instanceof CliError ? error : invalid('Invalid native JSON response; inspect status before retrying.')); }
      });
    });
    timer = setTimeout(() => request.destroy(new CliError('NATIVE_CLIENT_TIMEOUT', 'Native runtime request timed out; inspect status before retrying.', { uncertain: method !== 'GET' })), timeoutMs);
    request.on('error', (error) => fail(error instanceof CliError ? error : new CliError('NATIVE_RUNTIME_OFFLINE', 'Cannot reach the native runtime', { uncertain: method !== 'GET' })));
    request.end(payload);
  });
}
