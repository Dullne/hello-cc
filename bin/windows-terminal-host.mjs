#!/usr/bin/env node
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ensurePrivateGlobalSubdirectory } from '../lib/runtime/private-state.mjs';
import { acquireFileLock } from '../lib/shared/file-lock.mjs';
import { captureDirectory } from '../lib/platform/windows-filesystem.mjs';
import { writeWindowsJson } from '../lib/platform/windows-json.mjs';
import { inspectProcessIdentity } from '../lib/process/identity.mjs';
import { spawnWindowsPty } from '../lib/platform/windows-pty.mjs';
import { createTerminalHost } from '../lib/terminal/host.mjs';
import { startTerminalServer } from '../lib/terminal/server.mjs';
import { validateTerminalProject, prepareTerminalCreate, publishTerminalCreated, publishTerminalExited } from '../lib/terminal/store.mjs';

let owner, lease, server, host, stopping;
async function stop(exitCode = 0) {
  if (stopping) return stopping;
  stopping = (async () => {
    try { await host?.close(); await server?.close(); }
    catch (error) { process.stderr.write(`Terminal shutdown unconfirmed: ${error.code || 'UNKNOWN'}\n`); exitCode = 1; }
    finally { try { owner?.release(); } finally { lease?.close(); } }
    process.exit(exitCode);
  })();
  return stopping;
}
try {
  if (process.platform !== 'win32' || process.argv.length !== 4 || process.argv[2] !== '--state-dir') throw new Error('Invalid terminal service entry');
  const dir = ensurePrivateGlobalSubdirectory('terminals');
  if (process.argv[3] !== dir || process.cwd() !== dir) throw new Error('Invalid terminal service directory');
  lease = captureDirectory(dir, { pin: true });
  owner = acquireFileLock(path.join(dir, 'host-owner'), { createParent: false, nonblocking: true });
  const observed = inspectProcessIdentity(process.pid);
  if (observed.state !== 'live') throw new Error('Terminal service identity unavailable');
  host = createTerminalHost({ spawnPty: spawnWindowsPty, validateProject: validateTerminalProject,
    prepareCreate: prepareTerminalCreate,
    publishCreated: publishTerminalCreated, publishExited: publishTerminalExited });
  const token = randomBytes(32).toString('hex');
  server = await startTerminalServer({ host, token, identity: observed.identity, onShutdown: () => stop() });
  owner.assertHeld(); lease.assertUnchanged();
  writeWindowsJson(path.join(dir, 'runtime.json'), { protocol: 1, port: server.port, token,
    generation: host.generation, identity: observed.identity });
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  process.once('uncaughtException', error => { process.stderr.write(`Terminal service failure: ${error.code || 'UNCAUGHT'}\n`); void stop(1); });
  process.once('unhandledRejection', () => { process.stderr.write('Terminal service failure: UNHANDLED_REJECTION\n'); void stop(1); });
  const monitor = setInterval(() => {
    try { owner.assertHeld(); lease.assertUnchanged(); }
    catch { void stop(1); }
  }, 1000); monitor.unref();
} catch (error) {
  process.stderr.write(`Terminal service startup failed: ${error.code || error.message}\n`);
  await stop(1);
}
