import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { createTmuxStream } from '../lib/web/tmux-stream.mjs';
import { acquireFileLock } from '../lib/shared/file-lock.mjs';
import { bufferDirectoryLeaseTarget, withBufferDirectoryLease } from '../lib/runtime/buffer-directory-lease.mjs';

const originalPipes = new WeakMap();

function fixture(t, { tmuxBody = 'exit 0', lease = withBufferDirectoryLease } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-stream-stop-')));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { mode: 0o700 });
  // All commands hit a test-owned executable, never a user's tmux server.
  fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\n' + tmuxBody + '\n', { mode: 0o700 });
  const oldPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + (oldPath || '');
  const stream = createTmuxStream({ ctx: { root }, withBufferDirectoryLease: lease });
  const sessions = [];
  t.after(() => {
    for (const session of sessions) stream.stopTmuxStream(session, { shutdownDeadline: 0 });
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    fs.rmSync(root, { recursive: true, force: true });
  });
  function fifo(file) {
    assert.equal(spawnSync('mkfifo', [file]).status, 0);
    fs.chmodSync(file, 0o600);
  }
  function session() {
    const pipeFile = path.join(root, `stream-${sessions.length}.pipe`);
    fifo(pipeFile);
    const item = { pane: '%fixture', pipeFile,
      streamFd: fs.openSync(pipeFile, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK),
      streamPoller: setInterval(() => {}, 1000), replacePoller: setInterval(() => {}, 1000),
      replaceTimer: setTimeout(() => {}, 10000), inputRefreshTimer: setTimeout(() => {}, 10000) };
    sessions.push(item);
    originalPipes.set(item, fs.fstatSync(item.streamFd));
    return item;
  }
  return { root, stream, session, fifo };
}

function assertLocalResourcesClosed(session, fd) {
  for (const key of ['streamFd', 'streamPoller', 'replacePoller', 'replaceTimer', 'inputRefreshTimer', 'pipeFile']) {
    assert.equal(session[key], null, `${key} retained`);
  }
  // A lease worker can immediately reuse the numeric fd for its socket.
  let current;
  try { current = fs.fstatSync(fd); } catch (error) { assert.equal(error.code, 'EBADF'); return; }
  const original = originalPipes.get(session);
  assert.ok(current.dev !== original.dev || current.ino !== original.ino || !current.isFIFO(),
    'original FIFO descriptor is still open');
}

test('shutdown skips a held FIFO lease and always releases local resources', { skip: process.platform === 'win32' }, t => {
  const { root, stream, session } = fixture(t);
  const item = session(), fd = item.streamFd, file = item.pipeFile;
  const held = acquireFileLock(bufferDirectoryLeaseTarget(root));
  try {
    const started = performance.now();
    stream.stopTmuxStream(item, { shutdownDeadline: started + 1000 });
    assert.ok(performance.now() - started < 2000, 'waited for the contended lease');
    assert.ok(fs.lstatSync(file).isFIFO(), 'contended FIFO should be left for recovery');
    assertLocalResourcesClosed(item, fd);
  } finally { held.release(); }
});

test('shutdown unlinks its own FIFO when the lease is available', { skip: process.platform === 'win32' }, t => {
  const { stream, session } = fixture(t);
  const item = session(), fd = item.streamFd, file = item.pipeFile;
  stream.stopTmuxStream(item, { shutdownDeadline: performance.now() + 1000 });
  assert.equal(fs.existsSync(file), false);
  assertLocalResourcesClosed(item, fd);
});

test('shutdown preserves a replacement FIFO at the same pathname', { skip: process.platform === 'win32' }, t => {
  const { stream, session, fifo } = fixture(t);
  const item = session(), fd = item.streamFd, file = item.pipeFile;
  fs.renameSync(file, file + '.original');
  fifo(file);
  const successor = fs.lstatSync(file);
  stream.stopTmuxStream(item, { shutdownDeadline: performance.now() + 1000 });
  assert.equal(fs.lstatSync(file).ino, successor.ino);
  assertLocalResourcesClosed(item, fd);
});

test('expired shutdown budget starts no tmux or lease work but closes descriptors', { skip: process.platform === 'win32' }, t => {
  let leaseCalls = 0;
  const { root, stream, session } = fixture(t, { tmuxBody: 'touch "$0.called"', lease() { leaseCalls++; } });
  const item = session(), fd = item.streamFd, file = item.pipeFile;
  stream.stopTmuxStream(item, { shutdownDeadline: performance.now() - 1 });
  assert.equal(fs.existsSync(path.join(root, 'bin', 'tmux.called')), false);
  assert.equal(leaseCalls, 0);
  assert.ok(fs.existsSync(file));
  assertLocalResourcesClosed(item, fd);
});

test('slow tmux stops share one shutdown budget across sessions', { skip: process.platform === 'win32' }, t => {
  // exec leaves no sleeping grandchild when runTmux terminates the fixture.
  const { stream } = fixture(t, { tmuxBody: 'exec sleep 2' });
  const started = performance.now(), shutdownDeadline = started + 1000;
  for (let index = 0; index < 8; index++) stream.stopTmuxStream({ pane: '%fixture' }, { shutdownDeadline });
  assert.ok(performance.now() - started < 2000, 'per-session waits multiplied the shutdown budget');
});

test('ordinary detach retains blocking lease behavior and pathname cleanup', { skip: process.platform === 'win32' }, t => {
  let leaseCalls = 0;
  const { stream, session } = fixture(t, { lease(_directory, callback, options) {
    assert.deepEqual(options, {});
    leaseCalls++;
    return callback();
  } });
  const item = session(), fd = item.streamFd, file = item.pipeFile;
  stream.stopTmuxStream(item);
  assert.equal(leaseCalls, 1);
  assert.equal(fs.existsSync(file), false);
  assertLocalResourcesClosed(item, fd);
});
