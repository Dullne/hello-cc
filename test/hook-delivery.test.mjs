import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createHookCommand } from '../lib/cli/commands/hook.mjs';
import { createCoordinationState } from '../lib/coordination-state.mjs';

const noop = () => {};

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE peers (id TEXT PRIMARY KEY);
    INSERT INTO peers VALUES ('codex-a');
    CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE message_reads (
      message_id INTEGER NOT NULL, peer TEXT NOT NULL, read_at INTEGER NOT NULL,
      PRIMARY KEY (message_id, peer)
    );
  `);
  const { ackMessages } = createCoordinationState({
    connect: () => db,
    now: () => 100,
    observePeerEvidence: noop,
    queryInbox: noop,
    queryOpenTasks: noop,
    queryTimelineMessages: noop
  });
  const unread = () => db.prepare(`
    SELECT m.id, m.body FROM messages m
    LEFT JOIN message_reads r ON r.message_id = m.id AND r.peer = 'codex-a'
    WHERE r.message_id IS NULL ORDER BY m.id
  `).all().map((row) => ({ ...row }));

  function begin(event, payload = {}, stdoutOverride = null) {
    const order = [];
    const chunks = [];
    let releaseWrite;
    let settled = false;
    let closed = false;
    let startWrite;
    const writing = new Promise((resolve) => { startWrite = resolve; });
    const stdout = stdoutOverride || new Writable({
      write(chunk, _encoding, callback) {
        order.push('write');
        chunks.push(Buffer.from(chunk));
        releaseWrite = (error) => {
          order.push(error ? 'failed' : 'flushed');
          callback(error);
        };
        startWrite();
      }
    });
    const stdin = new PassThrough();
    stdin.end(JSON.stringify({
      session_id: 'test-session', cwd: '/test/project', hook_event_name: event,
      ...payload
    }));
    const hookProcess = {
      stdin,
      stdout,
      env: { HCC_PEER: 'codex-a' },
      platform: 'darwin',
      cwd: () => '/test/project',
      exit: () => assert.fail('hooks must let pending stdout finish before natural exit')
    };
    const { cmdHook } = createHookCommand({
      connect: () => ({
        prepare: db.prepare.bind(db),
        close() { closed = true; order.push('close'); }
      }),
      now: () => 100,
      addEvent: noop,
      auditPayload: (value) => value,
      registerProjectActivity: noop,
      liveProcessIdentity: noop,
      detectBranch: noop,
      providerSessionPeerId: noop,
      providerSessionParts: () => ({}),
      readAncestorCliInfo: noop,
      latestHookProviderSession: noop,
      formatHookEventName: (value) => value,
      upsertPeer: noop,
      upsertCanonicalPeerBinding: (_db, binding) => binding,
      autoPeerKind: () => 'codex',
      autoPeerBasis: () => 'test',
      autoPeerProviderSession: () => ({}),
      observeLockClockSafety: () => ({ renewed: 0 }),
      buildHookCoordinationContext: () => {
        const messages = unread();
        return {
          text: '[hello-cc coordination]\n' + messages.map((m) => `#${m.id}: ${m.body}`).join('\n'),
          messages
        };
      },
      ackMessages: (...args) => { order.push('ack'); ackMessages(...args); },
      reconcileRunningPeerBindings: noop,
      inspectProviderProcess: noop,
      resumeIdFromArgs: noop,
      shortHash: noop,
      renewOwnedLocks: () => 0,
      refreshHookOwnerIdentity: noop,
      path,
      process: hookProcess
    });
    const completion = cmdHook({}, [event]);
    completion.then(() => { settled = true; }, () => { settled = true; });
    return {
      completion, writing, order, stdin, stdout, hookProcess,
      output: () => Buffer.concat(chunks).toString('utf8'),
      finishWrite: (error) => releaseWrite(error),
      get settled() { return settled; },
      get closed() { return closed; }
    };
  }

  return {
    db, begin, unread,
    send: (body) => db.prepare('INSERT INTO messages(body) VALUES (?)').run(body),
    close: () => db.close()
  };
}

test('Stop flushes an official continuation before ACK and leaves later messages unread', async () => {
  const f = fixture();
  try {
    f.send('Please answer the other peer.');
    const run = f.begin('Stop', { stop_hook_active: false });
    await run.writing;
    assert.equal(run.settled, false);
    assert.equal(run.closed, false);
    assert.equal(f.unread().length, 1);
    assert.deepEqual(run.order, ['write']);

    // A message arriving while stdout is pending was not included in this
    // delivery and must not become read merely because another one flushed.
    f.send('Arrived during output.');
    run.finishWrite();
    await run.completion;
    const output = JSON.parse(run.output());
    assert.deepEqual(Object.keys(output).sort(), ['decision', 'reason']);
    assert.equal(output.decision, 'block');
    assert.match(output.reason, /Please answer the other peer\./);
    assert.doesNotMatch(output.reason, /Arrived during output/);
    assert.deepEqual(f.unread().map((m) => m.body), ['Arrived during output.']);
    assert.deepEqual(run.order, ['write', 'flushed', 'ack', 'close']);
    assert.equal(run.hookProcess.exitCode, 0);
    assert.equal(run.stdin.listenerCount('data'), 0);
    assert.equal(run.stdin.listenerCount('end'), 0);
    assert.equal(run.stdin.listenerCount('error'), 0);
    assert.equal(run.stdin.isPaused(), true);
    assert.equal(run.stdout.listenerCount('error'), 0);
  } finally {
    f.close();
  }
});

test('active Stop continuation keeps new messages unread without starting another turn', async () => {
  const f = fixture();
  try {
    f.send('Wait for the next independent turn.');
    const active = f.begin('Stop', { stop_hook_active: true });
    await active.completion;
    assert.equal(active.output(), '');
    assert.deepEqual(active.order, ['close']);
    assert.equal(f.unread().length, 1);

    const next = f.begin('UserPromptSubmit');
    await next.writing;
    assert.equal(f.unread().length, 1);
    next.finishWrite();
    await next.completion;
    assert.match(JSON.parse(next.output()).hookSpecificOutput.additionalContext,
      /Wait for the next independent turn/);
    assert.equal(f.unread().length, 0);
  } finally {
    f.close();
  }
});

for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse']) {
  test(`${event} retains additionalContext and ACKs only after stdout completion`, async () => {
    const f = fixture();
    try {
      f.send(`Message for ${event}.`);
      const run = f.begin(event);
      await run.writing;
      assert.equal(f.unread().length, 1);
      assert.equal(run.closed, false);
      run.finishWrite();
      await run.completion;
      const output = JSON.parse(run.output());
      assert.equal(output.hookSpecificOutput.hookEventName, event);
      assert.match(output.hookSpecificOutput.additionalContext, /Message for/);
      assert.equal(f.unread().length, 0);
      assert.deepEqual(run.order, ['write', 'flushed', 'ack', 'close']);
    } finally {
      f.close();
    }
  });
}

for (const event of ['Stop', 'SessionStart', 'UserPromptSubmit', 'PostToolUse']) {
  test(`${event} failed output retains messages for a later successful delivery`, async () => {
    const f = fixture();
    try {
      f.send('Retry after the broken pipe.');
      const failed = f.begin(event);
      await failed.writing;
      const error = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
      const rejection = assert.rejects(failed.completion, (err) => err === error);
      failed.finishWrite(error);
      await rejection;
      assert.equal(f.unread().length, 1);
      assert.deepEqual(failed.order, ['write', 'failed', 'close']);
      assert.equal(failed.hookProcess.exitCode, undefined);
      // A real Writable emits error after calling its write callback.
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(failed.stdout.listenerCount('error'), 0);

      const retry = f.begin(event);
      await retry.writing;
      retry.finishWrite();
      await retry.completion;
      assert.equal(f.unread().length, 0);
    } finally {
      f.close();
    }
  });
}

test('a synchronous stdout error closes the database without ACK', async () => {
  const f = fixture();
  try {
    f.send('Preserve this message.');
    const error = new Error('stdout unavailable');
    const stdout = new EventEmitter();
    stdout.write = () => { throw error; };
    const run = f.begin('Stop', {}, stdout);
    await assert.rejects(run.completion, (err) => err === error);
    assert.equal(f.unread().length, 1);
    assert.deepEqual(run.order, ['close']);
    assert.equal(stdout.listenerCount('error'), 0);
  } finally {
    f.close();
  }
});

for (const event of ['Stop', 'PostToolUse']) {
  test(`${event} does not output or block when there are no unread messages`, async () => {
    const f = fixture();
    try {
      const run = f.begin(event);
      await run.completion;
      assert.equal(run.output(), '');
      assert.deepEqual(run.order, ['close']);
    } finally {
      f.close();
    }
  });
}
