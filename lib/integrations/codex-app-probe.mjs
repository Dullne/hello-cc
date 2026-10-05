import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import WebSocket from 'ws';
import { CliError } from '../shared/errors.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
const statuses = new Set(['notLoaded', 'idle', 'active', 'systemError']);
const methods = new Set(['initialize', 'thread/read', 'thread/loaded/list']);
const messages = Object.freeze({
  DESKTOP_ENDPOINT_UNVERIFIED: 'The endpoint has not been verified as the server used by Codex Desktop.',
  READ_ONLY_PROBE: 'This probe does not attach, resume, subscribe to, or send input to a thread.',
  ENDPOINT_UNAVAILABLE: 'The explicitly selected Unix socket is unavailable.',
  ENDPOINT_CHANGED: 'The selected Unix socket changed during connection setup.',
  TRANSPORT_FAILED: 'The endpoint did not establish or retain the required WebSocket connection.',
  PROBE_TIMEOUT: 'The bounded probe deadline expired.',
  PROTOCOL_INVALID: 'The endpoint returned an invalid or unsupported protocol response.',
  RESPONSE_LIMIT: 'The endpoint exceeded a probe response limit.',
  METHOD_UNSUPPORTED: 'The endpoint does not support a required read-only method.',
  REQUEST_REJECTED: 'The endpoint rejected a read-only probe request.',
  THREAD_ID_MISMATCH: 'The returned thread identity did not match the requested thread.',
  CWD_MISMATCH: 'The reported thread working directory did not match the expected absolute path.',
  THREAD_NOT_LOADED: 'The target thread was not confirmed as loaded in this endpoint.',
  THREAD_STATE_CHANGED: 'Thread metadata and the loaded-thread list did not agree.',
  LOADED_LIST_INCOMPLETE: 'The loaded-thread list could not be completed within the page limit.',
  SERVER_REQUEST_REJECTED: 'The endpoint requested an operation from the probe; the probe rejected it.',
  DIRECT_INPUT_UNAVAILABLE: 'The endpoint did not advertise direct-input support for the target thread.'
});
const failure = code => Object.assign(new Error(code), { code });

function validate(options) {
  if (!object(options)) throw new CliError('BAD_ARGS', 'Codex probing requires explicit endpoint, thread, and working-directory options.');
  for (const key of ['socketPath', 'expectedCwd']) {
    if (!text(options[key], 4096) || !path.isAbsolute(options[key])) {
      throw new CliError('BAD_ARGS', `${key} must be an explicit absolute path.`);
    }
  }
  if (!text(options.threadId, 512)) throw new CliError('BAD_ARGS', 'threadId must be a nonempty bounded identifier.');
  const limits = { timeoutMs: [5000, 10, 30000], pageSize: [100, 1, 100], maxPages: [10, 1, 100], maxPayloadBytes: [262144, 1024, 1048576] };
  const result = { socketPath: options.socketPath, expectedCwd: options.expectedCwd, threadId: options.threadId };
  for (const [key, [defaultValue, minimum, maximum]] of Object.entries(limits)) {
    const value = options[key] ?? defaultValue;
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new CliError('BAD_ARGS', `${key} must be an integer between ${minimum} and ${maximum}.`);
    }
    result[key] = value;
  }
  return result;
}

function socketIdentity(socketPath) {
  try {
    const stat = fs.lstatSync(socketPath);
    if (!stat.isSocket()) throw failure('ENDPOINT_UNAVAILABLE');
    return { dev: stat.dev, ino: stat.ino };
  } catch { throw failure('ENDPOINT_UNAVAILABLE'); }
}

function connectProbe(options, identity, report, addCondition) {
  let ws, timer, pending, openResolve, openReject, failed, disposed = false;
  let nextId = 1, frameCount = 0, totalBytes = 0;
  const byteLimit = Math.min(options.maxPayloadBytes * (options.maxPages + 4), 16 * 1024 * 1024);
  const opened = new Promise((resolve, reject) => { openResolve = resolve; openReject = reject; });
  function fail(code) {
    if (failed || disposed) return;
    failed = failure(code);
    openReject(failed);
    pending?.reject(failed);
    pending = null;
  }
  function write(frame) {
    if (failed) throw failed;
    if (disposed || ws.readyState !== WebSocket.OPEN) throw failure('TRANSPORT_FAILED');
    ws.send(JSON.stringify(frame), error => { if (error) fail('TRANSPORT_FAILED'); });
  }
  function onMessage(bytes, binary) {
    if (failed || disposed) return;
    totalBytes += bytes.length;
    if (++frameCount > 1024 || totalBytes > byteLimit) return fail('RESPONSE_LIMIT');
    if (binary) return fail('PROTOCOL_INVALID');
    let frame;
    try { frame = JSON.parse(bytes.toString('utf8')); } catch { return fail('PROTOCOL_INVALID'); }
    if (!object(frame) || (frame.jsonrpc !== undefined && frame.jsonrpc !== '2.0')) return fail('PROTOCOL_INVALID');
    if (Object.hasOwn(frame, 'method')) {
      if (!text(frame.method, 256)) return fail('PROTOCOL_INVALID');
      if (Object.hasOwn(frame, 'id')) {
        if (!(Number.isSafeInteger(frame.id) || text(frame.id, 512))) return fail('PROTOCOL_INVALID');
        addCondition('SERVER_REQUEST_REJECTED');
        try { write({ id: frame.id, error: { code: -32601, message: 'Read-only probe does not execute server requests.' } }); }
        catch { fail('TRANSPORT_FAILED'); }
      }
      return; // Notifications and their contents are never retained.
    }
    if (!pending || frame.id !== pending.id || Object.hasOwn(frame, 'result') === Object.hasOwn(frame, 'error')) return fail('PROTOCOL_INVALID');
    const operation = pending;
    pending = null;
    if (Object.hasOwn(frame, 'error')) {
      operation.reject(failure(object(frame.error) && frame.error.code === -32601 ? 'METHOD_UNSUPPORTED' : 'REQUEST_REJECTED'));
    } else operation.resolve(frame.result);
  }
  try {
    // The public UDS transport uses a WebSocket handshake, not stdio JSONL.
    // No URL, ambient proxy, cookie, auth token, or default socket is accepted.
    ws = new WebSocket('ws://localhost/', {
      createConnection: () => net.createConnection({ path: options.socketPath }),
      followRedirects: false, perMessageDeflate: false,
      maxPayload: options.maxPayloadBytes, handshakeTimeout: options.timeoutMs
    });
    timer = setTimeout(() => fail('PROBE_TIMEOUT'), options.timeoutMs);
    ws.on('open', () => {
      if (failed || disposed) return;
      try {
        const current = socketIdentity(options.socketPath);
        if (identity.dev !== current.dev || identity.ino !== current.ino) throw failure('ENDPOINT_CHANGED');
      } catch { fail('ENDPOINT_CHANGED'); return; }
      report.transportConnected = true;
      openResolve();
    });
    ws.on('message', onMessage);
    ws.on('error', error => fail(error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' ? 'RESPONSE_LIMIT' : 'TRANSPORT_FAILED'));
    ws.on('close', () => fail('TRANSPORT_FAILED'));
  } catch { fail('TRANSPORT_FAILED'); }
  return {
    opened,
    request(method, params) {
      if (!methods.has(method) || pending) return Promise.reject(failure('PROTOCOL_INVALID'));
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending = { id, resolve, reject };
        try { write({ id, method, params }); }
        catch (error) { pending = null; reject(error); }
      });
    },
    initialized() { write({ method: 'initialized', params: {} }); },
    async close() {
      disposed = true;
      clearTimeout(timer);
      if (!ws || ws.readyState === WebSocket.CLOSED) return;
      // Close this connection only. Never unsubscribe, stop a daemon, or signal
      // any process. A bounded forced close affects only this probe's socket.
      await new Promise(resolve => {
        const closing = setTimeout(() => { ws.terminate(); resolve(); }, 100);
        ws.once('close', () => { clearTimeout(closing); resolve(); });
        if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
        else ws.close();
      });
    }
  };
}

/** Inspect one explicitly selected public endpoint. This never creates an executor or resumes a thread. */
export async function probeCodexEndpoint(input) {
  const options = validate(input);
  const report = {
    transportConnected: false, initialized: false, threadMatched: false, cwdMatched: false,
    loaded: null, status: null, directInputAdvertised: null,
    checks: { threadRead: false, loadedList: false },
    writable: false, desktopEndpointVerified: false, unmetConditions: []
  };
  const addCondition = code => {
    if (!report.unmetConditions.some(item => item.code === code)) report.unmetConditions.push({ code, message: messages[code] });
  };
  addCondition('DESKTOP_ENDPOINT_UNVERIFIED');
  addCondition('READ_ONLY_PROBE');
  let connection;
  try {
    const identity = socketIdentity(options.socketPath);
    connection = connectProbe(options, identity, report, addCondition);
    await connection.opened;
    const initialized = await connection.request('initialize', {
      clientInfo: { name: 'hello_cc_read_only_probe', title: 'hello-cc read-only endpoint probe', version: '1' },
      capabilities: { experimentalApi: false }
    });
    if (!object(initialized) || !text(initialized.userAgent, 1024)) throw failure('PROTOCOL_INVALID');
    connection.initialized();
    report.initialized = true;
    const result = await connection.request('thread/read', { threadId: options.threadId, includeTurns: false });
    const thread = result?.thread;
    if (!object(thread) || !text(thread.id, 512)) throw failure('PROTOCOL_INVALID');
    report.checks.threadRead = true;
    report.threadMatched = thread.id === options.threadId;
    if (!report.threadMatched) { addCondition('THREAD_ID_MISMATCH'); return report; }
    if (!text(thread.cwd, 4096) || !path.isAbsolute(thread.cwd) || !object(thread.status) || !statuses.has(thread.status.type)) throw failure('PROTOCOL_INVALID');
    report.cwdMatched = path.normalize(thread.cwd) === path.normalize(options.expectedCwd);
    report.status = thread.status.type;
    report.directInputAdvertised = typeof thread.canAcceptDirectInput === 'boolean' ? thread.canAcceptDirectInput : null;
    if (!report.cwdMatched) addCondition('CWD_MISMATCH');
    if (report.directInputAdvertised !== true) addCondition('DIRECT_INPUT_UNAVAILABLE');
    let cursor, found = false, complete = false;
    const cursors = new Set();
    for (let page = 0; page < options.maxPages; page++) {
      const list = await connection.request('thread/loaded/list', { limit: options.pageSize, ...(cursor ? { cursor } : {}) });
      if (!object(list) || !Array.isArray(list.data) || list.data.length > options.pageSize ||
          !list.data.every(id => text(id, 512)) || (list.nextCursor !== null && !text(list.nextCursor, 4096))) throw failure('PROTOCOL_INVALID');
      report.checks.loadedList = true;
      found = list.data.includes(options.threadId);
      if (found || list.nextCursor === null) { complete = true; break; }
      if (cursors.has(list.nextCursor)) throw failure('PROTOCOL_INVALID');
      cursors.add(list.nextCursor);
      cursor = list.nextCursor;
    }
    if (!complete) addCondition('LOADED_LIST_INCOMPLETE');
    else {
      report.loaded = found && report.status !== 'notLoaded';
      if (!report.loaded) addCondition('THREAD_NOT_LOADED');
      if (found !== (report.status !== 'notLoaded')) addCondition('THREAD_STATE_CHANGED');
    }
  } catch (error) {
    addCondition(Object.hasOwn(messages, error?.code) ? error.code : 'PROTOCOL_INVALID');
  } finally { await connection?.close(); }
  return report;
}
