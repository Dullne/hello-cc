import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createTerminalHost } from '../lib/terminal/host.mjs';

function fixture(options = {}) {
  const children = [];
  const host = createTerminalHost({ ...options, validateProject() {}, spawnPty() {
    const child = new EventEmitter();
    Object.assign(child, { pid: 123, creationTime: '456', writes: [], sizes: [],
      onData(fn) { child.on('data', fn); }, onExit(fn) { child.on('exit', fn); },
      write(data) { child.writes.push(data); return true; },
      resize(cols, rows) { child.sizes.push([cols, rows]); }, pause() {}, resume() {},
      async closeOwned() { child.emit('exit', { exitCode: 0 }); }
    }); children.push(child); return child;
  }});
  const input = { id: 'session-one', peerId: 'shell-one', kind: 'shell', role: 'peer',
    project: { root: 'test-root', stateDir: 'test-state', rootIdentity: {} }, cwd: 'test-root', cwdIdentity: {},
    command: { file: 'test-command', args: ['literal argument'] }, env: {}, cols: 80, rows: 24 };
  return { host, children, input };
}

test('terminal host restores complete screen after detach and fences generations and controller epochs', async () => {
  const { host, children, input } = fixture();
  try {
    const created = await host.create(input); const child = children[0];
    child.emit('data', '\x1b[2J\x1b[H旧文本\r\nsecond\x1b[1;1H新文本');
    const framesA = [], framesB = [];
    const a = await host.attach(created.id, created.generation, 'client-secret-a', value => framesA.push(value));
    assert.equal(framesA[0].type, 'snapshot'); assert.match(framesA[0].screen, /新文本/);
    assert.doesNotMatch(framesA[0].screen, /旧文本/);
    assert.equal(a.can_control, true);
    const b = await host.attach(created.id, created.generation, 'client-secret-b', value => framesB.push(value));
    assert.equal(b.can_control, false);
    assert.throws(() => host.action(created.id, created.generation, 'client-secret-b', { type: 'input', epoch: b.epoch, data: 'bad' }), { code: 'CONTROL_REQUIRED' });
    const claimed = host.action(created.id, created.generation, 'client-secret-b', { type: 'claim', epoch: b.epoch, takeover: true });
    assert.throws(() => host.action(created.id, created.generation, 'client-secret-a', { type: 'input', epoch: a.epoch, data: 'old' }), { code: 'STALE_CONTROL_EPOCH' });
    assert.throws(() => host.action(created.id, 'stale-generation', 'client-secret-b', { type: 'input', epoch: claimed.epoch, data: 'old' }), { code: 'TERMINAL_GENERATION_CHANGED' });
    host.action(created.id, created.generation, 'client-secret-b', { type: 'input', epoch: claimed.epoch, data: '中文\r' });
    host.detach(created.id, created.generation, 'client-secret-b');
    child.emit('data', '\r\nwhile disconnected');
    const restored = [];
    const resumed = await host.attach(created.id, created.generation, 'client-secret-b', value => restored.push(value));
    assert.equal(resumed.can_control, true); assert.ok(resumed.epoch > claimed.epoch);
    assert.match(restored[0].screen, /while disconnected/);
    assert.deepEqual(child.writes, ['中文\r']);
    assert.equal(host.list()[0].status, 'running');
  } finally { await host.close(); }
});

test('terminal host publishes snapshot then ordered output, survives viewer loss and requires confirmed close', async () => {
  const { host, children, input } = fixture();
  try {
    const session = await host.create(input), child = children[0], frames = [];
    const attached = host.attach(session.id, session.generation, 'viewer-secret', frame => frames.push(frame));
    child.emit('data', 'after attach'); await attached; await host.snapshot(session.id, session.generation);
    assert.equal(frames[0].type, 'snapshot');
    const data = frames.filter(frame => frame.type === 'data');
    assert.equal(data.length, 1); assert.ok(data[0].sequence > frames[0].sequence);
    host.detach(session.id, session.generation, 'viewer-secret');
    assert.equal(host.list()[0].status, 'running');
    const control = await host.attach(session.id, session.generation, 'viewer-secret', () => {});
    child.closeOwned = async () => { throw Object.assign(new Error('timeout'), { code: 'WINDOWS_PTY_CLOSE_UNCONFIRMED' }); };
    await assert.rejects(host.terminate(session.id, session.generation, 'viewer-secret', control.epoch), { code: 'WINDOWS_PTY_CLOSE_UNCONFIRMED' });
    assert.equal(host.list()[0].status, 'close_unconfirmed');
    child.closeOwned = async () => { child.emit('exit', { exitCode: 7 }); };
    await host.terminate(session.id, session.generation, 'viewer-secret', control.epoch);
    assert.equal(host.list()[0].status, 'exited');
  } finally { await host.close(); }
});

test('terminal host bounds session count and rejects duplicate creation, oversized input and invalid resize', async () => {
  const { host, input, children } = fixture({ maxSessions: 1 });
  try {
    const session = await host.create(input);
    await assert.rejects(host.create(input), { code: 'TERMINAL_EXISTS' });
    await assert.rejects(host.create({ ...input, id: 'second' }), { code: 'TERMINAL_LIMIT' });
    const control = await host.attach(session.id, session.generation, 'secret', () => {});
    assert.throws(() => host.action(session.id, session.generation, 'secret', { type: 'input', epoch: control.epoch, data: 'x'.repeat(65537) }), { code: 'BAD_REQUEST' });
    assert.throws(() => host.action(session.id, session.generation, 'secret', { type: 'resize', epoch: control.epoch, cols: 1e9, rows: 24 }), { code: 'BAD_REQUEST' });
    children[0].emit('exit', { exitCode: 0 }); await host.snapshot(session.id, session.generation);
    host.detach(session.id, session.generation, 'secret');
    const next = await host.create({ ...input, id: 'second' });
    assert.equal(next.id, 'second'); assert.equal(host.list().length, 1);
  } finally { await host.close(); }
});

test('a publication failure retains exit observation and ownership until a failed close can be retried', async () => {
  let releases = 0, child, attempts = 0, exited = 0;
  const { host, children, input } = fixture({
    prepareCreate: () => () => { releases++; },
    publishCreated() {
      child = children[0];
      child.closeOwned = async () => {
        if (++attempts === 1) throw Object.assign(new Error('cleanup incomplete'), { code: 'TEST_CLOSE_UNCONFIRMED' });
        child.emit('exit', { exitCode: 1 });
      };
      throw Object.assign(new Error('publication failed'), { code: 'TEST_PUBLICATION_FAILED' });
    },
    publishExited() { exited++; }
  });
  try {
    await assert.rejects(host.create(input), { code: 'TEST_CLOSE_UNCONFIRMED' });
    const session = host.list()[0];
    assert.equal(session.status, 'close_unconfirmed'); assert.equal(releases, 0);
    const control = await host.attach(session.id, session.generation, 'cleanup-owner', () => {});
    await host.terminate(session.id, session.generation, 'cleanup-owner', control.epoch);
    assert.equal(host.list()[0].status, 'exited'); assert.equal(releases, 1); assert.equal(exited, 1);
    host.detach(session.id, session.generation, 'cleanup-owner');
    host.forget(session.id, session.generation);
    assert.deepEqual(host.list(), []);
  } finally { await host.close(); }
});
