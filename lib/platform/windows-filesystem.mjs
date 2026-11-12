import { loadWindowsNative } from './windows-native.mjs';
import { CliError } from '../shared/errors.mjs';

function filesystem() {
  const native = loadWindowsNative();
  if (!native || typeof native.captureDirectory !== 'function' || typeof native.inspectDirectory !== 'function') {
    throw new CliError('WINDOWS_NATIVE_UNAVAILABLE', 'The Windows filesystem component is unavailable.');
  }
  return native;
}

// These primitives do not enable project access or process launch. A directory
// lease must remain owned for the entire operation that relies on its binding.
export function captureDirectory(...args) { return filesystem().captureDirectory(...args); }
export function inspectDirectory(...args) { return filesystem().inspectDirectory(...args); }
