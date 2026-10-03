import assert from 'node:assert/strict';
import test from 'node:test';
import { createTmuxClientSnapshot } from '../lib/web/tmux-client-snapshot.mjs';
import { createSessionSerialize } from '../lib/web/session-serialize.mjs';
import { validateTmuxDestructiveEvidence } from '../lib/core/peers/tmux-safety.mjs';

const unknown = { state: 'unknown', count: null };
const pane = (id = 1) => ({ id: `shell-${id}`, type: 'tmux', pane: `%${id}`, root: '/snapshot-test' });

function fixture(t) {
  let clock = 0;
  const calls = [];
  const snapshot = createTmuxClientSnapshot({ now: () => clock,
    run: (command, args, options, complete) => calls.push({ command, args, options, complete }) });
  t.after(() => snapshot.close());
  return { snapshot, calls, tick: (ms) => { clock += ms; },
    finish: (stdout, error = null) => calls.at(-1).complete(error, stdout) };
}

test('serializing many sessions stays synchronous and starts one asynchronous batch', t => {
  const f = fixture(t);
  const serializer = createSessionSerialize({ sessions: new Map(), ctx: { root: '/snapshot-test' },
    sameResolvedPath: (a, b) => a === b, cookieSocketValid: () => true,
    localClientObservation: f.snapshot.observe });
  for (let id = 1; id <= 200; id++) {
    assert.deepEqual(serializer.serializeSession(pane(id)).local_clients, unknown);
  }
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].command, 'tmux');
  assert.deepEqual(f.calls[0].args, ['list-panes', '-a', '-F', '#{pane_id}|#{session_id}|#{session_attached}']);
  assert.equal(f.calls[0].options.timeout, 1000);
  assert.equal(f.calls[0].options.maxBuffer, 1024 * 1024);
  f.finish('%1|$1|0\n%2|$2|3\n');
  assert.deepEqual(serializer.serializeSession(pane()).local_clients, { state: 'known', count: 0 });
  assert.deepEqual(serializer.serializeSession(pane(2)).local_clients, { state: 'known', count: 3 });
  assert.deepEqual(serializer.serializeSession(pane(3)).local_clients, unknown);
  assert.equal(f.calls.length, 1);
});

test('three-second UI polls use fresh values while one background refresh is pending', t => {
  const f = fixture(t);
  f.snapshot.observe(pane()); f.finish('%1|$1|1\n');
  for (let count = 2; count <= 4; count++) {
    f.tick(3000);
    assert.deepEqual(f.snapshot.observe(pane()), { state: 'known', count: count - 1 });
    assert.equal(f.calls.length, count);
    for (let request = 0; request < 50; request++) f.snapshot.observe(pane());
    assert.equal(f.calls.length, count);
    f.finish(`%1|$1|${count}\n`);
  }
  f.tick(5000);
  assert.deepEqual(f.snapshot.observe(pane()), unknown);
  assert.equal(f.calls.length, 5);
});

for (const code of ['ETIMEDOUT', 'ENOENT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER']) {
  test(`${code} clears cached and partial data and rate-limits another query`, t => {
    const f = fixture(t);
    f.snapshot.observe(pane()); f.finish('%1|$1|0\n');
    f.tick(2000); f.snapshot.observe(pane());
    f.finish('%1|$1|0\n', Object.assign(new Error('read failed'), { code }));
    for (let request = 0; request < 50; request++) assert.deepEqual(f.snapshot.observe(pane()), unknown);
    assert.equal(f.calls.length, 2);
    f.tick(1999); f.snapshot.observe(pane()); assert.equal(f.calls.length, 2);
    f.tick(1); f.snapshot.observe(pane()); assert.equal(f.calls.length, 3);
    f.finish('%1|$1|2\n');
    assert.deepEqual(f.snapshot.observe(pane()), { state: 'known', count: 2 });
  });
}

test('expired and missing panes stay unknown even while a stalled batch remains single-flight', t => {
  const f = fixture(t);
  f.snapshot.observe(pane()); f.finish('%1|$1|0\n');
  f.tick(2000); f.snapshot.observe(pane());
  f.tick(10000);
  assert.deepEqual(f.snapshot.observe(pane()), unknown);
  assert.deepEqual(f.snapshot.observe(pane(2)), unknown);
  assert.equal(f.calls.length, 2);
  // Even a late successful callback cannot make an old sample fresh again.
  f.finish('%1|$1|0\n');
  assert.deepEqual(f.snapshot.observe(pane()), unknown);
});

test('parser deduplicates linked panes and marks cross-session or conflicting panes unknown', t => {
  const f = fixture(t);
  f.snapshot.observe(pane());
  f.finish('%1|$1|2\r\n%1|$1|2\r\n%2|$2|1\n%2|$3|2\n%3|$4|0\n%3|$4|1\n%4|$5|3\n');
  assert.deepEqual(f.snapshot.observe(pane()), { state: 'known', count: 2 });
  assert.deepEqual(f.snapshot.observe(pane(2)), unknown);
  assert.deepEqual(f.snapshot.observe(pane(3)), unknown);
  assert.deepEqual(f.snapshot.observe(pane(4)), { state: 'known', count: 3 });
});

for (const invalid of ['%2|$2|1oops', '%2|$2|-1', '%2|$2|9007199254740992', 'unexpected output']) {
  test(`malformed batch is never partially published: ${invalid}`, t => {
    const f = fixture(t);
    f.snapshot.observe(pane()); f.finish('%1|$1|0\n');
    f.tick(2000); f.snapshot.observe(pane()); f.finish(`%1|$1|0\n${invalid}\n`);
    assert.deepEqual(f.snapshot.observe(pane()), unknown);
  });
}

test('an empty server snapshot does not claim zero clients for absent panes', t => {
  const f = fixture(t);
  f.snapshot.observe(pane()); f.finish('');
  assert.deepEqual(f.snapshot.observe(pane()), unknown);
  assert.deepEqual(f.snapshot.observe({ type: 'pty' }), unknown);
  assert.deepEqual(f.snapshot.observe({ type: 'tmux', pane: 'not-a-pane' }), unknown);
  assert.equal(f.calls.length, 1);
});

test('shutdown aborts the outstanding query and ignores a late successful callback', t => {
  const f = fixture(t);
  f.snapshot.observe(pane()); f.finish('%1|$1|0\n');
  f.tick(2000); f.snapshot.observe(pane());
  const pending = f.calls.at(-1);
  f.snapshot.close();
  assert.equal(pending.options.signal.aborted, true);
  pending.complete(null, '%1|$1|0\n');
  f.tick(10000);
  assert.deepEqual(f.snapshot.observe(pane()), unknown);
  assert.equal(f.calls.length, 2);
});

test('a display snapshot reporting no clients does not replace live destructive evidence', t => {
  const f = fixture(t);
  f.snapshot.observe(pane()); f.finish('%1|$1|0\n');
  assert.deepEqual(f.snapshot.observe(pane()), { state: 'known', count: 0 });
  const identity = { pid: 123, startToken: 'boot:1', commandHash: 'a'.repeat(64) };
  const stored = { session: 'shell-1', session_created: '1', session_id: '$1', root: '/snapshot-test',
    pane: '%1', process_identity: identity };
  for (const clients of [unknown, { state: 'known', count: 1 }]) {
    const result = validateTmuxDestructiveEvidence(stored, { ...stored, clients });
    assert.equal(result.ok, false);
    assert.equal(result.reason, clients.state === 'unknown' ? 'tmux_clients_unknown' : 'tmux_has_clients');
  }
});
