import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { startNativeService } from '../lib/runtime/native/service.mjs';
import { nativePaths, readNativePointer } from '../lib/runtime/native/store.mjs';
import { acquireFileLock, createFileLockLease } from '../lib/shared/file-lock.mjs';
import { inspectProcessIdentity } from '../lib/process/identity.mjs';
import { createNativeTestRoot } from './helpers/native-root.mjs';

for (const mode of ['event', 'throw']) {
  for (const code of ['EACCES', 'EMFILE', null]) {
    test(`native ownership ${mode} failure preserves bounded ${code || 'unknown'} diagnostics before persistence or providers start`, async t => {
      const root = await createNativeTestRoot('hcc-native-owner-error-');
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const ctx = { root, dbPath: path.join(root, '.hello-cc', 'mesh.db') };
      const traceBuffer = new SharedArrayBuffer(8);
      const trace = new Int32Array(traceBuffer);
      let workerExit;
      const acquireOwnership = createFileLockLease({ workerFactory({ workerSource, workerData }) {
        const injection = String.raw`
          const net = require('node:net');
          const { workerData: testData } = require('node:worker_threads');
          const trace = new Int32Array(testData.traceBuffer);
          net.Server.prototype.listen = function(options) {
            Atomics.add(trace, 0, 1);
            Atomics.store(trace, 1, options.port);
            const error = Object.assign(new Error('Bearer DO_NOT_COPY /private/DO_NOT_COPY'), {
              code: testData.code || '/private/DO_NOT_COPY',
              errno: testData.errno || 'DO_NOT_COPY',
              syscall: testData.code ? 'listen' : '/private/DO_NOT_COPY',
              address: '/private/DO_NOT_COPY', port: 'DO_NOT_COPY', token: 'DO_NOT_COPY'
            });
            if (testData.mode === 'throw') throw error;
            queueMicrotask(() => this.emit('error', error));
            return this;
          };
        `;
        const worker = new Worker(injection + workerSource, { eval: true, execArgv: [],
          workerData: { ...workerData, traceBuffer, code, errno: code ? -os.constants.errno[code] : null, mode } });
        workerExit = new Promise((resolve, reject) => { worker.once('exit', resolve); worker.once('error', reject); });
        return worker;
      } });
      const counts = { connects: 0, providers: 0 };
      const deps = { liveProcessIdentity: () => inspectProcessIdentity(process.pid).identity,
        connect() { counts.connects++; assert.fail('ownership failure must precede persistence'); } };
      await assert.rejects(startNativeService(ctx, deps, { acquireOwnership,
        adapterFactory() { counts.providers++; assert.fail('ownership failure must precede provider launch'); } }), error => {
        assert.equal(error.code, 'NATIVE_OWNERSHIP_UNAVAILABLE');
        assert.deepEqual(error.extra, {
          cause: { code, errno: code ? -os.constants.errno[code] : null, syscall: code ? 'listen' : null },
          endpoint: { host: '127.0.0.1', port: Atomics.load(trace, 1) }
        });
        assert.equal(JSON.stringify(error.extra).includes('DO_NOT_COPY'), false);
        assert.equal(error.message.includes(root), false);
        return true;
      });
      assert.deepEqual(counts, { connects: 0, providers: 0 });
      assert.equal(Atomics.load(trace, 0), 1, 'resource and permission failures must not be retried as contention');
      assert.equal(readNativePointer(ctx), null);
      assert.equal(fs.existsSync(nativePaths(ctx).db), false);
      assert.equal(await workerExit, 0);
      const lease = acquireFileLock(path.join(nativePaths(ctx).dir, 'service-owner'), { nonblocking: true });
      lease.release();
    });
  }
}
