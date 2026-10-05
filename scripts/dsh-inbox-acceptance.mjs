// Exercises the production Cordis plugin in the pinned official Agent runtime.
// ACP only creates/disposes test Agents: no session/prompt is ever submitted.
// All model responses come from a deterministic localhost fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { checkDshRuntime } from '../lib/integrations/dsh-cordis.mjs';
import { JsonRpcProcess } from '../lib/integrations/native/jsonrpc.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/dsh-inbox-acceptance.mjs --dsh-install DIRECTORY [--output FILE]');
  process.exit(0);
}
const options = {};
for (let i = 0; i < args.length; i += 2) {
  assert.ok(['--dsh-install', '--output'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--'), 'Invalid acceptance arguments');
  assert.equal(options[args[i]], undefined, 'Duplicate acceptance option');
  options[args[i]] = args[i + 1];
}
assert.ok(options['--dsh-install'], 'An existing official DSH installation is required');
const requireOfficial = createRequire(path.join(path.resolve(options['--dsh-install']), 'package.json'));
const officialBinary = requireOfficial.resolve('@deepseek-ai/dsh/lib/bin.js');
checkDshRuntime(officialBinary);
const repo = fileURLToPath(new URL('..', import.meta.url));
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-dsh-inbox-')));
const home = path.join(sandbox, 'home');
const roots = ['project A', 'project B', 'denied'].map(name => path.join(sandbox, name));
for (const directory of [home, ...roots]) fs.mkdirSync(directory, { mode: 0o700 });
const env = { PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '/usr/bin:/bin'),
  HOME: home, DSH_HOME: path.join(home, 'dsh'), TMPDIR: sandbox, LANG: 'C.UTF-8', SHELL: '/bin/sh',
  DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: 'local-fixture-no-credential' };
const output = path.resolve(options['--output'] || path.join(sandbox, 'receipt.json'));
const marker = 'IDLE_' + randomUUID().replaceAll('-', '');
const traceFile = path.join(sandbox, 'events.jsonl');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sources = ['lib/integrations/dsh-cordis.mjs', 'lib/integrations/dsh-inbox.mjs',
  'lib/integrations/dsh-collaboration.mjs', 'lib/core/coordination/messages.mjs',
  'lib/coordination-state.mjs', 'scripts/dsh-inbox-acceptance.mjs'];
const receipt = { schemaVersion: 1, startedAt: new Date().toISOString(), baseline: '0.2.0-rc.2',
  mode: 'Official Cordis Agent runtime; deterministic local model; isolated sessions; no Desktop UI',
  realModelCalls: false, explicitPromptRequests: 0, permissions: [], checks: [], completed: false,
  sourceHashes: Object.fromEntries(sources.map(name => [name, hash(path.join(repo, name))])) };
const databases = new Map(), modelRequests = [], notices = [];
let rpc, server, modelError;
const pass = name => receipt.checks.push({ name, passed: true });
function childNode(argv, root) {
  const result = spawnSync(process.execPath, argv, { cwd: root, env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr.slice(-2000));
  return result.stdout.trim();
}
function hcc(root, argv) {
  const value = JSON.parse(childNode([path.join(repo, 'bin/hcc.mjs'), '--root', root, '--json', ...argv], root));
  return value.data ?? value;
}
function rows(root, sql, ...values) {
  if (!databases.has(root)) {
    const module = pathToFileURL(path.join(repo, 'lib/runtime/paths.mjs')).href;
    databases.set(root, childNode(['--input-type=module', '-e',
      `import { projectDbPath } from ${JSON.stringify(module)}; console.log(projectDbPath(process.argv[1]));`, root], root));
  }
  const db = new DatabaseSync(databases.get(root), { readOnly: true });
  try { return db.prepare(sql).all(...values); } finally { db.close(); }
}
const events = () => fs.existsSync(traceFile)
  ? fs.readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
async function until(check, description) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (modelError) throw modelError;
    if (check()) return;
    await delay(30);
  }
  throw new Error('Timed out: ' + description);
}
function stream(res, model, block) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  emit('message_start', { message: { id: 'msg-' + randomUUID(), type: 'message', role: 'assistant', model,
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
  emit('content_block_start', { index: 0, content_block: block.type === 'tool_use' ? { ...block, input: {} } : block });
  if (block.type === 'tool_use') emit('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
  emit('content_block_stop', { index: 0 });
  emit('message_delta', { delta: { stop_reason: block.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
  emit('message_stop', {}); res.end();
}
try {
  const policy = path.join(sandbox, 'acceptance-policy.mjs');
  fs.writeFileSync(policy, `import fs from 'node:fs';
export const inject = ['agents', 'sessions'];
export function apply(ctx) {
  const record = value => fs.appendFileSync(${JSON.stringify(traceFile)}, JSON.stringify(value) + '\\n', {mode:0o600});
  ctx.on('agent/pre-step', async ({agent}, next) => {
    if (agent.session.header.cwd === ${JSON.stringify(roots[2])}) {
      record({type:'admission-rejected', sessionId:agent.session.header.id});
      return {kind:'reject'};
    }
    return next();
  });
  ctx.on('agent/status', ({agent,status}) => record({type:'status',sessionId:agent.session.header.id,status}));
  ctx.on('session/event', (session,event) => {
    if (event.type === 'user/message') record({type:event.type,sessionId:session.header.id,id:event.data.id,source:event.data.source?.kind});
  });
}
`, { mode: 0o600 });
  const patch = path.join(sandbox, 'cordis.patch.yml');
  fs.writeFileSync(patch, '- insert:\n    - id: hcc-inbox-acceptance\n      name: ' +
    JSON.stringify(path.join(repo, 'lib/integrations/dsh-cordis.mjs')) +
    '\n      config:\n        inboxPollMs: 100\n    - id: hcc-inbox-policy\n      name: ' + JSON.stringify(policy) + '\n', { mode: 0o600 });
  server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      let length = 0; const chunks = [];
      for await (const chunk of request) { length += chunk.length; assert.ok(length < 2 * 1024 * 1024); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      modelRequests.push(body);
      assert.ok(modelRequests.length <= 2, 'No duplicate or unrequested model round');
      assert.ok(JSON.stringify(body.messages).includes(marker), 'The model sees the exact inbox marker');
      if (modelRequests.length === 1) {
        assert.ok(body.tools.some(tool => tool.name === 'hcc_message_send'));
        stream(response, body.model, { type: 'tool_use', id: 'reply-once', name: 'hcc_message_send',
          input: { to: 'inbox-coordinator', body: 'REPLY_' + marker, kind: 'note' } });
      } else {
        assert.ok(body.messages.some(message => message.content?.some(block => block.type === 'tool_result' && block.tool_use_id === 'reply-once')));
        stream(response, body.model, { type: 'text', text: 'DONE_' + marker });
      }
    } catch (error) {
      modelError = error;
      response.writeHead(500); response.end(JSON.stringify({ error: { type: 'api_error', message: 'Acceptance assertion failed' } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  rpc = new JsonRpcProcess({ binary: process.execPath,
    args: [officialBinary, '--profile', 'acp', '--patch', patch], cwd: roots[0], env, timeoutMs: 30000,
    onNotification(method, params) { if (method === 'session/update') notices.push(params); },
    onRequest(method, params) {
      assert.equal(method, 'session/request_permission');
      // Answer only the exact test-owned reply through the official approval
      // path. All other requests are declined; no global policy is relaxed.
      const input = params.toolCall?.rawInput;
      const exactReply = params.toolCall?.title === 'hcc_message_send' &&
        input?.to === 'inbox-coordinator' && input.body === 'REPLY_' + marker;
      receipt.permissions.push({ tool: params.toolCall?.title, exactReply });
      const option = params.options?.find(item => item.kind === (exactReply ? 'allow_once' : 'reject_once'));
      return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } };
    } });
  await rpc.start();
  const initialized = await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: {},
    clientInfo: { name: 'hcc-inbox-acceptance', version: '1' } });
  assert.equal(initialized.protocolVersion, 1);
  const sessions = [];
  for (const root of roots) sessions.push(await rpc.request('session/new', { cwd: root, mcpServers: [] }));
  const peers = roots.map((root, i) => rows(root, 'SELECT peer FROM peer_bindings WHERE provider_session_id=?', sessions[i].sessionId)[0].peer);
  await delay(400);
  assert.equal(modelRequests.length, 0);
  pass('idle Agents with empty inboxes do not call the model');
  hcc(roots[0], ['register', '--peer', 'inbox-coordinator', '--kind', 'shell']);
  const sent = hcc(roots[0], ['msg', 'send', '--from', 'inbox-coordinator', '--to', peers[0], '--body', marker]);
  await until(() => rows(roots[0], 'SELECT id FROM messages WHERE sender=? AND body=?', peers[0], 'REPLY_' + marker).length === 1, 'inbox reply');
  await until(() => modelRequests.length === 2 && rows(roots[0], 'SELECT status FROM peers WHERE id=?', peers[0])[0].status === 'idle', 'Agent settles');
  assert.equal(rows(roots[0], 'SELECT * FROM message_reads WHERE peer=? AND message_id=?', peers[0], sent.id).length, 1);
  const committed = events().filter(event => event.type === 'user/message' && event.sessionId === sessions[0].sessionId);
  assert.ok(committed.length >= 1);
  assert.ok(committed.some(event => event.source === 'hello-cc'));
  assert.ok(committed.every(event => event.source !== 'user'), 'No user prompt started the Agent');
  assert.ok(notices.some(event => event.sessionId === sessions[0].sessionId), 'Official client receives original-session events');
  pass('bus message wakes original idle Agent, commits context, ACKs and replies without session/prompt');
  assert.equal(rows(roots[1], 'SELECT * FROM messages').length, 0);
  assert.equal(events().filter(event => event.type === 'user/message' && event.sessionId === sessions[1].sessionId).length, 0);
  pass('a sibling Agent in another project receives no message or model turn');
  hcc(roots[2], ['register', '--peer', 'inbox-coordinator', '--kind', 'shell']);
  const denied = hcc(roots[2], ['msg', 'send', '--from', 'inbox-coordinator', '--to', peers[2], '--body', 'DENIED_' + marker]);
  await until(() => events().some(event => event.type === 'admission-rejected'), 'rejected admission');
  await delay(500);
  assert.equal(rows(roots[2], 'SELECT * FROM message_reads WHERE peer=? AND message_id=?', peers[2], denied.id).length, 0);
  assert.equal(events().filter(event => event.type === 'admission-rejected').length, 1, 'Rejected input is not automatically retried');
  assert.equal(modelRequests.length, 2);
  pass('downstream admission rejection leaves the message unread without a wake loop');
  for (const session of sessions) await rpc.request('session/close', { sessionId: session.sessionId });
  hcc(roots[0], ['msg', 'send', '--from', 'inbox-coordinator', '--to', peers[0], '--body', 'AFTER_CLOSE_' + marker]);
  await delay(400);
  assert.equal(modelRequests.length, 2);
  assert.equal(rows(roots[0], 'SELECT status FROM peers WHERE id=?', peers[0])[0].status, 'exited');
  pass('disposed Agents stay exited and are not woken by later inbox messages');
  receipt.completed = true;
} catch (error) {
  receipt.error = { name: error.name, message: error.message }; process.exitCode = 1;
} finally {
  receipt.cleanup = {};
  try { await rpc?.close(); receipt.cleanup.ownedRuntimeStopped = true; }
  catch { receipt.cleanup.ownedRuntimeStopped = false; receipt.completed = false; process.exitCode = 1; }
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  receipt.cleanup.localModelStopped = !server?.listening;
  receipt.modelRequests = modelRequests.length;
  receipt.finishedAt = new Date().toISOString();
  receipt.changedSources = sources.filter(name => receipt.sourceHashes[name] !== hash(path.join(repo, name)));
  if (receipt.changedSources.length) { receipt.completed = false; process.exitCode = 1; }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ receipt: output, ...receipt }, null, 2));
}
