import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { attachWindowsTerminalSession } from '../lib/cli/windows-terminal.mjs';

function fake() {
  let receive, closed = false;
  const actions = [];
  const connection = { control: { epoch: 1, can_control: true }, initial: null,
    async action(message) { actions.push(message); return connection.control; }, close() { closed = true; } };
  const client = { async connect(id, generation, { onFrame }) {
    receive = onFrame;
    connection.initial = { type: 'snapshot', screen: 'old screen', sequence: 4, session: { status: 'running' } };
    onFrame(connection.initial); return connection;
  } };
  const input = new PassThrough(), output = new PassThrough(), errors = new PassThrough();
  let printed = '', diagnostics = ''; output.on('data', data => { printed += data; }); errors.on('data', data => { diagnostics += data; });
  return { client, connection, actions, input, output, errors, receive: frame => receive(frame),
    get closed() { return closed; }, get printed() { return printed; }, get diagnostics() { return diagnostics; } };
}

test('CLI terminal detach renders snapshot once, preserves Unicode input, and releases control without termination', async () => {
  const f = fake();
  const pending = attachWindowsTerminalSession(f.client, { id: 'one', generation: 'g' }, f);
  await new Promise(resolve => setImmediate(resolve));
  f.receive({ type: 'data', sequence: 5, data: 'new data' });
  const unicode = Buffer.from('中文'); f.input.write(unicode.subarray(0, 2)); f.input.write(unicode.subarray(2));
  f.input.write(Buffer.from([29]));
  assert.deepEqual(await pending, { detached: true, exitCode: null });
  assert.equal(f.printed, 'old screennew data');
  assert.deepEqual(f.actions, [{ type: 'input', epoch: 1, data: '中文' }, { type: 'release', epoch: 1 }]);
  assert.equal(f.closed, true);
});

test('CLI terminal viewer requires explicit takeover before input and never retries a lost action', async () => {
  const f = fake(); f.connection.control.can_control = false;
  const pending = attachWindowsTerminalSession(f.client, { id: 'one', generation: 'g' }, f);
  await new Promise(resolve => setImmediate(resolve));
  f.input.write('must-not-send'); f.input.write(Buffer.from([29]));
  await pending; assert.deepEqual(f.actions, []);
  const g = fake();
  const disconnected = attachWindowsTerminalSession(g.client, { id: 'two', generation: 'h' }, g);
  await new Promise(resolve => setImmediate(resolve));
  g.receive({ type: 'disconnected' });
  await assert.rejects(disconnected, { code: 'TERMINAL_CLIENT_DISCONNECTED' });
  assert.deepEqual(g.actions, []);
});

test('CLI terminal reports an uncertain exit instead of a successful completed session', async () => {
  const f = fake();
  const pending = attachWindowsTerminalSession(f.client, { id: 'one', generation: 'g' }, f);
  await new Promise(resolve => setImmediate(resolve));
  f.receive({ type: 'exit', event: { exitCode: null, uncertain: true } });
  await assert.rejects(pending, { code: 'TERMINAL_CLOSE_UNCONFIRMED' });
});
