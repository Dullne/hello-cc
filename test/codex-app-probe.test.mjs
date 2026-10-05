import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { probeCodexEndpoint } from '../lib/integrations/codex-app-probe.mjs';

const threadId = 'fixture-selected-thread';
const expectedCwd = '/fixture/project';
const sensitive = 'DO_NOT_EXPOSE_fixture_secret';
const conditionCodes = result => result.unmetConditions.map(item => item.code);
const readonlyMethods = ['initialize', 'initialized', 'thread/read', 'thread/loaded/list'];

async function fixture(t, handle = () => false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-cp-'));
  const socketPath = path.join(directory, 's');
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const frames = [];
  const peers = new Set();
  wss.on('connection', ws => {
    peers.add(ws);
    ws.on('error', () => {});
    ws.on('close', () => peers.delete(ws));
    ws.on('message', bytes => {
      const frame = JSON.parse(bytes.toString());
      frames.push(frame);
      const respond = result => ws.send(JSON.stringify({ id: frame.id, result }));
      if (handle({ ws, frame, respond })) return;
      if (frame.method === 'initialize') respond({ userAgent: `codex-cli/${sensitive}`, platformOs: sensitive });
      if (frame.method === 'thread/read') respond({ thread: {
        id: threadId, cwd: expectedCwd, status: { type: 'idle' },
        canAcceptDirectInput: true, preview: sensitive, name: sensitive,
        path: sensitive, turns: [{ input: sensitive }]
      } });
      if (frame.method === 'thread/loaded/list') respond({ data: [threadId], nextCursor: null });
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  t.after(async () => {
    for (const ws of peers) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { server, wss, socketPath, frames, peers,
    probe: options => probeCodexEndpoint({ socketPath, threadId, expectedCwd, timeoutMs: 2000, ...options }) };
}

test('Codex probe uses public UDS WebSocket read methods and never reports Desktop control', async t => {
  const peer = await fixture(t);
  const report = await peer.probe();
  assert.deepEqual({ ...report, unmetConditions: conditionCodes(report) }, {
    transportConnected: true, initialized: true, threadMatched: true, cwdMatched: true,
    loaded: true, status: 'idle', directInputAdvertised: true,
    checks: { threadRead: true, loadedList: true },
    writable: false, desktopEndpointVerified: false,
    unmetConditions: ['DESKTOP_ENDPOINT_UNVERIFIED', 'READ_ONLY_PROBE']
  });
  assert.deepEqual(peer.frames.map(frame => frame.method), readonlyMethods);
  assert.deepEqual(peer.frames[2].params, { threadId, includeTurns: false });
  assert.equal(peer.frames[0].params.capabilities.experimentalApi, false);
  assert.equal(JSON.stringify(report).includes(sensitive), false);
  assert.equal(JSON.stringify(report).includes(threadId), false);
  assert.equal(JSON.stringify(report).includes(expectedCwd), false);
  assert.equal(peer.server.listening, true);
});

test('Codex probe only closes its own connection, preserving another client and the endpoint', async t => {
  const peer = await fixture(t);
  const other = new WebSocket(`ws+unix://${peer.socketPath}:/`);
  await once(other, 'open');
  t.after(() => other.terminate());
  await peer.probe();
  assert.equal(other.readyState, WebSocket.OPEN);
  const pong = once(other, 'pong');
  other.ping('still-live');
  await pong;
  assert.equal(peer.server.listening, true);
  assert.ok(peer.frames.every(frame => readonlyMethods.includes(frame.method)));
});

test('Codex probe rejects every server request without executing or leaking it', async t => {
  let initializeId, rejected;
  const peer = await fixture(t, ({ ws, frame }) => {
    if (frame.method === 'initialize') {
      initializeId = frame.id;
      ws.send(JSON.stringify({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { command: sensitive } }));
      return true;
    }
    if (frame.id === 'approval-1') {
      rejected = frame;
      ws.send(JSON.stringify({ id: initializeId, result: { userAgent: 'fixture' } }));
      return true;
    }
    return false;
  });
  const report = await peer.probe();
  assert.deepEqual(rejected, { id: 'approval-1', error: { code: -32601, message: 'Read-only probe does not execute server requests.' } });
  assert.equal(report.loaded, true);
  assert.ok(conditionCodes(report).includes('SERVER_REQUEST_REJECTED'));
  assert.equal(JSON.stringify(report).includes(sensitive), false);
});

test('Codex probe pages only loaded IDs and stops immediately at the target', async t => {
  const peer = await fixture(t, ({ frame, respond }) => {
    if (frame.method !== 'thread/loaded/list') return false;
    respond(frame.params.cursor ? { data: [threadId], nextCursor: 'unused-page' } : { data: ['another-id'], nextCursor: 'page-2' });
    return true;
  });
  const report = await peer.probe({ pageSize: 1 });
  assert.equal(report.loaded, true);
  assert.deepEqual(peer.frames.filter(frame => frame.method === 'thread/loaded/list').map(frame => frame.params), [
    { limit: 1 }, { limit: 1, cursor: 'page-2' }
  ]);
});

for (const [name, status, list, expectedCode] of [
  ['unloaded thread', 'notLoaded', [], 'THREAD_NOT_LOADED'],
  ['thread unloaded between reads', 'idle', [], 'THREAD_STATE_CHANGED'],
  ['thread loaded between reads', 'notLoaded', [threadId], 'THREAD_STATE_CHANGED']
]) test(`Codex probe reports ${name} without resuming or creating anything`, async t => {
  const peer = await fixture(t, ({ frame, respond }) => {
    if (frame.method === 'thread/read') { respond({ thread: { id: threadId, cwd: expectedCwd, status: { type: status } } }); return true; }
    if (frame.method === 'thread/loaded/list') { respond({ data: list, nextCursor: null }); return true; }
    return false;
  });
  const report = await peer.probe();
  assert.equal(report.loaded, false);
  assert.ok(conditionCodes(report).includes(expectedCode));
  assert.equal(report.directInputAdvertised, null);
  assert.ok(conditionCodes(report).includes('DIRECT_INPUT_UNAVAILABLE'));
  assert.ok(peer.frames.every(frame => readonlyMethods.includes(frame.method)));
});

test('Codex probe preserves active status and never starts or steers a turn', async t => {
  const peer = await fixture(t, ({ frame, respond }) => {
    if (frame.method !== 'thread/read') return false;
    respond({ thread: { id: threadId, cwd: expectedCwd, status: { type: 'active', activeFlags: ['waitingOnApproval'] } } });
    return true;
  });
  const report = await peer.probe();
  assert.equal(report.status, 'active');
  assert.equal(report.loaded, true);
  assert.equal(report.writable, false);
  assert.deepEqual(peer.frames.map(frame => frame.method), readonlyMethods);
});

test('Codex probe rejects identity mismatch before any further thread request', async t => {
  const peer = await fixture(t, ({ frame, respond }) => {
    if (frame.method !== 'thread/read') return false;
    respond({ thread: { id: sensitive, cwd: expectedCwd, status: { type: 'idle' } } });
    return true;
  });
  const report = await peer.probe();
  assert.equal(report.threadMatched, false);
  assert.equal(report.loaded, null);
  assert.ok(conditionCodes(report).includes('THREAD_ID_MISMATCH'));
  assert.deepEqual(peer.frames.map(frame => frame.method), readonlyMethods.slice(0, 3));
  assert.equal(JSON.stringify(report).includes(sensitive), false);
});

test('Codex probe reports cwd mismatch without echoing provider paths or overriding cwd', async t => {
  const peer = await fixture(t);
  const report = await peer.probe({ expectedCwd: '/different/project' });
  assert.equal(report.cwdMatched, false);
  assert.ok(conditionCodes(report).includes('CWD_MISMATCH'));
  assert.equal(peer.frames.some(frame => Object.hasOwn(frame.params || {}, 'cwd')), false);
});

for (const [name, list, code] of [
  ['page limit', { data: ['other'], nextCursor: 'next' }, 'LOADED_LIST_INCOMPLETE'],
  ['repeated cursor', { data: ['other'], nextCursor: 'again' }, 'PROTOCOL_INVALID'],
  ['oversized page', { data: ['a', 'b'], nextCursor: null }, 'PROTOCOL_INVALID'],
  ['malformed cursor', { data: [], nextCursor: {} }, 'PROTOCOL_INVALID']
]) test(`Codex probe bounds loaded-list ${name}`, async t => {
  const peer = await fixture(t, ({ frame, respond }) => {
    if (frame.method !== 'thread/loaded/list') return false;
    respond(list); return true;
  });
  const report = await peer.probe({ pageSize: 1, maxPages: name === 'page limit' ? 1 : 3 });
  assert.equal(report.loaded, null);
  assert.ok(conditionCodes(report).includes(code));
  assert.ok(peer.frames.filter(frame => frame.method === 'thread/loaded/list').length <= 3);
});

for (const [name, emit, code] of [
  ['provider error', (ws, frame) => ws.send(JSON.stringify({ id: frame.id, error: { code: -32603, message: sensitive, data: sensitive } })), 'REQUEST_REJECTED'],
  ['unsupported method', (ws, frame) => ws.send(JSON.stringify({ id: frame.id, error: { code: -32601, message: sensitive } })), 'METHOD_UNSUPPORTED'],
  ['invalid JSON', ws => ws.send(`not-json ${sensitive}`), 'PROTOCOL_INVALID'],
  ['binary response', ws => ws.send(Buffer.from(sensitive)), 'PROTOCOL_INVALID'],
  ['unexpected response ID', ws => ws.send(JSON.stringify({ id: 999, result: sensitive })), 'PROTOCOL_INVALID'],
  ['oversized frame', ws => ws.send(JSON.stringify({ secret: sensitive.repeat(100) })), 'RESPONSE_LIMIT']
]) test(`Codex probe sanitizes ${name}`, async t => {
  const peer = await fixture(t, ({ ws, frame }) => {
    if (frame.method !== 'thread/read') return false;
    emit(ws, frame); return true;
  });
  const report = await peer.probe({ maxPayloadBytes: 1024 });
  assert.ok(conditionCodes(report).includes(code), JSON.stringify(report));
  assert.equal(JSON.stringify(report).includes(sensitive), false);
  assert.equal(report.writable, false);
});

test('Codex probe enforces a total deadline when the endpoint never answers', async t => {
  const peer = await fixture(t, ({ frame }) => frame.method === 'initialize');
  const started = Date.now();
  const report = await peer.probe({ timeoutMs: 50 });
  assert.ok(conditionCodes(report).includes('PROBE_TIMEOUT'));
  assert.ok(Date.now() - started < 1000);
  assert.equal(report.initialized, false);
  assert.equal(peer.server.listening, true);
});

test('Codex probe bounds notification floods while waiting for a read response', async t => {
  const peer = await fixture(t, ({ ws, frame }) => {
    if (frame.method !== 'thread/read') return false;
    for (let i = 0; i < 1030; i++) ws.send(JSON.stringify({ method: 'fixture/notice', params: { secret: sensitive } }));
    return true;
  });
  const report = await peer.probe();
  assert.ok(conditionCodes(report).includes('RESPONSE_LIMIT'));
  assert.equal(JSON.stringify(report).includes(sensitive), false);
});

test('Codex probe refuses a socket path replaced during the WebSocket handshake', async t => {
  const peer = await fixture(t);
  const moved = `${peer.socketPath}-old`;
  peer.wss.once('headers', () => fs.renameSync(peer.socketPath, moved));
  try {
    const report = await peer.probe();
    assert.ok(conditionCodes(report).includes('ENDPOINT_CHANGED'));
    assert.equal(report.transportConnected, false);
    assert.equal(peer.frames.length, 0);
  } finally { fs.renameSync(moved, peer.socketPath); }
});

test('Codex probe bounds an endpoint which accepts a socket but never upgrades', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-cp-'));
  const socketPath = path.join(directory, 's');
  const connections = new Set();
  const target = http.createServer();
  target.on('connection', socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
  target.on('upgrade', () => {});
  await new Promise(resolve => target.listen(socketPath, resolve));
  t.after(async () => {
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => target.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const started = Date.now();
  const report = await probeCodexEndpoint({ socketPath, threadId, expectedCwd, timeoutMs: 50 });
  assert.ok(conditionCodes(report).some(code => ['PROBE_TIMEOUT', 'TRANSPORT_FAILED'].includes(code)));
  assert.equal(report.initialized, false);
  assert.ok(Date.now() - started < 1000);
});

test('Codex probe never follows HTTP redirects to a different endpoint', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-cp-'));
  const socketPath = path.join(directory, 's');
  const target = http.createServer((_req, res) => { res.writeHead(302, { Location: `http://127.0.0.1:1/${sensitive}` }); res.end(); });
  await new Promise(resolve => target.listen(socketPath, resolve));
  t.after(async () => { await new Promise(resolve => target.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  const report = await probeCodexEndpoint({ socketPath, threadId, expectedCwd });
  assert.ok(conditionCodes(report).includes('TRANSPORT_FAILED'));
  assert.equal(report.transportConnected, false);
  assert.equal(JSON.stringify(report).includes(sensitive), false);
});

test('Codex probe validates explicit inputs and never falls back to a default endpoint', async t => {
  const peer = await fixture(t);
  for (const options of [undefined, {}, { socketPath: 'relative' }, { threadId: '' },
    { expectedCwd: 'relative' }, { timeoutMs: 0 }, { maxPages: 101 }, { pageSize: 101 }, { maxPayloadBytes: 0 }]) {
    const input = options === undefined ? undefined : { socketPath: peer.socketPath, threadId, expectedCwd, ...options };
    if (options && Object.keys(options).length === 0) delete input.socketPath;
    await assert.rejects(probeCodexEndpoint(input), error => error.code === 'BAD_ARGS' && !error.message.includes(sensitive));
  }
  assert.equal(peer.frames.length, 0);
  const report = await peer.probe({ socketPath: path.join(path.dirname(peer.socketPath), 'missing') });
  assert.ok(conditionCodes(report).includes('ENDPOINT_UNAVAILABLE'));
  const alias = path.join(path.dirname(peer.socketPath), 'alias');
  fs.symlinkSync(peer.socketPath, alias);
  const symlink = await peer.probe({ socketPath: alias });
  assert.ok(conditionCodes(symlink).includes('ENDPOINT_UNAVAILABLE'));
  assert.equal(peer.frames.length, 0);
});
