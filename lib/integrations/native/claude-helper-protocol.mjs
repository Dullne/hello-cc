import { CliError } from '../../shared/errors.mjs';

export const CLAUDE_HELPER_PROTOCOL = 1;
export const CLAUDE_HELPER_MAX_FRAME = 2 * 1024 * 1024;
export const CLAUDE_HELPER_MAX_PENDING = 16;
export const CLAUDE_HELPER_MAX_BUFFERED = 4 * 1024 * 1024;

export function helperJson(value) {
  let text;
  try {
    text = JSON.stringify(value, (key, item) => {
      if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint' ||
          (typeof item === 'number' && !Number.isFinite(item))) throw new Error('Unsupported JSON value');
      return item;
    });
  } catch { throw new CliError('NATIVE_PROTOCOL_LIMIT', 'Claude helper arguments must contain bounded JSON data'); }
  if (typeof text !== 'string' || Buffer.byteLength(text) > CLAUDE_HELPER_MAX_FRAME) {
    throw new CliError('NATIVE_PROTOCOL_LIMIT', 'Claude helper protocol frame exceeds its size limit');
  }
  return text;
}

export function helperError(error) {
  return { code: typeof error?.code === 'string' ? error.code : 'NATIVE_SDK_ERROR',
    message: String(error?.message || 'Claude helper operation failed').slice(0, 4096),
    extra: error?.extra || {} };
}
