import fs from 'node:fs';
import path from 'node:path';

import { withFileLock } from '../shared/file-lock.mjs';

const BUFFER_DIRECTORY_LEASE_NAME = '.hcc-buffer-directory.lease';

function canonicalDirectory(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('buffer directory must be a non-empty path');
  }
  const resolved = path.resolve(value);
  const canonical = fs.realpathSync.native(resolved);
  const stat = fs.statSync(canonical);
  if (!stat.isDirectory()) throw new TypeError(`buffer directory is not a directory: ${resolved}`);
  return canonical;
}

export function bufferDirectoryLeaseTarget(directory) {
  return path.join(canonicalDirectory(directory), BUFFER_DIRECTORY_LEASE_NAME);
}

export function withBufferDirectoryLease(directory, fn, options = {}) {
  if (typeof fn !== 'function') throw new TypeError('buffer directory lease callback must be a function');
  const target = bufferDirectoryLeaseTarget(directory);
  const lockOptions = {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.retryMs === undefined ? {} : { retryMs: options.retryMs }),
    ...(options.nonblocking === undefined ? {} : { nonblocking: options.nonblocking })
  };
  return withFileLock(target, () => fn(path.dirname(target)), lockOptions);
}

export function withBufferDirectoryLeases(directories, fn, options = {}) {
  if (typeof fn !== 'function') throw new TypeError('buffer directory leases callback must be a function');
  const targets = [...new Set((directories || []).map(bufferDirectoryLeaseTarget))].sort();
  const acquire = options.withLease || ((target, nested) => withFileLock(target, nested, {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.retryMs === undefined ? {} : { retryMs: options.retryMs }),
    ...(options.nonblocking === undefined ? {} : { nonblocking: options.nonblocking })
  }));

  const visit = (index) => index >= targets.length
    ? fn()
    : acquire(targets[index], () => visit(index + 1));
  return visit(0);
}
