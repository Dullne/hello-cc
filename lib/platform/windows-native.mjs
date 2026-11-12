import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { CliError } from '../shared/errors.mjs';

export const WINDOWS_NATIVE_PROTOCOL_VERSION = 1;
export const WINDOWS_NATIVE_NAPI_VERSION = 8;
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const sha256 = data => createHash('sha256').update(data).digest('hex');

export function windowsNativeSourceHash(root = packageRoot) {
  const directory = path.join(root, 'native', 'windows');
  const files = fs.readdirSync(directory).filter(name => /\.(?:cc|h|hpp)$/.test(name)).sort();
  if (!files.includes('addon.cc')) throw unavailable('source_missing');
  const hash = createHash('sha256');
  for (const name of files) {
    hash.update(name).update('\0').update(fs.readFileSync(path.join(directory, name))).update('\0');
  }
  return hash.digest('hex');
}

function unavailable(reason) {
  return new CliError('WINDOWS_NATIVE_UNAVAILABLE',
    'The Windows native component is unavailable or does not match this installation.', { reason });
}

// Importing this file never loads native code. POSIX callers can share the
// platform boundary without requiring Windows artifacts in their installation.
export function loadWindowsNative({ platform = process.platform, arch = process.arch, root = packageRoot } = {}) {
  if (platform !== 'win32') return null;
  if (arch !== 'x64') throw unavailable('target_unsupported');
  const directory = path.join(root, 'native', 'bin', `win32-${arch}`);
  const binary = path.join(directory, 'hcc-windows.node');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(directory, 'hcc-windows.json'), 'utf8')); }
  catch (error) { throw unavailable(error.code === 'ENOENT' ? 'manifest_missing' : 'manifest_invalid'); }
  if (manifest?.manifestVersion !== 1 || manifest.protocolVersion !== WINDOWS_NATIVE_PROTOCOL_VERSION ||
      manifest.napiVersion !== WINDOWS_NATIVE_NAPI_VERSION || manifest.platform !== platform || manifest.arch !== arch ||
      !/^[a-f0-9]{64}$/.test(manifest.sourceSha256 || '') || !/^[a-f0-9]{64}$/.test(manifest.binarySha256 || '')) {
    throw unavailable('manifest_incompatible');
  }
  let sourceHash;
  try { sourceHash = windowsNativeSourceHash(root); }
  catch { throw unavailable('source_missing'); }
  if (sourceHash !== manifest.sourceSha256) throw unavailable('source_mismatch');
  let binaryHash;
  try { binaryHash = sha256(fs.readFileSync(binary)); }
  catch { throw unavailable('binary_missing'); }
  if (binaryHash !== manifest.binarySha256) throw unavailable('binary_mismatch');
  let native;
  try { native = require(binary); }
  catch { throw unavailable('load_failed'); }
  if (native.protocolVersion !== WINDOWS_NATIVE_PROTOCOL_VERSION || native.sourceHash !== sourceHash ||
      native.capabilities?.processIdentity !== true || typeof native.inspectProcess !== 'function') {
    throw unavailable('exports_incompatible');
  }
  return native;
}
