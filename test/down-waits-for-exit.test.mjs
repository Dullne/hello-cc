import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import { createMiscCommands } from '../lib/cli/commands/misc.mjs';
import { CliError } from '../lib/shared/errors.mjs';
import { compareProcessIdentity, waitForProcessIdentityExit } from '../lib/process/identity.mjs';

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
  const requestError = new CliError('RUNTIME_UNREACHABLE', 'response lost', options.requestExtra || {});
  const commands = createMiscCommands({
    path, fs: options.fs || fs,
    process: { env: {} },
    CliError,
    parseOpts: () => ({}),
    printResult: (_ctx, data, render) => events.push(`print:${render(data)}`),
    readRuntime: () => { options.onReadRuntime?.(); return runtime; },
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
      return options.reclaimResult || { reclaimed: 1, blocked: false };
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

function assertStopDiagnostic(error, phase, state, { confirmed = true } = {}) {
  assert.equal(error.extra.stopPhase, phase);
  assert.equal(error.extra.state, state);
  assert.ok(Number.isSafeInteger(error.extra.stopElapsedMs) && error.extra.stopElapsedMs >= 0);
  if (confirmed) {
    assert.ok(Number.isSafeInteger(error.extra.confirmationMs) && error.extra.confirmationMs >= 0);
    assert.ok(error.extra.stopElapsedMs >= error.extra.confirmationMs);
  } else assert.equal(Object.hasOwn(error.extra, 'confirmationMs'), false);
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
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, 'RUNTIME_STOP_TIMEOUT');
      assert.equal(error.extra.pid, 42);
      assertStopDiagnostic(error, 'exit_unconfirmed', 'live');
      return true;
    }
  );
  assert.deepEqual(fixture.events, ['request', 'wait:boot-a:100']);
});

test('an owner exiting after the accepted-stop deadline does not turn its earlier timeout into success', async (t) => {
  let elapsed = 0;
  const observe = () => elapsed <= 5000
    ? { state: 'live', identity: fixtureIdentity() } : { state: 'dead', identity: null };
  const atDeadline = await waitForProcessIdentityExit(fixtureIdentity(), {
    timeoutMs: 5000, intervalMs: 25, inspect: observe,
    monotonicNow: () => elapsed, sleep: async delay => { elapsed += delay; }
  });
  const fixture = commandFixture(t, atDeadline);
  await assert.rejects(fixture.cmdDown({}, []), { code: 'RUNTIME_STOP_TIMEOUT' });
  elapsed++;
  assert.equal(observe().state, 'dead', 'a later fixture observation can confirm exit without a signal');
  assert.deepEqual(fixture.events, ['request', 'wait:boot-a:100']);
});

test('down confirms the original owner exit after response loss and pointer removal', async (t) => {
  const fixture = commandFixture(t, { state: 'dead', identity: null }, {
    lostResponse: true,
    onRequest: ({ pointer }) => fs.unlinkSync(pointer)
  });
  await fixture.cmdDown({}, []);
  assert.deepEqual(fixture.events, ['request', 'wait:boot-a:100', 'print:hello-cc runtime stopped']);
  assert.deepEqual(fixture.requestError.extra, {}, 'successful recovery adds no failure diagnostics');
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
    assertStopDiagnostic(fixture.requestError, 'exit_unconfirmed', state);
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
    assertStopDiagnostic(fixture.requestError, 'evidence_unavailable', 'unknown', { confirmed: false });
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
  assertStopDiagnostic(fixture.requestError, 'pointer_cleanup_failed', 'dead');
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
    assertStopDiagnostic(fixture.requestError, 'pointer_changed', 'dead');
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
  assertStopDiagnostic(fixture.requestError, 'pointer_changed', 'dead');
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
    assertStopDiagnostic(fixture.requestError, kind === 'malformed' ? 'pointer_changed' : 'pointer_cleanup_failed', 'dead');
    assert.deepEqual(fixture.events, ['request', 'wait:boot-a:100']);
  });
}

test('lost-response diagnostics retain the original transport error and sanitize observation state', async t => {
  const fixture = commandFixture(t, { state: 'PRIVATE_STATE\n::error::injected', identity: null }, {
    lostResponse: true,
    requestExtra: { elapsedMs: 8014, timeoutMs: 8000, method: 'POST', path: '/api/runtime/stop' }
  });
  await assert.rejects(fixture.cmdDown({}, []), error => error === fixture.requestError);
  assert.equal(fixture.requestError.code, 'RUNTIME_UNREACHABLE');
  assert.equal(fixture.requestError.message, 'response lost');
  assertStopDiagnostic(fixture.requestError, 'exit_unconfirmed', 'unknown');
  const { stopPhase, state, stopElapsedMs, confirmationMs, ...transport } = fixture.requestError.extra;
  assert.deepEqual(transport, { elapsedMs: 8014, timeoutMs: 8000, method: 'POST', path: '/api/runtime/stop' });
  assert.doesNotMatch(JSON.stringify(fixture.requestError.extra), /PRIVATE_STATE|injected/);
  assert.deepEqual(fixture.events, ['request', 'wait:boot-a:100']);
});

test('stop elapsed diagnostics include local preflight before the transport request', async t => {
  const fixture = commandFixture(t, { state: 'dead', identity: null }, {
    lostResponse: true, observed: { state: 'unknown', identity: null },
    onReadRuntime() {
      const until = performance.now() + 15;
      while (performance.now() < until) {}
    }
  });
  await assert.rejects(fixture.cmdDown({}, []), error => error === fixture.requestError);
  assertStopDiagnostic(fixture.requestError, 'evidence_unavailable', 'unknown', { confirmed: false });
  assert.ok(fixture.requestError.extra.stopElapsedMs >= 15);
});

test('pointer lock failure after confirmed exit preserves the transport error without the lock message', async t => {
  const fixture = commandFixture(t, { state: 'dead', identity: null }, {
    lostResponse: true,
    onRequest: ({ pointer }) => fs.unlinkSync(pointer),
    onLock() { throw new Error('PRIVATE_LOCK_PATH'); }
  });
  await assert.rejects(fixture.cmdDown({}, []), error => error === fixture.requestError);
  assertStopDiagnostic(fixture.requestError, 'pointer_cleanup_failed', 'dead');
  assert.doesNotMatch(JSON.stringify(fixture.requestError.extra), /PRIVATE_LOCK_PATH/);
  assert.deepEqual(fixture.events, ['request', 'wait:boot-a:100']);
});

test('blocked pointer reclamation after confirmed exit reports its phase without reporting success', async t => {
  const fixture = commandFixture(t, { state: 'dead', identity: null }, {
    lostResponse: true, reclaimResult: { reclaimed: 0, blocked: true }
  });
  await assert.rejects(fixture.cmdDown({}, []), error => error === fixture.requestError);
  assertStopDiagnostic(fixture.requestError, 'pointer_cleanup_failed', 'dead');
  assert.equal(fs.existsSync(fixture.pointer), true);
  assert.deepEqual(fixture.events, ['request', 'wait:boot-a:100', 'reclaim']);
});

function fixtureIdentity() {
  return {
    pid: 42,
    startToken: 'boot-a:100',
    commandHash: 'a'.repeat(64)
  };
}
