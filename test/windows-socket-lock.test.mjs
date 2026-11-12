import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { acquireFileLock, createFileLockLease } from '../lib/shared/file-lock.mjs';

function deniedPrimary(t) {
  return createFileLockLease({ workerFactory({ workerSource, workerData }) {
    const inject = String.raw`
      const net = require('node:net');
      const { workerData } = require('node:worker_threads');
      const listen = net.Server.prototype.listen;
      net.Server.prototype.listen = function (...args) {
        if (args[0]?.port === workerData.targets[0].ports[0]) {
          setImmediate(() => this.emit('error', Object.assign(new Error('reserved or exclusive port'), { code: 'EACCES' })));
          return this;
        }
        return listen.apply(this, args);
      };
    `;
    const worker = new Worker(inject + workerSource, { eval: true, workerData, execArgv: [] });
    t.after(async () => { await worker.terminate(); });
    return worker;
  } });
}

test('Windows reserved primary port falls back while preserving a single lock owner',
  { skip: process.platform !== 'win32' }, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-win-socket-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const target = path.join(root, 'state.json');
    const acquire = deniedPrimary(t);
    const owner = acquire(target, { nonblocking: true });
    try {
      owner.assertHeld();
      assert.throws(() => acquireFileLock(target, { nonblocking: true }), { code: 'ERR_FILE_LOCK_BUSY' });
    } finally { owner.release(); }
    const next = acquireFileLock(target, { nonblocking: true });
    next.release();
  });

test('Windows access-denied port still probes an existing matching lock owner',
  { skip: process.platform !== 'win32' }, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-win-socket-owner-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const target = path.join(root, 'state.json');
    const owner = acquireFileLock(target, { nonblocking: true });
    try {
      assert.throws(() => deniedPrimary(t)(target, { nonblocking: true }), { code: 'ERR_FILE_LOCK_BUSY' });
    } finally { owner.release(); }
  });
