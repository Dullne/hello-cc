import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fixtureFetch } from '../scripts/regression-http-transport.mjs';

test('fixture HTTP transport preserves options and response identity while closing every header form', async t => {
  const response = new Response('fixture-response');
  const promise = Promise.resolve(response), calls = [];
  t.mock.method(globalThis, 'fetch', (input, options) => { calls.push({ input, options }); return promise; });
  const signal = new AbortController().signal;
  for (const headers of [
    { Authorization: 'fixture-token', Connection: 'keep-alive' },
    [['Authorization', 'fixture-token'], ['connection', 'keep-alive']],
    new Headers({ Authorization: 'fixture-token', CONNECTION: 'keep-alive' })
  ]) {
    const before = [...new Headers(headers)];
    const input = new URL('http://127.0.0.1:1/fixture');
    const options = { method: 'POST', headers, body: 'fixture-body', signal, redirect: 'manual', cache: 'no-store' };
    const returned = fixtureFetch(input, options);
    assert.equal(returned, promise);
    assert.equal(await returned, response);
    const call = calls.at(-1);
    assert.equal(call.input, input);
    assert.equal(call.options.headers.get('connection'), 'close');
    assert.equal(call.options.headers.get('authorization'), 'fixture-token');
    for (const [key, value] of Object.entries(options)) if (key !== 'headers') assert.equal(call.options[key], value);
    assert.deepEqual([...new Headers(headers)], before, 'caller headers stay unchanged');
    assert.equal(options.headers, headers);
  }
  assert.equal(calls.length, 3);
  assert.equal(response.bodyUsed, false);
});

test('fixture HTTP transport returns the original rejection without retrying', async t => {
  const error = new TypeError('fixture network failure');
  const promise = Promise.reject(error);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', () => { calls++; return promise; });
  const returned = fixtureFetch('http://127.0.0.1:1/fixture', { method: 'POST', body: 'fixture' });
  assert.equal(returned, promise);
  await assert.rejects(returned, observed => observed === error);
  assert.equal(calls, 1);
});

// The server remains responsive while the parent runs a synchronous CLI. It
// only accepts loopback requests and records fake admissions, never task data.
const serverSource = `
import http from 'node:http';
let nextSocket = 0, posts = 0, admissions = 0;
const sockets = new WeakMap();
const server = http.createServer(async (req, res) => {
  for await (const chunk of req) {}
  if (req.method === 'POST') { posts++; admissions++; }
  if (req.url === '/admit-then-reset') { req.socket.destroy(); return; }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ socketId: sockets.get(req.socket), connection: req.headers.connection,
    method: req.method, posts, admissions }));
});
server.keepAliveTimeout = 30_000;
server.on('connection', socket => sockets.set(socket, ++nextSocket));
process.on('message', message => {
  if (message === 'stats') process.send({ posts, admissions, connections: nextSocket });
  if (message === 'stop') { server.closeAllConnections(); server.close(() => process.exit(0)); }
});
process.on('disconnect', () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
`;

async function serverFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-http-transport-home-'));
  const env = { HOME: home, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` };
  const child = spawn(process.execPath, ['--input-type=module', '-e', serverSource], {
    env, stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        if (child.connected) child.send('stop');
        const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
        try { await exited; } finally { clearTimeout(timer); }
      }
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
  const [{ port }] = await once(child, 'message', { signal: AbortSignal.timeout(5000) });
  return {
    base: `http://127.0.0.1:${port}`,
    pause() {
      const result = spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)'],
        { env, stdio: 'ignore', timeout: 5000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
    },
    async stats() {
      const received = once(child, 'message', { signal: AbortSignal.timeout(5000) });
      child.send('stats');
      return (await received)[0];
    }
  };
}

test('fixture requests from the first call use distinct connections across synchronous CLI work', { timeout: 15000 }, async t => {
  const f = await serverFixture(t), socketIds = [];
  for (let index = 0; index < 4; index++) {
    const response = await fixtureFetch(f.base + '/state');
    const body = await response.json();
    assert.equal(body.connection, 'close');
    socketIds.push(body.socketId);
  }
  f.pause();
  const response = await fixtureFetch(f.base + '/fake-action', { method: 'POST', body: 'fixture' });
  const body = await response.json();
  assert.equal(body.connection, 'close');
  socketIds.push(body.socketId);
  assert.equal(new Set(socketIds).size, 5);
  assert.deepEqual(await f.stats(), { posts: 1, admissions: 1, connections: 5 });
});

test('an admitted fake POST whose response resets is not replayed', { timeout: 15000 }, async t => {
  const f = await serverFixture(t);
  await assert.rejects(fixtureFetch(f.base + '/admit-then-reset', { method: 'POST', body: 'fixture' }), error => {
    assert.ok(error instanceof TypeError);
    assert.ok(['ECONNRESET', 'UND_ERR_SOCKET'].includes(error.cause?.code));
    return true;
  });
  assert.deepEqual(await f.stats(), { posts: 1, admissions: 1, connections: 1 });
});
