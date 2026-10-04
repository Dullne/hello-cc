import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { createTerminalMarkerMatcher, waitForTerminalMarker, terminalMarkerFailureDiagnostic } from '../scripts/regression-terminal-marker.mjs';
import { claimTerminalControl, fixtureFailureDiagnostic, fixtureDiagnosticText } from '../scripts/regression.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
class Socket extends EventEmitter {
  readyState = WebSocket.OPEN;
  hccActionToken = 'PRIVATE_FIXTURE_TOKEN';
  hccControl = { can_control: true, epoch: 1 };
  sent = [];
  closed = 0;
  terminated = 0;
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.closed++; this.readyState = WebSocket.CLOSED; this.emit('close'); }
  terminate() { this.terminated++; this.close(); }
  message(type, data = '') { this.emit('message', JSON.stringify({ type, data })); }
}
function fixture(options = {}) {
  const ws = new Socket();
  let claims = 0, releases = 0, signal;
  const promise = waitForTerminalMarker(ws, 'WS_TMUX_OK', {
    claim: async current => { claims++; signal = current; },
    release: () => { releases++; }, timeoutMs: 1000, ...options
  });
  return { ws, promise, get claims() { return claims; }, get releases() { return releases; }, get signal() { return signal; } };
}
function clean(ws) {
  for (const event of ['message', 'error', 'close']) assert.equal(ws.listenerCount(event), 0, event);
}

test('marker detection accepts every split of the stream and bounds retained output', () => {
  const marker = 'WS_TMUX_OK';
  for (let split = 1; split < marker.length; split++) {
    const matcher = createTerminalMarkerMatcher(marker);
    assert.equal(matcher.observe('data', 'x'.repeat(1024 * 1024) + marker.slice(0, split)), false);
    assert.ok(matcher.retainedLength <= marker.length - 1);
    assert.equal(matcher.observe('data', marker.slice(split) + '\r\n'), true);
    assert.ok(matcher.retainedLength <= marker.length - 1);
  }
  const single = createTerminalMarkerMatcher('X');
  assert.equal(single.observe('data', 'X'), true);
  assert.equal(single.retainedLength, 0);
});

test('screen projections do not fabricate raw stream matches or interrupt real stream continuity', () => {
  const matcher = createTerminalMarkerMatcher('MARKER');
  assert.equal(matcher.observe('snapshot', 'MAR'), false);
  assert.equal(matcher.observe('data', 'KER'), false);
  assert.equal(matcher.observe('data', 'MAR'), false);
  assert.equal(matcher.observe('replace', 'KER'), false);
  assert.equal(matcher.observe('data', 'KER'), true);
  assert.equal(matcher.observe('replace', 'MARKER'), true);
  assert.equal(matcher.observe('snapshot', 'MARKER'), true);
  assert.equal(matcher.observe('control', 'MARKER'), false);
});

test('initial history cannot pass the test and repeated snapshots submit input only once', async () => {
  const f = fixture();
  let resolved = false;
  f.promise.then(() => { resolved = true; });
  f.ws.message('data', 'WS_TMUX_OK');
  f.ws.message('snapshot', 'WS_TMUX_OK');
  f.ws.message('snapshot', 'WS_TMUX_OK');
  await tick();
  assert.equal(resolved, false);
  assert.equal(f.claims, 1);
  assert.equal(f.ws.sent.length, 1);
  assert.equal(f.ws.sent[0].type, 'input');
  f.ws.message('data', 'WS_TM');
  f.ws.message('replace', 'a separate screen projection');
  f.ws.message('data', 'UX_OK\r\n');
  await f.promise;
  assert.equal(f.releases, 1);
  assert.equal(f.ws.closed, 1);
  assert.equal(f.signal.aborted, true);
  clean(f.ws);
});

test('a projection after input can confirm the marker without resending input', async () => {
  for (const type of ['snapshot', 'replace']) {
    const f = fixture();
    f.ws.message('snapshot'); await tick();
    f.ws.message(type, 'WS_TMUX_OK'); await f.promise;
    assert.equal(f.ws.sent.length, 1);
    clean(f.ws);
  }
});

test('timeout before a snapshot closes the socket without claiming control', async () => {
  const f = fixture({ timeoutMs: 5 });
  const rejected = assert.rejects(f.promise, { code: 'TERMINAL_MARKER_TIMEOUT', phase: 'snapshot' });
  f.ws.message('data', 'WS_TMUX_OK');
  await rejected;
  assert.equal(f.claims, 0);
  assert.equal(f.ws.sent.length, 0);
  assert.equal(f.ws.terminated, 1);
  clean(f.ws);
});

for (const outcome of ['close', 'timeout']) {
  test(`${outcome} while control is pending cancels it and prevents late input`, async () => {
    let resolveClaim, signal;
    const f = fixture({ timeoutMs: outcome === 'timeout' ? 10 : 1000,
      claim: current => { signal = current; return new Promise(resolve => { resolveClaim = resolve; }); } });
    const rejected = assert.rejects(f.promise, { code: outcome === 'timeout' ? 'TERMINAL_MARKER_TIMEOUT' : 'TERMINAL_MARKER_CLOSED', phase: 'control' });
    f.ws.message('snapshot'); await tick();
    if (outcome === 'close') f.ws.close();
    await rejected;
    assert.equal(signal.aborted, true);
    resolveClaim(); await tick();
    assert.equal(f.ws.sent.length, 0);
    clean(f.ws);
  });
}

for (const [kind, code] of [['claim', 'TERMINAL_MARKER_CONTROL_FAILED'], ['socket', 'TERMINAL_MARKER_SOCKET_ERROR'], ['server', 'TERMINAL_MARKER_SERVER_ERROR'], ['invalid', 'TERMINAL_MARKER_MESSAGE_INVALID'], ['send', 'TERMINAL_MARKER_INPUT_FAILED']]) {
  test(`${kind} failure is bounded, cleans resources, and publishes only owned fixed diagnostics`, async () => {
    const f = fixture(kind === 'claim' ? { claim: async () => { throw new Error('PRIVATE_CLAIM_ERROR'); } } : {});
    if (kind === 'send') f.ws.send = () => { throw new Error('PRIVATE_SEND_ERROR'); };
    const caught = f.promise.catch(error => error);
    f.ws.message('snapshot'); await tick();
    if (kind === 'socket') f.ws.emit('error', new Error('PRIVATE_SOCKET_ERROR'));
    if (kind === 'server') f.ws.emit('message', JSON.stringify({ type: 'error', error: { message: 'PRIVATE_SERVER_ERROR' } }));
    if (kind === 'invalid') f.ws.emit('message', 'PRIVATE_INVALID_FRAME');
    const error = await caught;
    assert.equal(error.code, code);
    assert.equal(f.ws.terminated, 1);
    const expected = { code, phase: kind === 'claim' ? 'control' : kind === 'send' ? 'input' : 'marker' };
    assert.deepEqual(terminalMarkerFailureDiagnostic(error), expected);
    error.code = 'PRIVATE_FORGED_CODE'; error.phase = 'PRIVATE_FORGED_PHASE';
    const published = fixtureFailureDiagnostic(error);
    assert.deepEqual(published.terminalMarker, expected);
    assert.doesNotMatch(fixtureDiagnosticText(published), /PRIVATE_/);
    clean(f.ws);
  });
}

test('an arbitrary error cannot forge publishable terminal diagnostics', () => {
  const external = Object.assign(new Error('PRIVATE_ERROR'), { code: 'TERMINAL_MARKER_TIMEOUT', phase: 'marker', terminalMarker: { code: 'PRIVATE_VALUE' } });
  assert.equal(terminalMarkerFailureDiagnostic(external), undefined);
  assert.equal(fixtureFailureDiagnostic(external).terminalMarker, undefined);
});

test('cancelling the real control claim removes its listener and ignores late control messages', async () => {
  const ws = new Socket(), controller = new AbortController();
  ws.hccControl = { can_control: false, epoch: 0 };
  const claiming = claimTerminalControl(ws, { signal: controller.signal });
  const rejected = assert.rejects(claiming, { code: 'TERMINAL_CONTROL_ABORTED' });
  assert.equal(ws.listenerCount('message'), 1);
  controller.abort(); await rejected;
  assert.equal(ws.listenerCount('message'), 0);
  ws.emit('message', JSON.stringify({ type: 'control', control: { can_control: true, epoch: 1 } }));
  assert.equal(ws.sent.length, 1);
});

test('cancellation during one message dispatch makes an already-queued claim listener inert', async () => {
  const ws = new Socket();
  ws.hccControl = { can_control: false, epoch: 0 };
  const waiting = waitForTerminalMarker(ws, 'WS_TMUX_OK', {
    claim: signal => claimTerminalControl(ws, { signal }), release: () => {}, timeoutMs: 1000
  });
  const rejected = assert.rejects(waiting, { code: 'TERMINAL_MARKER_MESSAGE_INVALID' });
  ws.message('snapshot'); await tick();
  // EventEmitter has already copied both listeners when the first one aborts
  // the claim. The removed listener can still run in this same dispatch.
  assert.doesNotThrow(() => ws.emit('message', 'null'));
  await rejected;
  assert.equal(ws.sent.length, 1);
  assert.equal(ws.sent[0].type, 'control');
  clean(ws);
});

test('real loopback WebSocket returns a split marker with the original fifteen-second deadline', { timeout: 3000 }, async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { for (const ws of server.clients) ws.terminate(); server.close(resolve); }));
  let inputs = 0;
  server.on('connection', ws => {
    ws.send(JSON.stringify({ type: 'snapshot', data: '' }));
    ws.on('message', raw => {
      if (JSON.parse(String(raw)).type !== 'input') return;
      inputs++;
      ws.send(JSON.stringify({ type: 'data', data: 'WS_TM' }));
      ws.send(JSON.stringify({ type: 'data', data: 'UX_OK\r\n' }));
    });
  });
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  t.after(() => ws.terminate());
  const closed = once(ws, 'close');
  await waitForTerminalMarker(ws, 'WS_TMUX_OK', { claim: async () => {}, release: () => {} });
  await closed;
  assert.equal(inputs, 1);
  clean(ws);
});
