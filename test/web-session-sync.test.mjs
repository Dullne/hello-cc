import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionSync, applyStateOperations } from '../lib/web/browser/session-sync.mjs';
import { createSessionStateStream, sendStructuredFrame, STATE_HIGH_WATER_BYTES } from '../lib/web/session-state-sync.mjs';
import { createSessionSerialize } from '../lib/web/session-serialize.mjs';
import { benchmarkSessionSync } from '../scripts/benchmark-session-sync.mjs';

const initial = () => ({ executorId: 'executor', status: 'ready', updateSequence: 0, truncated: false,
  threads: [{ id: 'thread', turns: [{ id: 'turn', items: [{ id: 'message', type: 'agentMessage', text: '' }] }] }],
  events: [], pendingApprovals: [] });
const hint = { textOnly: true, textItems: [{ threadId: 'thread', turnId: 'turn', itemId: 'message' }] };
const streamFor = state => createSessionStateStream({ root: '/project', sessionId: 'session', channel: 'codex', state, generation: 'generation' });
const roundtrip = value => JSON.parse(JSON.stringify(value));
function append(state, text) {
  state.threads[0].turns[0].items[0].text += text;
  state.events.push({ method: 'item/agentMessage/delta', params: { delta: text }, at: ++state.updateSequence });
  if (state.events.length > 100) state.events.shift();
}
function observer() {
  const requests = [], states = [];
  const receiver = createSessionSync({ root: '/project', sessionId: 'session', requestSnapshot: frame => requests.push(frame), onState: (state, channel) => states.push({ state, channel }) });
  return { receiver, requests, states };
}

test('negotiated text deltas preserve complete state and previous UI snapshots after ring retention', () => {
  const state = initial(), stream = streamFor(state), { receiver, states } = observer();
  receiver.receive(roundtrip(stream.snapshot()));
  const empty = states[0].state;
  for (let index = 0; index < 130; index++) {
    append(state, '字' + index);
    const patch = roundtrip(stream.update(state, hint));
    assert.equal(patch.mode, 'patch'); assert.equal(receiver.receive(patch).accepted, true);
  }
  assert.deepEqual(receiver.state, state);
  assert.equal(empty.threads[0].turns[0].items[0].text, '', 'delivered UI snapshots are never mutated');
  assert.equal(receiver.state.events.length, 100);
});

test('missing, duplicated, out of order and foreign generation frames fail closed and recover exactly once', () => {
  for (const fault of ['missing', 'duplicate', 'out-of-order', 'old-executor', 'old-generation']) {
    const state = initial(), stream = streamFor(state), { receiver, requests } = observer();
    receiver.receive(roundtrip(stream.snapshot()));
    append(state, 'one'); const one = roundtrip(stream.update(state, hint));
    append(state, 'two'); const two = roundtrip(stream.update(state, hint));
    let bad;
    if (fault === 'duplicate') { receiver.receive(one); bad = one; }
    else if (fault === 'old-executor') bad = { ...one, executorId: 'old' };
    else if (fault === 'old-generation') bad = { ...one, generation: 'old' };
    else bad = two;
    assert.equal(receiver.receive(bad).recovery, true, fault);
    receiver.receive(bad); assert.equal(requests.length, 1, 'only one read-only recovery request while waiting');
    assert.equal(requests[0].type, 'state_sync_request'); assert.equal(Object.hasOwn(requests[0], 'action_token'), false);
    assert.equal(receiver.receive(roundtrip(stream.snapshot(requests[0].requestId))).accepted, true);
    assert.deepEqual(receiver.state, state); assert.equal(receiver.recovering, false);
  }
});

test('reconnection resets the receiver and a restarted executor gets its own generation', () => {
  const first = streamFor(initial()), { receiver, requests } = observer(); receiver.receive(first.snapshot());
  const next = initial(); next.executorId = 'new-executor';
  const restarted = createSessionStateStream({ root: '/project', sessionId: 'session', channel: 'codex', state: next, generation: 'restart' });
  assert.equal(receiver.receive(restarted.snapshot()).accepted, false);
  receiver.reset(); assert.equal(receiver.receive(restarted.snapshot()).accepted, true);
  assert.equal(requests.length, 1); assert.equal(receiver.state.executorId, 'new-executor');
});

test('approval, completion, error and changed metadata travel in immediate state patches', () => {
  const state = initial(), stream = streamFor(state), { receiver } = observer(); receiver.receive(stream.snapshot());
  append(state, 'latest text');
  state.pendingApprovals = [{ requestId: 'approve', executorId: 'executor' }];
  state.metrics = { source: 'provider', scope: 'session', totalTokens: 12 };
  receiver.receive(roundtrip(stream.update(state)));
  assert.equal(receiver.state.pendingApprovals.length, 1); assert.equal(receiver.state.metrics.totalTokens, 12);
  state.pendingApprovals = []; state.status = 'disconnected'; state.error = { code: 'OFFLINE' };
  state.threads[0].turns[0].status = 'failed';
  receiver.receive(roundtrip(stream.update(state)));
  assert.deepEqual(receiver.state, state);
});

test('text fast path falls back for new items and evicted history without losing state', () => {
  const state = initial(), stream = streamFor(state), { receiver } = observer(); receiver.receive(stream.snapshot());
  state.threads[0].turns[0].items = [{ id: 'new', type: 'agentMessage', text: 'replacement' }];
  const frame = stream.update(state, { textOnly: true, textItems: [{ threadId: 'thread', turnId: 'turn', itemId: 'new' }] });
  assert.equal(receiver.receive(roundtrip(frame)).accepted, true); assert.deepEqual(receiver.state, state);
});

test('text fast path does not traverse unchanged retained message bodies', () => {
  const state = initial(); state.threads[0].turns.unshift({ id: 'history', items: [{ id: 'old', text: 'large history'.repeat(20000) }] });
  const stream = streamFor(state); let reads = 0;
  Object.defineProperty(state.threads[0].turns[0].items[0], 'text', { enumerable: true, get() { reads++; return 'large history'.repeat(20000); } });
  state.threads[0].turns[1].items[0].text = 'new text'; state.updateSequence++;
  state.events.push({ method: 'item/agentMessage/delta', params: { delta: 'new text' } });
  const frame = stream.update(state, hint);
  assert.equal(frame.mode, 'patch'); assert.equal(reads, 0, 'stable historical text is neither copied nor traversed');
});

test('wire normalization removes undefined fields consistently before diffing', () => {
  const state = { ...initial(), optional: undefined, nested: { omitted: undefined, value: 'before' } };
  const stream = streamFor(state), { receiver } = observer(); receiver.receive(roundtrip(stream.snapshot()));
  delete state.optional; state.nested = { value: undefined, after: 1 };
  receiver.receive(roundtrip(stream.update(state))); assert.deepEqual(receiver.state, roundtrip(state));
});

test('malformed operations are atomic and cannot partially overwrite a valid state', () => {
  const state = initial(), stream = streamFor(state), { receiver } = observer(); receiver.receive(stream.snapshot());
  const frame = { ...stream.snapshot(), mode: 'patch', baseRevision: 0, revision: 1,
    operations: [{ op: 'set', path: ['status'], value: 'changed' }, { op: 'append', path: ['missing', 'text'], value: 'invalid' }] };
  assert.equal(receiver.receive(frame).accepted, false); assert.equal(receiver.state.status, 'ready');
  assert.throws(() => applyStateOperations(state, [{ op: 'set', path: ['constructor'], value: {} }]));
});

function socket(sync = false) {
  return { OPEN: 1, CLOSED: 3, readyState: 1, hccStateSync: sync, bufferedAmount: 0, sent: [], closed: [],
    send(value) { this.sent.push(value); }, close(code, reason) { this.closed.push({ code, reason }); this.readyState = 3; }, terminate() { this.readyState = 3; } };
}
function fixture() {
  let state = initial();
  const session = { id: 'session', root: '/project', type: 'app-server', clients: new Set(), adapter: { snapshot: () => structuredClone(state) } };
  const api = createSessionSerialize({ sessions: new Map(), cookieSocketValid: () => true, ctx: { root: '/project' }, sameResolvedPath: (a, b) => a === b });
  return { session, api, get state() { return state; }, replace(value) { state = value; } };
}

test('two panes share revisions while a late snapshot observes pending text and legacy stays full-frame', () => {
  const f = fixture(), first = socket(true), second = socket(true), legacy = socket();
  const one = observer(), two = observer();
  f.session.clients.add(first); f.session.clients.add(legacy); f.api.sendStateSnapshot(f.session, first);
  one.receiver.receive(JSON.parse(first.sent.shift()));
  append(f.state, 'pending');
  f.session.clients.add(second); f.api.sendStateSnapshot(f.session, second);
  assert.equal(one.receiver.receive(JSON.parse(first.sent.shift())).accepted, true);
  assert.equal(two.receiver.receive(JSON.parse(second.sent.shift())).accepted, true);
  append(f.state, '+published'); f.api.broadcast(f.session, { type: 'codex_state', state: f.state }, hint);
  one.receiver.receive(JSON.parse(first.sent.shift())); two.receiver.receive(JSON.parse(second.sent.shift()));
  assert.deepEqual(one.receiver.state, two.receiver.state); assert.deepEqual(one.receiver.state, f.state);
  assert.equal(JSON.parse(legacy.sent.at(-1)).type, 'codex_state');
  assert.deepEqual(JSON.parse(legacy.sent.at(-1)).state, f.state);
});

test('slow observers close with recovery status while fast panes keep receiving and terminal data is unchanged', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), slow = socket(true), fast = socket(true), raw = socket();
  f.session.clients = new Set([slow, fast]); f.api.sendStateSnapshot(f.session, slow); f.api.sendStateSnapshot(f.session, fast);
  slow.bufferedAmount = STATE_HIGH_WATER_BYTES + 1;
  append(f.state, 'new'); f.api.broadcast(f.session, { type: 'codex_state', state: f.state }, hint);
  assert.equal(slow.closed[0].code, 1013); assert.equal(fast.closed.length, 0);
  const before = slow.sent.length; append(f.state, 'more'); f.api.broadcast(f.session, { type: 'codex_state', state: f.state }, hint);
  assert.equal(slow.sent.length, before);
  f.session.clients = new Set([raw]);
  const payload = { type: 'data', data: '\u001b[31mraw\r\n' };
  f.api.broadcast(f.session, payload); assert.equal(raw.sent[0], JSON.stringify(payload));
  t.mock.timers.tick(1000);
});

test('executor replacement closes existing synchronized observers and new connection snapshots the replacement', () => {
  const f = fixture(), old = socket(true); f.session.clients.add(old); f.api.sendStateSnapshot(f.session, old);
  f.replace({ ...initial(), executorId: 'replacement' });
  f.api.broadcast(f.session, { type: 'codex_state', state: f.state }); assert.equal(old.closed[0].code, 1012);
  const next = socket(true); f.session.clients.add(next); f.api.sendStateSnapshot(f.session, next);
  const { receiver } = observer(); assert.equal(receiver.receive(JSON.parse(next.sent[0])).accepted, true);
  assert.equal(receiver.state.executorId, 'replacement');
});

test('oversized single frames and a non-draining close are bounded', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = socket(true); let terminated = false;
  client.close = code => client.closed.push({ code }); client.terminate = () => { terminated = true; };
  assert.equal(sendStructuredFrame(client, 'x'.repeat(16 * 1024 * 1024 + 1)), false);
  assert.equal(client.closed[0].code, 1009); assert.equal(client.sent.length, 0);
  t.mock.timers.tick(1000); assert.equal(terminated, true);
});

test('same-input benchmark retains every fragment and bounds wire bytes without timing assertions', () => {
  const result = benchmarkSessionSync({ fragments: 100, batchSize: 5 });
  assert.equal(result.legacy.frames, result.incremental.frames);
  assert.equal(result.legacy.finalOutputCharacters, result.incremental.finalOutputCharacters);
  assert.ok(result.incremental.bytes < result.legacy.bytes * .1);
});
