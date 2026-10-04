import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMiscCommands } from '../lib/cli/commands/misc.mjs';
import { CliError } from '../lib/shared/errors.mjs';
import { compareProcessIdentity } from '../lib/process/identity.mjs';

function commandFixture(t, waitResult, options = {}) {
  const events = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-down-exit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pointer = path.join(root, 'runtime.json');
  const runtime = {
    pid: 42,
    process_identity: {
      pid: 42,
      startToken: 'boot-a:100',
      commandHash: 'a'.repeat(64)
    },
    base_url: 'http://127.0.0.1:8787',
    source: pointer,
    ...options.runtime
  };
  fs.writeFileSync(pointer, JSON.stringify({ ...runtime, ...options.recordedRuntime }));
  const requestError = new CliError('RUNTIME_UNREACHABLE', 'response lost');
  const commands = createMiscCommands({
    path, fs: options.fs || fs,
    process: { env: {} },
    CliError,
    parseOpts: () => ({}),
    printResult: (_ctx, data, render) => events.push(`print:${render(data)}`),
    readRuntime: () => runtime,
    runtimeRequest: async () => {
      events.push('request');
      options.onRequest?.({ pointer, runtime });
      if (options.lostResponse) throw requestError;
    },
    runtimePath: () => pointer,
    globalRuntimePath: () => '/home/.hello-cc/runtime.json',
    reclaimRuntimePointerFiles: (_files, reclaimOptions) => {
      assert.equal(reclaimOptions.reclaimUnknown, false);
      events.push('reclaim');
      return { reclaimed: 1, blocked: false };
    },
    compareProcessIdentity,
    inspectProcessIdentity: () => options.observed || { state: 'live', identity: runtime.process_identity },
    withFileLock: (file, operation) => {
      options.onLock?.({ pointer, runtime });
      return operation(file);
    },
    waitForProcessIdentityExit: async (identity, waitOptions) => {
      assert.deepEqual(waitOptions, { timeoutMs: 5_000, intervalMs: 25 });
      events.push(`wait:${identity.startToken}`);
      options.onWait?.({ pointer, runtime });
      return waitResult;
    },
    helpDown: () => {},
    loadSetup: async () => ({}),
    PRODUCT_NAME: 'hello-cc'
  });
  return { ...commands, events, runtime, pointer, requestError };
}

test('down waits for the runtime process instance to exit before reporting success', async (t) => {
  const fixture = commandFixture(t, { state: 'dead', identity: null });

  await fixture.cmdDown({}, []);

  assert.deepEqual(fixture.events, [
    'request',
    'wait:boot-a:100',
    'print:hello-cc runtime stopped'
  ]);
});

test('down does not report success while the runtime process is still live', async (t) => {
  const fixture = commandFixture(t, { state: 'live', identity: fixtureIdentity() });

  await assert.rejects(
    fixture.cmdDown({}, []),
    (error) => error instanceof CliError && error.code === 'RUNTIME_STOP_TIMEOUT'
  );
  assert.deepEqual(fixture.events, ['request', 'wait:boot-a:100']);
});

test('down confirms the original owner exit after response loss and pointer removal', async (t) => {
  const fixture = commandFixture(t, { state: 'dead', identity: null }, {
    lostResponse: true,
    onRequest: ({ pointer }) => fs.unlinkSync(pointer)
  });
  await fixture.cmdDown({}, []);
  assert.deepEqual(fixture.events, ['request', 'wait:boot-a:100', 'print:hello-cc runtime stopped']);
});

test('down retains dead-pointer reclamation after a lost response', async (t) => {
  const fixture = commandFixture(t, { state: 'dead', identity: null }, { lostResponse: true });
  await fixture.cmdDown({}, []);
  assert.deepEqual(fixture.events, ['request', 'wait:boot-a:100', 'reclaim', 'print:hello-cc stale runtime pointer removed']);
});

for (const state of ['live', 'unknown']) {
  test(`down preserves the transport failure when the original owner remains ${state} without a pointer`, async (t) => {
    const fixture = commandFixture(t, { state, identity: state === 'live' ? fixtureIdentity() : null }, {
      lostResponse: true,
      onRequest: ({ pointer }) => fs.unlinkSync(pointer)
    });
    await assert.rejects(fixture.cmdDown({}, []), (error) => error === fixture.requestError);
    assert.deepEqual(fixture.events, ['request', 'wait:boot-a:100']);
  });
}

for (const [name, changes] of [
  ['environment runtime', { runtime: { source: 'env' } }],
  ['remote endpoint in a local pointer', { runtime: { base_url: 'https://example.invalid:8787' } }],
  ['unrecognized pointer source', { runtime: { source: '/different/runtime.json' } }],
  ['bare PID', { runtime: { process_identity: undefined } }],
  ['incomplete stored identity', { runtime: { process_identity: { pid: 42, startToken: 'boot-a:100' } } }],
  ['ambiguous identity aliases', { runtime: { processIdentity: fixtureIdentity() } }],
  ['unknown initial owner', { observed: { state: 'unknown', identity: null } }],
  ['changed initial owner command', { observed: { state: 'live', identity: { ...fixtureIdentity(), commandHash: 'b'.repeat(64) } } }],
  ['changed stored pointer command', { recordedRuntime: { process_identity: { ...fixtureIdentity(), commandHash: 'b'.repeat(64) } } }],
  ['incompatible legacy Mac owner', {
    runtime: { process_identity: { ...fixtureIdentity(), startToken: '1700000000:123456:Tue Nov 14 22:13:20 2023' } },
    observed: { state: 'live', identity: { ...fixtureIdentity(), startToken: 'darwin:54a2cf47-9cb7-4be8-b9ab-6823a2af4c11:Tue Nov 14 22:13:20 2023' } }
  }]
]) {
  test(`down cannot confirm a lost response for ${name}`, async (t) => {
    if (name === 'incompatible legacy Mac owner') {
      assert.equal(compareProcessIdentity(changes.runtime.process_identity, changes.observed.identity), 'unknown');
    }
    const fixture = commandFixture(t, { state: 'dead', identity: null }, {
      ...changes, lostResponse: true,
      onRequest: ({ pointer }) => fs.unlinkSync(pointer)
    });
    await assert.rejects(fixture.cmdDown({}, []), (error) => error === fixture.requestError);
    assert.deepEqual(fixture.events, ['request']);
  });
}

test('down does not treat a pointer permission failure as absence', async (t) => {
  let denyRead = false;
  const fixture = commandFixture(t, { state: 'dead', identity: null }, {
    lostResponse: true,
    fs: {
      ...fs,
      lstatSync: (file) => {
        if (denyRead) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        return fs.lstatSync(file);
      }
    },
    onWait: () => { denyRead = true; }
  });
  await assert.rejects(fixture.cmdDown({}, []), (error) => error === fixture.requestError);
  assert.equal(fs.existsSync(fixture.pointer), true);
  assert.deepEqual(fixture.events, ['request', 'wait:boot-a:100']);
});

for (const moment of ['onRequest', 'onWait', 'onLock']) {
  test(`down preserves a replacement pointer introduced at ${moment}`, async (t) => {
    const replacement = JSON.stringify({ pid: 99, base_url: 'http://127.0.0.1:9999' });
    const fixture = commandFixture(t, { state: 'dead', identity: null }, {
      lostResponse: true,
      [moment]: ({ pointer }) => fs.writeFileSync(pointer, replacement)
    });
    await assert.rejects(fixture.cmdDown({}, []), (error) => error === fixture.requestError);
    assert.equal(fs.readFileSync(fixture.pointer, 'utf8'), replacement);
    assert.deepEqual(fixture.events, ['request', 'wait:boot-a:100']);
  });
}

test('down preserves a replacement inode even when its bytes are identical', async (t) => {
  const fixture = commandFixture(t, { state: 'dead', identity: null }, {
    lostResponse: true,
    onWait: ({ pointer }) => {
      const replacement = `${pointer}.new`;
      fs.writeFileSync(replacement, fs.readFileSync(pointer));
      fs.renameSync(replacement, pointer);
    }
  });
  await assert.rejects(fixture.cmdDown({}, []), (error) => error === fixture.requestError);
  assert.equal(fs.existsSync(fixture.pointer), true);
  assert.deepEqual(fixture.events, ['request', 'wait:boot-a:100']);
});

for (const kind of ['malformed', 'directory', 'symlink']) {
  test(`down does not treat a ${kind} pointer as absent`, async (t) => {
    const fixture = commandFixture(t, { state: 'dead', identity: null }, {
      lostResponse: true,
      onWait: ({ pointer }) => {
        fs.unlinkSync(pointer);
        if (kind === 'malformed') fs.writeFileSync(pointer, '{');
        else if (kind === 'directory') fs.mkdirSync(pointer);
        else fs.symlinkSync(`${pointer}.missing`, pointer);
      }
    });
    await assert.rejects(fixture.cmdDown({}, []), (error) => error === fixture.requestError);
    assert.deepEqual(fixture.events, ['request', 'wait:boot-a:100']);
  });
}

function fixtureIdentity() {
  return {
    pid: 42,
    startToken: 'boot-a:100',
    commandHash: 'a'.repeat(64)
  };
}
