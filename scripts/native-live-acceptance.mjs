import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createEventHelpers } from '../lib/db/events.mjs';
import { createConnectionHelpers } from '../lib/db/connection.mjs';
import { createPeerBindingStore } from '../lib/db/stores/peers.mjs';
import { createPeerHelpers } from '../lib/core/peers/peer-helpers.mjs';
import { createMessageStore } from '../lib/core/coordination/messages.mjs';
import { createEvidenceRuntime } from '../lib/core/peers/evidence-runtime.mjs';
import { detectBranch } from '../lib/runtime/project-context.mjs';
import { createCodexAdapter } from '../lib/integrations/native/codex.mjs';
import { JsonRpcProcess } from '../lib/integrations/native/jsonrpc.mjs';
import { createDshAcpAdapter } from '../lib/integrations/native/dsh-acp.mjs';
import { createClaudeAdapter } from '../lib/integrations/native/claude.mjs';
import { createNativeSessions } from '../lib/web/native-sessions.mjs';
import { startNativeService } from '../lib/runtime/native/service.mjs';
import { nativeRequest } from '../lib/runtime/native/client.mjs';
import { readNativePointer } from '../lib/runtime/native/store.mjs';
import { redactSecrets } from '../lib/shared/redact.mjs';

// Opt-in only: uses the caller's existing authentication for small real model
// turns. Every provider session and HCC database is created in a fresh sandbox.
// No existing session is resumed or interrupted. No packages are installed.
const args = process.argv.slice(2);
function option(name, fallback) { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; }
if (!args.includes('--run-live')) {
  console.log('Usage: node scripts/native-live-acceptance.mjs --run-live [--provider codex|claude|dsh|all] [--codex-bin PATH] [--dsh-bin PATH] [--claude-sdk PATH] [--output PATH] [--permission-probe] [--cross-provider] [--communication-only]');
  process.exit(0);
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function sourceHashes(dir = path.join(repo, 'lib')) {
  return Object.fromEntries(fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? Object.entries(sourceHashes(file)) : entry.name.endsWith('.mjs')
      ? [[path.relative(repo, file), createHash('sha256').update(fs.readFileSync(file)).digest('hex')]] : [];
  }));
}
const initialSources = sourceHashes();
const providers = option('--provider', 'codex') === 'all' ? ['codex', 'claude', 'dsh'] : [option('--provider', 'codex')];
assert.ok(providers.every((p) => ['codex', 'claude', 'dsh'].includes(p)), 'unknown provider');
assert.ok(!(args.includes('--cross-provider') || args.includes('--communication-only')) || providers.length >= 2, 'cross-provider acceptance requires --provider all');
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-native-live-')));
fs.chmodSync(sandbox, 0o700);
const root = path.join(sandbox, 'project');
fs.mkdirSync(root, { mode: 0o700 });
const ctx = { root, cwd: root, dbPath: path.join(root, '.hello-cc', 'mesh.db') };
const report = { startedAt: new Date().toISOString(), node: process.version, scope: 'isolated real authenticated native runtime and shared HCC bus',
  sandbox, authentication: 'caller provider route, private temporary provider state', defaultClaudeSdkInstalled: null,
  sourceFiles: initialSources,
  providers: {}, checks: [], limitations: [], cleanup: {} };
const output = path.resolve(option('--output', path.join(sandbox, 'receipt.json')));
const credentials = [];
const observations = new Map();
let service;
let inspect;
function check(name, details = {}) { report.checks.push({ name, passed: true, ...details }); console.log(JSON.stringify({ check: name, ...details })); }
function flush() { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(redactSecrets(report), null, 2) + '\n', { mode: 0o600 }); }
function privateDir(name) { const dir = path.join(sandbox, name); fs.mkdirSync(dir, { mode: 0o700 }); credentials.push(dir); return dir; }
function isolatedCodexHome() {
  const source = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const dir = privateDir('codex-home');
  const file = path.join(source, 'config.toml');
  if (fs.existsSync(file)) {
    // Preserve model/provider routing, discard user tools, plugins, hooks,
    // project trust records and UI settings. Credentials are never printed.
    let section = '';
    const config = fs.readFileSync(file, 'utf8').split('\n').filter((line) => {
      const header = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/);
      if (header) section = header[1].split('.')[0].replaceAll('"', '').replaceAll("'", '');
      if (section) return section === 'model_providers';
      return /^\s*(?:model(?:_provider|_reasoning_effort|_reasoning_summary|_verbosity|_catalog_json)?|cli_auth_credentials_store)\s*=/.test(line);
    }).join('\n');
    fs.writeFileSync(path.join(dir, 'config.toml'), config + '\n', { mode: 0o600 });
  }
  if (fs.existsSync(path.join(source, 'auth.json'))) {
    fs.copyFileSync(path.join(source, 'auth.json'), path.join(dir, 'auth.json'));
    fs.chmodSync(path.join(dir, 'auth.json'), 0o600);
  }
  return dir;
}
const now = () => Math.floor(Date.now() / 1000);
const events = createEventHelpers({ now });
const bindings = createPeerBindingStore({ now, ...events });
const evidence = createEvidenceRuntime({ now });
const peers = createPeerHelpers({ now, ...events, ...evidence, detectBranch });
const messages = createMessageStore({ now, ...events });
const connections = createConnectionHelpers({ now, ...bindings, redactedLogText: (s) => redactSecrets(s) });
const deps = { ...connections, ...events, ...bindings, ...peers, ...messages, ...evidence, detectBranch };
const homes = {};
const api = (method, route, body = null) => nativeRequest(ctx, method, route, body, { timeoutMs: 45000 });
const terminal = new Set(['completed', 'failed', 'uncertain']);
async function until(fn, timeoutMs = 120000, description = 'provider outcome') {
  const end = Date.now() + timeoutMs;
  let notice = Date.now() + 20000;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= notice) { console.log(JSON.stringify({ waiting: description })); notice += 20000; }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}
async function delivery(peer, id) { return (await api('GET', `/deliveries?peer=${encodeURIComponent(peer)}`)).find((row) => row.message_id === id); }
async function send(peer, body, from = 'acceptance-observer') {
  return api('POST', '/send', { peer, from, body, submissionId: randomUUID() });
}
async function finish(peer, sent) {
  const row = await until(async () => { const row = await delivery(peer, sent.message_id); return terminal.has(row?.state) ? row : null; }, 120000, `${peer} message ${sent.message_id}`);
  assert.equal(row.state, 'completed', JSON.stringify({ state: row.state, evidence: row.evidence }));
  const reply = inspect.prepare("SELECT * FROM messages WHERE reply_to=? AND kind='reply'").get(sent.message_id);
  assert.ok(reply, 'successful ask must write a reply');
  assert.equal(reply.thread_id, sent.message_id, 'reply must retain the original thread');
  assert.ok(inspect.prepare('SELECT read_at FROM message_reads WHERE peer=? AND message_id=?').get(peer, sent.message_id), 'completion must ACK');
  return { row, reply };
}
async function runProvider(provider) {
  const peer = `accept-${provider}`;
  report.providers[provider] = { status: 'running', prompts: 0, route: 'original authenticated provider', observations: [],
    approvalDenial: { requested: args.includes('--permission-probe'), exercised: false } };
  const result = report.providers[provider];
  try {
    const binary = provider === 'codex' ? option('--codex-bin', 'codex') : provider === 'dsh' ? option('--dsh-bin', 'dsh') : undefined;
    const started = await api('POST', '/workers', { peer, provider, ...(binary ? { binary } : {}) });
    if (provider !== 'claude') {
      const env = { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}`, ...(provider === 'dsh' ? { DSH_HOME: homes.dsh } : { CODEX_HOME: homes.codex }) };
      result.version = execFileSync(binary, ['--version'], { env, encoding: 'utf8', timeout: 10000 }).trim();
    }
    result.capabilities = started.capabilities;
    result.sessionId = started.sessionId;
    result.observations.push({ opened: true, sessionIdInitiallyPresent: Boolean(started.sessionId) });
    if (args.includes('--communication-only')) { result.status = 'ready'; result.lifecycleChecks = 'not exercised'; return; }
    const marker = `HCC_MEMORY_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const body = `This is a native communication acceptance test. Remember this nonce in this conversation: ${marker}. Reply with only ${marker}. Do not use any tools, run commands, read files, delegate tasks, or modify files.`;
    const first = await send(peer, body);
    result.prompts++;
    const duplicate = await api('POST', '/send', { peer, from: 'acceptance-observer', body, submissionId: first.submission_id });
    assert.equal(duplicate.message_id, first.message_id);
    const finished = await finish(peer, first);
    assert.equal(finished.reply.body.trim(), marker);
    check(`${provider}: real turn, correlated reply, ACK, idempotent queue`, { messageId: first.message_id, turnId: finished.row.turn_id });
    const state = await api('GET', `/workers/${peer}/state`);
    result.sessionId = state.snapshot.sessionId;
    assert.ok(result.sessionId);
    const second = await send(peer, 'Without using tools or reading files, return only the nonce you were asked to remember earlier.');
    result.prompts++;
    assert.equal((await finish(peer, second)).reply.body.trim(), marker);
    check(`${provider}: persistent session retains previous turn`);
    await api('POST', '/close', { peer });
    const resumed = await api('POST', '/workers', { peer, provider, ...(binary ? { binary } : {}), resume: 'last' });
    if (resumed.sessionId) assert.equal(resumed.sessionId, result.sessionId);
    const third = await send(peer, 'This is after reconnecting your saved session. Without using tools or reading files, return only the nonce from the earlier conversation.');
    result.prompts++;
    assert.equal((await finish(peer, third)).reply.body.trim(), marker);
    assert.equal((await api('GET', `/workers/${peer}/state`)).snapshot.sessionId, result.sessionId);
    check(`${provider}: owned close/resume preserves identity and history`);
    const index = observations.get(peer)?.length || 0;
    const long = await send(peer, 'Do not use any tools. Immediately begin writing the numbers 1 through 100000, one per line, with no commentary. Keep writing until all numbers are emitted.');
    result.prompts++;
    if (provider === 'dsh') {
      // ACP implementations may buffer model output until the turn ends.
      // Interrupt an admitted running request rather than requiring a delta.
      await until(async () => { const s = await api('GET', `/workers/${peer}/state`); return s.active_delivery?.message_id === long.message_id && s.snapshot.status === 'running'; }, 30000, 'DSH running ACP request');
      await delay(500);
    } else await until(() => observations.get(peer)?.slice(index).some((event) => ['delta', 'output'].includes(event.type) && event.text), 120000, `${provider} active streamed output`);
    const active = await api('GET', `/workers/${peer}/state`);
    assert.ok(active.active_delivery, 'interrupt requires a genuinely active delivery');
    const interrupted = await api('POST', '/interrupt', { peer, turnId: active.snapshot.turnId });
    const interruptedDelivery = await until(async () => { const row = await delivery(peer, long.message_id); return terminal.has(row?.state) ? row : null; }, 45000, `${provider} terminal interruption`);
    assert.equal(interruptedDelivery.state, 'failed', 'interrupted work must not be marked successful');
    assert.equal(inspect.prepare('SELECT COUNT(*) AS n FROM message_reads WHERE peer=? AND message_id=?').get(peer, long.message_id).n, 0);
    assert.equal(inspect.prepare('SELECT COUNT(*) AS n FROM messages WHERE reply_to=?').get(long.message_id).n, 0);
    check(`${provider}: active interruption has terminal evidence, no reply/ACK`, { requestStatus: interrupted.status, terminalState: interruptedDelivery.state });
    if (args.includes('--permission-probe') && provider === 'codex') {
      // Codex workspace-write normally permits the OS temporary directory.
      // Use a fresh test-owned HOME subdirectory to actually cross the sandbox.
      const boundary = fs.mkdtempSync(path.join(os.homedir(), '.hcc-native-live-permission-'));
      fs.chmodSync(boundary, 0o700);
      credentials.push(boundary);
      const target = path.join(boundary, 'proof.txt');
      const startIndex = observations.get(peer).length;
      const permission = await send(peer, `Permission boundary acceptance test: use the command tool with sandbox_permissions=require_escalated to write the word PROOF to this absolute path outside your workspace: ${target}. Request approval for the write if sandbox restrictions require it. If permission is denied, stop and say DENIED; do not retry with another tool or technique. Do not read any other files.`);
      result.prompts++;
      const request = await until(async () => {
        const state = await api('GET', `/workers/${peer}/state`);
        const request = state.snapshot.pendingApprovals?.[0];
        return request || observations.get(peer).slice(startIndex).find((event) => event.type === 'approval' && event.decision === 'decline');
      }, 45000, 'real permission request');
      if (request.status === 'pending') {
        await api('POST', '/respond', { peer, executorId: request.executorId, sessionId: request.sessionId, turnId: request.turnId, requestId: request.requestId, decision: 'decline' });
        check(`${provider}: pending real approval explicitly declined`, { method: request.method });
      }
      await finish(peer, permission);
      assert.ok(observations.get(peer).slice(startIndex).some((event) => event.type === 'approval.resolved' && event.reason === 'answered' || event.type === 'approval' && event.decision === 'decline'), 'provider must actually request approval and receive denial');
      assert.equal(fs.existsSync(target), false, 'denied write must not create the target');
      result.approvalDenial.exercised = true;
      check(`${provider}: real approval request denied and outside write absent`);
    }
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed';
    result.error = { code: error.code || 'ACCEPTANCE_FAILED', message: error.message };
    const observed = observations.get(peer) || [];
    result.observations.push(...observed.filter((event) => ['error', 'completed', 'approval', 'permission'].includes(event.type)).slice(-12));
    console.log(JSON.stringify(redactSecrets({ provider, failure: result.error })));
  } finally {
    try { if (result.status !== 'ready') { await api('POST', '/close', { peer }); result.closed = true; } }
    catch (error) { result.closed = false; result.closeError = { code: error.code, message: error.message }; }
    flush();
  }
}
async function runCommunications() {
  const selected = providers.filter((provider) => ['passed', 'ready'].includes(report.providers[provider].status));
  if (selected.length < 2) { report.limitations.push('Cross-provider test requires at least two successfully authenticated providers.'); return; }
  const sessions = new Map();
  const bridge = createNativeSessions({ sessions, sessionKey: (project, peer) => `${project.root}:${peer}`,
    connectWebProject: (project) => deps.connect(project, { migrateRegistered: false }) });
  report.communications = { status: 'running', pairs: [] };
  try {
    const alreadyOpen = (await api('GET', '/status')).workers.filter((worker) => worker.owned).map((worker) => worker.peer);
    for (const provider of selected) {
      if (alreadyOpen.includes(`accept-${provider}`)) continue;
      const binary = provider === 'codex' ? option('--codex-bin', 'codex') : provider === 'dsh' ? option('--dsh-bin', 'dsh') : undefined;
      await api('POST', '/workers', { peer: `accept-${provider}`, provider, ...(binary ? { binary } : {}), resume: 'last' });
    }
    const before = inspect.prepare('SELECT * FROM peer_bindings ORDER BY peer').all();
    const views = await bridge.discoverNativeSessions(ctx);
    assert.equal(views.length, selected.length);
    assert.deepEqual(inspect.prepare('SELECT * FROM peer_bindings ORDER BY peer').all(), before);
    check('Web: discovers real native workers and preserves their provider binding');
    for (let index = 0; index < selected.length; index++) {
      const fromProvider = selected[index], toProvider = selected[(index + 1) % selected.length];
      const from = `accept-${fromProvider}`, to = `accept-${toProvider}`;
      const marker = `HCC_CROSS_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
      const body = `Native cross-provider test. Return only ${marker}. Do not use tools, read files, delegate, or change files.`;
      const input = { to, kind: 'ask', body };
      const session = sessions.get(`${root}:${from}`);
      const sent = await bridge.nativeAction(session, 'send', { submissionId: randomUUID(), text:
        `Use only the hello_cc_scoped MCP hcc_message_send tool exactly once with these JSON arguments: ${JSON.stringify(input)}. Do not send by shell or any other transport. Do not manually read or ACK inbox messages. After the tool succeeds, return only SENT. No other tools or file changes.` });
      report.providers[fromProvider].prompts++;
      await until(async () => {
        const state = await api('GET', `/workers/${from}/state`);
        for (const request of state.snapshot.pendingApprovals || []) {
          const args = request.params?.input || request.params?._meta?.tool_params || request.params?.toolCall?.rawInput;
          const name = request.params?.tool || request.params?.message || request.params?.toolCall?.title || '';
          const safe = String(name).includes('hcc_message_send') && args?.to === to && args?.body === body && args?.kind === 'ask';
          await api('POST', '/respond', { peer: from, executorId: request.executorId, sessionId: request.sessionId,
            turnId: request.turnId, requestId: request.requestId, decision: safe ? 'accept' : 'decline' });
          assert.ok(safe, 'acceptance harness only grants the exact scoped test-message operation');
        }
        const row = await delivery(from, sent.message_id);
        return terminal.has(row?.state) ? row : null;
      }, 120000, `${fromProvider} scoped MCP send to ${toProvider}`);
      const source = await finish(from, sent);
      report.communications.lastSource = { fromProvider, response: source.reply.body,
        observed: (observations.get(from) || []).slice(-25).filter((event) => !['delta', 'output'].includes(event.type)) };
      const request = inspect.prepare('SELECT * FROM messages WHERE sender=? AND recipient=? AND body=?').get(from, to, body);
      assert.ok(request, 'actual model MCP call must write the intended message as its own peer');
      const reply = await finish(to, { message_id: request.id });
      report.providers[toProvider].prompts++;
      assert.equal(reply.reply.body.trim(), marker);
      const receipt = await until(async () => { const row = await delivery(from, reply.reply.id); return terminal.has(row?.state) ? row : null; }, 120000, `${fromProvider} receives ${toProvider} reply`);
      assert.equal(receipt.state, 'completed');
      report.providers[fromProvider].prompts++;
      assert.ok(inspect.prepare('SELECT read_at FROM message_reads WHERE peer=? AND message_id=?').get(from, reply.reply.id));
      await delay(500);
      assert.equal(inspect.prepare('SELECT COUNT(*) AS n FROM messages WHERE reply_to=?').get(reply.reply.id).n, 0);
      report.communications.pairs.push({ fromProvider, toProvider, sentByModel: true, requestId: request.id,
        replyId: reply.reply.id, replyConsumed: true, noReplyLoop: true });
      check(`${fromProvider} -> ${toProvider}: actual scoped MCP send, model reply, reply consumption, no loop`,
        { requestId: request.id, replyId: reply.reply.id });
    }
    bridge.closeNativeBridge();
    const status = await api('GET', '/status');
    assert.equal(status.workers.filter((worker) => worker.owned).length, selected.length);
    check('Web: closing the bridge preserves live native workers');
    report.communications.status = 'passed';
    for (const provider of selected) if (report.providers[provider].status === 'ready') report.providers[provider].status = 'passed';
  } catch (error) {
    report.communications.status = 'failed';
    report.communications.error = { code: error.code || 'ACCEPTANCE_FAILED', message: error.message };
    console.log(JSON.stringify({ communicationsFailure: report.communications.error }));
  } finally {
    bridge.closeNativeBridge();
    for (const provider of selected) await api('POST', '/close', { peer: `accept-${provider}` }).catch(() => {});
  }
}

try {
  if (providers.includes('codex')) homes.codex = isolatedCodexHome();
  if (providers.includes('claude')) homes.claude = privateDir('claude-home');
  if (providers.includes('dsh')) homes.dsh = privateDir('dsh-home');
  inspect = deps.connect(ctx, { migrateRegistered: false });
  service = await startNativeService(ctx, deps, { adapterFactory: async (provider, options) => {
    const peer = options.env.HCC_PEER;
    const prior = options.onEvent;
    const env = { ...options.env, PATH: `${path.dirname(process.execPath)}:${options.env.PATH || ''}`,
      ...(provider === 'codex' ? { CODEX_HOME: homes.codex } : {}),
      ...(provider === 'claude' ? { CLAUDE_CONFIG_DIR: homes.claude } : {}),
      ...(provider === 'dsh' ? { DSH_HOME: homes.dsh, DSH_TELEMETRY_DISABLED: '1' } : {}) };
    const liveOptions = { ...options, env, timeoutMs: 30000, onEvent: (event) => {
      // Keep streaming evidence bounded. Store only acceptance test text.
      const list = observations.get(peer) || [];
      list.push(redactSecrets(event));
      if (list.length > 1500) list.shift();
      observations.set(peer, list);
      prior(event);
    } };
    if (provider === 'claude' && option('--claude-sdk')) {
      const sdkPath = path.resolve(option('--claude-sdk'));
      const sdk = await import(pathToFileURL(sdkPath));
      const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(sdkPath), 'package.json'), 'utf8'));
      report.providers.claude.sdk = { version: pkg.version, executableSource: 'SDK default bundled CLI', entry: sdkPath, sha256: createHash('sha256').update(fs.readFileSync(sdkPath)).digest('hex'), dependencyResolution: 'explicit external SDK entry injection' };
      return createClaudeAdapter({ ...liveOptions, query: sdk.query });
    }
    if (provider === 'claude') {
      const adapter = createClaudeAdapter(liveOptions);
      const open = adapter.open;
      adapter.open = async (input) => {
        try { const result = await open(input); report.defaultClaudeSdkInstalled = true; return result; }
        catch (error) { if (error.code === 'NATIVE_SDK_MISSING') report.defaultClaudeSdkInstalled = false; throw error; }
      };
      return adapter;
    }
    if (provider === 'codex') return createCodexAdapter({ ...liveOptions, rpcFactory: (config) => new JsonRpcProcess({ ...config,
      onRequest: (method, params, requestId) => {
        const list = observations.get(peer) || [];
        list.push(redactSecrets({ type: 'protocol.request', method, requestId, params }));
        observations.set(peer, list);
        return config.onRequest(method, params, requestId);
      },
      onNotification: (method, params) => {
        if (params?.item?.type === 'mcpToolCall' || method.startsWith('mcp')) {
          const list = observations.get(peer) || [];
          list.push(redactSecrets({ type: 'protocol.mcp', method, item: params.item || params }));
          observations.set(peer, list);
        }
        config.onNotification(method, params);
      } }) });
    return createDshAcpAdapter(liveOptions);
  } });
  for (const provider of providers) await runProvider(provider);
  if (args.includes('--cross-provider') || args.includes('--communication-only')) await runCommunications();
  report.limitations.push('The acceptance harness calls the same native service/adapters with an isolated environment factory; this does not prove CLI default dependency resolution or packaged distribution.');
  report.limitations.push('No existing TUI/Desktop session, published build or business task acceptance was exercised.');
  const unprobed = providers.filter(provider => !report.providers[provider]?.approvalDenial?.exercised);
  if (unprobed.length) report.limitations.push(`Real command/file approval denial was not exercised for ${unprobed.join(', ')}; any MCP tool confirmation is recorded separately. This script supports --permission-probe only for Codex; installed dsh approval denial is covered by dsh-installed-acceptance.mjs --run-live.`);
} catch (error) {
  report.fatalError = { code: error.code || 'ACCEPTANCE_FAILED', message: error.message };
} finally {
  try { await service?.shutdown(); report.cleanup.runtimeStopped = !readNativePointer(ctx); }
  catch (error) { report.cleanup.runtimeStopped = false; report.cleanup.error = { code: error.code, message: error.message }; }
  inspect?.close();
  // Remove only the test-owned credential/config copies, even after failures.
  for (const dir of credentials) fs.rmSync(dir, { recursive: true, force: true });
  report.cleanup.temporaryCredentialsRemoved = true;
  const finalSources = sourceHashes();
  report.sourceChangesDuringRun = Object.keys({ ...initialSources, ...finalSources }).filter((file) => initialSources[file] !== finalSources[file]);
  report.sourceUnchangedDuringRun = report.sourceChangesDuringRun.length === 0;
  report.sourceFiles = Object.fromEntries(Object.entries(initialSources).sort(([a], [b]) => a.localeCompare(b)));
  report.completedAt = new Date().toISOString();
  flush();
}
console.log(JSON.stringify({ receipt: output, providers: Object.fromEntries(Object.entries(report.providers).map(([p, r]) => [p, r.status])), cleanup: report.cleanup }));
process.exitCode = report.fatalError || report.communications?.status === 'failed' || !report.sourceUnchangedDuringRun || Object.values(report.providers).some((p) => p.status !== 'passed') || !report.cleanup.runtimeStopped ? 1 : 0;
