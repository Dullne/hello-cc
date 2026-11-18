import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadWindowsNative } from '../lib/platform/windows-native.mjs';
import { captureWindowsPrivateDatabase, inspectWindowsPrivateDirectory, openWindowsPrivateAppendResource,
  readWindowsPrivateFile, withWindowsPrivateDirectory, withWindowsPrivateScope
} from '../lib/platform/windows-private-state.mjs';

const windows = process.platform === 'win32';
const componentRoot = path.resolve(import.meta.dirname, '../native');

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.homedir(), 'hcc-admission-test-'));
  const directory = path.join(base, 'private');
  loadWindowsNative().createPrivateDirectory(directory);
  const file = path.join(directory, 'data'); fs.writeFileSync(file, 'private');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { directory, file };
}

// Observe the real loader's I/O, hashing, native exports, and filesystem work.
// Alter only the bytes supplied at its disk-read boundary, so these tests never
// modify the installed component or rely on replacing a loaded Windows DLL.
function observeComponent(t) {
  const original = fs.readFileSync;
  const counts = { manifest: 0, source: 0, binary: 0 };
  let corrupted;
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    const result = Reflect.apply(original, this, [file, ...args]);
    const target = typeof file === 'string' ? path.resolve(file) : '';
    if (!target.startsWith(componentRoot + path.sep)) return result;
    const kind = target.endsWith('hcc-windows.json') ? 'manifest'
      : target.endsWith('hcc-windows.node') ? 'binary' : /\.(cc|h|hpp)$/.test(target) ? 'source' : null;
    if (!kind) return result;
    counts[kind]++;
    if (corrupted !== kind) return result;
    if (kind === 'manifest') return '{';
    const changed = Buffer.from(result); changed[0] ^= 1; return changed;
  });
  return { counts, corrupt(kind) { corrupted = kind; } };
}

for (const operation of ['inspect', 'pinned callback', 'database', 'append']) {
  test(`Windows ${operation} admits the component once for its synchronous capture`, { skip: !windows }, t => {
    const { directory, file } = fixture(t), { counts } = observeComponent(t);
    if (operation === 'inspect') assert.equal(inspectWindowsPrivateDirectory(directory).identity.platform, 'win32');
    if (operation === 'pinned callback') assert.equal(withWindowsPrivateDirectory(directory, parent => parent.security().private), true);
    if (operation === 'database') { const hold = captureWindowsPrivateDatabase(file); hold.assertUnchanged(); hold.close(); }
    if (operation === 'append') { const resource = openWindowsPrivateAppendResource(file); resource.write('!'); resource.close(); }
    assert.equal(counts.manifest, 1, 'one fresh component admission per internal operation');
    assert.equal(counts.binary, 1, 'binary is reread once rather than for each nested capture');
    assert.ok(counts.source > 0, 'native sources are still read and hashed');
    assert.deepEqual(fs.readdirSync(directory), ['data'], 'temporary pins are closed');
  });
}

test('retaining a private scope does not retain component admission across caller operations', { skip: !windows }, t => {
  const { directory, file } = fixture(t), { counts } = observeComponent(t);
  withWindowsPrivateScope(() => {
    assert.equal(readWindowsPrivateFile(file).toString(), 'private');
    assert.equal(counts.manifest, 1);
    assert.equal(readWindowsPrivateFile(file).toString(), 'private');
    assert.equal(counts.manifest, 2);
    withWindowsPrivateDirectory(directory, () => {
      assert.equal(counts.manifest, 3);
      assert.equal(readWindowsPrivateFile(file).toString(), 'private');
      assert.equal(counts.manifest, 4, 'a caller callback cannot lend admission to another public operation');
    });
  });
});

for (const [kind, reason] of [['manifest', 'manifest_invalid'], ['source', 'source_mismatch'], ['binary', 'binary_mismatch']]) {
  test(`a reused private scope rejects ${kind} tampering between operations`, { skip: !windows }, t => {
    const { file } = fixture(t), observer = observeComponent(t);
    withWindowsPrivateScope(() => {
      assert.equal(readWindowsPrivateFile(file).toString(), 'private');
      observer.corrupt(kind);
      assert.throws(() => readWindowsPrivateFile(file), error => error.code === 'WINDOWS_NATIVE_UNAVAILABLE' && error.extra.reason === reason);
      assert.throws(() => loadWindowsNative(), error => error.code === 'WINDOWS_NATIVE_UNAVAILABLE' && error.extra.reason === reason);
    });
  });

  test(`a sharing retry rejects ${kind} tampering even with a retained private scope`, { skip: !windows }, t => {
    const { file } = fixture(t), writer = openWindowsPrivateAppendResource(file);
    const observer = observeComponent(t); let waits = 0;
    t.mock.method(Atomics, 'wait', () => { waits++; writer.close(); observer.corrupt(kind); return 'timed-out'; });
    try {
      withWindowsPrivateScope(() => assert.throws(() => readWindowsPrivateFile(file),
        error => error.code === 'WINDOWS_NATIVE_UNAVAILABLE' && error.extra.reason === reason));
      assert.equal(waits, 1, 'the real sharing refusal reached a retry boundary');
    } finally { writer.close(); }
  });
}
