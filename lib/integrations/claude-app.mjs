import http from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError } from '../shared/errors.mjs';
import { captureSelectedCwdIdentity } from '../process/selected-cwd-identity.mjs';

export const CLAUDE_APP_MIN_VERSION = '2.1.287';
export const CLAUDE_APP_PROTOCOL = 1;
const TERMINAL = new Set(['completed', 'aborted', 'uncertain', 'rejected']);
const clone = value => structuredClone(value);
const fail = (code, message) => new CliError(code, message);

export function claudeAppCapability(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version || ''));
  const parts = match?.slice(1).map(Number);
  const supported = !!parts && (parts[0] > 2 || parts[0] === 2 &&
    (parts[1] > 1 || parts[1] === 1 && parts[2] >= 287));
  return { supported, version: version || null, minimumVersion: CLAUDE_APP_MIN_VERSION,
    reason: supported ? null : 'CLAUDE_APP_ENGINE_UNSUPPORTED' };
}

function identifier(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) {
    throw fail('BAD_ARGS', `Invalid ${name}`);
  }
  return value;
}

function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key))) throw fail('BAD_ARGS', 'Unexpected bridge fields');
}

function reply(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw fail('BAD_ARGS', 'Bridge body exceeds 256 KiB');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail('BAD_ARGS', 'Expected a JSON object'); }
}

/** A local capability for ONE explicitly selected existing Desktop session.
 * No Claude account credentials, transcript files, peer bindings or settings are read.
 * The secret authorizes this HCC bridge only. Same-OS-user code that can read a
 * generated plugin is inside this boundary; it is not provider attestation.
 */
export async function createClaudeAppBridge({ root, initialRootIdentity = null, sessionId, port = 0, pollMs = 1000,
  leaseMs = 15000, maxRequests = 256, onConnected, onDisconnected, onStatus, onRequest } = {}) {
  identifier(sessionId, 'sessionId');
  if (!Number.isInteger(port) || port < 0 || port > 65535 ||
      !Number.isInteger(pollMs) || pollMs < 100 || pollMs > 10000 ||
      !Number.isInteger(leaseMs) || leaseMs < pollMs * 3 || leaseMs > 120000 ||
      !Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 4096) {
    throw fail('BAD_ARGS', 'Invalid Claude bridge limits');
  }
  const cwdBinding = captureSelectedCwdIdentity(root, initialRootIdentity);
  const secret = randomBytes(32).toString('base64url');
  const requests = new Map();
  const events = new Map();
  const maxEvents = Math.max(256, maxRequests * 4);
  let closed = false, connection = null, address;
  const publicStatus = () => ({ sessionId, cwd: cwdBinding.canonical,
    version: connection?.version || null, ready: Boolean(connection?.ready && !closed),
    surfaces: connection?.surfaces || [], transport: 'claude-desktop-mod',
    minimumVersion: CLAUDE_APP_MIN_VERSION, reason: connection?.reason || null });
  function notify(callback, value) {
    try { Promise.resolve(callback?.(clone(value))).catch(() => {}); } catch { /* observers cannot change delivery */ }
  }
  function publish(request) { notify(onRequest, request); return clone(request); }
  function disconnect(reason) {
    const wasReady = connection?.ready;
    if (connection) { connection.ready = false; connection.reason = reason; }
    for (const request of requests.values()) {
      if (!TERMINAL.has(request.status)) {
        request.status = 'uncertain'; request.reason = reason; publish(request);
      }
    }
    if (wasReady) notify(onDisconnected, publicStatus());
    notify(onStatus, publicStatus());
  }
  function check() {
    if (closed) throw fail('CLAUDE_APP_CLOSED', 'Claude Desktop bridge is closed');
    try { cwdBinding.assertUnchanged(); }
    catch (error) { disconnect('PROJECT_PATH_CHANGED'); throw error; }
    if (connection?.ready && Date.now() - connection.lastSeen > leaseMs) disconnect('CLAUDE_APP_CONNECTION_EXPIRED');
  }
  function assertIdentity(body, connected = true) {
    if (body.sessionId !== sessionId || body.cwd !== cwdBinding.canonical) {
      throw fail('CLAUDE_APP_IDENTITY_MISMATCH', 'The session or directory differs from this bridge');
    }
    if (connected && (!connection?.ready || body.connectionId !== connection.id)) {
      throw fail('CLAUDE_APP_CONNECTION_STALE', 'This mod connection is no longer active');
    }
  }
  function applyEvent(body) {
    fields(body, ['sessionId', 'cwd', 'connectionId', 'eventId', 'requestId', 'type', 'turnId', 'answer', 'reason']);
    assertIdentity(body);
    identifier(body.eventId, 'eventId'); identifier(body.requestId, 'requestId');
    const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    if (events.has(body.eventId)) {
      if (events.get(body.eventId) !== digest) throw fail('CLAUDE_APP_EVENT_CONFLICT', 'Event ID was reused with different content');
      return { ok: true };
    }
    const request = requests.get(body.requestId);
    if (!request || request.connectionId !== connection.id) throw fail('CLAUDE_APP_REQUEST_UNKNOWN', 'Request is not owned by this connection');
    if (TERMINAL.has(request.status)) throw fail('CLAUDE_APP_REQUEST_SETTLED', 'Request already reached a final state');
    if (body.type === 'accepted') {
      if (request.status !== 'claimed' || request.accepted) throw fail('CLAUDE_APP_EVENT_ORDER', 'Only a newly polled request can be accepted');
      request.accepted = true;
    } else if (body.type === 'started') {
      identifier(body.turnId, 'turnId');
      if (!request.accepted || request.status !== 'claimed') throw fail('CLAUDE_APP_EVENT_ORDER', 'A start requires an accepted request');
      request.status = 'started'; request.turnId = body.turnId;
    } else if (body.type === 'completed' || body.type === 'aborted') {
      if (request.status !== 'started' || body.turnId !== request.turnId) {
        throw fail('CLAUDE_APP_TURN_MISMATCH', 'Only the request’s observed turn can complete it');
      }
      if (typeof body.answer !== 'string' || body.answer.length > 100000) throw fail('BAD_ARGS', 'Invalid final answer');
      request.status = body.type; request.answer = body.answer; request.reason = body.reason || null;
    } else if (body.type === 'uncertain' || body.type === 'rejected') {
      if (!request.accepted) throw fail('CLAUDE_APP_EVENT_ORDER', 'A rejection requires an accepted request');
      request.status = body.type; request.reason = String(body.reason || body.type).slice(0,500);
    } else throw fail('BAD_ARGS', 'Unknown bridge event');
    // Keep small receipt digests after request release: a lost HTTP response
    // retries this exact event, even if its durable owner already released it.
    events.set(body.eventId, digest);
    if (events.size > maxEvents) events.delete(events.keys().next().value);
    publish(request);
    return { ok: true };
  }
  const server = http.createServer(async (req, res) => {
    try {
      // No browser origin can use this API, even with an accidentally disclosed token.
      if (req.headers.origin || req.headers.host !== new URL(address).host || req.method !== 'POST') {
        return reply(res, 403, { error: { code: 'CLAUDE_APP_FORBIDDEN' } });
      }
      const presented = Buffer.from(String(req.headers.authorization || ''));
      const expected = Buffer.from(`Bearer ${secret}`);
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        return reply(res, 401, { error: { code: 'CLAUDE_APP_UNAUTHORIZED' } });
      }
      if (!['/connect', '/poll', '/event', '/disconnect'].includes(req.url)) return reply(res, 404, { error: { code: 'NOT_FOUND' } });
      check();
      const body = await readBody(req);
      check();
      if (req.url === '/connect') {
        fields(body, ['sessionId', 'cwd', 'version', 'surfaces', 'instanceId']);
        assertIdentity(body, false); identifier(body.instanceId, 'instanceId');
        if (!claudeAppCapability(body.version).supported) throw fail('CLAUDE_APP_ENGINE_UNSUPPORTED', `Claude Code ${CLAUDE_APP_MIN_VERSION} or later is required`);
        if (!Array.isArray(body.surfaces) || !body.surfaces.includes('desktop') || body.surfaces.some(x => typeof x !== 'string')) {
          throw fail('CLAUDE_APP_DESKTOP_REQUIRED', 'The current session has no Desktop surface');
        }
        if (connection?.ready && connection.instanceId !== body.instanceId) throw fail('CLAUDE_APP_ALREADY_CONNECTED', 'A mod instance is already connected');
        if (!connection?.ready) {
          connection = { id: randomUUID(), instanceId: body.instanceId, version: body.version,
            surfaces: body.surfaces.slice(), ready: true, lastSeen: Date.now(), reason: null };
          notify(onConnected, publicStatus()); notify(onStatus, publicStatus());
        }
        connection.lastSeen = Date.now();
        return reply(res, 200, { protocol: CLAUDE_APP_PROTOCOL, connectionId: connection.id });
      }
      assertIdentity(body);
      connection.lastSeen = Date.now();
      if (req.url === '/poll') {
        fields(body, ['sessionId', 'cwd', 'connectionId']);
        const request = [...requests.values()].find(x => x.connectionId === connection.id &&
          (x.status === 'queued' || x.status === 'claimed') && !x.accepted);
        if (request?.status === 'queued') { request.status = 'claimed'; publish(request); }
        return reply(res, 200, { request: request ? { requestId: request.requestId, prompt: request.prompt } : null });
      }
      if (req.url === '/event') return reply(res, 200, applyEvent(body));
      fields(body, ['sessionId', 'cwd', 'connectionId', 'reason']);
      disconnect(String(body.reason || 'session_ended').slice(0,200));
      return reply(res, 200, { ok: true });
    } catch (error) {
      if (!res.headersSent) reply(res, error?.code === 'BAD_ARGS' ? 400 : 409,
        { error: { code: error?.code || 'CLAUDE_APP_ERROR', message: error?.message || 'Bridge error' } });
    }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
  } catch (error) { cwdBinding.release(); throw error; }
  address = `http://127.0.0.1:${server.address().port}`;
  const sweep = setInterval(() => { try { check(); } catch {} }, pollMs);
  sweep.unref();
  const pluginConfig = Object.freeze({ protocol: CLAUDE_APP_PROTOCOL, endpoint: address, secret,
    sessionId, cwd: cwdBinding.canonical, minVersion: CLAUDE_APP_MIN_VERSION, pollMs });
  return {
    address, pluginConfig,
    list() { check(); return [clone(publicStatus())]; },
    send(input) {
      fields(input, ['sessionId', 'text', 'requestId']); check();
      if (input.sessionId !== sessionId) throw fail('CLAUDE_APP_IDENTITY_MISMATCH', 'Target differs from the bound Desktop session');
      identifier(input.requestId, 'requestId');
      if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 64000) throw fail('BAD_ARGS', 'Message must contain 1–64000 characters');
      const existing = requests.get(input.requestId);
      if (existing) {
        if (existing.text !== input.text) throw fail('CLAUDE_APP_REQUEST_CONFLICT', 'Request ID was reused with different content');
        return clone(existing);
      }
      if (!connection?.ready) throw fail('CLAUDE_APP_NOT_CONNECTED', 'The selected Desktop session has not connected its mod');
      if (requests.size >= maxRequests) throw fail('CLAUDE_APP_QUEUE_FULL', 'Bridge request capacity reached; persist and release terminal requests before sending more');
      const request = { requestId: input.requestId, sessionId, cwd: cwdBinding.canonical,
        text: input.text, prompt: `[HCC message ${randomUUID()}]\n${input.text}`,
        connectionId: connection.id, status: 'queued', accepted: false, turnId: null,
        answer: null, reason: null };
      requests.set(request.requestId, request); return publish(request);
    },
    getRequest(id) { check(); return clone(requests.get(id) || null); },
    // The caller must persist the terminal receipt and own request-id
    // idempotency before releasing the in-memory body and its capacity.
    releaseRequest(id) {
      identifier(id, 'requestId'); check();
      const request = requests.get(id);
      if (!request) return false;
      if (!TERMINAL.has(request.status)) throw fail('CLAUDE_APP_REQUEST_PENDING', 'Only terminal requests can be released');
      return requests.delete(id);
    },
    async close() {
      if (closed) return;
      disconnect('CLAUDE_APP_CLOSED'); closed = true; clearInterval(sweep);
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      cwdBinding.release();
    }
  };
}

/** Generate a capability-bearing plugin in a NEW private directory. Never installs it. */
export function writeClaudeAppPlugin({ directory, bridge } = {}) {
  if (!bridge?.pluginConfig || bridge.pluginConfig.protocol !== CLAUDE_APP_PROTOCOL) throw fail('BAD_ARGS', 'A running Claude bridge is required');
  let output;
  if (directory) { output = path.resolve(directory); fs.mkdirSync(output, { mode: 0o700 }); }
  else output = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-claude-app-'));
  const identity = fs.lstatSync(output);
  function dispose() {
    let current;
    try { current = fs.lstatSync(output); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev ||
        current.ino !== identity.ino || current.birthtimeMs !== identity.birthtimeMs) {
      throw fail('CLAUDE_APP_PLUGIN_PATH_CHANGED', 'Generated plugin directory was replaced; refusing to remove it');
    }
    // This catches replacement before cleanup. Same-user concurrent pathname
    // races are not an atomic filesystem security boundary.
    fs.rmSync(output, { recursive: true, force: true });
  }
  try {
    fs.chmodSync(output, 0o700);
    const runId = randomBytes(12).toString('hex');
    const name = 'hcc-claude-app', marketplace = `hcc-claude-app-${runId}`, version = `0.1.0-bridge.${runId}`;
    const pluginDirectory = path.join(output, 'plugin');
    fs.mkdirSync(path.join(output, '.claude-plugin'), { mode: 0o700 });
    fs.mkdirSync(pluginDirectory, { mode: 0o700 });
    fs.mkdirSync(path.join(pluginDirectory, '.claude-plugin'), { mode: 0o700 });
    fs.mkdirSync(path.join(pluginDirectory, 'hooks'), { mode: 0o700 });
    const template = fs.readFileSync(fileURLToPath(new URL('./claude-mod/register.mjs', import.meta.url)), 'utf8');
    const source = template.replace('const HCC_CONFIG = null;', `const HCC_CONFIG = ${JSON.stringify(bridge.pluginConfig)};`);
    fs.writeFileSync(path.join(output, '.claude-plugin/marketplace.json'), JSON.stringify({
      name: marketplace, owner: { name: 'hello-cc' }, plugins: [{ name, source: './plugin', version,
        description: 'Connect one explicitly selected existing Claude Desktop Code session' }]
    }, null, 2), { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(pluginDirectory, '.claude-plugin/plugin.json'), JSON.stringify({ name, version,
      description: 'Explicitly connect this existing Claude Desktop Code session to hello-cc' }, null, 2), { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(pluginDirectory, 'hooks/hooks.json'), JSON.stringify({ modules: ['./register.mjs'] }, null, 2), { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(pluginDirectory, 'hooks/register.mjs'), source, { flag: 'wx', mode: 0o600 });
    return { directory: pluginDirectory, marketplaceDirectory: output, name, marketplace, version,
      minimumVersion: CLAUDE_APP_MIN_VERSION, sessionId: bridge.pluginConfig.sessionId, dispose };
  } catch (error) {
    try { dispose(); } catch (cleanupError) { cleanupError.cause = error; throw cleanupError; }
    throw error;
  }
}
