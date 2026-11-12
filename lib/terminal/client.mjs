import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { CliError } from '../shared/errors.mjs';
import { ensurePrivateGlobalSubdirectory } from '../runtime/private-state.mjs';
import { readPrivateTextFile, openPrivateAppendResource } from '../runtime/private-file.mjs';
import { captureDirectory } from '../platform/windows-filesystem.mjs';
import { spawnWindowsServiceHost } from '../platform/windows-service-host.mjs';
import { inspectProcessIdentity, compareProcessIdentity } from '../process/identity.mjs';
import { acquireFileLock } from '../shared/file-lock.mjs';

const entry = fileURLToPath(new URL('../../bin/windows-terminal-host.mjs', import.meta.url));
const fail = (code, message) => new CliError(code, message);
const fromResponse = error => Object.assign(fail(error?.code || 'TERMINAL_REQUEST_FAILED', error?.message || 'Terminal request failed'),
  error?.control ? { control: error.control } : {});

export function terminalClient(pointer) {
  const headers = { authorization: `Bearer ${pointer.token}`, 'x-hcc-terminal-generation': pointer.generation };
  function request(method, route, value, { timeoutMs = 10000 } = {}) {
    return new Promise((resolve, reject) => {
      const encoded = value === undefined ? null : Buffer.from(JSON.stringify(value));
      if (encoded?.length > 1024 * 1024) return reject(fail('BAD_REQUEST', 'Terminal request exceeds 1 MiB'));
      let dispatched = false;
      const req = http.request({ host: '127.0.0.1', port: pointer.port, method, path: route,
        headers: { ...headers, ...(encoded ? { 'content-type': 'application/json', 'content-length': encoded.length } : {}) } }, res => {
        const chunks = []; let bytes = 0;
        res.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) res.destroy(fail('TERMINAL_RESPONSE_INVALID', 'Terminal response exceeds limit')); else chunks.push(chunk); });
        res.on('error', reject);
        res.on('end', () => {
          let result; try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { reject(fail('TERMINAL_RESPONSE_INVALID', 'Invalid terminal service response')); return; }
          if (res.statusCode < 200 || res.statusCode >= 300) reject(fromResponse(result.error)); else resolve(result);
        });
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error('Terminal service deadline')));
      req.on('error', error => reject(fail(method === 'POST' && dispatched ? 'TERMINAL_OPERATION_UNCONFIRMED' : 'TERMINAL_HOST_OFFLINE',
        method === 'POST' && dispatched ? 'Terminal action result is unconfirmed; inspect its state before retrying' : `Cannot reach terminal service: ${error.code || 'timeout'}`)));
      dispatched = true; req.end(encoded);
    });
  }
  function connect(id, generation, { clientToken = randomUUID(), onFrame = () => {} } = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${pointer.port}/attach`, { headers, maxPayload: 8 * 1024 * 1024,
        perMessageDeflate: false, handshakeTimeout: 5000 });
      const pending = new Map();
      let settled = false, initial = null, control = null, closed = false;
      const timeout = setTimeout(() => { ws.terminate(); reject(fail('TERMINAL_ATTACH_TIMEOUT', 'Terminal did not confirm attachment')); }, 10000);
      const connection = { clientToken, get initial() { return initial; }, get control() { return control; },
        close() { closed = true; ws.close(1000, 'Detached'); },
        action(message) {
          if (closed || ws.readyState !== WebSocket.OPEN) return Promise.reject(fail('TERMINAL_CLIENT_DISCONNECTED', 'Reconnect before terminal actions'));
          if (pending.size >= 32 || ws.bufferedAmount > 256 * 1024) return Promise.reject(fail('TERMINAL_BACKPRESSURE', 'Wait for pending terminal actions'));
          return new Promise((ok, no) => {
            const requestId = randomUUID();
            const timer = setTimeout(() => { pending.delete(requestId); no(fail('TERMINAL_OPERATION_UNCONFIRMED', 'Terminal action result is unconfirmed; inspect its state before retrying')); }, 15000);
            pending.set(requestId, { ok, no, timer });
            ws.send(JSON.stringify({ ...message, requestId, generation, hostGeneration: pointer.generation }), error => {
              if (!error) return;
              clearTimeout(timer); pending.delete(requestId); no(fail('TERMINAL_OPERATION_UNCONFIRMED', 'Terminal action delivery is unconfirmed'));
            });
          });
        }
      };
      ws.on('open', () => ws.send(JSON.stringify({ type: 'attach', id, generation, clientToken })));
      ws.on('message', bytes => {
        let frame; try { frame = JSON.parse(bytes.toString()); } catch { ws.terminate(); return; }
        if (!frame || typeof frame !== 'object' || Array.isArray(frame) || typeof frame.type !== 'string' ||
            (['snapshot', 'attached', 'control', 'data', 'exit', 'state'].includes(frame.type) &&
              (frame.generation !== generation || frame.hostGeneration !== pointer.generation)) ||
            (frame.type === 'snapshot' && (typeof frame.screen !== 'string' || frame.id !== id ||
              frame.session?.id !== id || frame.session?.generation !== generation || frame.session?.hostGeneration !== pointer.generation)) ||
            (frame.type === 'attached' && (!initial || !frame.control))) {
          if (!settled) { settled = true; clearTimeout(timeout); reject(fail('TERMINAL_RESPONSE_INVALID', 'Terminal response identity does not match')); }
          ws.terminate(); return;
        }
        if (frame.type === 'snapshot') initial = frame;
        if (frame.type === 'control' || frame.type === 'attached') control = frame.control;
        if (frame.type === 'reply' || frame.type === 'error') {
          const receipt = pending.get(frame.requestId);
          if (receipt) { clearTimeout(receipt.timer); pending.delete(frame.requestId);
            if (frame.type === 'reply') receipt.ok(frame.result); else receipt.no(fromResponse(frame.error));
          } else if (!settled && frame.type === 'error') { settled = true; clearTimeout(timeout); reject(fromResponse(frame.error)); ws.close(); }
        }
        try { onFrame(frame); } catch { ws.close(1011, 'Terminal client failed'); }
        if (frame.type === 'attached' && !settled) {
          settled = true; clearTimeout(timeout);
          if (!initial || frame.generation !== generation || frame.hostGeneration !== pointer.generation) {
            reject(fail('TERMINAL_RESPONSE_INVALID', 'Terminal attachment identity does not match')); ws.close();
          } else resolve(connection);
        }
      });
      ws.on('error', () => {});
      ws.on('close', () => {
        closed = true; clearTimeout(timeout);
        if (!settled) { settled = true; reject(fail('TERMINAL_HOST_OFFLINE', 'Terminal service disconnected before attachment')); }
        for (const receipt of pending.values()) { clearTimeout(receipt.timer); receipt.no(fail('TERMINAL_OPERATION_UNCONFIRMED', 'Terminal disconnected before confirming its action')); }
        pending.clear();
        try { onFrame({ type: 'disconnected' }); } catch {}
      });
    });
  }
  return { pointer, request, connect, status: () => request('GET', '/status'),
    list: async () => (await request('GET', '/sessions')).sessions,
    create: input => request('POST', '/sessions', input),
    snapshot: (id, generation) => request('POST', `/sessions/${encodeURIComponent(id)}/snapshot`, { generation }),
    forget: (id, generation) => request('POST', `/sessions/${encodeURIComponent(id)}/forget`, { generation }),
    shutdown: () => request('POST', '/shutdown', {}) };
}

function readPointer(dir) {
  const raw = readPrivateTextFile(path.join(dir, 'runtime.json'), { maxBytes: 16384 });
  if (raw === null) return null;
  let pointer; try { pointer = JSON.parse(raw); } catch { throw fail('TERMINAL_STATE_INVALID', 'Terminal service pointer is invalid'); }
  if (pointer?.protocol !== 1 || !Number.isInteger(pointer.port) || pointer.port < 1 || pointer.port > 65535 ||
      !/^[a-f0-9]{64}$/.test(pointer.token || '') || typeof pointer.generation !== 'string' ||
      !Number.isInteger(pointer.identity?.pid) || typeof pointer.identity?.startToken !== 'string' ||
      typeof pointer.identity?.commandHash !== 'string') throw fail('TERMINAL_STATE_INVALID', 'Terminal service pointer is incomplete');
  return pointer;
}
async function ready(dir) {
  const pointer = readPointer(dir); if (!pointer) return null;
  const observed = inspectProcessIdentity(pointer.identity.pid);
  const state = observed.state === 'live' ? compareProcessIdentity(pointer.identity, observed.identity) : observed.state;
  if (state === 'dead') return null;
  if (state !== 'live') throw fail('TERMINAL_OWNER_UNKNOWN', 'Cannot confirm the previous terminal service identity');
  const client = terminalClient(pointer);
  const status = await client.request('GET', '/status', undefined, { timeoutMs: 2000 });
  if (status.protocol !== 1 || status.generation !== pointer.generation ||
      compareProcessIdentity(pointer.identity, status.identity) !== 'live') throw fail('TERMINAL_RESPONSE_INVALID', 'Terminal service identity does not match its private pointer');
  if (status.stopping) throw fail('TERMINAL_HOST_STOPPING', 'Terminal service is stopping');
  return client;
}
const starting = new Map();
export async function ensureTerminalHost() {
  if (process.platform !== 'win32') throw fail('WINDOWS_TERMINAL_UNAVAILABLE', 'This terminal backend requires Windows');
  const dir = ensurePrivateGlobalSubdirectory('terminals');
  const existing = await ready(dir); if (existing) return existing;
  if (starting.has(dir)) return starting.get(dir);
  const promise = launch(dir); starting.set(dir, promise);
  try { return await promise; } finally { starting.delete(dir); }
}
async function launch(dir) {
  const lock = acquireFileLock(path.join(dir, 'launcher-owner'), { createParent: false, timeoutMs: 15000 });
  let lease, log, child, childError;
  try {
    const existing = await ready(dir); if (existing) return existing;
    lease = captureDirectory(dir, { pin: true });
    log = openPrivateAppendResource(path.join(dir, 'runtime.log'));
    child = spawnWindowsServiceHost(process.execPath, [entry, '--state-dir', dir], { cwd: dir, lease, log });
    child.on('error', error => { childError = error; });
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (childError) throw childError;
      if (child.exitCode !== null) throw fail('TERMINAL_HOST_START_FAILED', 'Terminal service exited during startup; inspect its private runtime log');
      let current;
      try { current = await ready(dir); }
      catch (error) { if (error.code !== 'TERMINAL_HOST_OFFLINE') throw error; }
      if (current) {
        if (current.pointer.identity.pid !== child.pid || current.pointer.identity.startToken !== `win32:v1:${child.creationTime}`) {
          throw fail('TERMINAL_HOST_START_FAILED', 'Terminal startup receipt belongs to a different process');
        }
        child.detach(); child.unref(); child = null; return current;
      }
      await delay(50);
    }
    throw fail('TERMINAL_HOST_START_FAILED', 'Terminal service did not publish readiness before the deadline');
  } finally {
    try { if (child) await child.close({ timeoutMs: 5000 }); }
    finally { log?.close(); lease?.close(); lock.release(); }
  }
}
