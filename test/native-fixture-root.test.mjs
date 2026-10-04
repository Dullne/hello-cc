import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';
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
      }), { code: 'EADDRINUSE' });
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
  const mkdtemp = fs.mkdtempSync, denied = Object.assign(new Error('fixture listen denied'), { code: 'EACCES' });
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
