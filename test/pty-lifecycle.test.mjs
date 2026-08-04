import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  capturePtyStartupEvidence,
  installPtyTerminationHandlers,
  ptyStartupFailureDisposition,
  ptyTerminationSignal,
  stopPtyAfterStartupFailure,
  trackPtyExit
} from '../lib/process/pty-lifecycle.mjs';

function completeIdentity(pid, marker) {
  return {
    pid,
    startToken: `boot-a:${marker}`,
    commandHash: marker.repeat(64).slice(0, 64)
  };
}

function fakePty(pid = 42) {
  let onExit = null;
  return {
    pid,
    onExit(callback) {
      assert.equal(onExit, null, 'exit listener must only be registered once');
      onExit = callback;
    },
    emitExit(event) {
      assert.ok(onExit, 'exit listener must be registered before the child can exit');
      onExit(event);
    }
  };
}

test('tracks an early PTY exit and replays it to later consumers', async () => {
  const child = fakePty();
  const exit = trackPtyExit(child);
  const event = { exitCode: 7, signal: 0 };

  child.emitExit(event);

  assert.deepEqual(exit.event, event);
  assert.deepEqual(await exit.promise, event);
});

test('captures complete wrapper and child identities before publication', async () => {
  const child = fakePty(42);
  const exit = trackPtyExit(child);
  const wrapperIdentity = completeIdentity(11, 'a');
  const childIdentity = completeIdentity(42, 'b');
  const calls = [];

  const result = await capturePtyStartupEvidence({
    childPid: child.pid,
    wrapperPid: 11,
    exit,
    waitForIdentity: async (pid, options) => {
      calls.push([pid, options]);
      return {
        state: 'live',
        identity: pid === child.pid ? childIdentity : wrapperIdentity
      };
    },
    timeoutMs: 2000
  });

  assert.deepEqual(result, {
    state: 'ready',
    wrapperIdentity,
    childIdentity
  });
  assert.deepEqual(calls, [
    [11, { timeoutMs: 2000 }],
    [42, { timeoutMs: 2000 }]
  ]);
});

test('fails startup when the wrapper identity remains incomplete', async () => {
  const child = fakePty(42);
  const exit = trackPtyExit(child);

  const result = await capturePtyStartupEvidence({
    childPid: child.pid,
    wrapperPid: 11,
    exit,
    waitForIdentity: async (pid) => pid === child.pid
      ? { state: 'live', identity: completeIdentity(42, 'b') }
      : { state: 'unknown', identity: null }
  });

  assert.deepEqual(result, {
    state: 'failed',
    reason: 'wrapper_identity_unavailable',
    exitEvent: null,
    childIdentity: completeIdentity(42, 'b')
  });
});

test('fails startup when the PTY exits after identity capture but before publication', async () => {
  const child = fakePty(42);
  const exit = trackPtyExit(child);
  const event = { exitCode: 0, signal: 0 };

  const result = await capturePtyStartupEvidence({
    childPid: child.pid,
    wrapperPid: 11,
    exit,
    waitForIdentity: async (pid) => {
      const identity = completeIdentity(pid, pid === child.pid ? 'b' : 'a');
      if (pid === child.pid) child.emitExit(event);
      return { state: 'live', identity };
    }
  });

  assert.deepEqual(result, {
    state: 'failed',
    reason: 'child_exited_before_identity',
    exitEvent: event
  });
});

test('preserves the bounded child-identity timeout policy', async () => {
  const child = fakePty(42);
  const exit = trackPtyExit(child);

  const result = await capturePtyStartupEvidence({
    childPid: child.pid,
    wrapperPid: 11,
    exit,
    waitForIdentity: async (pid) => pid === child.pid
      ? { state: 'unknown', identity: null }
      : { state: 'live', identity: completeIdentity(11, 'a') }
  });

  assert.deepEqual(result, {
    state: 'ready',
    wrapperIdentity: completeIdentity(11, 'a'),
    childIdentity: null
  });
});

test('force-kills and confirms a startup-failed PTY that ignores HUP', async () => {
  const child = fakePty(42);
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === 'SIGKILL') child.emitExit({ exitCode: 0, signal: 9 });
  };
  const exit = trackPtyExit(child);

  const result = await stopPtyAfterStartupFailure(child, exit, {
    graceMs: 25,
    killTimeoutMs: 50,
    sleep: async () => {}
  });

  assert.deepEqual(signals, ['SIGHUP', 'SIGKILL']);
  assert.deepEqual(result, {
    exited: true,
    event: { exitCode: 0, signal: 9 }
  });
});

test('reports an unconfirmed startup-failed PTY termination without hanging', async () => {
  const child = fakePty(42);
  const signals = [];
  child.kill = (signal) => { signals.push(signal); };
  const exit = trackPtyExit(child);

  const result = await stopPtyAfterStartupFailure(child, exit, {
    graceMs: 25,
    killTimeoutMs: 50,
    sleep: async () => {}
  });

  assert.deepEqual(signals, ['SIGHUP', 'SIGKILL']);
  assert.deepEqual(result, { exited: false, event: null });
});

test('handles wrapper termination while PTY identity capture is still pending', async () => {
  const child = fakePty(42);
  const exit = trackPtyExit(child);
  const emitter = new EventEmitter();
  const signals = [];
  const timers = [];
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === 'SIGHUP') child.emitExit({ exitCode: 0, signal: 1 });
  };
  const termination = installPtyTerminationHandlers(child, {
    emitter,
    setTimer: (callback) => {
      timers.push(callback);
      return { unref() {} };
    },
    clearTimer: () => {}
  });

  const capture = capturePtyStartupEvidence({
    childPid: child.pid,
    wrapperPid: 11,
    exit,
    waitForIdentity: async () => new Promise(() => {})
  });
  emitter.emit('SIGTERM');

  assert.deepEqual(await capture, {
    state: 'failed',
    reason: 'child_exited_before_identity',
    exitEvent: { exitCode: 0, signal: 1 }
  });
  assert.deepEqual(signals, ['SIGHUP']);
  assert.equal(termination.signal, 'SIGTERM');
  assert.equal(timers.length, 1);
  termination.dispose();
  assert.equal(emitter.listenerCount('SIGINT'), 0);
  assert.equal(emitter.listenerCount('SIGTERM'), 0);
});

test('preserves the wrapper termination signal over the PTY cleanup signal', () => {
  assert.equal(ptyTerminationSignal('SIGTERM', 1), 'SIGTERM');
  assert.equal(ptyTerminationSignal('SIGINT', 2), 'SIGINT');
  assert.equal(ptyTerminationSignal(null, 15), 15);
  assert.equal(ptyTerminationSignal(null, 0), null);
});

test('retains child evidence when startup-failure termination is unconfirmed', () => {
  const childIdentity = completeIdentity(42, 'b');
  assert.deepEqual(ptyStartupFailureDisposition({
    termination: { exited: false, event: null },
    childPid: 42,
    childIdentity
  }), {
    status: 'blocked',
    eventType: 'run.session.termination_unconfirmed',
    preserveEvidence: true,
    childPid: 42,
    childIdentity
  });
  assert.deepEqual(ptyStartupFailureDisposition({
    termination: { exited: true, event: { exitCode: 1, signal: 0 } },
    childPid: 42,
    childIdentity
  }), {
    status: 'exited',
    eventType: 'run.session.exited',
    preserveEvidence: false,
    childPid: 42,
    childIdentity
  });
});
