import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { windowsNativeSourceHash, WINDOWS_NATIVE_PROTOCOL_VERSION, WINDOWS_NATIVE_NAPI_VERSION,
  loadWindowsNative } from '../lib/platform/windows-native.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function verify(name, extension, sourceHash, extra = {}) {
  const directory = path.join(root, 'native', 'bin', 'win32-x64');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, `${name}.json`), 'utf8'));
  const bytes = fs.readFileSync(path.join(directory, `${name}.${extension}`));
  if (manifest.manifestVersion !== 1 || manifest.platform !== 'win32' || manifest.arch !== 'x64' ||
      manifest.sourceSha256 !== sourceHash || manifest.binarySha256 !== hash(bytes) ||
      Object.entries(extra).some(([key, value]) => manifest[key] !== value)) throw new Error(`${name}: manifest, binary and source do not agree`);
  const pe = bytes.length >= 64 ? bytes.readUInt32LE(60) : -1;
  if (bytes.subarray(0, 2).toString() !== 'MZ' || pe < 64 || pe + 26 > bytes.length ||
      bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664 ||
      bytes.readUInt16LE(pe + 24) !== 0x20b) throw new Error(`${name}: expected an x64 PE32+ image`);
  console.log(`Verified Windows x64 ${name}.${extension}`);
}
verify('hcc-windows', 'node', windowsNativeSourceHash(root), {
  protocolVersion: WINDOWS_NATIVE_PROTOCOL_VERSION, napiVersion: WINDOWS_NATIVE_NAPI_VERSION });
verify('hcc-shim', 'exe', hash(fs.readFileSync(path.join(root, 'native', 'windows', 'launcher', 'shim.cc'))));
for (const filename of ['bin/windows-terminal-host.mjs', 'lib/integrations/native/claude-helper.mjs',
  'lib/terminal/client.mjs', 'lib/terminal/server.mjs', 'lib/terminal/store.mjs']) {
  if (!fs.statSync(path.join(root, filename)).isFile()) throw new Error(`Missing Windows runtime entry ${filename}`);
}
if (process.platform === 'win32') {
  const native = loadWindowsNative();
  for (const name of ['captureDirectory', 'inspectProcess', 'startOwnedPty', 'startDetachedHost']) {
    if (typeof native[name] !== 'function') throw new Error(`Missing Windows native operation ${name}`);
  }
}
