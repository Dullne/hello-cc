import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import test from 'node:test';
import { acquireFileLock } from '../lib/shared/file-lock.mjs';
import { createNativeFixtureRoot } from '../scripts/native-fixture-root.mjs';
import { createNativeTestRoot } from './helpers/native-root.mjs';

async function selectedFixture(t) {
  const ports = [], createServer = net.createServer;
  const mocked = t.mock.method(net, 'createServer', (...args) => {
    const server = createServer(...args), listen = server.listen;
    server.listen = function (options, ...rest) {
      ports.push(options.port);
      assert.equal(options.host, '127.0.0.1');
      assert.equal(options.exclusive, true);
      return listen.call(this, options, ...rest);
    };
    return server;
  });
  try {
    const root = await createNativeFixtureRoot('hcc-fixture-root-test-', { projectSubdir: 'project with spaces' });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, ports: ports.slice(-4) };
  } finally { mocked.mock.restore(); }
}

test('shared fixture checks the same four loopback candidates held by the product lock', async t => {
  assert.equal(createNativeTestRoot, createNativeFixtureRoot);
  const { root, ports } = await selectedFixture(t);
  assert.equal(new Set(ports).size, 4);
  assert.deepEqual(fs.readdirSync(root), [], 'selection must not create project state');
  const target = path.join(root, 'project with spaces', '.hello-cc', 'native', 'service-owner');
  const lease = acquireFileLock(target, { nonblocking: true, rejectLegacyOwner: true });
  try {
    for (const port of ports) {
      const server = net.createServer();
      await assert.rejects(new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
      }), error => error.code === 'EADDRINUSE' || (process.platform === 'win32' && error.code === 'EACCES'));
      server.close();
    }
  } finally { lease.release(); }
});

test('fixture skips a final-candidate silent listener without connecting or stopping it', async t => {
  const first = await selectedFixture(t), occupied = net.createServer();
  let connections = 0;
  occupied.on('connection', socket => { connections++; socket.destroy(); });
  await new Promise((resolve, reject) => {
    occupied.once('error', reject);
    occupied.listen({ host: '127.0.0.1', port: first.ports[3], exclusive: true }, resolve);
  });
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const mkdtemp = fs.mkdtempSync;
  let calls = 0;
  t.mock.method(fs, 'mkdtempSync', (...args) => ++calls === 1 ? first.root : mkdtemp(...args));
  const selected = await createNativeFixtureRoot('hcc-fixture-root-test-', { projectSubdir: 'project with spaces' });
  t.after(() => fs.rmSync(selected, { recursive: true, force: true }));
  assert.notEqual(selected, first.root);
  assert.equal(fs.existsSync(first.root), false, 'only the rejected fixture directory is removed');
  assert.equal(connections, 0, 'the fixture must use bind-only inspection');
  assert.equal(occupied.listening, true, 'the occupied listener remains untouched');
  assert.deepEqual(fs.readdirSync(selected), []);
});

test('fixture preserves non-contention bind errors and cleans its rejected directory without retrying', async t => {
  const mkdtemp = fs.mkdtempSync, denied = Object.assign(new Error('fixture address unavailable'), { code: 'EADDRNOTAVAIL' });
  let root, calls = 0;
  t.mock.method(fs, 'mkdtempSync', (...args) => { calls++; return root = mkdtemp(...args); });
  t.mock.method(net, 'createServer', () => {
    const server = new EventEmitter();
    server.listen = () => queueMicrotask(() => server.emit('error', denied));
    server.close = callback => callback(Object.assign(new Error('not running'), { code: 'ERR_SERVER_NOT_RUNNING' }));
    return server;
  });
  await assert.rejects(createNativeFixtureRoot('hcc-fixture-root-test-'), error => error === denied);
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(root), false);
});

test('simultaneous fixture preflight does not impersonate a legacy runtime on a colliding port', { timeout: 15000 }, async t => {
  const createServer = net.createServer, sockets = new Set();
  let selectedRoot, firstPort, resumePreflight, announceFirst;
  const firstListening = new Promise(resolve => { announceFirst = resolve; });
  const continuePreflight = new Promise(resolve => { resumePreflight = resolve; });
  let paused = false;
  const mocked = t.mock.method(net, 'createServer', (...args) => {
    const server = createServer(...args), listen = server.listen;
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    server.listen = function (options, ...rest) {
      if (firstPort === undefined) {
        server.once('listening', () => { firstPort = options.port; announceFirst(); });
      }
      if (firstPort !== undefined && !paused) {
        paused = true;
        void continuePreflight.then(() => listen.call(this, options, ...rest));
        return this;
      }
      return listen.call(this, options, ...rest);
    };
    return server;
  });
  const selection = createNativeFixtureRoot('hcc-fixture-overlap-', {
    ownershipKey(root) { selectedRoot = root; return path.join(root, 'fixture-owner'); }
  });
  let worker, acquired = false, workerExit;
  try {
    await firstListening;
    // Pick a different lock whose primary port collides with the live
    // preflight listener, while the fixture's remaining binds are paused.
    let target;
    for (let index = 0; index < 500000; index++) {
      const candidate = path.join(selectedRoot, `independent-owner-${index}`);
      if (20000 + createHash('sha256').update(candidate).digest().readUInt32BE(0) % 40000 === firstPort) {
        target = candidate; break;
      }
    }
    assert.ok(target, 'could not find a deterministic collision');
    worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');
      import(workerData.module).then(({acquireFileLock})=>{
        try {
          const lease=acquireFileLock(workerData.target,{nonblocking:true,rejectLegacyOwner:true});
          parentPort.once('message',()=>{lease.release();parentPort.close();});
          parentPort.postMessage({acquired:true});
        } catch(error) { parentPort.postMessage({acquired:false,code:error.code});parentPort.close(); }
      });`, { eval: true, workerData: { target, module: new URL('../lib/shared/file-lock.mjs', import.meta.url).href } });
    workerExit = new Promise((resolve, reject) => { worker.once('exit', resolve); worker.once('error', reject); });
    const result = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
    acquired = result.acquired;
    assert.deepEqual(result, { acquired: true }, 'a fixture listener must not look like an unidentified legacy runtime');
  } finally {
    if (acquired) worker.postMessage('release');
    if (workerExit) assert.equal(await workerExit, 0);
    for (const socket of sockets) socket.destroy();
    resumePreflight();
    mocked.mock.restore();
    const root = await selection;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Windows fixture retries a reserved port without probing its occupant', { skip: process.platform !== 'win32' }, async t => {
  const createServer = net.createServer, mkdtemp = fs.mkdtempSync;
  const roots = [];
  let attempts = 0;
  t.mock.method(fs, 'mkdtempSync', (...args) => { const root = mkdtemp(...args); roots.push(root); return root; });
  t.mock.method(net, 'createServer', (...args) => {
    if (attempts++ !== 0) return createServer(...args);
    const server = new EventEmitter();
    server.listen = () => queueMicrotask(() => server.emit('error', Object.assign(new Error('reserved port'), { code: 'EACCES' })));
    server.close = callback => callback(Object.assign(new Error('not running'), { code: 'ERR_SERVER_NOT_RUNNING' }));
    return server;
  });
  const root = await createNativeFixtureRoot('hcc-fixture-reserved-port-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.notEqual(root, roots[0]);
  assert.equal(fs.existsSync(roots[0]), false);
  assert.deepEqual(fs.readdirSync(root), []);
});
