import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { createMiscCommands } from '../lib/cli/commands/misc.mjs';
import { CliError } from '../lib/shared/errors.mjs';

function commandFixture(waitResult) {
  const events = [];
  const runtime = {
    pid: 42,
    process_identity: {
      pid: 42,
      startToken: 'boot-a:100',
      commandHash: 'a'.repeat(64)
    },
    base_url: 'http://127.0.0.1:8787',
    source: '/project/.hello-cc/runtime.json'
  };
  const commands = createMiscCommands({
    path,
    process: { env: {} },
    CliError,
    parseOpts: () => ({}),
    printResult: (_ctx, data, render) => events.push(`print:${render(data)}`),
    readRuntime: () => runtime,
    runtimeRequest: async () => { events.push('request'); },
    runtimePath: () => runtime.source,
    globalRuntimePath: () => '/home/.hello-cc/runtime.json',
    reclaimRuntimePointerFiles: () => ({ reclaimed: 0, blocked: false }),
    waitForProcessIdentityExit: async (identity) => {
      events.push(`wait:${identity.startToken}`);
      return waitResult;
    },
    helpDown: () => {},
    loadSetup: async () => ({}),
    PRODUCT_NAME: 'hello-cc'
  });
  return { ...commands, events, runtime };
}

test('down waits for the runtime process instance to exit before reporting success', async () => {
  const fixture = commandFixture({ state: 'dead', identity: null });

  await fixture.cmdDown({}, []);

  assert.deepEqual(fixture.events, [
    'request',
    'wait:boot-a:100',
    'print:hello-cc runtime stopped'
  ]);
});

test('down does not report success while the runtime process is still live', async () => {
  const fixture = commandFixture({ state: 'live', identity: fixtureIdentity() });

  await assert.rejects(
    fixture.cmdDown({}, []),
    (error) => error instanceof CliError && error.code === 'RUNTIME_STOP_TIMEOUT'
  );
  assert.deepEqual(fixture.events, ['request', 'wait:boot-a:100']);
});

function fixtureIdentity() {
  return {
    pid: 42,
    startToken: 'boot-a:100',
    commandHash: 'a'.repeat(64)
  };
}
