import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { createTerminalHost } from '../lib/terminal/host.mjs';
import { startTerminalServer } from '../lib/terminal/server.mjs';
import { terminalClient } from '../lib/terminal/client.mjs';

test('terminal protocol authenticates host generation and shares persistent control between two clients', async () => {
  let child;
  const host = createTerminalHost({ validateProject() {}, spawnPty() {
    child = new EventEmitter(); Object.assign(child, { pid: 123, creationTime: '456', writes: [],
      onData(fn) { child.on('data', fn); }, onExit(fn) { child.on('exit', fn); },
      write(data) { child.writes.push(data); }, resize() {}, pause() {}, resume() {},
      async closeOwned() { child.emit('exit', { exitCode: 0 }); }
    }); return child;
  }});
  const token = 'ab'.repeat(32);
  const server = await startTerminalServer({ host, token, identity: { pid: process.pid } });
  const client = terminalClient({ port: server.port, token, generation: host.generation });
  let one, two;
  try {
    await assert.rejects(terminalClient({ port: server.port, token: 'wrong', generation: host.generation }).list(), { code: 'UNAUTHORIZED' });
    await assert.rejects(terminalClient({ port: server.port, token, generation: 'old-host' }).list(), { code: 'TERMINAL_HOST_CHANGED' });
    const originStatus = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: server.port, path: '/status', headers: {
        authorization: `Bearer ${token}`, 'x-hcc-terminal-generation': host.generation, origin: 'http://evil.invalid' } }, res => {
        res.resume(); resolve(res.statusCode);
      }).on('error', reject);
    });
    assert.equal(originStatus, 401);
    const session = await client.create({ id: 'protocol-one', project: {}, cwd: 'test', cwdIdentity: {},
      command: { file: 'fake', args: [] }, env: {}, peerId: 'shell-one', kind: 'shell' });
    one = await client.connect(session.id, session.generation);
    await assert.rejects(client.connect(session.id, session.generation, { clientToken: one.clientToken }), { code: 'CONTROL_CLIENT_CONNECTED' });
    assert.equal(one.control.can_control, true, 'rejected duplicate must not detach the original controller');
    two = await client.connect(session.id, session.generation);
    assert.equal(one.control.can_control, true); assert.equal(two.control.can_control, false);
    await assert.rejects(two.action({ type: 'input', epoch: two.control.epoch, data: 'rejected' }), { code: 'CONTROL_REQUIRED' });
    await one.action({ type: 'input', epoch: one.control.epoch, data: '中文' });
    await two.action({ type: 'claim', epoch: two.control.epoch, takeover: true });
    await assert.rejects(one.action({ type: 'input', epoch: one.control.epoch, data: 'rejected' }), { code: 'CONTROL_REQUIRED' });
    child.emit('data', '\x1b[2J\x1b[Hsurvives');
    one.close(); one = null;
    const snapshot = await client.snapshot(session.id, session.generation);
    assert.match(snapshot.screen, /survives/); assert.equal((await client.list())[0].status, 'running');
    await assert.rejects(client.shutdown(), { code: 'TERMINAL_HOST_BUSY' });
    await two.action({ type: 'terminate', epoch: two.control.epoch });
    assert.equal((await client.list())[0].status, 'exited'); assert.deepEqual(child.writes, ['中文']);
  } finally { one?.close(); two?.close(); await server.close(); await host.close(); }
});

test('terminal protocol bounds queued actions while attach waits and detaches only its accepted connection', async () => {
  let unblock, detachments = 0, actions = 0;
  const barrier = new Promise(resolve => { unblock = resolve; });
  const host = { generation: 'bounded-host', async attach() { await barrier; return { epoch: 1, can_control: true }; },
    detach() { detachments++; }, action() { actions++; } };
  const token = 'cd'.repeat(32), server = await startTerminalServer({ host, token });
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/attach`, { headers: {
    authorization: `Bearer ${token}`, 'x-hcc-terminal-generation': host.generation } });
  ws.on('error', () => {});
  try {
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'attach', id: 'one', generation: 'one-generation', clientToken: 'owner' }));
    await new Promise(resolve => setTimeout(resolve, 10));
    for (let i = 0; i < 40; i++) ws.send(JSON.stringify({ type: 'input', data: 'x', requestId: String(i) }));
    assert.equal((await once(ws, 'close'))[0], 1013);
    assert.equal(detachments, 0, 'pending attachment is not an accepted controller');
    unblock(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(detachments, 1); assert.equal(actions, 0);
  } finally { unblock(); ws.terminate(); await server.close(); }
});

test('terminal client validates malformed and foreign-generation frames before exposing them', async () => {
  for (const frame of [null, { type: 'snapshot', generation: 'wrong', hostGeneration: 'host' },
    { type: 'attached', generation: 'session', hostGeneration: 'host', control: {} }]) {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    wss.on('connection', ws => { ws.on('error', () => {}); ws.send(JSON.stringify(frame)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let exposed = 0;
    try {
      const client = terminalClient({ port: server.address().port, token: 'token', generation: 'host' });
      await assert.rejects(client.connect('one', 'session', { onFrame(value) { if (value.type !== 'disconnected') exposed++; } }),
        { code: 'TERMINAL_RESPONSE_INVALID' });
      assert.equal(exposed, 0);
    } finally {
      for (const ws of wss.clients) ws.terminate();
      await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve));
    }
  }
});
