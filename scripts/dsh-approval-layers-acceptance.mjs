// Deterministic local Messages responses drive the real official Harness and
// the production ACP adapter. No real model, credential or global profile.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createDshAcpAdapter } from '../lib/integrations/native/dsh-acp.mjs';
import { createDshEnvironment, resolveDshBinary } from '../lib/integrations/dsh.mjs';
import { isKnownDshEscalationApproval } from './web-native-interaction-diagnostics.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/dsh-approval-layers-acceptance.mjs [--dsh-bin PATH] [--output FILE]');
  process.exit(0);
}
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const requestedBinary = option('--dsh-bin');
let binary;
if (requestedBinary && /\.(?:mjs|cjs|js)$/.test(requestedBinary)) {
  binary = fs.realpathSync(path.resolve(requestedBinary));
  assert.ok(fs.statSync(binary).isFile(), 'Explicit JavaScript launcher must be a regular file');
  fs.accessSync(binary, fs.constants.R_OK);
} else binary = resolveDshBinary({ dshBin: requestedBinary });
assert.ok(binary, 'An existing official DSH launcher is required');
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-dsh-approval-layers-')));
fs.chmodSync(sandbox, 0o700);
// npm's bin.js may be a non-executable source file. Use this run's Node 24
// explicitly without changing installed file modes or the product transport.
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
let launcher = binary;
if (/\.(?:mjs|cjs|js)$/.test(binary)) {
  launcher = path.join(sandbox, 'official-dsh');
  fs.writeFileSync(launcher, '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(binary) + ' "$@"\n', { mode: 0o700 });
}
const output = path.resolve(option('--output', path.join(sandbox, 'evidence.json')));
const repo = fileURLToPath(new URL('..', import.meta.url));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceFiles = Object.fromEntries(['scripts/dsh-approval-layers-acceptance.mjs', 'lib/integrations/native/dsh-acp.mjs',
  'lib/integrations/native/jsonrpc.mjs', 'lib/integrations/native/interactions.mjs',
  'scripts/web-native-interaction-diagnostics.mjs'].map(name => [name, hash(path.join(repo, name))]));
const receipt = { schemaVersion: 1, startedAt: new Date().toISOString(), sourceFiles,
  mode: 'Deterministic local Messages server; actual official Harness and production ACP adapter',
  realModelCalls: false, scenarios: [], completed: false, cleanup: false };
const scenarios = [
  { name: 'policy-only-allow', forcedAsk: true, escalation: false, decisions: ['accept'], written: true },
  { name: 'policy-and-escalation-allow', forcedAsk: true, escalation: true, decisions: ['accept', 'accept'], written: true },
  { name: 'policy-allow-escalation-decline', forcedAsk: true, escalation: true, decisions: ['accept', 'decline'], written: false },
  { name: 'policy-decline', forcedAsk: true, escalation: true, decisions: ['decline'], written: false },
  { name: 'escalation-only-allow', forcedAsk: false, escalation: true, decisions: ['accept'], written: true },
];

function stream(res, model, block) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  event('message_start', { message: { id: 'msg-fixture', type: 'message', role: 'assistant', model,
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
  event('content_block_start', { index: 0, content_block: block.type === 'tool_use' ? { ...block, input: {} } : block });
  if (block.type === 'tool_use') event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
  event('content_block_stop', { index: 0 });
  event('message_delta', { delta: { stop_reason: block.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
  event('message_stop', {}); res.end();
}

try {
  for (const scenario of scenarios) {
    const directory = path.join(sandbox, scenario.name), root = path.join(directory, 'project'), home = path.join(directory, 'home');
    const target = path.join(directory, 'target.txt'), marker = 'DETERMINISTIC_APPROVAL_OK', callId = 'call-' + scenario.name;
    for (const folder of [directory, root, home]) fs.mkdirSync(folder, { mode: 0o700 });
    let requests = 0, completed, adapter, server;
    const observed = { name: scenario.name, requests: [], modelRequests: 0, realModelCalls: false, completed: false };
    receipt.scenarios.push(observed);
    try {
      server = http.createServer(async (request, response) => {
        try {
          assert.equal(request.method, 'POST');
          const chunks = []; let length = 0;
          for await (const chunk of request) { length += chunk.length; assert.ok(length < 2 * 1024 * 1024); chunks.push(chunk); }
          const body = JSON.parse(Buffer.concat(chunks).toString());
          requests++;
          assert.ok(requests <= 2, 'The fixture never emits another tool call or retries');
          if (requests === 1) {
            assert.ok(body.tools.some(tool => tool.name === 'write'));
            stream(response, body.model, { type: 'tool_use', id: callId, name: 'write', input: {
              file_path: target, content: marker,
              ...(scenario.escalation ? { sandbox_permissions: 'danger-full-access', justification: 'Only this temporary acceptance target.' } : {}),
            } });
          } else {
            observed.toolResultReceived = body.messages.some(message => Array.isArray(message.content) &&
              message.content.some(block => block.type === 'tool_result' && block.tool_use_id === callId));
            stream(response, body.model, { type: 'text', text: 'DETERMINISTIC_DONE' });
          }
        } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: { type: 'api_error', message: error.message } })); }
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const env = createDshEnvironment({ PATH: process.env.PATH, LANG: 'C.UTF-8', SHELL: '/bin/sh' });
      Object.assign(env, { HOME: home, DSH_HOME: path.join(home, 'dsh'), TMPDIR: directory, DSH_TELEMETRY_DISABLED: '1',
        DEEPSEEK_API_KEY: 'isolated-local-no-credential', DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}` });
      const initialized = spawnSync(launcher, ['--profile', 'acp', '--dump-config'], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
      assert.equal(initialized.status, 0, 'Isolated profile initialization failed (config omitted)');
      if (scenario.forcedAsk) {
        const policy = path.join(directory, 'policy.mjs');
        fs.writeFileSync(policy, `export const inject=['tools'];export function apply(ctx){ctx.on('tools/pre-execute',async(exec,next)=>exec.name==='write'&&exec.arguments.file_path===${JSON.stringify(target)}?{kind:'ask',reason:'exact test-owned write'}:next());}\n`, { mode: 0o600 });
        fs.writeFileSync(path.join(env.DSH_HOME, 'profiles/acp/cordis.patch.yml'), '- insert:\n    - id: deterministic-approval-policy\n      name: ' + JSON.stringify(policy) + '\n', { mode: 0o600 });
      }
      adapter = createDshAcpAdapter({ binary: launcher, cwd: root, env, interactive: true, executorId: randomUUID(),
        onEvent(event) { if (event.type === 'completed') completed = { status: event.status, stopReason: event.stopReason }; } });
      const opened = await adapter.open();
      const sent = await adapter.send({ text: 'Execute the one fixture tool, then finish.', submissionId: randomUUID() });
      const seen = new Set(), deadline = Date.now() + 30000;
      let firstRequest;
      while (!completed && Date.now() < deadline) {
        const snapshot = adapter.snapshot();
        assert.ok(!snapshot.error, 'Unexpected ACP runtime error');
        for (const pending of snapshot.pendingApprovals) {
          assert.ok(!seen.has(pending.requestId), 'Answered request must leave pending state');
          assert.equal(pending.method, 'session/request_permission');
          assert.equal(pending.sessionId, opened.sessionId); assert.equal(pending.turnId, sent.turnId);
          assert.equal(pending.params.toolCall.toolCallId, callId); assert.equal(pending.params.toolCall.title, 'write');
          assert.equal(pending.params.toolCall.rawInput.file_path, target); assert.equal(pending.params.toolCall.rawInput.content, marker);
          const decision = scenario.decisions[observed.requests.length];
          assert.ok(decision, 'Unexpected additional approval is never answered');
          if (firstRequest) {
            assert.equal(isKnownDshEscalationApproval(firstRequest, pending, {
              target, content: marker, priorDecision: scenario.decisions[0], additionalAnswers: observed.requests.length - 1,
            }), true, 'The actual official second layer must satisfy the fixture operation guard');
          } else firstRequest = structuredClone(pending);
          observed.requests.push({ requestId: pending.requestId, method: pending.method, toolName: 'write',
            toolCallId: callId, sameOriginalSession: true, sameOriginalTurn: true, targetExactOwned: true,
            targetExistsBeforeAnswer: fs.existsSync(target), decision });
          seen.add(pending.requestId);
          adapter.respond({ executorId: pending.executorId, requestId: pending.requestId, sessionId: pending.sessionId, turnId: pending.turnId, decision });
        }
        await delay(20);
      }
      assert.equal(completed?.status, 'completed'); assert.equal(completed?.stopReason, 'end_turn');
      assert.equal(observed.requests.length, scenario.decisions.length);
      assert.equal(fs.existsSync(target), scenario.written);
      if (scenario.written) assert.equal(fs.readFileSync(target, 'utf8'), marker);
      assert.equal(requests, 2); assert.equal(observed.toolResultReceived, true);
      observed.targetExistsAfterCompletion = fs.existsSync(target);
      observed.targetSha256 = fs.existsSync(target) ? hash(target) : null;
      observed.oneModelToolCall = true; observed.modelRequests = requests; observed.completed = true;
      console.log(JSON.stringify({ scenario: scenario.name, permissionRequests: observed.requests.length, written: scenario.written, passed: true }));
    } finally {
      await adapter?.close();
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
  receipt.completed = true;
} catch (error) {
  receipt.error = { name: error.name, message: error.message }; process.exitCode = 1;
} finally {
  receipt.cleanup = scenarios.every(scenario => !fs.existsSync(path.join(sandbox, scenario.name)));
  if (launcher !== binary) {
    try { fs.rmSync(launcher); } catch { receipt.cleanup = false; }
  }
  receipt.finishedAt = new Date().toISOString();
  receipt.sourceChanges = Object.entries(sourceFiles).filter(([name, before]) => hash(path.join(repo, name)) !== before).map(([name]) => name);
  if (!receipt.cleanup || receipt.sourceChanges.length) {
    receipt.completed = false; process.exitCode = 1;
    receipt.error ||= { name: 'AcceptanceIntegrityError', message: 'Owned cleanup failed or source changed during acceptance' };
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ output, completed: receipt.completed, cleanup: receipt.cleanup, error: receipt.error }));
}
