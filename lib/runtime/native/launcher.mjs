import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { CliError } from '../../shared/errors.mjs';
import { fileLockEndpoint } from '../../shared/file-lock.mjs';
import { openPrivateAppendFile } from '../private-file.mjs';
import { assertNativePointerOwner, nativePaths, readNativeOwnerStatus, readNativePointer } from './store.mjs';
import { nativeRequest } from './client.mjs';
import { spawnPinnedCwdProcess } from '../../process/pinned-cwd.mjs';
import { assertSelectedCwdSnapshot, captureSelectedCwdSnapshot } from '../../process/selected-cwd-identity.mjs';

// Shared by CLI and Web. The in-process promise and short-lived loopback lock
// prevent concurrent launchers from spawning competing project daemons.
export function createNativeLauncher({ spawnProcess = spawn, request = nativeRequest,
  env = process.env, startupTimeoutMs = 10000, pollMs = 100 } = {}) {
  const starting = new Map();

  async function readReady(ctx) {
    if (ctx.initialRootIdentity) assertSelectedCwdSnapshot(ctx.initialRootIdentity);
    const pointer = readNativePointer(ctx);
    if (!pointer) return null;
    try { assertNativePointerOwner(ctx, pointer); }
    catch (error) { if (error.code === 'NATIVE_RUNTIME_OFFLINE') return null; throw error; }
    try {
      const status = await request(ctx, 'GET', '/status', null, { timeoutMs: 2000 });
      if (!status || status.root !== ctx.root || status.meshDb !== ctx.dbPath ||
          status.generation !== pointer.generation) {
        throw new CliError('NATIVE_RESPONSE_INVALID', 'Native runtime does not match this project');
      }
      if (status.stopping) throw new CliError('NATIVE_RUNTIME_STOPPING', 'Native runtime is stopping; finish its shutdown before creating another worker');
      if (ctx.initialRootIdentity) assertSelectedCwdSnapshot(ctx.initialRootIdentity);
      return status;
    } catch (error) {
      if (error.code === 'NATIVE_RUNTIME_OFFLINE') return null;
      throw error;
    }
  }

  async function launch(ctx) {
    const ready = await readReady(ctx);
    if (ready) return ready;
    const paths = nativePaths(ctx, { create: true });
    const endpoint = fileLockEndpoint(path.join(paths.dir, 'launcher-owner'));
    const deadline = Date.now() + startupTimeoutMs;
    let lock;
    while (!lock && Date.now() < deadline) {
      const candidate = net.createServer(socket => socket.end());
      const acquired = await new Promise((resolve, reject) => {
        candidate.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
        candidate.listen(endpoint.port, '127.0.0.1', () => resolve(true));
      });
      if (acquired) lock = candidate;
      else {
        const existing = await readReady(ctx);
        if (existing) return existing;
        await delay(pollMs);
      }
    }
    if (!lock) throw new CliError('NATIVE_RUNTIME_START_FAILED', 'Another native launcher is still starting; inspect native status before retrying');
    try {
      const existing = await readReady(ctx);
      if (existing) return existing;
      // A daemon can hold its durable owner before publishing runtime.json.
      // Keep the rc8 launcher lock and wait for that owner, rather than launch
      // a second process when the pointer is temporarily absent.
      while (Date.now() < deadline && ['live', 'unknown'].includes(readNativeOwnerStatus(ctx).state)) {
        const status = await readReady(ctx);
        if (status) return status;
        await delay(pollMs);
      }
      if (Date.now() >= deadline) throw new CliError('NATIVE_RUNTIME_START_FAILED', 'A native owner is still starting or its exit is unconfirmed; inspect native status before retrying');
      let log, child;
      try {
        log = openPrivateAppendFile(paths.log);
        child = spawnPinnedCwdProcess(process.execPath, [fileURLToPath(new URL('../../../bin/hcc.mjs', import.meta.url)), '--root', ctx.root, '--db', ctx.dbPath, 'native', 'serve'], {
          cwd: ctx.root, expectedIdentity: ctx.initialRootIdentity,
          env: { ...env, HCC_PINNED_ROOT_IDENTITY: JSON.stringify({
            canonical: ctx.initialRootIdentity.canonical, identity: ctx.initialRootIdentity.identity
          }) }, detached: true, stdio: ['ignore', log, log]
        }, spawnProcess);
      } catch (error) {
        if (error?.code === 'PROJECT_PATH_FORBIDDEN') throw new CliError('NATIVE_STATE_UNSAFE', error.message);
        throw error;
      } finally {
        if (log !== undefined) fs.closeSync(log);
      }
      let failed;
      let exited;
      child.on('error', error => { failed = error; });
      child.once('exit', (code, signal) => { exited = { code, signal }; });
      child.unref();
      while (Date.now() < deadline) {
        if (failed) throw new CliError('NATIVE_RUNTIME_START_FAILED', failed.message);
        if (exited) throw new CliError('NATIVE_RUNTIME_START_FAILED',
          `Native runtime exited before it became ready (code=${exited.code ?? ''}${exited.signal ? ` signal=${exited.signal}` : ''}). Inspect ${paths.log}`);
        const status = await readReady(ctx);
        if (status) return status;
        await delay(pollMs);
      }
      throw new CliError('NATIVE_RUNTIME_START_FAILED', `Native runtime did not become ready. Inspect native status and ${paths.log} before retrying`);
    } finally { await new Promise(resolve => lock.close(resolve)); }
  }

  return function ensureNativeRuntime(ctx) {
    const expectedRootIdentity = ctx.initialRootIdentity || ctx.rootIdentity || captureSelectedCwdSnapshot(ctx.root);
    assertSelectedCwdSnapshot(expectedRootIdentity);
    const canonical = { ...ctx, root: expectedRootIdentity.canonical,
      initialRootIdentity: expectedRootIdentity, dbPath: path.resolve(ctx.dbPath) };
    const key = `${canonical.root}\0${canonical.dbPath}`;
    if (starting.has(key)) return starting.get(key);
    const pending = launch(canonical).finally(() => {
      if (starting.get(key) === pending) starting.delete(key);
    });
    starting.set(key, pending);
    return pending;
  };
}

export const ensureNativeRuntime = createNativeLauncher();
