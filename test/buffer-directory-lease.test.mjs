import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  bufferDirectoryLeaseTarget,
  withBufferDirectoryLease,
  withBufferDirectoryLeases
} from '../lib/runtime/buffer-directory-lease.mjs';

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-buffer-lease-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('producer and GC serialize on the same canonical directory lease', (t) => {
  const directory = tempDirectory(t);
  const alias = path.join(path.dirname(directory), `${path.basename(directory)}-alias`);
  fs.symlinkSync(directory, alias);
  t.after(() => fs.rmSync(alias, { force: true }));

  assert.equal(bufferDirectoryLeaseTarget(alias), bufferDirectoryLeaseTarget(directory));
  withBufferDirectoryLease(directory, () => {
    assert.throws(
      () => withBufferDirectoryLease(alias, () => {}, { nonblocking: true }),
      (error) => error?.code === 'ERR_FILE_LOCK_BUSY'
    );
  });
});

test('multi-directory GC leases are acquired in canonical order', (t) => {
  const first = tempDirectory(t);
  const second = tempDirectory(t);
  const observed = [];
  const result = withBufferDirectoryLeases([second, first, second], () => 'applied', {
    withLease(target, fn) {
      observed.push(target);
      return fn();
    }
  });

  assert.equal(result, 'applied');
  assert.deepEqual(observed, [first, second].sort().map(bufferDirectoryLeaseTarget));
});
