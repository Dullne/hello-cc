import path from 'node:path';
import {
  assertSelectedCwdSnapshot,
  captureSelectedCwdSnapshot,
  sameSelectedCwdIdentity
} from '../../process/selected-cwd-identity.mjs';
import { CliError } from '../../shared/errors.mjs';
import { isWindowsFileIdentity } from '../../platform/windows-private-state.mjs';

export const HOOK_ROOT_IDENTITY_ENV = 'HCC_HOOK_ROOT_IDENTITY';

function mismatch() {
  return new CliError('HOOK_ROOT_IDENTITY_MISMATCH',
    'Hook project root no longer matches the provider launch identity');
}

// Carry the launch-time directory identity into short-lived hook children.
// A pathname alone cannot distinguish a moved project from another directory
// subsequently installed at the same pathname.
export function hookRootIdentityValue(root, original = null) {
  const selected = captureSelectedCwdSnapshot(root);
  if (original) {
    if (typeof original.assertUnchanged === 'function') original.assertUnchanged();
    else assertSelectedCwdSnapshot(original);
    if (!sameSelectedCwdIdentity(selected, original)) throw mismatch();
  }
  return JSON.stringify({ version: 1, ...selected });
}

export function assertHookRootIdentity(root, value) {
  if (value === undefined) return false; // Unmanaged and pre-upgrade hooks have no launch marker.
  try {
    if (typeof value !== 'string' || value.length > 4096) throw mismatch();
    const snapshot = JSON.parse(value);
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
        snapshot.version !== 1 || snapshot.requested !== path.resolve(root) ||
        typeof snapshot.canonical !== 'string' || !path.isAbsolute(snapshot.canonical) ||
        !snapshot.identity || typeof snapshot.identity !== 'object') {
      throw mismatch();
    }
    const validIdentity = process.platform === 'win32'
      ? isWindowsFileIdentity(snapshot.identity)
      : snapshot.identity.platform === undefined &&
        /^\d+$/.test(snapshot.identity.dev) && /^\d+$/.test(snapshot.identity.ino) &&
        (snapshot.identity.birthtimeNs === null || /^\d+$/.test(snapshot.identity.birthtimeNs));
    if (!validIdentity) {
      throw mismatch();
    }
    assertSelectedCwdSnapshot(snapshot);
    return snapshot;
  } catch {
    throw mismatch();
  }
}
