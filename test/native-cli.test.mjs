import { prepareCliSubmission } from '../lib/runtime/native/cli-submissions.mjs';
import { nativePaths } from '../lib/runtime/native/store.mjs';
import os from 'node:os';
import { nativeRequest } from '../lib/runtime/native/client.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { inspectProcessIdentity } from '../lib/process/identity.mjs';
import { createNativeTestRoot } from './helpers/native-root.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hccBin = path.join(repoRoot, 'bin', 'hcc.mjs');

// A real executable and stdio protocol, with no SDK, network, model, or credentials.
// Approval replies control completion so a missing denial cannot silently pass.
const fakeCodexSource = `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const log = (entry) => fs.appendFileSync(process.env.FAKE_CODEX_LOG,
  JSON.stringify({ pid: process.pid, ...entry }) + '\\n');
const write = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\\n');
const result = (id, value) => write({ id, result: value });
const notify = (method, params) => write({ method, params });
let threadId;
let turnCount = 0;
let requestCount = 0;
let active;
const approvals = new Map();
log({ kind: 'started', args: process.argv.slice(2), cwd: process.cwd(), home: process.env.HOME,
  peer: process.env.HCC_PEER, root: process.env.HCC_ROOT, db: process.env.HCC_DB });
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['app-server', '--stdio'])) process.exit(9);
function finish(turn) {
  notify('item/completed', { threadId, turnId: turn.id,
    item: { type: 'agentMessage', id: 'answer-' + turn.id, text: 'fake-codex-answer' } });
  notify('turn/completed', { threadId, turn: { id: turn.id, status: 'completed' } });
  if (turn.fast) result(turn.requestId, { turn: { id: turn.id, status: 'inProgress' } });
  active = null;
}
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const frame = JSON.parse(line);
  log({ kind: 'frame', frame });
  if (!frame.method) {
    const turn = approvals.get(frame.id);
    if (turn) {
      approvals.delete(frame.id);
      turn.pending--;
      if (!turn.pending) setImmediate(() => finish(turn));
    }
    return;
  }
  const params = frame.params || {};
  if (frame.method === 'initialize') return result(frame.id, { userAgent: 'hcc-fake-codex' });
  if (frame.method === 'initialized') return;
  if (frame.method === 'thread/start' || frame.method === 'thread/resume') {
    threadId = params.threadId || 'fake-thread-' + process.pid;
    return result(frame.id, { thread: { id: threadId, turns: [] },
      sandbox: { type: params.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite', networkAccess: false },
      approvalPolicy: params.approvalPolicy });
  }
  if (frame.method === 'turn/start') {
    const text = params.input.map((item) => item.text || '').join('\\n');
    const turn = { id: 'fake-turn-' + (++turnCount), requestId: frame.id,
      fast: text.includes('fast-completion'), pending: 0 };
    active = turn;
    if (!turn.fast) result(frame.id, { turn: { id: turn.id, status: 'inProgress' } });
    notify('turn/started', { threadId, turn: { id: turn.id, status: 'inProgress' } });
    if (text.includes('hold-open')) return;
    if (text.includes('user-input-check')) {
      const id = 'fake-question-' + (++requestCount);
      approvals.set(id, turn); turn.pending++;
      write({ id, method: 'item/tool/requestUserInput', params: { threadId, turnId: turn.id,
        questions: [{ id: 'review_scope', header: 'Scope', question: 'Which area should be inspected?', isOther: false, isSecret: false,
          options: [{ label: 'Tests only', description: 'Inspect tests.' }, { label: 'Runtime only', description: 'Inspect runtime.' }] }] } });
      for (const method of ['item/commandExecution/requestApproval',
        'item/fileChange/requestApproval', 'item/permissions/requestApproval']) {
        const escalationId = 'fake-question-escalation-' + (++requestCount);
        approvals.set(escalationId, turn); turn.pending++;
        write({ id: escalationId, method, params: { threadId, turnId: turn.id, itemId: escalationId, reason: 'question must not grant permissions' } });
      }
    } else if (text.includes('mcp-form-check')) {
      const id = 'fake-mcp-form-' + (++requestCount);
      approvals.set(id, turn); turn.pending++;
      write({ id, method: 'mcpServer/elicitation/request', params: { threadId, turnId: turn.id, serverName: 'form-fixture', mode: 'form', message: 'Project preferences',
        requestedSchema: { type: 'object', properties: { enabled: { type: 'boolean' }, count: { type: 'integer', minimum: 1 } }, required: ['enabled', 'count'] } } });
    } else if (text.includes('approval-check')) {
      for (const method of ['item/commandExecution/requestApproval',
        'item/fileChange/requestApproval', 'item/permissions/requestApproval']) {
        const id = 'fake-approval-' + (++requestCount);
        approvals.set(id, turn);
        turn.pending++;
        write({ id, method, params: { threadId, turnId: turn.id, itemId: id, reason: 'test-only approval' } });
      }
    } else setImmediate(() => finish(turn));
    return;
  }
  if (frame.method === 'turn/interrupt') {
    result(frame.id, {});
    if (active) notify('turn/completed', { threadId, turn: { id: active.id, status: 'interrupted' } });
    active = null;
    return;
  }
  write({ id: frame.id, error: { code: -32601, message: 'Unsupported fake method: ' + frame.method } });
});
lines.on('close', () => process.exit(0));
`;

async function fixture(t) {
  const projectSubdir = "project space ' quote";
  const sandbox = await createNativeTestRoot('hcc-native-cli-', { projectSubdir });
  const root = path.join(sandbox, projectSubdir);
  const home = path.join(sandbox, 'home');
  const binary = path.join(sandbox, 'fake-codex.mjs');
  const traceFile = path.join(sandbox, 'codex.jsonl');
  for (const directory of [root, home]) fs.mkdirSync(directory);
  fs.writeFileSync(binary, fakeCodexSource, { mode: 0o700 });
  const dbPath = path.join(root, '.hello-cc', 'mesh.db');
  const pointer = path.join(root, '.hello-cc', 'native', 'runtime.json');
  const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home,
    NODE_NO_WARNINGS: '1',
    FAKE_CODEX_LOG: traceFile, HCC_RUNTIME_URL: '', NO_COLOR: '1' };
  const processes = new Map();
  const trace = () => fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const remember = (pid) => {
    if (!Number.isInteger(pid) || processes.has(pid)) return;
    const observed = inspectProcessIdentity(pid);
    if (observed.state === 'live') processes.set(pid, observed.identity);
  };
  const capture = () => {
    if (fs.existsSync(pointer)) {
      try { remember(JSON.parse(fs.readFileSync(pointer, 'utf8')).pid); } catch {}
    }
    for (const row of trace()) if (row.kind === 'started') remember(row.pid);
  };
  const alive = (pid) => {
    try { process.kill(pid, 0); return true; } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  };
  const signalOwned = (pid, signal) => {
    const observed = inspectProcessIdentity(pid);
    const identity = processes.get(pid);
    if (observed.state === 'live' && observed.identity.startToken === identity.startToken &&
        observed.identity.commandHash === identity.commandHash) process.kill(pid, signal);
  };
  const raw = (...args) => {
    const result = spawnSync(process.execPath, [hccBin, '--root', root, '--json', ...args], {
      cwd: root, env, encoding: 'utf8', timeout: 15_000
    });
    capture();
    return result;
  };
  const run = (...args) => {
    const result = raw(...args);
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    return output.data;
  };
  const fail = (code, ...args) => {
    const result = raw(...args);
    assert.notEqual(result.status, 0, result.stdout);
    assert.equal(JSON.parse(result.stderr).error.code, code);
  };
  const wait = async (read, accept, description) => {
    const deadline = Date.now() + 8_000;
    let value;
    while (Date.now() < deadline) {
      value = read();
      if (accept(value)) return value;
      await delay(75);
    }
    assert.fail(`Timed out waiting for ${description}: ${JSON.stringify(value)}`);
  };
  const withDb = (read) => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { return read(db); } finally { db.close(); }
  };
  const start = (peer = 'native-worker', extra = []) => run('native', 'start', '--peer', peer,
    '--provider', 'codex', '--binary', binary, ...extra);
  const waitDelivery = (messageId, state = 'completed', peer = 'native-worker') => wait(
    () => run('native', 'deliveries', '--peer', peer),
    (rows) => rows.some((row) => row.message_id === messageId && row.state === state), `message ${messageId} ${state}`
  ).then((rows) => rows.find((row) => row.message_id === messageId));
  const waitStopped = () => wait(() => ({ pointer: fs.existsSync(pointer), live: [...processes.keys()].filter(alive) }),
    (state) => !state.pointer && !state.live.length, 'owned native runtime and provider to stop');
  t.after(async () => {
    capture();
    try {
      if (fs.existsSync(pointer)) raw('native', 'down');
      for (let i = 0; i < 30 && [...processes.keys()].some(alive); i++) await delay(100);
      for (const pid of processes.keys()) if (alive(pid)) signalOwned(pid, 'SIGTERM');
      for (let i = 0; i < 10 && [...processes.keys()].some(alive); i++) await delay(100);
      for (const pid of processes.keys()) if (alive(pid)) signalOwned(pid, 'SIGKILL');
      await wait(() => [...processes.keys()].filter(alive), (pids) => !pids.length, 'fixture process cleanup');
    } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
  });
  return { root, home, dbPath, pointer, binary, env, raw, run, fail, trace, start, wait, withDb, waitDelivery, waitStopped };
}

test('native CLI help, lifecycle and saved resume use only the owned stdio process', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t);
  const help = f.raw('native', '--help');
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /native start --peer NAME --provider codex\|claude\|dsh/);
  assert.equal(fs.existsSync(f.pointer), false);
  f.fail('NATIVE_RUNTIME_OFFLINE', 'native', 'status');
  const up = f.run('native', 'up');
  assert.deepEqual(up.workers, []);
  assert.equal(f.run('native', 'up').generation, up.generation);
  assert.equal(f.run('native', 'status').pid, up.pid);
  const worker = f.start();
  assert.equal(worker.status, 'idle');
  assert.match(worker.sessionId, /^fake-thread-/);
  const started = f.trace().find((row) => row.kind === 'started');
  assert.equal(started.home, f.home);
  assert.equal(started.root, fs.realpathSync(f.root));
  assert.equal(started.db, fs.realpathSync(f.dbPath));
  assert.equal(started.peer, 'native-worker');
  assert.deepEqual(started.args, ['app-server', '--stdio']);
  const frames = f.trace().filter((row) => row.kind === 'frame').map((row) => row.frame);
  assert.deepEqual(frames.map((frame) => frame.method), ['initialize', 'initialized', 'thread/start']);
  assert.equal(frames[2].params.sandbox, 'workspace-write');
  assert.equal(frames[2].params.approvalPolicy, 'on-request');
  assert.equal(frames[2].params.approvalsReviewer, 'user');
  assert.equal(f.run('native', 'status').workers[0].session_id, worker.sessionId);
  assert.deepEqual(f.run('native', 'close', '--peer', 'native-worker'), { peer: 'native-worker', status: 'closed' });
  f.fail('NATIVE_SESSION_NOT_OWNED', 'native', 'start', '--peer', 'foreign-worker', '--provider', 'codex',
    '--binary', f.binary, '--resume', worker.sessionId);
  f.fail('NATIVE_RESUME_REQUIRED', 'native', 'start', '--peer', 'native-worker', '--provider', 'codex', '--binary', f.binary);
  assert.equal(f.start('native-worker', ['--resume', 'last']).sessionId, worker.sessionId);
  const resume = f.trace().find((row) => row.frame?.method === 'thread/resume');
  assert.equal(resume.frame.params.threadId, worker.sessionId);
  f.run('native', 'close', '--peer', 'native-worker');
  assert.deepEqual(f.run('native', 'down'), { stopping: true });
  await f.waitStopped();
  f.fail('NATIVE_RUNTIME_OFFLINE', 'native', 'status');
});

test('native send and ordinary mesh messages receive one provider submission, reply and ack', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t);
  const worker = f.start();
  const first = f.run('native', 'send', '--peer', 'native-worker', '--from', 'coordinator', '--body', 'from-native-command');
  assert.equal(first.state, 'queued');
  const firstDelivery = await f.waitDelivery(first.message_id);
  assert.equal(firstDelivery.submission_id, first.submission_id);
  assert.match(firstDelivery.turn_id, /^fake-turn-/);
  const initialEvents = f.run('native', 'events', '--peer', 'native-worker');
  assert.ok(initialEvents.some((row) => row.payload.type === 'completed'));
  const cursor = initialEvents.at(-1).id;
  const second = f.run('msg', 'send', '--from', 'teammate', '--to', 'native-worker', '--body', 'from-ordinary-mesh-command');
  const secondDelivery = await f.waitDelivery(second.id);
  assert.equal(secondDelivery.state, 'completed');
  const laterEvents = f.run('native', 'events', '--peer', 'native-worker', '--after', String(cursor));
  assert.ok(laterEvents.length);
  assert.ok(laterEvents.every((row) => row.id > cursor));
  for (const [sender, originalId] of [['coordinator', first.message_id], ['teammate', second.id]]) {
    const replies = f.run('msg', 'inbox', '--peer', sender);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].sender, 'native-worker');
    assert.equal(replies[0].kind, 'reply');
    assert.equal(replies[0].body, 'fake-codex-answer');
    assert.equal(replies[0].reply_to, originalId);
    assert.equal(replies[0].thread_id, originalId);
  }
  f.withDb((db) => {
    const reads = db.prepare('SELECT message_id, peer FROM message_reads ORDER BY message_id').all();
    assert.deepEqual(reads.map((row) => ({ ...row })), [
      { message_id: first.message_id, peer: 'native-worker' }, { message_id: second.id, peer: 'native-worker' }
    ]);
    const binding = db.prepare('SELECT transport, provider_session_id FROM peer_bindings WHERE peer=?').get('native-worker');
    assert.equal(binding.transport, 'native');
    assert.equal(binding.provider_session_id, worker.sessionId);
  });
  const sends = f.trace().filter((row) => row.frame?.method === 'turn/start');
  assert.equal(sends.length, 2);
  assert.ok(sends.every((row) => row.frame.params.threadId === worker.sessionId));
  assert.match(sends[0].frame.params.input[0].text, /from-native-command/);
  assert.match(sends[1].frame.params.input[0].text, /from-ordinary-mesh-command/);
  assert.equal(sends[0].frame.params.clientUserMessageId, first.submission_id);
  assert.equal(sends[1].frame.params.clientUserMessageId, secondDelivery.submission_id);
  f.run('native', 'close', '--peer', 'native-worker');
  f.run('native', 'down');
  await f.waitStopped();
});

test('native CLI lists and answers hosted approvals and retains completion before admission', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t);
  f.start();
  const message = f.run('native', 'send', '--peer', 'native-worker', '--from', 'coordinator',
    '--body', 'approval-check fast-completion');
  const requests = await f.wait(() => f.run('native', 'requests', '--peer', 'native-worker'), value => value.length === 3, 'interactive requests');
  assert.equal(f.trace().some(row => row.frame?.id?.startsWith?.('fake-approval-') && row.frame.result), false);
  for (const request of requests) f.run('native', 'respond', '--peer', 'native-worker', '--request', String(request.requestId), '--decision', 'decline');
  f.fail('NATIVE_APPROVAL_MISMATCH', 'native', 'respond', '--peer', 'native-worker', '--request', String(requests[0].requestId), '--decision', 'accept');
  const delivery = await f.waitDelivery(message.message_id);
  assert.equal(delivery.state, 'completed');
  const responses = f.trace().filter((row) => row.frame?.id?.startsWith?.('fake-approval-')).map((row) => row.frame);
  assert.deepEqual(responses.map((frame) => frame.result), [
    { decision: 'decline' }, { decision: 'decline' }, { permissions: {}, scope: 'turn' }
  ]);
  const events = f.run('native', 'events', '--peer', 'native-worker');
  const approvals = events.filter((row) => row.payload.type === 'approval');
  assert.equal(approvals.length, 3);
  assert.ok(approvals.every((row) => row.payload.status === 'pending'));
  assert.equal(events.filter((row) => row.payload.type === 'completed').length, 1);
  assert.equal(f.run('msg', 'inbox', '--peer', 'coordinator')[0].body, 'fake-codex-answer');
  f.run('native', 'down');
  await f.waitStopped();
});

test('native down closes an active owned worker without fabricating a reply or ack', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t);
  f.start();
  const message = f.run('native', 'send', '--peer', 'native-worker', '--from', 'coordinator', '--body', 'hold-open');
  await f.waitDelivery(message.message_id, 'accepted');
  f.run('native', 'down');
  await f.waitStopped();
  f.withDb((db) => {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM message_reads WHERE message_id=?').get(message.message_id).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE reply_to=?').get(message.message_id).n, 0);
  });
  const db = new DatabaseSync(path.join(f.root, '.hello-cc', 'native', 'state.db'), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT state FROM deliveries WHERE message_id=?').get(message.message_id).state, 'uncertain');
    assert.equal(db.prepare('SELECT status FROM workers WHERE peer=?').get('native-worker').status, 'closed');
  } finally { db.close(); }
});


test('native CLI response files carry validated MCP content through the owning executor', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t); f.start();
  const message = f.run('native', 'send', '--peer', 'native-worker', '--from', 'coordinator', '--body', 'mcp-form-check');
  const [request] = await f.wait(() => f.run('native', 'requests', '--peer', 'native-worker'), value => value.length === 1, 'MCP form request');
  const file = path.join(f.home, 'form-response.json');
  fs.writeFileSync(file, JSON.stringify({ content: { enabled: 'false', count: 2 } }), { mode: 0o600 });
  f.fail('INTERACTION_RESPONSE_INVALID', 'native', 'respond', '--peer', 'native-worker', '--request', String(request.requestId), '--decision', 'accept', '--response-file', file);
  assert.equal(f.run('native', 'requests', '--peer', 'native-worker').length, 1);
  fs.writeFileSync(file, JSON.stringify({ content: { enabled: false, count: 2 } }), { mode: 0o600 });
  const receipt = f.run('native', 'respond', '--peer', 'native-worker', '--request', String(request.requestId), '--decision', 'accept', '--response-file', file);
  assert.equal(receipt.status, 'submitted');
  assert.equal((await f.waitDelivery(message.message_id)).state, 'completed');
  assert.deepEqual(f.trace().find(row => row.frame?.id === request.requestId && row.frame.result).frame.result, { action: 'accept', content: { enabled: false, count: 2 } });
  assert.equal(JSON.stringify(f.run('native', 'events', '--peer', 'native-worker')).includes('"content"'), false);
  f.run('native', 'down'); await f.waitStopped();
});

test('native CLI can retry one explicit submission ID without queueing a second message', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  f.start();
  const args = ['native', 'send', '--peer', 'native-worker', '--from', 'coordinator',
    '--body', 'one durable CLI request', '--submission-id', 'cli_retry_001'];
  const first = f.run(...args);
  const retry = f.run(...args);
  assert.equal(retry.message_id, first.message_id);
  assert.equal(retry.submission_id, 'cli_retry_001');
  f.withDb(db => assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE body='one durable CLI request'").get().n, 1));
  f.fail('NATIVE_SUBMISSION_MISMATCH', ...args.slice(0, 7), 'different', '--submission-id', 'cli_retry_001');
  f.fail('BAD_ARGS', 'native', 'send', '--peer', 'native-worker', '--body', 'x', '--submission-id', 'bad');
});

test('native CLI rejects invalid and non-Codex sandbox before starting a daemon', async t => {
  const f = await fixture(t);
  for (const [provider, sandbox] of [['codex', 'danger-full-access'], ['codex', ''], ['claude', 'read-only'], ['dsh', 'workspace-write']]) {
    f.fail('BAD_ARGS', 'native', 'start', '--peer', 'readonly-worker', '--provider', provider, '--sandbox=' + sandbox);
    assert.equal(fs.existsSync(f.pointer), false);
    assert.equal(f.trace().length, 0);
  }
});

test('native CLI preserves read-only sandbox on resume and declines escalation requests', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const worker = f.start('readonly-worker', ['--sandbox', 'read-only']);
  assert.equal(worker.sandbox, 'read-only');
  assert.equal(worker.sandboxVerified, true);
  assert.equal(worker.capabilities.approvals, false);
  assert.equal(worker.capabilities.userInput, true);
  const opened = f.trace().find(row => row.frame?.method === 'thread/start').frame.params;
  assert.equal(opened.sandbox, 'read-only');
  assert.equal(opened.approvalPolicy, 'never');
  assert.equal(opened.config?.mcp_servers?.hello_cc_scoped, undefined);
  const sent = f.run('native', 'send', '--peer', 'readonly-worker', '--body', 'approval-check');
  await f.waitDelivery(sent.message_id, 'completed', 'readonly-worker');
  const turn = f.trace().find(row => row.frame?.method === 'turn/start').frame.params;
  assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(turn.approvalPolicy, 'never');
  assert.deepEqual(f.run('native', 'requests', '--peer', 'readonly-worker'), []);
  assert.doesNotMatch(turn.input[0].text, /Use this exact prefix for HCC commands/);
  const questionMessage = f.run('native', 'send', '--peer', 'readonly-worker', '--from', 'coordinator', '--body', 'user-input-check');
  const [question] = await f.wait(() => f.run('native', 'requests', '--peer', 'readonly-worker'),
    value => value.length === 1 && value[0].kind === 'userInput', 'read-only ordinary question');
  assert.equal(question.method, 'item/tool/requestUserInput');
  const readonlyState = f.run('native', 'status').workers.find(value => value.peer === 'readonly-worker');
  assert.equal(readonlyState.sandbox, 'read-only');
  assert.equal(readonlyState.capabilities.approvals, false);
  assert.equal(readonlyState.capabilities.userInput, true);
  const questionEscalations = f.trace().filter(row => row.frame?.id?.startsWith?.('fake-question-escalation-') && row.frame.result);
  assert.deepEqual(questionEscalations.map(row => row.frame.result), [
    { decision: 'decline' }, { decision: 'decline' }, { permissions: {}, scope: 'turn' }
  ]);
  f.fail('NATIVE_APPROVAL_MISMATCH', 'native', 'respond', '--peer', 'readonly-worker',
    '--request', questionEscalations[0].frame.id, '--decision', 'accept');
  const answerFile = path.join(f.home, 'question-response.json');
  const answers = { review_scope: { answers: ['Tests only'] } };
  fs.writeFileSync(answerFile, JSON.stringify({ answers }), { mode: 0o600 });
  const answered = f.run('native', 'respond', '--peer', 'readonly-worker', '--request', String(question.requestId),
    '--decision', 'accept', '--response-file', answerFile);
  assert.equal(answered.status, 'submitted');
  assert.equal((await f.waitDelivery(questionMessage.message_id, 'completed', 'readonly-worker')).state, 'completed');
  assert.deepEqual(f.trace().find(row => row.frame?.id === question.requestId && row.frame.result).frame.result, { answers });
  assert.deepEqual(f.run('native', 'requests', '--peer', 'readonly-worker'), []);
  const questionTurn = f.trace().filter(row => row.frame?.method === 'turn/start').at(-1).frame.params;
  assert.deepEqual(questionTurn.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(questionTurn.approvalPolicy, 'never');
  assert.equal(f.run('msg', 'inbox', '--peer', 'coordinator').find(message => message.reply_to === questionMessage.message_id).body, 'fake-codex-answer');
  f.run('native', 'close', '--peer', 'readonly-worker');
  const resumed = f.start('readonly-worker', ['--resume', 'last']);
  assert.equal(resumed.sandbox, 'read-only');
  assert.equal(resumed.sessionId, worker.sessionId);
  assert.equal(f.trace().find(row => row.frame?.method === 'thread/resume').frame.params.sandbox, 'read-only');
  f.run('native', 'close', '--peer', 'readonly-worker');
  const count = f.trace().filter(row => row.kind === 'started').length;
  const mismatch = f.raw('native', 'start', '--peer', 'readonly-worker', '--provider', 'codex', '--binary', f.binary,
    '--resume', 'last', '--sandbox', 'workspace-write');
  assert.notEqual(mismatch.status, 0);
  assert.equal(f.trace().filter(row => row.kind === 'started').length, count);
});


test('native CLI launch hold refuses start before spawning the runtime or provider', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  f.env.HCC_PINNED_LAUNCH_MODE = 'hold';
  f.fail('PINNED_LAUNCH_PAUSED', 'native', 'start', '--peer', 'held', '--provider', 'codex', '--binary', f.binary);
  assert.equal(fs.existsSync(f.pointer), false);
  assert.deepEqual(f.trace(), []);
  if (fs.existsSync(f.dbPath)) {
    f.withDb(db => {
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM peers WHERE id='held'").get().n, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
    });
  }
});


test('native CLI journals generated submission IDs before sending and exposes local receipts', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  f.start();
  const args = ['native', 'send', '--peer', 'native-worker', '--from', 'coordinator', '--body', 'same intentional request'];
  const first = f.run(...args);
  const second = f.run(...args);
  assert.notEqual(first.submission_id, second.submission_id);
  assert.notEqual(first.message_id, second.message_id);
  const ctx = { root: fs.realpathSync(f.root), dbPath: fs.realpathSync(f.dbPath) };
  const journalDir = path.join(path.dirname(nativePaths(ctx).dir), 'native-cli-submissions');
  const saved = JSON.parse(fs.readFileSync(path.join(journalDir, `submission-${first.submission_id}.json`), 'utf8'));
  assert.equal(saved.mesh_db_relative, 'mesh.db');
  const journal = f.run('native', 'submissions', '--peer', 'native-worker');
  assert.equal(journal.length, 2);
  for (const receipt of [first, second]) {
    const entry = journal.find(row => row.submission_id === receipt.submission_id);
    assert.equal(entry.peer, 'native-worker');
    assert.equal(entry.from, 'coordinator');
    assert.equal(entry.confirmation, 'received');
    assert.deepEqual(entry.receipt, { message_id: receipt.message_id,
      submission_id: receipt.submission_id, state: receipt.state });
  }
  f.withDb(db => assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE body='same intentional request'").get().n, 2));
  f.run('native', 'down');
  await f.waitStopped();
  assert.equal(f.run('native', 'submissions', '--peer', 'native-worker').length, 2,
    'local submission IDs remain inspectable when the native runtime is offline');
});


test('prepared CLI submission survives a lost response and refuses a changed manual retry', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  f.start();
  const ctx = { root: fs.realpathSync(f.root), dbPath: fs.realpathSync(f.dbPath) };
  const input = { peer: 'native-worker', from: 'coordinator', taskId: null, body: 'one recoverable request' };
  const prepared = prepareCliSubmission(ctx, input);
  assert.equal(f.run('native', 'submissions')[0].confirmation, 'unconfirmed');
  f.withDb(db => assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0));
  for (const args of [
    ['--peer', 'other-worker', '--from', input.from, '--body', input.body],
    ['--peer', input.peer, '--from', 'other-sender', '--body', input.body],
    ['--peer', input.peer, '--from', input.from, '--body', input.body, '--task', '1'],
    ['--peer', input.peer, '--from', input.from, '--body', 'changed before first POST']
  ]) {
    f.fail('NATIVE_SUBMISSION_MISMATCH', 'native', 'send', ...args,
      '--submission-id', prepared.submission_id);
  }
  f.withDb(db => assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0));
  const first = await nativeRequest(ctx, 'POST', '/send', { ...input, submissionId: prepared.submission_id });
  assert.equal(f.run('native', 'submissions')[0].confirmation, 'unconfirmed');
  const retry = f.run('native', 'send', '--peer', input.peer, '--from', input.from,
    '--body', input.body, '--submission-id', prepared.submission_id);
  assert.equal(retry.message_id, first.message_id);
  assert.equal(f.run('native', 'submissions')[0].receipt.message_id, first.message_id);
  f.withDb(db => assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE body='one recoverable request'").get().n, 1));
});


test('native CLI fails before sending when its private submission journal cannot be created', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  f.start();
  const ctx = { root: fs.realpathSync(f.root), dbPath: fs.realpathSync(f.dbPath) };
  const journal = path.join(path.dirname(nativePaths(ctx).dir), 'native-cli-submissions');
  fs.writeFileSync(journal, 'blocked', { flag: 'wx', mode: 0o600 });
  f.fail('PROJECT_PATH_FORBIDDEN', 'native', 'send', '--peer', 'native-worker',
    '--from', 'coordinator', '--body', 'must not reach the bus');
  f.withDb(db => assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0));
});


test('native CLI journal does not publish a partial record when its writer is killed', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  f.start();
  const source = `
    import fs from 'node:fs';
    import { prepareCliSubmission } from ${JSON.stringify(new URL('../lib/runtime/native/cli-submissions.mjs', import.meta.url).href)};
    const original = fs.writeFileSync;
    fs.writeFileSync = (fd, value, ...args) => {
      if (typeof fd === 'number' && typeof value === 'string' && value.includes('"submission_id"')) {
        fs.writeSync(fd, value.slice(0, Math.ceil(value.length / 2)));
        process.kill(process.pid, 'SIGKILL');
      }
      return original(fd, value, ...args);
    };
    prepareCliSubmission({ root: process.argv[1], dbPath: process.argv[2] },
      { peer: 'native-worker', from: 'coordinator', taskId: null, body: 'not sent' });
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source,
    fs.realpathSync(f.root), fs.realpathSync(f.dbPath)], {
    cwd: f.root, env: f.env, encoding: 'utf8', timeout: 15_000
  });
  assert.equal(child.signal, 'SIGKILL', child.stderr || child.stdout);
  assert.deepEqual(f.run('native', 'submissions'), []);
  f.withDb(db => assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0));
});


test('native CLI journal repairs a published record left linked by a killed writer', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  f.start();
  const baseline = f.run('native', 'send', '--peer', 'native-worker', '--from', 'coordinator', '--body', 'baseline');
  const source = `
    import fs from 'node:fs';
    import { prepareCliSubmission } from ${JSON.stringify(new URL('../lib/runtime/native/cli-submissions.mjs', import.meta.url).href)};
    const original = fs.linkSync;
    fs.linkSync = (temporary, final) => {
      original(temporary, final);
      process.kill(process.pid, 'SIGKILL');
    };
    prepareCliSubmission({ root: process.argv[1], dbPath: process.argv[2] },
      { peer: 'native-worker', from: 'coordinator', taskId: null, body: 'after link crash' });
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source,
    fs.realpathSync(f.root), fs.realpathSync(f.dbPath)], {
    cwd: f.root, env: f.env, encoding: 'utf8', timeout: 15_000
  });
  assert.equal(child.signal, 'SIGKILL', child.stderr || child.stdout);
  const ctx = { root: fs.realpathSync(f.root), dbPath: fs.realpathSync(f.dbPath) };
  const journalDir = path.join(path.dirname(nativePaths(ctx).dir), 'native-cli-submissions');
  const competingReader = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { listCliSubmissions } from ${JSON.stringify(new URL('../lib/runtime/native/cli-submissions.mjs', import.meta.url).href)};
    const directory = process.argv[3], original = fs.readdirSync;
    let reads = 0, removed = false;
    fs.readdirSync = (target, ...args) => {
      if (target === directory && ++reads === 2) {
        const temporary = original(directory).find(name => name.startsWith('.submission-') && name.includes('.tmp.'));
        if (temporary) { fs.unlinkSync(path.join(directory, temporary)); removed = true; }
      }
      return original(target, ...args);
    };
    const entries = listCliSubmissions({ root: process.argv[1], dbPath: process.argv[2] });
    process.stdout.write(JSON.stringify({ entries, removed }));
  `;
  const reader = spawnSync(process.execPath, ['--input-type=module', '-e', competingReader,
    ctx.root, ctx.dbPath, journalDir], { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 15_000 });
  assert.equal(reader.status, 0, reader.stderr || reader.stdout);
  const observed = JSON.parse(reader.stdout);
  assert.equal(observed.removed, true);
  const saved = observed.entries;
  assert.equal(saved.length, 2);
  assert.ok(saved.some(row => row.submission_id === baseline.submission_id && row.confirmation === 'received'));
  const unconfirmed = saved.find(row => row.confirmation === 'unconfirmed');
  assert.ok(unconfirmed);
  assert.equal(fs.lstatSync(path.join(journalDir, `submission-${unconfirmed.submission_id}.json`)).nlink, 1);
  const retry = f.run('native', 'send', '--peer', 'native-worker', '--from', 'coordinator',
    '--body', 'after link crash', '--submission-id', unconfirmed.submission_id);
  assert.equal(retry.submission_id, unconfirmed.submission_id);
  assert.equal(f.run('native', 'submissions').find(row => row.submission_id === unconfirmed.submission_id).confirmation, 'received');
  f.withDb(db => assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE body='after link crash'").get().n, 1));
});


test('native CLI receipt publication accepts a matching concurrent winner without overwriting it', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  f.start();
  const ctx = { root: fs.realpathSync(f.root), dbPath: fs.realpathSync(f.dbPath) };
  const input = { peer: 'native-worker', from: 'coordinator', taskId: null, body: 'one receipt race' };
  const prepared = prepareCliSubmission(ctx, input);
  const receipt = await nativeRequest(ctx, 'POST', '/send', { ...input, submissionId: prepared.submission_id });
  const source = `
    import fs from 'node:fs';
    import { recordCliSubmissionReceipt } from ${JSON.stringify(new URL('../lib/runtime/native/cli-submissions.mjs', import.meta.url).href)};
    const original = fs.linkSync;
    fs.linkSync = (temporary, final) => {
      original(temporary, final);
      return original(temporary, final);
    };
    recordCliSubmissionReceipt(JSON.parse(process.argv[1]), JSON.parse(process.argv[2]), JSON.parse(process.argv[3]));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source,
    JSON.stringify(ctx), JSON.stringify(prepared), JSON.stringify(receipt)], {
    cwd: f.root, env: f.env, encoding: 'utf8', timeout: 15_000
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const journal = f.run('native', 'submissions');
  assert.equal(journal[0].receipt.message_id, receipt.message_id);
  f.withDb(db => assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE body='one receipt race'").get().n, 1));
});


test('native CLI keeps a prepared ID recoverable after a receipt writer is killed mid-write', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  f.start();
  const ctx = { root: fs.realpathSync(f.root), dbPath: fs.realpathSync(f.dbPath) };
  const input = { peer: 'native-worker', from: 'coordinator', taskId: null, body: 'receipt interrupted' };
  const prepared = prepareCliSubmission(ctx, input);
  const receipt = await nativeRequest(ctx, 'POST', '/send', { ...input, submissionId: prepared.submission_id });
  const source = `
    import fs from 'node:fs';
    import { recordCliSubmissionReceipt } from ${JSON.stringify(new URL('../lib/runtime/native/cli-submissions.mjs', import.meta.url).href)};
    const original = fs.writeFileSync;
    fs.writeFileSync = (fd, value, ...args) => {
      if (typeof fd === 'number' && typeof value === 'string' && value.includes('"message_id"')) {
        fs.writeSync(fd, value.slice(0, Math.ceil(value.length / 2)));
        process.kill(process.pid, 'SIGKILL');
      }
      return original(fd, value, ...args);
    };
    recordCliSubmissionReceipt(JSON.parse(process.argv[1]), JSON.parse(process.argv[2]), JSON.parse(process.argv[3]));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source,
    JSON.stringify(ctx), JSON.stringify(prepared), JSON.stringify(receipt)], {
    cwd: f.root, env: f.env, encoding: 'utf8', timeout: 15_000
  });
  assert.equal(child.signal, 'SIGKILL', child.stderr || child.stdout);
  assert.equal(f.run('native', 'submissions')[0].confirmation, 'unconfirmed');
  const retried = f.run('native', 'send', '--peer', input.peer, '--from', input.from,
    '--body', input.body, '--submission-id', prepared.submission_id);
  assert.equal(retried.message_id, receipt.message_id);
  assert.equal(f.run('native', 'submissions')[0].receipt.message_id, receipt.message_id);
  f.withDb(db => assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE body='receipt interrupted'").get().n, 1));
});
