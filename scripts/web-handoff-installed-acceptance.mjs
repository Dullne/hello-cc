// Installed Codex protocol and scoped MCP discovery. No model turn, account
// configuration, or existing task is touched; every file belongs to this run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { initSchema } from '../lib/db/schema.mjs';
import { createEventHelpers } from '../lib/db/events.mjs';
import { createPeerHelpers } from '../lib/core/peers/peer-helpers.mjs';
import { createPeerBindingStore } from '../lib/db/stores/peers.mjs';
import { createCodexSessions } from '../lib/web/codex-sessions.mjs';
import { createCodexAppServer } from '../lib/web/codex-app-server.mjs';
import { createScopedMcpConfig } from '../lib/mcp/scope.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-installed-mcp-'));
const root = path.join(directory, 'project'), codexHome = path.join(directory, 'codex-home');
fs.mkdirSync(root); fs.mkdirSync(codexHome);
const ctx = { root, dbPath: path.join(root, 'mesh.db') };
const connect = () => new DatabaseSync(ctx.dbPath);
const db = connect(); initSchema(db); db.close();
const now = () => Math.floor(Date.now() / 1000);
const events = createEventHelpers({ now }), peers = createPeerHelpers({ now, ...events });
const bindings = createPeerBindingStore({ now, ...events });
const sessions = new Map();
let child;
const manager = createCodexSessions({ sessions, sessionKey: (context, id) => context.root + '\0' + id,
  nextProjectSessionId: () => 'installed-mcp-qa', connectWebProject: connect,
  ...peers, ...bindings, ...events, now, observePeerEvidence: () => ({ state: 'dead' }),
  broadcast() {}, closeSessionClients() {},
  mcpConfigFactory: options => createScopedMcpConfig({ ...options,
    cliPath: fileURLToPath(new URL('../bin/hcc.mjs', import.meta.url)) }),
  adapterFactory: options => createCodexAppServer({ ...options,
    env: { ...options.env, CODEX_HOME: codexHome, HCC_SHIM_NO_ATTACH: '1' },
    spawnProcess: (...args) => { child = spawn(...args); return child; }, requestTimeoutMs: 10000 }) });

let requestSequence = 0;
function rpc(method, params) {
  const requestId = 'qa-protocol-' + ++requestSequence;
  return new Promise((resolve, reject) => {
    let buffer = '';
    const cleanup = () => { clearTimeout(timer); child.stdout.off('data', onData); child.off('exit', onExit); };
    const onExit = () => { cleanup(); reject(new Error('Installed App Server exited before MCP discovery')); };
    const onData = data => {
      buffer += data;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let frame; try { frame = JSON.parse(line); } catch { continue; }
        if (frame.id === requestId) { cleanup(); resolve(frame); }
      }
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Scoped MCP discovery timed out')); }, 15000);
    child.stdout.on('data', onData); child.once('exit', onExit);
    child.stdin.write(JSON.stringify({ id: requestId, method, params }) + '\n');
  });
}

try {
  const session = await manager.startCodexSession({ kind: 'codex', projectCtx: ctx });
  let server;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const frame = await rpc('mcpServerStatus/list', { threadId: session.binding.provider_session_id,
      serverName: 'hello_cc_scoped', limit: 20 });
    assert.equal(frame.error, undefined, frame.error?.message);
    server = (frame.result?.data || []).find(entry => entry.name === 'hello_cc_scoped');
    if (Object.keys(server?.tools || {}).length) break;
    await delay(250);
  }
  const evidence = { isolatedHome: true, inferenceCalled: false, initialize: 'passed', threadStart: 'passed',
    userAgent: session.adapter.snapshot().metadata?.userAgent || null,
    mcpConfigured: Boolean(session.mcpCapability), serverDiscovered: Boolean(server),
    toolCount: Object.keys(server?.tools || {}).length, serverFields: Object.keys(server || {}),
    startupStatus: server?.startupStatus || server?.status || null, authStatus: server?.authStatus || null,
    serverError: server?.error || server?.startupError || null,
    mcpNotifications: session.adapter.snapshot().events.filter(event => /mcp/i.test(event.method)).map(event => ({ method: event.method,
      status: event.params.status || null,
      error: String(event.params.error || '').split(session.mcpCapability.config.env.HCC_MCP_BOOTSTRAP_TOKEN).join('[redacted]') })) };
  assert.equal(evidence.serverDiscovered, true, 'Installed Codex did not discover its thread-scoped MCP server');
  assert.equal(evidence.toolCount, 10, 'Installed Codex did not discover all scoped tools');
  const result = await rpc('mcpServer/tool/call', { threadId: session.binding.provider_session_id,
    server: 'hello_cc_scoped', tool: 'hcc_state', arguments: {} });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.result.isError, false, 'Installed Codex could not execute a scoped coordination read');
  assert.equal(result.result.structuredContent.ok, true);
  assert.equal(result.result.structuredContent.peer, session.peerId);
  evidence.mcpBusinessRead = 'passed';
  console.log(JSON.stringify(evidence));
  const history = await manager.listCodexThreads(ctx, { limit: 5 });
  assert.ok(Array.isArray(history.threads));
  console.log('INSTALLED_PROTOCOL_MCP_OK');
} finally {
  for (const session of sessions.values()) { await session.adapter?.close(); session.mcpCapability?.dispose(); }
  fs.rmSync(directory, { recursive: true, force: true });
}
