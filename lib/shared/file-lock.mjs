import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { aggregateCleanupFailure } from './cleanup-error.mjs';

const NO_ERROR = Symbol('no-file-lock-error');
const STATE_INDEX = 0;
const DETAIL_INDEX = 1;
const STATE = Object.freeze({
  STARTING: 0,
  ACQUIRED: 1,
  BUSY: 2,
  TIMEOUT: 3,
  FAILED: 4,
  RELEASED: 5,
  RELEASE_FAILED: 6
});
const HOST = '127.0.0.1';
const PORT_BASE = 20_000;
const PORT_COUNT = 40_000;
const STARTUP_GRACE_MS = 5000;
const RELEASE_GRACE_MS = 5000;
const WORKER_URL = new URL('./socket-lock-worker.mjs', import.meta.url);
const WORKER_BOOTSTRAP = String.raw`
  import('node:worker_threads').then(({ parentPort, workerData }) => {
    const state = new Int32Array(workerData.stateBuffer);
    const fail = () => {
      Atomics.store(state, 1, 1);
      Atomics.store(state, 0, workerData.states.FAILED);
      Atomics.notify(state, 0);
      parentPort.close();
    };
    import(workerData.moduleUrl).then((module) => {
      if (typeof module.runSocketLockWorker !== 'function') throw new TypeError('invalid worker module');
      module.runSocketLockWorker(workerData);
    }).catch(fail);
  }).catch(() => {});
`;

function sameObject(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function invalidLock(message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = 'ERR_INVALID_FILE_LOCK';
  return error;
}

function busyError(key) {
  const error = new Error(`file lock is busy: ${key}`);
  error.code = 'ERR_FILE_LOCK_BUSY';
  return error;
}

function timeoutError(key) {
  const error = new Error(`timed out waiting for file lock: ${key}`);
  error.code = 'ERR_FILE_LOCK_TIMEOUT';
  return error;
}

function workerError(key, phase, cause = null) {
  const error = new Error(
    `file lock worker ${phase} failed: ${key}`,
    cause ? { cause } : undefined
  );
  error.code = phase === 'release'
    ? 'ERR_FILE_LOCK_RELEASE_FAILED'
    : 'ERR_FILE_LOCK_WORKER_START_FAILED';
  return error;
}

function startupTimeoutError(key) {
  const error = new Error(`file lock worker did not start in time: ${key}`);
  error.code = 'ERR_FILE_LOCK_WORKER_START_TIMEOUT';
  return error;
}

function canonicalTarget(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('file lock target must be a non-empty path');
  }
  const supplied = path.resolve(value);
  const suppliedParent = path.dirname(supplied);
  fs.mkdirSync(suppliedParent, { recursive: true, mode: 0o700 });
  const canonicalParent = fs.realpathSync.native(suppliedParent);
  const parentIdentity = fs.statSync(canonicalParent);
  if (!parentIdentity.isDirectory()) {
    throw invalidLock(`file lock parent is not a directory: ${suppliedParent}`);
  }
  const canonicalKey = path.join(canonicalParent, path.basename(supplied));
  return {
    suppliedKey: supplied,
    suppliedParent,
    canonicalParent,
    canonicalTarget: canonicalKey,
    parentIdentity,
    key: canonicalKey
  };
}

function assertStableParent(location) {
  const canonicalParent = fs.realpathSync.native(location.suppliedParent);
  const parentIdentity = fs.statSync(canonicalParent);
  if (canonicalParent !== location.canonicalParent ||
      !sameObject(parentIdentity, location.parentIdentity) ||
      !parentIdentity.isDirectory()) {
    throw invalidLock('file lock parent changed during acquisition');
  }
}

function endpointForLocation(location) {
  return endpointForKey(location.key);
}

function endpointForKey(key) {
  const digest = createHash('sha256').update(key).digest();
  return {
    host: HOST,
    port: PORT_BASE + digest.readUInt32BE(0) % PORT_COUNT,
    key
  };
}

function endpointsForLocation(location) {
  const byPort = new Map();
  for (const key of [location.suppliedKey, location.key].sort()) {
    const endpoint = endpointForKey(key);
    if (!byPort.has(endpoint.port)) byPort.set(endpoint.port, endpoint);
  }
  return [...byPort.values()].sort((left, right) => left.port - right.port);
}

// A fixed endpoint is deliberately fail-closed. A hash collision or unrelated
// listener is indistinguishable from the same target being locked, so callers
// receive BUSY/TIMEOUT and this module never probes an alternate port.
export function fileLockEndpoint(target) {
  const location = canonicalTarget(target);
  assertStableParent(location);
  return endpointForLocation(location);
}

export function fileLockEndpoints(target) {
  const location = canonicalTarget(target);
  assertStableParent(location);
  return endpointsForLocation(location);
}

function combineCleanup(primary, cleanup, message, phase, key) {
  if (primary === NO_ERROR) return cleanup;
  return aggregateCleanupFailure(primary, cleanup, message, { phase, lockPath: key });
}

function defaultWorkerFactory({ workerSource, workerData }) {
  // The eval bootstrap owns module-load failures and reports them through the
  // shared state before closing its parent port. No parent execArgv is needed.
  return new Worker(workerSource, { eval: true, workerData, execArgv: [] });
}

function injectedFailure(worker, state, phase, key) {
  const detail = Atomics.load(state, DETAIL_INDEX);
  try {
    const failure = worker?.failure?.(detail, phase);
    if (failure) return failure;
  } catch (error) {
    return workerError(key, phase, error);
  }
  return workerError(key, phase);
}

function terminateWorker(worker, primary, key) {
  if (!worker) return primary;
  try {
    const pending = worker.terminate();
    if (pending && typeof pending.then === 'function') {
      pending.catch(() => {});
      const cleanup = new Error(`file lock worker termination is unconfirmed: ${key}`);
      cleanup.code = 'ERR_FILE_LOCK_WORKER_TERMINATION_UNCONFIRMED';
      return combineCleanup(
        primary,
        cleanup,
        'file lock operation failed and asynchronous worker termination cannot be confirmed',
        'terminate',
        key
      );
    }
    return primary;
  } catch (cleanup) {
    return combineCleanup(
      primary,
      cleanup,
      'file lock operation and worker termination both failed',
      'terminate',
      key
    );
  }
}

function acquisitionError(status, resources) {
  if (status === STATE.BUSY) return busyError(resources.location.key);
  if (status === STATE.TIMEOUT) return timeoutError(resources.location.key);
  if (status === STATE.FAILED) {
    return injectedFailure(resources.worker, resources.state, 'startup', resources.location.key);
  }
  return startupTimeoutError(resources.location.key);
}

function acquireWorker(location, options, workerFactory) {
  const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const state = new Int32Array(buffer);
  const endpoints = endpointsForLocation(location);
  const resources = { location, endpoints, state, worker: null };
  let primary = NO_ERROR;
  try {
    resources.worker = workerFactory({
      workerSource: WORKER_BOOTSTRAP,
      workerUrl: WORKER_URL,
      workerData: {
        stateBuffer: buffer,
        states: STATE,
        ports: endpoints.map((endpoint) => endpoint.port),
        moduleUrl: WORKER_URL.href,
        timeoutMs: options.timeoutMs,
        retryMs: options.retryMs,
        nonblocking: options.nonblocking
      },
      state,
      states: STATE
    });
    if (!resources.worker || typeof resources.worker.unref !== 'function' ||
        typeof resources.worker.postMessage !== 'function' ||
        typeof resources.worker.terminate !== 'function') {
      throw new TypeError('file lock worker factory returned an invalid worker');
    }
    if (typeof resources.worker.on === 'function') {
      // A module-load failure happens before the Worker can publish FAILED.
      // Suppress the otherwise-unhandled event; the bounded startup wait below
      // converts this path to ERR_FILE_LOCK_WORKER_START_TIMEOUT.
      resources.worker.on('error', () => {});
    }
    resources.worker.unref();
    const waitMs = STARTUP_GRACE_MS +
      (options.nonblocking ? 0 : Math.ceil(options.timeoutMs)) + 100;
    Atomics.wait(state, STATE_INDEX, STATE.STARTING, waitMs);
    const status = Atomics.load(state, STATE_INDEX);
    if (status !== STATE.ACQUIRED) throw acquisitionError(status, resources);
    assertStableParent(location);
    return resources;
  } catch (error) {
    primary = error;
  }
  if (Atomics.load(state, STATE_INDEX) === STATE.ACQUIRED) {
    throw releaseWorker(resources, primary);
  }
  if ([STATE.BUSY, STATE.TIMEOUT, STATE.FAILED].includes(
    Atomics.load(state, STATE_INDEX)
  )) {
    throw primary;
  }
  throw terminateWorker(resources.worker, primary, location.key);
}

function releaseWorker(resources, primary) {
  let error = primary;
  let mustTerminate = false;
  try {
    resources.worker.postMessage({ type: 'release' });
    Atomics.wait(resources.state, STATE_INDEX, STATE.ACQUIRED, RELEASE_GRACE_MS);
    const status = Atomics.load(resources.state, STATE_INDEX);
    if (status !== STATE.RELEASED) {
      const cleanup = status === STATE.RELEASE_FAILED
        ? injectedFailure(resources.worker, resources.state, 'release', resources.location.key)
        : workerError(resources.location.key, 'release');
      mustTerminate = status !== STATE.FAILED;
      error = combineCleanup(
        error,
        cleanup,
        'file lock operation and worker release both failed',
        'release',
        resources.location.key
      );
    }
  } catch (cleanup) {
    mustTerminate = true;
    error = combineCleanup(
      error,
      cleanup,
      'file lock operation and worker release both failed',
      'release',
      resources.location.key
    );
  }
  return mustTerminate
    ? terminateWorker(resources.worker, error, resources.location.key)
    : error;
}

export function createFileLock({ workerFactory = defaultWorkerFactory } = {}) {
  if (typeof workerFactory !== 'function') {
    throw new TypeError('file lock workerFactory must be a function');
  }
  return function withConfiguredFileLock(
    target,
    fn,
    { timeoutMs = 5000, retryMs = 25, nonblocking = false } = {}
  ) {
    if (typeof fn !== 'function') throw new TypeError('file lock callback must be a function');
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new RangeError('file lock timeoutMs must be a non-negative finite number');
    }
    if (!Number.isFinite(retryMs) || retryMs <= 0) {
      throw new RangeError('file lock retryMs must be a positive finite number');
    }
    if (typeof nonblocking !== 'boolean') {
      throw new TypeError('file lock nonblocking must be a boolean');
    }
    if (fn.constructor?.name === 'AsyncFunction') {
      throw new TypeError('withFileLock requires a synchronous callback');
    }

    const location = canonicalTarget(target);
    const resources = acquireWorker(location, { timeoutMs, retryMs, nonblocking }, workerFactory);
    let result;
    let primary = NO_ERROR;
    try {
      // Protected I/O must use this fixed path. The supplied parent alias may
      // be retargeted after acquisition and belongs to a different lock domain.
      result = fn(location.canonicalTarget);
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch(() => {});
        throw new TypeError('withFileLock requires a synchronous callback');
      }
    } catch (error) {
      primary = error;
    }
    const finalError = releaseWorker(resources, primary);
    if (finalError !== NO_ERROR) throw finalError;
    return result;
  };
}

export const withFileLock = createFileLock();
