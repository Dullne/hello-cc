import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonRpcProcess } from '../lib/integrations/native/jsonrpc.mjs';

// A real stdio peer, deliberately writing fragmented and interleaved frames.
// It has no model, provider credentials, filesystem writes, or network access.
const peerProgram = String.raw`
const { createInterface } = require('node:readline');
const lines = createInterface({ input: process.stdin });
let held;
let serverRequest;
const write = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
lines.on('line', (line) => {
  const frame = JSON.parse(line);
  if (!frame.method) {
    if (serverRequest && frame.id === 'peer-approval') {
      write({ id: serverRequest, result: frame });
      serverRequest = null;
    }
    return;
  }
  const response = (value) => write({ id: frame.id, result: value });
  switch (frame.method) {
    case 'ready': return response({ pid: process.pid });
    case 'delayed-term':
      setInterval(() => {}, 1000);
      process.on('SIGTERM', () => setTimeout(() => process.exit(0), 120));
      return response({ installed: true });
    case 'ignore-term':
      setInterval(() => {}, 1000);
      process.on('SIGTERM', () => {});
      return response({ installed: true });
    case 'echo': return response(frame.params);
    case 'fragment': {
      const text = '中文🙂é';
      const encoded = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: text }) + '\n');
      const split = encoded.indexOf(Buffer.from('中')) + 1;
      process.stdout.write(encoded.subarray(0, split));
      setTimeout(() => {
        const emojiSplit = encoded.indexOf(Buffer.from('🙂')) + 2;
        process.stdout.write(encoded.subarray(split, emojiSplit));
        setTimeout(() => {
          process.stdout.write(Buffer.concat([
            encoded.subarray(emojiSplit),
            Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'unicode-notice', params: { text } }) + '\n')
          ]));
        }, 5);
      }, 5);
      return;
    }
    case 'hold-first': held = frame; return;
    case 'release-second':
      process.stdout.write([
        { jsonrpc: '2.0', method: 'between', params: { text: 'notice' } },
        { jsonrpc: '2.0', id: frame.id, result: 'second' },
        { jsonrpc: '2.0', id: held.id, result: 'first' }
      ].map((item) => JSON.stringify(item) + '\n').join(''));
      return;
    case 'notify-input':
      write({ method: 'notification-received', params: frame.params });
      return;
    case 'ask-permission':
      serverRequest = frame.id;
      write({ id: 'peer-approval', method: 'permission/request', params: { action: 'write' } });
      return;
    case 'late':
      setTimeout(() => {
        response({ from: 'expired', id: frame.id });
        write({ method: 'late-sent', params: { id: frame.id } });
      }, 100);
      return;
    case 'after-late':
      setTimeout(() => response({ from: 'current', id: frame.id }), 180);
      return;
    case 'pending': return;
    case 'exit': setTimeout(() => process.exit(23), 5); return;
    case 'stderr':
      process.stderr.write(Buffer.alloc(8 * 1024 * 1024, 120), () => response({ drained: true }));
      return;
    case 'invalid': process.stdout.write('not JSON\n'); return;
    case 'nonobject': process.stdout.write('[]\n'); return;
    case 'large-line': process.stdout.write(JSON.stringify({ id: frame.id, result: 'x'.repeat(4096) }) + '\n'); return;
    case 'large-partial': process.stdout.write('x'.repeat(4096)); return;
    case 'rpc-error': write({ id: frame.id, error: { code: -32602, message: 'bad input', data: { field: 'text' } } }); return;
  }
});
`;

async function until(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for real stdio peer');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function transport(t, options = {}) {
  const rpc = new JsonRpcProcess({ binary: process.execPath, args: ['-e', peerProgram], timeoutMs: 2000, ...options });
  t.after(() => rpc.close());
  await rpc.start();
  await rpc.request('ready');
  return rpc;
}

test('JSON-RPC decodes split UTF-8 and dispatches multiple out-of-order responses and notifications', async (t) => {
  const notices = [];
  const rpc = await transport(t, { onNotification: (method, params) => notices.push({ method, params }) });
  assert.equal(await rpc.request('fragment'), '中文🙂é');
  await until(() => notices.some((notice) => notice.method === 'unicode-notice'));
  assert.deepEqual(notices.find((notice) => notice.method === 'unicode-notice').params, { text: '中文🙂é' });
  const first = rpc.request('hold-first');
  const second = rpc.request('release-second');
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  assert.ok(notices.some((notice) => notice.method === 'between'));
  rpc.notify('notify-input', { text: 'notification only' });
  await until(() => notices.some((notice) => notice.method === 'notification-received'));
  assert.deepEqual(notices.find((notice) => notice.method === 'notification-received').params, { text: 'notification only' });
});

test('JSON-RPC rejects unsupported server requests and transmits an explicit deny response', async (t) => {
  const unsupported = await transport(t);
  const rejected = await unsupported.request('ask-permission');
  assert.equal(rejected.id, 'peer-approval');
  assert.equal(rejected.error.code, -32601);
  assert.match(rejected.error.message, /Unsupported/);
  const seen = [];
  const denied = await transport(t, {
    onRequest: async (method, params) => {
      seen.push({ method, params });
      return { decision: 'deny' };
    }
  });
  const reply = await denied.request('ask-permission');
  assert.deepEqual(seen, [{ method: 'permission/request', params: { action: 'write' } }]);
  assert.equal(reply.error, undefined);
  assert.deepEqual(reply.result, { decision: 'deny' });
});

test('JSON-RPC discards a timed-out response while the next request is pending', async (t) => {
  let lateSent = false;
  const rpc = await transport(t, { onNotification: (method) => { if (method === 'late-sent') lateSent = true; } });
  await assert.rejects(rpc.request('late', {}, { timeoutMs: 20 }), (error) => {
    assert.equal(error.code, 'NATIVE_REQUEST_TIMEOUT');
    assert.equal(error.extra.uncertain, true);
    return true;
  });
  let currentFinished = false;
  const current = rpc.request('after-late').then((value) => { currentFinished = true; return value; });
  await until(() => lateSent);
  assert.equal(currentFinished, false, 'the late response must not settle the new request');
  assert.equal(rpc.pending.size, 1);
  const response = await current;
  assert.equal(response.from, 'current');
  assert.equal(rpc.pending.size, 0);
  assert.deepEqual(await rpc.request('echo', { still: 'connected' }), { still: 'connected' });
});

test('JSON-RPC process exit rejects every pending request with exit evidence', async (t) => {
  const exits = [];
  const rpc = await transport(t, { onExit: (event) => exits.push(event) });
  const outcomes = await Promise.allSettled([rpc.request('pending'), rpc.request('exit')]);
  for (const outcome of outcomes) {
    assert.equal(outcome.status, 'rejected');
    assert.equal(outcome.reason.code, 'NATIVE_PROCESS_EXITED');
    assert.equal(outcome.reason.extra.code, 23);
    assert.equal(outcome.reason.extra.uncertain, true);
  }
  assert.deepEqual(exits, [{ code: 23, signal: null, expected: false }]);
  assert.equal(rpc.pending.size, 0);
  await assert.rejects(rpc.request('echo'), { code: 'NATIVE_TRANSPORT_CLOSED' });
});

test('JSON-RPC close terminates its owned child and leaves another child usable', async (t) => {
  const exits = [];
  const owned = await transport(t, { onExit: (event) => exits.push(event) });
  const independent = await transport(t);
  const ownedPid = owned.child.pid;
  const independentPid = independent.child.pid;
  const pending = owned.request('pending');
  const pendingRejection = assert.rejects(pending, { code: 'NATIVE_TRANSPORT_CLOSED' });
  await owned.close();
  await pendingRejection;
  assert.equal(owned.closed, true);
  assert.ok(owned.child.exitCode !== null || owned.child.signalCode !== null);
  assert.equal(exits.at(-1).expected, true);
  assert.throws(() => process.kill(ownedPid, 0), { code: 'ESRCH' });
  assert.equal(process.kill(independentPid, 0), true);
  assert.deepEqual(await independent.request('echo', { alive: true }), { alive: true });
  await owned.close();
});

test('concurrent JSON-RPC closes share one promise and all wait for the real delayed exit', async (t) => {
  const exits = [];
  const rpc = await transport(t, { onExit: (event) => exits.push(event) });
  await rpc.request('delayed-term');
  const first = rpc.close();
  const second = rpc.close();
  assert.equal(first, second);
  let finished = false;
  second.then(() => { finished = true; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(finished, false);
  assert.equal(process.kill(rpc.child.pid, 0), true);
  await Promise.all([first, second]);
  assert.equal(rpc.child.exitCode, 0);
  assert.deepEqual(exits, [{ code: 0, signal: null, expected: true }]);
  assert.throws(() => process.kill(rpc.child.pid, 0), { code: 'ESRCH' });
});

test('JSON-RPC close escalates an ignored SIGTERM and waits for SIGKILL exit evidence', async (t) => {
  const exits = [];
  const rpc = await transport(t, { closeGraceMs: 40, closeKillTimeoutMs: 1000,
    onExit: (event) => exits.push(event) });
  await rpc.request('ignore-term');
  const closing = rpc.close();
  assert.equal(closing, rpc.close());
  await closing;
  assert.equal(rpc.child.signalCode, 'SIGKILL');
  assert.deepEqual(exits, [{ code: null, signal: 'SIGKILL', expected: true }]);
  assert.throws(() => process.kill(rpc.child.pid, 0), { code: 'ESRCH' });
});

test('JSON-RPC close handles never-started and failed-spawn transports without waiting for exit', async () => {
  const unstarted = new JsonRpcProcess({ binary: process.execPath });
  assert.equal(unstarted.close(), unstarted.close());
  await unstarted.close();
  await assert.rejects(unstarted.start(), { code: 'NATIVE_TRANSPORT_STATE' });
  const failed = new JsonRpcProcess({ binary: `/nonexistent-hcc-native-${process.pid}` });
  await assert.rejects(failed.start(), { code: 'ENOENT' });
  await failed.close();
  assert.equal(failed.child?.pid, undefined);
});

test('JSON-RPC close reports signal failures and accepts an observed exit on retry', async (t) => {
  const rpc = await transport(t);
  const originalKill = rpc.child.kill.bind(rpc.child);
  rpc.child.kill = () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); };
  const closing = rpc.close();
  assert.equal(closing, rpc.close());
  await assert.rejects(closing, (error) => {
    assert.equal(error.code, 'NATIVE_CLOSE_FAILED');
    assert.deepEqual(error.extra, { pid: rpc.child.pid, uncertain: true, cause: 'EPERM' });
    return true;
  });
  await assert.rejects(rpc.close(), { code: 'NATIVE_CLOSE_FAILED' });
  rpc.child.kill = originalKill;
  originalKill('SIGKILL');
  await until(() => rpc.child.exitCode !== null || rpc.child.signalCode !== null);
  await rpc.close();
  await assert.rejects(closing, { code: 'NATIVE_CLOSE_FAILED' });
});

for (const failure of ['signal', 'exit-timeout']) {
  test(`JSON-RPC close retries a live owned child after ${failure} failure`, async (t) => {
    const rpc = await transport(t, { closeGraceMs: 20, closeKillTimeoutMs: 20 });
    await rpc.request('ignore-term');
    const originalKill = rpc.child.kill.bind(rpc.child);
    rpc.child.kill = () => {
      if (failure === 'signal') throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
      return true; // A successful signal call alone is not an exit receipt.
    };
    try {
      const first = rpc.close();
      assert.equal(first, rpc.close());
      await assert.rejects(first, (error) => error.code === 'NATIVE_CLOSE_FAILED' &&
        error.extra.cause === (failure === 'signal' ? 'EPERM' : 'NATIVE_EXIT_TIMEOUT'));
      assert.equal(rpc.child.exitCode, null);
      assert.equal(rpc.child.signalCode, null);
      await assert.rejects(rpc.request('echo'), { code: 'NATIVE_TRANSPORT_CLOSED' });
      rpc.child.kill = originalKill;
      const retry = rpc.close();
      assert.equal(retry, rpc.close());
      await retry;
      assert.equal(rpc.child.signalCode, 'SIGKILL');
      assert.throws(() => process.kill(rpc.child.pid, 0), { code: 'ESRCH' });
      await assert.rejects(first, { code: 'NATIVE_CLOSE_FAILED' });
    } finally {
      rpc.child.kill = originalKill;
      if (rpc.child.exitCode === null && rpc.child.signalCode === null) originalKill('SIGKILL');
      await until(() => rpc.child.exitCode !== null || rpc.child.signalCode !== null);
    }
  });
}

test('JSON-RPC drains stderr larger than pipe capacity without corrupting stdout', async (t) => {
  const notices = [];
  const rpc = await transport(t, { onNotification: (method) => notices.push(method) });
  assert.deepEqual(await rpc.request('stderr', {}, { timeoutMs: 3000 }), { drained: true });
  assert.deepEqual(notices, []);
  assert.deepEqual(await rpc.request('echo', { valid: true }), { valid: true });
});

test('JSON-RPC protocol failure observes failed cleanup without fabricating process exit', async (t) => {
  const errors = [];
  const exits = [];
  const rpc = await transport(t, {
    onError(error) {
      errors.push(error);
      return Promise.reject(new Error('consumer rejected error notification'));
    },
    onExit: (event) => exits.push(event)
  });
  await rpc.request('ignore-term');
  const originalKill = rpc.child.kill.bind(rpc.child);
  rpc.child.kill = () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); };
  try {
    await assert.rejects(rpc.request('invalid'), { code: 'NATIVE_PROTOCOL_ERROR' });
    await until(() => errors.length === 2);
    assert.deepEqual(errors.map((error) => error.code), ['NATIVE_PROTOCOL_ERROR', 'NATIVE_CLOSE_FAILED']);
    assert.equal(errors[0].extra.uncertain, true);
    assert.equal(rpc.lastCloseError, errors[1]);
    assert.deepEqual(rpc.lastCloseError.extra, { pid: rpc.child.pid, uncertain: true, cause: 'EPERM' });
    await assert.rejects(rpc.close(), (error) => error === rpc.lastCloseError);
    assert.deepEqual(exits, []);
    assert.equal(rpc.child.exitCode, null);
    assert.equal(rpc.child.signalCode, null);
    assert.equal(process.kill(rpc.child.pid, 0), true);
    // Give asynchronous consumer rejections an opportunity to surface.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    rpc.child.kill = originalKill;
    originalKill('SIGKILL');
    await until(() => rpc.child.exitCode !== null || rpc.child.signalCode !== null);
    await rpc.close();
  }
});

test('JSON-RPC invalid and oversized stdout frames fail closed and terminate the child', async (t) => {
  for (const method of ['invalid', 'nonobject', 'large-line', 'large-partial']) {
    const rpc = await transport(t, { maxFrameBytes: 256 });
    await assert.rejects(rpc.request(method), (error) => {
      assert.equal(error.code, 'NATIVE_PROTOCOL_ERROR', method);
      assert.equal(error.extra.uncertain, true, method);
      return true;
    });
    assert.equal(rpc.closed, true, method);
    await until(() => rpc.child.exitCode !== null || rpc.child.signalCode !== null);
    await assert.rejects(rpc.request('echo'), { code: 'NATIVE_TRANSPORT_CLOSED' });
  }
});

test('JSON-RPC provider errors retain method and RPC evidence without killing a valid connection', async (t) => {
  const rpc = await transport(t);
  await assert.rejects(rpc.request('rpc-error'), (error) => {
    assert.equal(error.code, 'NATIVE_RPC_ERROR');
    assert.equal(error.message, 'bad input');
    assert.deepEqual(error.extra, { method: 'rpc-error', rpc_code: -32602, data: { field: 'text' } });
    return true;
  });
  assert.deepEqual(await rpc.request('echo', { good: true }), { good: true });
});
