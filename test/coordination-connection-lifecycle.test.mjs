import assert from 'node:assert/strict';
import test from 'node:test';

import { createCoordinationCommands } from '../lib/cli/commands/coordination.mjs';
import { CliError } from '../lib/shared/errors.mjs';

function fixture({ command, failSend = false } = {}) {
  const trace = [];
  let active = 0;
  let nextConnection = 0;
  const commands = createCoordinationCommands({
    CliError,
    connect() {
      const number = ++nextConnection;
      active += 1;
      trace.push(`connect:${number}`);
      return { close() { active -= 1; trace.push(`close:${number}`); } };
    },
    parseOpts() {
      return command === 'ask'
        ? { to: 'recipient', body: 'message', inject: true, _: [] }
        : { body: 'message', inject: true, _: [] };
    },
    intOpt() { return null; },
    resolveCurrentPeer() { return { id: 'sender' }; },
    readRuntime() { return { base_url: 'http://127.0.0.1:1' }; },
    touchCurrentPeer() { trace.push('touch'); },
    sendMessage() {
      trace.push('send');
      if (failSend) throw new Error('message failed');
      return 42;
    },
    auditPayload(value) { return value; },
    addEvent() { trace.push('audit'); },
    async runtimeRequest(_ctx, method) {
      assert.equal(active, 0, 'all SQLite connections must be closed before network I/O');
      trace.push(`runtime:${method}`);
      if (method === 'GET') return { sessions: [{ id: 'recipient', status: 'running' }] };
      return { ok: true };
    },
    printResult() { trace.push('printed'); }
  });
  return { commands, trace, activeConnections: () => active };
}

for (const command of ['ask', 'broadcast']) {
  test(`${command} closes its message connection before network injection`, async () => {
    const f = fixture({ command });
    await f.commands[command === 'ask' ? 'cmdAsk' : 'cmdBroadcast']({}, []);
    assert.equal(f.activeConnections(), 0);
    assert.deepEqual(f.trace.slice(0, 4), ['connect:1', 'touch', 'send', 'close:1']);
    assert.ok(f.trace.indexOf('close:1') < f.trace.findIndex(value => value.startsWith('runtime:')));
    assert.ok(f.trace.indexOf('close:2') < f.trace.indexOf('runtime:POST'));
    assert.equal(f.trace.at(-1), 'printed');
  });

  test(`${command} closes its message connection when persistence fails`, async () => {
    const f = fixture({ command, failSend: true });
    await assert.rejects(f.commands[command === 'ask' ? 'cmdAsk' : 'cmdBroadcast']({}, []), /message failed/);
    assert.equal(f.activeConnections(), 0);
    assert.deepEqual(f.trace, ['connect:1', 'touch', 'send', 'close:1']);
  });
}
