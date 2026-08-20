import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import * as lockModule from '../lib/shared/file-lock.mjs';

const { withFileLock } = lockModule;
const repoRoot = path.resolve(import.meta.dirname, '..');
const lockModuleUrl = pathToFileURL(path.join(repoRoot, 'lib/shared/file-lock.mjs')).href;

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-socket-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function legacySidecarPath(target) {
  const resolved = path.resolve(target);
  return `${path.join(fs.realpathSync.native(path.dirname(resolved)), path.basename(resolved))}.lock.sqlite`;
}

function endpointPortForKey(key) {
  return 20_000 + createHash('sha256').update(key).digest().readUInt32BE(0) % 40_000;
}

function captureThrown(fn) {
  let threw = false;
  let value;
  try {
    fn();
  } catch (error) {
    threw = true;
    value = error;
  }
  assert.equal(threw, true);
  return value;
}

async function waitForPath(file, timeoutMs = 30000) {
  const deadline = performance.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (performance.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function waitForExit(child, { allowSignal = false, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for child: ${stderr}`)), timeoutMs);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 || (allowSignal && signal)) resolve({ code, signal });
      else reject(new Error(`child exited ${code ?? signal}: ${stderr}`));
    });
  });
}

function errorIncludes(error, expected, seen = new Set()) {
  if (error === expected) return true;
  if (!error || seen.has(error)) return false;
  seen.add(error);
  if (error.cause && errorIncludes(error.cause, expected, seen)) return true;
  return error instanceof AggregateError &&
    error.errors.some((nested) => errorIncludes(nested, expected, seen));
}

function startHolder(t, target, root, suffix = '') {
  const ready = path.join(root, `holder-ready${suffix}`);
  const release = path.join(root, `holder-release${suffix}`);
  const source = String.raw`
    import fs from 'node:fs';
    const [moduleUrl, target, ready, release] = process.argv.slice(1);
    const { withFileLock } = await import(moduleUrl);
    withFileLock(target, () => {
      fs.writeFileSync(ready, 'ready');
      const wait = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(release)) Atomics.wait(wait, 0, 0, 10);
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source,
    lockModuleUrl, target, ready, release], {
    cwd: repoRoot,
    stdio: ['ignore', 'ignore', 'pipe']
  });
  t.after(() => {
    try { child.kill('SIGKILL'); } catch {}
  });
  return { child, ready, release };
}

function startHalfOpenProbe(t, endpoint, expectedBanner, root) {
  const ready = path.join(root, 'half-open-probe-ready');
  const stop = path.join(root, 'half-open-probe-stop');
  const ports = [];
  for (let index = 0; ports.length < 4; index += 1) {
    const digest = index === 0
      ? createHash('sha256').update(endpoint.key).digest()
      : createHash('sha256')
        .update(`hcc-file-lock-port-v1\0${index}\0${endpoint.key}`)
        .digest();
    const port = 20_000 + digest.readUInt32BE(0) % 40_000;
    if (!ports.includes(port)) ports.push(port);
  }
  assert.equal(ports[0], endpoint.port);
  const source = String.raw`
    import fs from 'node:fs';
    import net from 'node:net';
    const [host, encodedPorts, expectedBanner, ready, stop] = process.argv.slice(1);
    const ports = JSON.parse(encodedPorts);
    let socket = null;
    let retryTimer = null;
    let nextPortIndex = 0;
    const stopTimer = setInterval(() => {
      if (!fs.existsSync(stop)) return;
      clearTimeout(retryTimer);
      try { socket?.destroy(); } finally { process.exit(0); }
    }, 10);
    const retry = () => {
      if (retryTimer !== null) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, 10);
    };
    const connect = () => {
      if (fs.existsSync(stop)) {
        clearInterval(stopTimer);
        process.exit(0);
      }
      if (socket !== null) return;
      let bannerConfirmed = false;
      let received = '';
      const port = ports[nextPortIndex];
      nextPortIndex = (nextPortIndex + 1) % ports.length;
      const candidate = net.createConnection({
        host,
        port,
        allowHalfOpen: true
      });
      socket = candidate;
      let bannerTimer = setTimeout(() => {
        bannerTimer = null;
        if (!bannerConfirmed) candidate.destroy();
      }, 250);
      const clearBannerTimer = () => {
        clearTimeout(bannerTimer);
        bannerTimer = null;
      };
      candidate.setEncoding('utf8');
      candidate.on('data', (chunk) => { received += chunk; });
      candidate.once('end', () => {
        clearBannerTimer();
        if (received !== expectedBanner) {
          candidate.destroy();
          return;
        }
        fs.writeFileSync(ready, 'ready');
        bannerConfirmed = true;
      });
      candidate.once('error', () => {
        if (!bannerConfirmed) {
          clearBannerTimer();
          candidate.destroy();
        }
      });
      candidate.once('close', () => {
        clearBannerTimer();
        if (socket === candidate) socket = null;
        if (bannerConfirmed) {
          clearInterval(stopTimer);
          process.exit(0);
        }
        retry();
      });
    };
    connect();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source,
    endpoint.host, JSON.stringify(ports), expectedBanner, ready, stop], {
    cwd: repoRoot,
    stdio: ['ignore', 'ignore', 'pipe']
  });
  t.after(() => {
    try { child.kill('SIGKILL'); } catch {}
  });
  return { child, ready, stop };
}

test('serializes real concurrent child processes without lock files', async (t) => {
  // Four fresh node processes contend with the whole unit suite for CPU;
  // the assertion is serialization order, not wall-clock speed, so the
  // child waits below use generous deadlines.
  const root = sandbox(t);
  const target = path.join(root, 'registry.json');
  const log = path.join(root, 'sequence.log');
  const release = path.join(root, 'release');
  const source = String.raw`
    import fs from 'node:fs';
    const [moduleUrl, target, log, id, ready, release] = process.argv.slice(1);
    const { withFileLock } = await import(moduleUrl);
    fs.writeFileSync(ready, 'ready');
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(release)) Atomics.wait(wait, 0, 0, 10);
    withFileLock(target, () => {
      fs.appendFileSync(log, id + ':start\n');
      Atomics.wait(wait, 0, 0, 30);
      fs.appendFileSync(log, id + ':end\n');
    });
  `;
  const children = [];
  const readyFiles = [];
  for (let index = 0; index < 4; index += 1) {
    const ready = path.join(root, `ready-${index}`);
    readyFiles.push(ready);
    children.push(spawn(process.execPath, ['--input-type=module', '-e', source,
      lockModuleUrl, target, log, String(index), ready, release], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'pipe']
    }));
  }
  t.after(() => children.forEach((child) => {
    try { child.kill('SIGKILL'); } catch {}
  }));
  await Promise.all(readyFiles.map((file) => waitForPath(file)));
  fs.writeFileSync(release, 'go');
  await Promise.all(children.map((child) => waitForExit(child)));

  const rows = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(rows.length, 8);
  for (let index = 0; index < rows.length; index += 2) {
    const id = rows[index].split(':')[0];
    assert.deepEqual(rows.slice(index, index + 2), [`${id}:start`, `${id}:end`]);
  }
  assert.equal(fs.existsSync(legacySidecarPath(target)), false);
  assert.equal(fs.existsSync(`${legacySidecarPath(target)}.anchor`), false);
});

test('pair replacement of every legacy lock pathname cannot create a second lock domain', async (t) => {
  const root = sandbox(t);
  const target = path.join(root, 'registry.json');
  const sidecar = legacySidecarPath(target);
  const anchor = `${sidecar}.anchor`;
  const holder = startHolder(t, target, root, '-pair');
  await waitForPath(holder.ready);

  if (fs.existsSync(sidecar)) fs.renameSync(sidecar, `${sidecar}.old`);
  if (fs.existsSync(anchor)) fs.renameSync(anchor, `${anchor}.old`);
  fs.writeFileSync(sidecar, 'first replacement');
  fs.linkSync(sidecar, anchor);
  fs.renameSync(sidecar, `${sidecar}.replacement`);
  fs.renameSync(anchor, `${anchor}.replacement`);
  fs.writeFileSync(sidecar, 'second replacement');
  fs.linkSync(sidecar, anchor);
  let contenderRan = false;

  assert.throws(
    () => withFileLock(target, () => { contenderRan = true; }, { nonblocking: true }),
    (error) => error?.code === 'ERR_FILE_LOCK_BUSY'
  );
  assert.equal(contenderRan, false);
  fs.writeFileSync(holder.release, 'go');
  await waitForExit(holder.child);
});

test('maps nonblocking and bounded contention waits to stable errors', async (t) => {
  const root = sandbox(t);
  const target = path.join(root, 'registry.json');
  const holder = startHolder(t, target, root, '-waits');
  await waitForPath(holder.ready);

  const nonblockingStart = performance.now();
  assert.throws(
    () => withFileLock(target, () => {}, { nonblocking: true }),
    (error) => error?.code === 'ERR_FILE_LOCK_BUSY'
  );
  assert.ok(performance.now() - nonblockingStart < 500);

  const timeoutStart = performance.now();
  assert.throws(
    () => withFileLock(target, () => {}, { timeoutMs: 80, retryMs: 2 }),
    (error) => error?.code === 'ERR_FILE_LOCK_TIMEOUT'
  );
  const elapsed = performance.now() - timeoutStart;
  assert.ok(elapsed >= 70, `timeout returned too early after ${elapsed}ms`);
  assert.ok(elapsed < 750, `timeout returned too late after ${elapsed}ms`);

  fs.writeFileSync(holder.release, 'go');
  await waitForExit(holder.child);
});

test('kill -9 of a holder releases the kernel endpoint', async (t) => {
  const root = sandbox(t);
  const target = path.join(root, 'registry.json');
  const holder = startHolder(t, target, root, '-kill');
  await waitForPath(holder.ready);
  const exited = waitForExit(holder.child, { allowSignal: true });
  holder.child.kill('SIGKILL');
  await exited;
  assert.equal(withFileLock(target, () => 'recovered', { nonblocking: true }), 'recovered');
});

test('release closes a half-open identity probe before publishing RELEASED', async (t) => {
  const root = sandbox(t);
  const target = path.join(root, 'registry.json');
  const endpoint = lockModule.fileLockEndpoint(target);
  const identity = createHash('sha256')
    .update(`hcc-file-lock-v1\0${endpoint.key}`)
    .digest('hex');
  const expectedBanner = `HCC_FILE_LOCK_V1 ${identity}\n`;
  const probe = startHalfOpenProbe(t, endpoint, expectedBanner, root);
  const probeExit = waitForExit(probe.child);
  probeExit.catch(() => {});
  const probeClosed = new Promise((resolve) => probe.child.once('close', resolve));
  let releaseStarted;
  let hasPrimaryError = false;
  let primaryError;

  try {
    const result = withFileLock(target, () => {
      const wait = new Int32Array(new SharedArrayBuffer(4));
      const deadline = performance.now() + 5000;
      while (!fs.existsSync(probe.ready)) {
        const remaining = deadline - performance.now();
        assert.ok(remaining > 0, 'timed out waiting for the half-open identity probe');
        Atomics.wait(wait, 0, 0, Math.min(10, remaining));
      }
      releaseStarted = performance.now();
      return 'released';
    });
    const releaseElapsed = performance.now() - releaseStarted;
    assert.equal(result, 'released');
    assert.ok(releaseElapsed < 2500, `release took ${releaseElapsed}ms`);
    assert.equal(
      withFileLock(target, () => 'reacquired', { nonblocking: true }),
      'reacquired'
    );
    assert.equal(probe.child.exitCode, null);
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
  }

  const cleanupErrors = [];
  const killProbe = () => {
    if (probe.child.exitCode !== null || probe.child.signalCode !== null) return;
    try {
      if (!probe.child.kill('SIGKILL')) {
        const error = new Error('failed to kill the half-open identity probe');
        error.code = 'ERR_HALF_OPEN_PROBE_KILL_FAILED';
        cleanupErrors.push(error);
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  };
  try {
    fs.writeFileSync(probe.stop, 'stop');
  } catch (error) {
    cleanupErrors.push(error);
    killProbe();
  }
  let exitTimer;
  try {
    await Promise.race([
      probeExit,
      new Promise((_, reject) => {
        exitTimer = setTimeout(() => {
          const error = new Error('timed out waiting for the half-open identity probe to exit');
          error.code = 'ERR_HALF_OPEN_PROBE_EXIT_TIMEOUT';
          reject(error);
        }, 5000);
      })
    ]);
  } catch (error) {
    cleanupErrors.push(error);
    killProbe();
  } finally {
    clearTimeout(exitTimer);
  }
  let closeTimer;
  try {
    await Promise.race([
      probeClosed,
      new Promise((_, reject) => {
        closeTimer = setTimeout(() => {
          const error = new Error('timed out waiting to reap the half-open identity probe');
          error.code = 'ERR_HALF_OPEN_PROBE_REAP_TIMEOUT';
          reject(error);
        }, 5000);
      })
    ]);
  } catch (error) {
    cleanupErrors.push(error);
    killProbe();
  } finally {
    clearTimeout(closeTimer);
  }

  const failures = hasPrimaryError ? [primaryError, ...cleanupErrors] : cleanupErrors;
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'half-open probe test and cleanup failed', {
      cause: failures[0]
    });
  }
});

test('terminal listener failure wins when release joins an in-flight close', async (t) => {
  const root = sandbox(t);
  const closeStartedBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const closeStarted = new Int32Array(closeStartedBuffer);
  let worker = null;
  let workerExit = null;
  let callbackRan = false;
  const lock = lockModule.createFileLock({
    workerFactory({ workerSource, workerData }) {
      const injectedSource = String.raw`
        const net = require('node:net');
        const { parentPort, workerData } = require('node:worker_threads');
        const state = new Int32Array(workerData.stateBuffer);
        const closeStarted = new Int32Array(workerData.testCloseStartedBuffer);
        const originalListen = net.Server.prototype.listen;
        const originalClose = net.Server.prototype.close;
        const pendingCloseCallbacks = [];
        let releaseObserved = false;
        let injectFailure = true;
        let delayCloseCallbacks = false;

        parentPort.on('message', (message) => {
          if (message?.type !== 'release') return;
          releaseObserved = true;
          setImmediate(() => {
            for (const callback of pendingCloseCallbacks.splice(0)) callback();
          });
        });

        net.Server.prototype.listen = function(...args) {
          const callbackIndex = args.length - 1;
          const callback = args[callbackIndex];
          if (typeof callback !== 'function') return originalListen.apply(this, args);
          const server = this;
          args[callbackIndex] = function(...callbackArgs) {
            callback.apply(this, callbackArgs);
            if (injectFailure &&
                Atomics.load(state, 0) === workerData.states.ACQUIRED) {
              injectFailure = false;
              delayCloseCallbacks = true;
              const error = new Error('injected bound listener failure');
              error.code = 'ERR_TEST_LISTENER_FAILURE';
              server.emit('error', error);
            }
          };
          return originalListen.apply(this, args);
        };

        net.Server.prototype.close = function(callback) {
          if (!delayCloseCallbacks || typeof callback !== 'function') {
            return originalClose.call(this, callback);
          }
          if (Atomics.compareExchange(closeStarted, 0, 0, 1) === 0) {
            Atomics.notify(closeStarted, 0);
          }
          return originalClose.call(this, (error) => {
            const deliver = () => callback(error);
            if (releaseObserved) setImmediate(deliver);
            else pendingCloseCallbacks.push(deliver);
          });
        };
      ` + workerSource;
      worker = new Worker(injectedSource, {
        eval: true,
        workerData: { ...workerData, testCloseStartedBuffer: closeStartedBuffer },
        execArgv: []
      });
      workerExit = new Promise((resolve, reject) => {
        worker.once('exit', resolve);
        worker.once('error', reject);
      });
      workerExit.catch(() => {});
      return worker;
    }
  });
  t.after(async () => {
    if (worker === null) return;
    try { await worker.terminate(); } catch {}
  });

  const error = captureThrown(() => lock(path.join(root, 'registry.json'), () => {
    callbackRan = true;
    assert.notEqual(
      Atomics.wait(closeStarted, 0, 0, 5000),
      'timed-out',
      'timed out waiting for the injected listener close'
    );
    return 'callback completed';
  }, { nonblocking: true }));

  assert.equal(callbackRan, true);
  assert.equal(error?.code, 'ERR_FILE_LOCK_RELEASE_FAILED');
  assert.equal(await workerExit, 0);
});

test('derives a fixed endpoint from the canonical target and shares it with aliases', (t) => {
  const root = sandbox(t);
  const realParent = path.join(root, 'real');
  const aliasParent = path.join(root, 'alias');
  fs.mkdirSync(realParent);
  fs.symlinkSync(realParent, aliasParent, 'dir');
  const realTarget = path.join(realParent, 'registry.json');
  const aliasTarget = path.join(aliasParent, 'registry.json');
  assert.equal(typeof lockModule.fileLockEndpoint, 'function');
  const endpoint = lockModule.fileLockEndpoint(realTarget);
  const aliasEndpoint = lockModule.fileLockEndpoint(aliasTarget);
  const canonicalTarget = path.join(fs.realpathSync.native(realParent), 'registry.json');
  const lexicalTarget = path.resolve(aliasTarget);
  const expectedPort = endpointPortForKey(canonicalTarget);
  assert.deepEqual(endpoint, { host: '127.0.0.1', port: expectedPort, key: canonicalTarget });
  assert.deepEqual(aliasEndpoint, endpoint);
  const expectedEndpoints = [
    { host: '127.0.0.1', port: endpointPortForKey(lexicalTarget), key: lexicalTarget },
    { host: '127.0.0.1', port: expectedPort, key: canonicalTarget }
  ].sort((left, right) => left.key.localeCompare(right.key));
  const expectedByPort = new Map();
  for (const value of expectedEndpoints) {
    if (!expectedByPort.has(value.port)) expectedByPort.set(value.port, value);
  }
  assert.deepEqual(
    lockModule.fileLockEndpoints(aliasTarget),
    [...expectedByPort.values()].sort((left, right) => left.port - right.port)
  );
});

test('passes the fixed canonical target to the callback across alias retargeting', (t) => {
  const root = sandbox(t);
  const firstParent = path.join(root, 'first');
  const aliasParent = path.join(root, 'alias');
  fs.mkdirSync(firstParent);
  fs.symlinkSync(firstParent, aliasParent, 'dir');
  const aliasTarget = path.join(aliasParent, 'registry.json');
  const firstTarget = path.join(firstParent, 'registry.json');
  const canonicalRoot = fs.realpathSync.native(root);
  const occupiedPorts = new Set([
    endpointPortForKey(path.resolve(aliasTarget)),
    endpointPortForKey(path.join(canonicalRoot, 'first', 'registry.json'))
  ]);
  let secondParent;
  for (let index = 0; index < 1000; index += 1) {
    const candidate = path.join(root, `second-${index}`);
    const candidatePorts = [
      endpointPortForKey(path.join(candidate, 'registry.json')),
      endpointPortForKey(path.join(canonicalRoot, `second-${index}`, 'registry.json'))
    ];
    if (candidatePorts.every((port) => !occupiedPorts.has(port))) {
      secondParent = candidate;
      break;
    }
  }
  assert.ok(secondParent);
  fs.mkdirSync(secondParent);
  const secondTarget = path.join(secondParent, 'registry.json');

  const result = withFileLock(aliasTarget, (lockedTarget) => {
    assert.equal(lockedTarget, path.join(fs.realpathSync.native(firstParent), 'registry.json'));
    fs.unlinkSync(aliasParent);
    fs.symlinkSync(secondParent, aliasParent, 'dir');

    const directResult = withFileLock(secondTarget, (directTarget) => {
      assert.equal(directTarget, path.join(fs.realpathSync.native(secondParent), 'registry.json'));
      fs.writeFileSync(directTarget, 'second');
      return 'direct-b';
    }, { nonblocking: true });
    fs.writeFileSync(lockedTarget, 'first');
    return directResult;
  });

  assert.equal(result, 'direct-b');
  assert.equal(fs.readFileSync(firstTarget, 'utf8'), 'first');
  assert.equal(fs.readFileSync(secondTarget, 'utf8'), 'second');
});

test('a retargeted parent alias remains locked while the new direct target stays independent', async (t) => {
  const root = sandbox(t);
  const firstParent = path.join(root, 'first');
  const aliasParent = path.join(root, 'alias');
  fs.mkdirSync(firstParent);
  fs.symlinkSync(firstParent, aliasParent, 'dir');
  const aliasTarget = path.join(aliasParent, 'registry.json');
  const firstTarget = path.join(firstParent, 'registry.json');
  const occupiedPorts = new Set([
    endpointPortForKey(path.resolve(aliasTarget)),
    endpointPortForKey(path.resolve(firstTarget))
  ]);
  let secondParent;
  for (let index = 0; index < 1000; index += 1) {
    const candidate = path.join(root, `second-${index}`);
    const candidatePort = endpointPortForKey(path.join(candidate, 'registry.json'));
    if (!occupiedPorts.has(candidatePort)) {
      secondParent = candidate;
      break;
    }
  }
  assert.ok(secondParent);
  fs.mkdirSync(secondParent);
  const secondTarget = path.join(secondParent, 'registry.json');
  const holder = startHolder(t, aliasTarget, root, '-alias-retarget');
  await waitForPath(holder.ready);

  assert.throws(
    () => withFileLock(firstTarget, () => {}, { nonblocking: true }),
    (error) => error?.code === 'ERR_FILE_LOCK_BUSY'
  );
  fs.unlinkSync(aliasParent);
  fs.symlinkSync(secondParent, aliasParent, 'dir');
  let aliasContenderRan = false;
  assert.throws(
    () => withFileLock(aliasTarget, () => { aliasContenderRan = true; }, { nonblocking: true }),
    (error) => error?.code === 'ERR_FILE_LOCK_BUSY'
  );
  assert.equal(aliasContenderRan, false);
  assert.equal(withFileLock(secondTarget, () => 'direct-b', { nonblocking: true }), 'direct-b');

  fs.writeFileSync(holder.release, 'go');
  await waitForExit(holder.child);
  fs.unlinkSync(aliasParent);
  fs.symlinkSync(firstParent, aliasParent, 'dir');
  assert.equal(withFileLock(aliasTarget, () => 'restored', { nonblocking: true }), 'restored');
});

test('releases and rejects when a parent alias is retargeted during acquisition', (t) => {
  const root = sandbox(t);
  const firstParent = path.join(root, 'first');
  const secondParent = path.join(root, 'second');
  const aliasParent = path.join(root, 'alias');
  fs.mkdirSync(firstParent);
  fs.mkdirSync(secondParent);
  fs.symlinkSync(firstParent, aliasParent, 'dir');
  let released = false;
  let callbackRan = false;
  const lock = lockModule.createFileLock({
    workerFactory({ state, states }) {
      fs.unlinkSync(aliasParent);
      fs.symlinkSync(secondParent, aliasParent, 'dir');
      Atomics.store(state, 0, states.ACQUIRED);
      return {
        unref() {},
        postMessage() {
          released = true;
          Atomics.store(state, 0, states.RELEASED);
          Atomics.notify(state, 0);
        },
        terminate() {}
      };
    }
  });

  assert.throws(
    () => lock(path.join(aliasParent, 'registry.json'), () => { callbackRan = true; }),
    /parent changed during acquisition/
  );
  assert.equal(callbackRan, false);
  assert.equal(released, true);
});

test('different noncolliding targets can be held at the same time', (t) => {
  const root = sandbox(t);
  const first = path.join(root, 'first.json');
  let second;
  for (let index = 0; index < 1000; index += 1) {
    const candidate = path.join(root, `second-${index}.json`);
    if (lockModule.fileLockEndpoint(candidate).port !== lockModule.fileLockEndpoint(first).port) {
      second = candidate;
      break;
    }
  }
  assert.ok(second);
  assert.equal(withFileLock(first, () =>
    withFileLock(second, () => 'nested', { nonblocking: true })), 'nested');
});

test('different targets with the same primary port keep independent lock domains', (t) => {
  const root = sandbox(t);
  const byPort = new Map();
  let pair = null;
  for (let index = 0; index < 2000 && !pair; index += 1) {
    const target = path.join(root, `collision-${index}.json`);
    const { port } = lockModule.fileLockEndpoint(target);
    const previous = byPort.get(port);
    if (previous) pair = [previous, target];
    else byPort.set(port, target);
  }
  assert.ok(pair, 'expected a primary-port collision in 2000 deterministic targets');
  assert.equal(withFileLock(pair[0], () =>
    withFileLock(pair[1], () => 'independent', { nonblocking: true })), 'independent');
});

test('an unrelated listener on the primary port does not impersonate the file lock', async (t) => {
  const root = sandbox(t);
  const target = path.join(root, 'registry.json');
  const ready = path.join(root, 'port-ready');
  const { port } = lockModule.fileLockEndpoint(target);
  const source = String.raw`
    import fs from 'node:fs';
    import net from 'node:net';
    const [port, ready] = process.argv.slice(1);
    const server = net.createServer((socket) => socket.destroy());
    server.listen({ host: '127.0.0.1', port: Number(port), exclusive: true }, () => {
      fs.writeFileSync(ready, 'ready');
    });
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, String(port), ready], {
    cwd: repoRoot,
    stdio: ['ignore', 'ignore', 'pipe']
  });
  t.after(() => {
    try { child.kill('SIGKILL'); } catch {}
  });
  await waitForPath(ready);
  assert.equal(
    withFileLock(target, () => {
      assert.throws(
        () => withFileLock(target, () => {}, { nonblocking: true }),
        (error) => error?.code === 'ERR_FILE_LOCK_BUSY'
      );
      return 'acquired';
    }, { nonblocking: true }),
    'acquired'
  );
  const exited = waitForExit(child, { allowSignal: true });
  child.kill('SIGKILL');
  await exited;
});

test('releases after callback errors, falsy throws, thenables, and async callbacks', (t) => {
  const root = sandbox(t);
  const target = path.join(root, 'registry.json');
  for (const [index, thrown] of [new Error('callback failed'), null, false, 0].entries()) {
    assert.equal(captureThrown(() => withFileLock(target, () => { throw thrown; })), thrown);
    assert.equal(withFileLock(target, () => `released-${index}`, { nonblocking: true }), `released-${index}`);
  }
  assert.throws(() => withFileLock(target, () => ({ then() {} })), /requires a synchronous callback/);
  assert.equal(withFileLock(target, () => 'after-thenable', { nonblocking: true }), 'after-thenable');
  assert.throws(() => withFileLock(target, async () => 'no'), /requires a synchronous callback/);
});

test('aggregates startup and terminate failures through an injected worker factory', (t) => {
  const root = sandbox(t);
  const startup = new Error('worker unref failed');
  const terminate = new Error('worker terminate failed');
  assert.equal(typeof lockModule.createFileLock, 'function');
  const lock = lockModule.createFileLock({
    workerFactory() {
      return {
        unref() { throw startup; },
        postMessage() {},
        terminate() { throw terminate; }
      };
    }
  });
  const error = captureThrown(() => lock(path.join(root, 'registry.json'), () => {}));
  assert.equal(error instanceof AggregateError, true);
  assert.equal(errorIncludes(error, startup), true);
  assert.equal(errorIncludes(error, terminate), true);
  assert.equal(error.cleanup?.phase, 'terminate');
});

test('a worker-reported startup failure is already closed and is not terminated', (t) => {
  const root = sandbox(t);
  const startup = new Error('worker reported startup failure');
  let terminateCalls = 0;
  const lock = lockModule.createFileLock({
    workerFactory({ state, states }) {
      Atomics.store(state, 0, states.FAILED);
      Atomics.store(state, 1, 1);
      return {
        unref() {},
        postMessage() {},
        terminate() { terminateCalls += 1; },
        failure() { return startup; }
      };
    }
  });
  const error = captureThrown(() => lock(path.join(root, 'registry.json'), () => {}));
  assert.equal(error, startup);
  assert.equal(terminateCalls, 0);
});

test('a successful worker release is not followed by terminate', (t) => {
  const root = sandbox(t);
  let terminateCalls = 0;
  const lock = lockModule.createFileLock({
    workerFactory({ state, states }) {
      Atomics.store(state, 0, states.ACQUIRED);
      return {
        unref() {},
        postMessage() {
          Atomics.store(state, 0, states.RELEASED);
          Atomics.notify(state, 0);
        },
        terminate() { terminateCalls += 1; }
      };
    }
  });
  assert.equal(lock(path.join(root, 'registry.json'), () => 'released'), 'released');
  assert.equal(terminateCalls, 0);
});

test('a thenable terminate result is reported as unconfirmed cleanup', (t) => {
  const root = sandbox(t);
  const startup = new Error('worker unref failed');
  const lock = lockModule.createFileLock({
    workerFactory() {
      return {
        unref() { throw startup; },
        postMessage() {},
        terminate() { return Promise.reject(new Error('async terminate failed')); }
      };
    }
  });
  const error = captureThrown(() => lock(path.join(root, 'registry.json'), () => {}));
  assert.equal(error instanceof AggregateError, true);
  assert.equal(errorIncludes(error, startup), true);
  assert.equal(error.errors.some((nested) =>
    nested?.code === 'ERR_FILE_LOCK_WORKER_TERMINATION_UNCONFIRMED'), true);
  assert.equal(error.cleanup?.phase, 'terminate');
});

test('worker module load failures report immediately without waiting for startup grace', (t) => {
  const root = sandbox(t);
  const missingWorkerUrl = new URL(`./missing-worker-${Date.now()}.mjs`, import.meta.url);
  const syntaxWorker = path.join(root, 'syntax-worker.mjs');
  const throwingWorker = path.join(root, 'throwing-worker.mjs');
  fs.writeFileSync(syntaxWorker, 'export const = ;\n');
  fs.writeFileSync(throwingWorker, "throw new Error('top-level failure');\n");
  const cases = [
    ['missing', missingWorkerUrl],
    ['syntax', pathToFileURL(syntaxWorker)],
    ['top-level throw', pathToFileURL(throwingWorker)]
  ];
  for (const [label, workerModuleUrl] of cases) {
    const lock = lockModule.createFileLock({
      workerFactory({ workerSource, workerData }) {
        const source = workerSource || workerModuleUrl;
        return new Worker(source, {
          eval: typeof source === 'string',
          workerData: { ...workerData, moduleUrl: workerModuleUrl.href },
          execArgv: []
        });
      }
    });
    const started = performance.now();
    assert.throws(
      () => lock(path.join(root, `${label}.json`), () => {}, { nonblocking: true }),
      (error) => error?.code === 'ERR_FILE_LOCK_WORKER_START_FAILED'
    );
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1000, `${label} worker module failure took ${elapsed}ms`);
  }
});

test('aggregates falsy callback, release, and terminate failures', (t) => {
  const root = sandbox(t);
  const release = new Error('worker release failed');
  const terminate = new Error('worker terminate failed');
  const lock = lockModule.createFileLock({
    workerFactory({ state, states }) {
      Atomics.store(state, 0, states.ACQUIRED);
      return {
        unref() {},
        postMessage() {
          Atomics.store(state, 0, states.RELEASE_FAILED);
          Atomics.store(state, 1, 1);
          Atomics.notify(state, 0);
        },
        terminate() { throw terminate; },
        failure(errorCode) { return errorCode === 1 ? release : null; }
      };
    }
  });
  const error = captureThrown(() => lock(path.join(root, 'registry.json'), () => { throw null; }));
  assert.equal(error instanceof AggregateError, true);
  assert.equal(errorIncludes(error, null), true);
  assert.equal(errorIncludes(error, release), true);
  assert.equal(errorIncludes(error, terminate), true);
  assert.equal(error.cleanup?.phase, 'terminate');
});

test('released real workers all exit and do not accumulate', async (t) => {
  const root = sandbox(t);
  const exits = [];
  const lock = lockModule.createFileLock({
    workerFactory({ workerSource, workerData }) {
      const worker = new Worker(workerSource, { eval: true, workerData, execArgv: [] });
      exits.push(new Promise((resolve, reject) => {
        worker.once('exit', resolve);
        worker.once('error', reject);
      }));
      return worker;
    }
  });
  for (let index = 0; index < 20; index += 1) {
    assert.equal(lock(path.join(root, `target-${index}.json`), () => index), index);
  }
  let timer;
  try {
    await Promise.race([
      Promise.all(exits),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('workers did not exit')), 5000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
});
