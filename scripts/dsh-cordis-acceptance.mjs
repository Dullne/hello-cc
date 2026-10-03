import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { JsonRpcProcess } from '../lib/integrations/native/jsonrpc.mjs';
import { createDshEnvironment, ensureDshIntegration } from '../lib/integrations/dsh.mjs';
import { checkDshRuntime } from '../lib/integrations/dsh-cordis.mjs';
import { redactSecrets } from '../lib/shared/redact.mjs';

// Runs the published Harness, AgentLoop, tool policies and persistence. Default:
// a deterministic local Messages model. --run-live uses the original DeepSeek
// route from environment, without writing/copying credentials or user config.
const install = process.argv[2];
if (!install) throw new Error('Usage: node scripts/dsh-cordis-acceptance.mjs /isolated/dsh/install [--run-live] [--bundle]');
const live = process.argv.includes('--run-live');
const bundle = process.argv.includes('--bundle');
if (live && !process.env.DEEPSEEK_API_KEY) throw new Error('Live acceptance requires an existing DEEPSEEK_API_KEY');
const requireOfficial = createRequire(path.join(path.resolve(install), 'package.json'));
const binary = requireOfficial.resolve('@deepseek-ai/dsh/lib/bin.js');
checkDshRuntime(binary);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-dsh-cordis-acceptance-')));
const rootA = path.join(sandbox, 'project A'), rootB = path.join(sandbox, 'project B');
const home = path.join(sandbox, 'home');
for (const dir of [rootA, rootB, home]) fs.mkdirSync(dir, { mode: 0o700 });
const env = createDshEnvironment(process.env);
Object.assign(env, { HOME: home, DSH_HOME: path.join(home, 'dsh'), DSH_TELEMETRY_DISABLED: '1',
  PATH: path.dirname(process.execPath) + path.delimiter + (env.PATH || '') });
const marker = 'CORDIS_' + randomUUID().replaceAll('-', '').slice(0, 16);
const receipt = { startedAt: new Date().toISOString(), baseline: '0.2.0-rc.2', node: process.version,
  loading: bundle ? 'npm tarball installed into isolated ACP profile' : 'project overlay',
  validation: live ? 'original authenticated DeepSeek model' : 'deterministic local Messages model; real official Harness',
  sandbox, checks: [], cleanup: {}, sourceHashes: {} };
for (const name of ['lib/integrations/dsh-cordis.mjs', 'lib/integrations/dsh-collaboration.mjs',
  'lib/mcp/tools.mjs', 'lib/integrations/native/jsonrpc.mjs', 'scripts/dsh-cordis-acceptance.mjs']) {
  receipt.sourceHashes[name] = createHash('sha256').update(fs.readFileSync(path.join(repo, name))).digest('hex');
}
const output = path.join(sandbox, 'receipt.json');
function check(name, details = {}) { receipt.checks.push({ name, passed: true, ...details }); }
function read(root, sql, ...params) {
  const db = new DatabaseSync(path.join(root, '.hello-cc', 'mesh.db'));
  try { return db.prepare(sql).all(...params).map(row => ({ ...row })); } finally { db.close(); }
}
function hcc(root, args) {
  const result = spawnSync(process.execPath, [path.join(repo, 'bin/hcc.mjs'), '--root', root, '--json', ...args],
    { cwd: root, env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, redactSecrets(result.stderr + result.stdout));
  const value = JSON.parse(result.stdout); return value.data ?? value;
}
let rpc, server;
const modelRequests = [], notices = [], permissions = [];
let taskId, peerA;
let stage = 0;
function stream(res, model, block) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  event('message_start', { message: { id: 'msg-' + randomUUID(), type: 'message', role: 'assistant', model,
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
  event('content_block_start', { index: 0, content_block: block.type === 'tool_use' ? { ...block, input: {} } : block });
  if (block.type === 'tool_use') event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
  event('content_block_stop', { index: 0 });
  event('message_delta', { delta: { stop_reason: block.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
  event('message_stop', {}); res.end();
}
try {
  const setup = ensureDshIntegration({ root: rootA, cwd: rootA }, { mode: 'cordis' });
  const policy = path.join(sandbox, 'policy.mjs');
  fs.writeFileSync(policy, `export const inject = ['tools'];\nexport function apply(ctx) {\n  ctx.on('tools/pre-execute', async (exec, next) => {\n    if (exec.name === 'hcc_message_send' && exec.arguments.body === 'DENY_WRITE') return {kind:'deny',reason:'acceptance denies this write'};\n    if (exec.name === 'hcc_message_send' && exec.arguments.body === 'ASK_WRITE') return {kind:'ask',reason:'acceptance requires approval'};\n    return next();\n  });\n}\n`);
  const policyPatch = path.join(sandbox, 'policy.yml');
  fs.writeFileSync(policyPatch, `- insert:\n    - id: acceptance-policy\n      name: ${JSON.stringify(policy)}\n`);
  const argv = ['--profile', 'acp', ...(bundle ? [] : ['--patch', setup.patchPath]), '--patch', policyPatch];
  if (bundle) {
    const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', sandbox],
      { cwd: repo, env, encoding: 'utf8', timeout: 30000 });
    assert.equal(packed.status, 0, packed.stderr);
    const metadata = JSON.parse(packed.stdout)[0];
    assert.ok(metadata.files.some(file => file.path === 'lib/integrations/dsh.bundle.yml'));
    assert.ok(metadata.files.some(file => file.path === 'lib/integrations/dsh-cordis.d.ts'));
    const unpack = path.join(sandbox, 'installed'); fs.mkdirSync(unpack);
    const extracted = spawnSync('tar', ['-xzf', path.join(sandbox, metadata.filename), '-C', unpack],
      { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(extracted.status, 0, extracted.stderr);
    const profile = path.join(env.DSH_HOME, 'profiles', 'acp');
    const packageDirectory = path.join(profile, 'node_modules', '@logicseek');
    fs.mkdirSync(packageDirectory, { recursive: true, mode: 0o700 });
    fs.symlinkSync(path.join(unpack, 'package'), path.join(packageDirectory, 'hello-cc'));
    fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'isolated-cordis-profile', private: true,
      dependencies: { '@logicseek/hello-cc': 'file:' + path.join(unpack, 'package') },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app', '@logicseek/hello-cc'] } } }));
    fs.writeFileSync(path.join(profile, 'cordis.yml'), '[]\n');
    receipt.package = { filename: metadata.filename, shasum: metadata.shasum, fileCount: metadata.files.length };
  }

  if (!live) {
    server = http.createServer(async (req, res) => {
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        modelRequests.push(body);
        const serialized = JSON.stringify(body.messages);
        const primary = serialized.includes('RUN_COLLABORATION_A');
        const actions = [
          ['hcc_state', {}], ['hcc_task_next', {}], ['hcc_lock_acquire', { resource: 'cordis-proof.txt', task_id: taskId }],
          ['hcc_message_send', { to: 'acceptance-coordinator', body: marker, task_id: taskId }],
          ['hcc_handoff', { task_id: taskId, summary: marker, to: 'acceptance-coordinator', tests: ['official Harness tool round trip'] }],
          ['hcc_message_send', { to: 'acceptance-coordinator', body: 'DENY_WRITE' }],
          ['hcc_message_send', { to: 'acceptance-coordinator', body: 'ASK_WRITE' }]
        ];
        const action = primary ? actions[stage++] : null;
        if (action) {
          assert.ok(body.tools.some(tool => tool.name === action[0]), 'model must receive the registered collaboration tool');
          stream(res, body.model, { type: 'tool_use', id: 'tool-' + randomUUID(), name: action[0], input: action[1] });
        } else stream(res, body.model, { type: 'text', text: primary ? marker : 'B_SESSION_OK' });
      } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: { type: 'api_error', message: error.message } })); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    env.DEEPSEEK_API_KEY = 'isolated-local-model';
    env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  }
  rpc = new JsonRpcProcess({ binary, args: argv, cwd: rootA, env, timeoutMs: 180000,
    onNotification: (method, params) => { if (method === 'session/update') notices.push(params); },
    onRequest: (method, params) => {
      if (method !== 'session/request_permission') throw new Error(`Unexpected server request ${method}`);
      permissions.push({ method, requested: true });
      const rejected = params.options.find(option => option.kind === 'reject_once');
      return rejected ? { outcome: { outcome: 'selected', optionId: rejected.optionId } } : { outcome: { outcome: 'cancelled' } };
    }
  });
  await rpc.start();
  const initialized = await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'hello-cc-cordis-acceptance', version: '1.0.1' } });
  assert.equal(initialized.protocolVersion, 1);
  const a = await rpc.request('session/new', { cwd: rootA, mcpServers: [] });
  const b = await rpc.request('session/new', { cwd: rootB, mcpServers: [] });
  assert.notEqual(a.sessionId, b.sessionId);
  peerA = read(rootA, 'SELECT peer FROM peer_bindings WHERE provider_session_id=?', a.sessionId)[0].peer;
  const peerB = read(rootB, 'SELECT peer FROM peer_bindings WHERE provider_session_id=?', b.sessionId)[0].peer;
  check('two Agents in one official runtime have independent project, peer and raw session bindings', { peerA, peerB });
  hcc(rootA, ['register', '--peer', 'acceptance-coordinator', '--kind', 'shell']);
  hcc(rootA, ['task', 'create', '--from', 'acceptance-coordinator', '--title', marker]);
  taskId = read(rootA, 'SELECT id FROM tasks WHERE title=?', marker)[0].id;
  hcc(rootA, ['msg', 'send', '--from', 'acceptance-coordinator', '--to', peerA, '--body', 'INBOX_ONLY_FOR_A_' + marker]);
  const promptA = `RUN_COLLABORATION_A. This is an isolated acceptance task. Use hcc_state, then hcc_task_next to claim task #${taskId}. Acquire the lock cordis-proof.txt for that task using hcc_lock_acquire. Send the exact body ${marker} to acceptance-coordinator using hcc_message_send, with task_id ${taskId}. Record a hcc_handoff for that task to acceptance-coordinator, with summary ${marker}. Then call hcc_message_send once with body DENY_WRITE and once with body ASK_WRITE to acceptance-coordinator to test refusal handling. Respect both refusals; do not retry or bypass them. Finally reply only ${marker}. Do not use Bash, files, other tools or delegate.`;
  const completed = await rpc.request('session/prompt', { sessionId: a.sessionId, prompt: [{ type: 'text', text: promptA }] }, { timeoutMs: 180000 });
  assert.equal(completed.stopReason, 'end_turn');
  const task = read(rootA, 'SELECT * FROM tasks WHERE id=?', taskId)[0];
  assert.equal(task.owner, peerA);
  const locks = read(rootA, 'SELECT owner, task_id FROM locks WHERE resource=? OR base_resource=?', 'cordis-proof.txt', 'cordis-proof.txt');
  assert.ok(locks.length, 'The model must acquire the requested resource, including a scoped lock key');
  assert.equal(locks[0].owner, peerA);
  assert.equal(locks[0].task_id, taskId);
  assert.equal(read(rootA, 'SELECT sender FROM messages WHERE body=?', marker)[0].sender, peerA);
  assert.ok(read(rootA, 'SELECT * FROM handoffs WHERE task_id=?', taskId).length);
  check('model commits task claim, scoped lock, peer message and handoff through shared collaboration services', { taskId });
  assert.equal(read(rootA, "SELECT * FROM messages WHERE body IN ('DENY_WRITE', 'ASK_WRITE')").length, 0);
  assert.ok(permissions.length >= 1, 'ask must reach the ACP permission handler');
  check('deny and ask policy remain effective, rejected writes do not execute', { permissionRequests: permissions.length });
  assert.ok(read(rootA, 'SELECT * FROM message_reads WHERE peer=?', peerA).length);
  assert.equal(read(rootB, 'SELECT * FROM messages').length, 0);
  const promptB = 'RUN_SESSION_B. Use hcc_state to read your own project. Do not use any other tools. Reply only B_SESSION_OK.';
  await rpc.request('session/prompt', { sessionId: b.sessionId, prompt: [{ type: 'text', text: promptB }] }, { timeoutMs: 180000 });
  check('committed context ACKs only its Agent inbox; other project remains isolated');
  if (!live) {
    assert.match(JSON.stringify(modelRequests[0].messages), new RegExp('INBOX_ONLY_FOR_A_' + marker));
    const requestsB = modelRequests.filter(body => JSON.stringify(body.messages).includes('RUN_SESSION_B'));
    assert.ok(requestsB.length);
    for (const body of requestsB) assert.doesNotMatch(JSON.stringify(body.messages), new RegExp(marker));
    check('actual first model request contains awaited collaboration context, foreign Agent context never appears');
  }
  await rpc.request('session/close', { sessionId: a.sessionId });
  assert.equal(read(rootA, 'SELECT status FROM peers WHERE id=?', peerA)[0].status, 'exited');
  assert.equal(read(rootB, 'SELECT status FROM peers WHERE id=?', peerB)[0].status, 'idle');
  await rpc.request('session/prompt', { sessionId: b.sessionId, prompt: [{ type: 'text', text: promptB }] }, { timeoutMs: 180000 });
  check('closing one Agent preserves the live sibling and marks only its own peer exited');
  await rpc.request('session/resume', { sessionId: a.sessionId, cwd: rootA, mcpServers: [] });
  assert.equal(read(rootA, 'SELECT provider_session_id FROM peer_bindings WHERE peer=?', peerA)[0].provider_session_id, a.sessionId);
  check('resume re-establishes the original raw session and peer without duplicate live ownership');
  await rpc.request('session/close', { sessionId: a.sessionId });
  await rpc.request('session/close', { sessionId: b.sessionId });
  receipt.passed = true;
} catch (error) {
  receipt.passed = false;
  receipt.error = { name: error.name, message: redactSecrets(error.message) };
  process.exitCode = 1;
} finally {
  try { await rpc?.close(); receipt.cleanup.ownedRuntimeStopped = true; } catch { receipt.cleanup.ownedRuntimeStopped = false; process.exitCode = 1; }
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  receipt.cleanup.localModelStopped = !server?.listening;
  receipt.modelRequests = live ? null : modelRequests.length;
  receipt.permissionRequests = permissions.length;
  receipt.updateKinds = [...new Set(notices.map(value => value.update?.sessionUpdate).filter(Boolean))];
  receipt.completedAt = new Date().toISOString();
  fs.writeFileSync(output, JSON.stringify(redactSecrets(receipt), null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ receipt: output, ...redactSecrets(receipt) }, null, 2));
}
