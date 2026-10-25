// Actual SDK, CLI subprocess and production adapter; optional local Messages
// fixture isolates transcript/fork behavior from model recall and credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createClaudeAdapter } from '../lib/integrations/native/claude.mjs';
import { redactSecrets } from '../lib/shared/redact.mjs';

const args = process.argv.slice(2);
if (args.includes('--help') || (!args.includes('--fixture') && !args.includes('--run-live'))) {
  console.log('Usage: node scripts/claude-fork-acceptance.mjs --fixture|--run-live [--claude-package DIR] [--output FILE]');
  console.log('--fixture uses a local Messages server, no model or credentials. --run-live copies existing model routing/auth into a private provider home and consumes quota.');
  process.exit(0);
}
const flags = new Set(['--fixture', '--run-live']), values = new Set(['--claude-package', '--output']);
const options = new Map();
for (let index = 0; index < args.length; index++) {
  const name = args[index];
  assert.ok(!options.has(name) && (flags.has(name) || values.has(name)), 'Unknown or repeated option');
  if (flags.has(name)) options.set(name, true);
  else { assert.ok(args[index + 1] && !args[index + 1].startsWith('--'), 'Missing option value'); options.set(name, args[++index]); }
}
assert.notEqual(Boolean(options.get('--fixture')), Boolean(options.get('--run-live')), 'Select exactly one mode');
assert.ok(['linux', 'darwin'].includes(process.platform), 'Run inside Linux, macOS or WSL');
const live = Boolean(options.get('--run-live'));
const repo = fileURLToPath(new URL('..', import.meta.url));
const output = path.resolve(options.get('--output') || path.join(os.tmpdir(), 'hcc-claude-fork-' + randomUUID() + '.json'));
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-claude-fork-')));
fs.chmodSync(sandbox, 0o700);
const root = path.join(sandbox, 'project'), home = path.join(sandbox, 'home'), providerHome = path.join(home, '.claude');
for (const directory of [root, home, providerHome]) fs.mkdirSync(directory, { mode: 0o700 });
const hash = value => createHash('sha256').update(value).digest('hex');
const digest = file => hash(fs.readFileSync(file));
const sourceFiles = Object.fromEntries(['scripts/claude-fork-acceptance.mjs', 'lib/integrations/native/claude.mjs',
  'lib/integrations/native/interactions.mjs', 'lib/process/selected-cwd-identity.mjs'].map(name => [name, digest(path.join(repo, name))]));
const originalEnv = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
const settings = path.join(originalEnv.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
const protectedBefore = fs.existsSync(settings) ? digest(settings) : null;
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), sourceFiles,
  mode: live ? 'real configured model' : 'deterministic local Messages fixture; actual SDK and CLI subprocess',
  modelCallsRequested: live, realModelCalls: false, queryInjected: false, checks: [], snapshots: [], requests: [], cleanup: {}, success: false,
  limitations: ['Adapter/SDK transcript and recall acceptance; native service ownership guards are covered separately.',
    'A successful routed model call establishes only the model actually reported, not Anthropic model acceptance.'] };
const flush = () => { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(redactSecrets(report), null, 2) + '\n', { mode: 0o600 }); };
const check = name => { report.checks.push(name); console.log('PASS ' + name); flush(); };
const adapters = [], observations = new Map();
let server, sdk;
function adapter(name) {
  const events = [];
  const value = createClaudeAdapter({ cwd: root, env: { ...process.env, HCC_SHIM_ENSURED: '1', HCC_SHIM_NO_ATTACH: '1' },
    executorId: randomUUID(), timeoutMs: 15000,
    onEvent(event) {
      if (event.type === 'metadata') report.reportedModel = event.runtimeMetadata?.model || report.reportedModel;
      if (event.type === 'completed') events.push({ type: event.type, turnId: event.turnId, status: event.status, text: event.text });
    } });
  adapters.push({ name, value }); observations.set(value, events); return value;
}
async function turn(value, prompt, expected) {
  const sent = await value.send({ text: prompt, submissionId: randomUUID() });
  const deadline = Date.now() + 90000;
  let completion;
  while (!(completion = observations.get(value).find(event => event.turnId === sent.turnId)) && Date.now() < deadline) {
    const state = value.snapshot();
    assert.equal(state.pendingApprovals?.length || 0, 0, 'Nonce-only fork test must never approve tools');
    assert.ok(!state.error, 'Unexpected SDK error during fork acceptance');
    await delay(50);
  }
  assert.ok(completion, 'Fork acceptance turn timed out');
  if (live) report.realModelCalls = true;
  assert.equal(completion.status, 'completed');
  // Persist a non-sensitive actual/expected digest even when the assertion fails.
  report.lastTurn = { sessionId: value.snapshot().sessionId, turnId: sent.turnId,
    actualSha256: hash(completion.text || ''), expectedSha256: hash(expected), matches: completion.text?.trim() === expected };
  flush(); assert.equal(completion.text?.trim(), expected);
}
async function history(sessionId, label) {
  const messages = (await sdk.getSessionMessages(sessionId, { dir: root })).filter(message => ['user', 'assistant'].includes(message.type));
  const snapshot = { label, sessionId, messages: messages.length,
    contentHashes: messages.map(message => hash(JSON.stringify({ type: message.type, message: message.message }))),
    messageIds: messages.map(message => message.uuid) };
  report.snapshots.push(snapshot); flush(); return snapshot;
}
async function assertCopied(parentId, childId, label) {
  // Capture both immediately after fork and before the child's first query.
  const parent = await history(parentId, label + ': parent'), child = await history(childId, label + ': child before first query');
  assert.ok(parent.messages >= 2, 'Parent transcript must include the seed turn');
  assert.deepEqual(child.contentHashes, parent.contentHashes, 'Fork must copy the whole parent history before recall');
  check(label + ': complete parent/child transcript copy before first child query');
}
function fixtureText(messages) {
  const users = messages.filter(message => message.role === 'user').map(message =>
    typeof message.content === 'string' ? message.content : (message.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n'));
  const seed = users.join('\n').match(/HCC_FORK_SEED (HCC_BASE_[a-f0-9]+)\|(HCC_BRANCH_[a-f0-9]+)/);
  let branch = seed?.[2];
  for (const text of users) { const changed = /HCC_FORK_SET (HCC_BRANCH_[a-f0-9]+)/.exec(text); if (changed) branch = changed[1]; }
  report.requests.push({ historyHasSeed: Boolean(seed), userMessages: users.length, branchSha256: branch ? hash(branch) : null });
  return seed ? seed[1] + '|' + branch : 'MISSING_CONTEXT';
}
function stream(response, model, text) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (type, value) => response.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...value }) + '\n\n');
  event('message_start', { message: { id: 'msg_' + randomUUID().replaceAll('-', ''), type: 'message', role: 'assistant', model,
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
  event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  event('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
  event('content_block_stop', { index: 0 });
  event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
  event('message_stop', {}); response.end();
}
try {
  if (options.get('--claude-package')) {
    const installed = fs.realpathSync(path.resolve(options.get('--claude-package')));
    const pkg = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
    assert.equal(pkg.name, '@anthropic-ai/claude-agent-sdk');
    const scope = path.join(root, 'node_modules', '@anthropic-ai'); fs.mkdirSync(scope, { recursive: true, mode: 0o700 });
    fs.symlinkSync(installed, path.join(scope, 'claude-agent-sdk'), 'dir');
  }
  const entry = createRequire(path.join(root, 'package.json')).resolve('@anthropic-ai/claude-agent-sdk');
  report.sdk = { entrySha256: digest(entry), version: JSON.parse(fs.readFileSync(path.join(path.dirname(entry), 'package.json'), 'utf8')).version };
  process.env.HOME = home; process.env.CLAUDE_CONFIG_DIR = providerHome;
  if (live) {
    if (protectedBefore) {
      const source = JSON.parse(fs.readFileSync(settings, 'utf8'));
      const env = Object.fromEntries(Object.entries(source.env || {}).filter(([key, value]) => key.startsWith('ANTHROPIC_') && typeof value === 'string'));
      fs.writeFileSync(path.join(providerHome, 'settings.json'), JSON.stringify({ env,
        ...(typeof source.model === 'string' ? { model: source.model } : {}) }), { mode: 0o600 });
    }
  } else {
    server = http.createServer(async (request, response) => {
      try {
        assert.equal(request.method, 'POST'); assert.match(request.url, /^\/v1\/messages(?:\?|$)/);
        const chunks = []; let size = 0;
        for await (const chunk of request) { size += chunk.length; assert.ok(size <= 2 * 1024 * 1024); chunks.push(chunk); }
        assert.ok(report.requests.length < 10, 'Fixture request bound exceeded');
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const text = fixtureText(body.messages);
        if (body.stream) stream(response, body.model, text);
        else { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: body.model,
          content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })); }
      } catch { response.writeHead(500); response.end(JSON.stringify({ error: { type: 'api_error', message: 'Fixture protocol failure' } })); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    fs.writeFileSync(path.join(providerHome, 'settings.json'), JSON.stringify({ model: 'claude-sonnet-4-5-20250929', env: {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + server.address().port, ANTHROPIC_API_KEY: 'local-fixture-no-credential',
      ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } }), { mode: 0o600 });
  }
  sdk = await import(pathToFileURL(entry).href);
  assert.equal(typeof sdk.forkSession, 'function'); assert.equal(typeof sdk.getSessionMessages, 'function');
  const base = 'HCC_BASE_' + randomUUID().replaceAll('-', '').slice(0, 16);
  const initial = 'HCC_BRANCH_' + randomUUID().replaceAll('-', '').slice(0, 16);
  const changed = 'HCC_BRANCH_' + randomUUID().replaceAll('-', '').slice(0, 16);
  const recall = 'HCC_FORK_RECALL: Without tools or reading files, reply only with the full base|branch values established earlier, including the original HCC_BASE_ and HCC_BRANCH_ prefixes and their hexadecimal suffixes. Do not infer or invent missing values.';
  const parent = adapter('parent'); await parent.open();
  await turn(parent, 'HCC_FORK_SEED ' + base + '|' + initial + '. Remember both complete values in this conversation. Reply with exactly this complete string including both HCC_ prefixes: ' + base + '|' + initial + '. Do not use tools or read files.', base + '|' + initial);
  const parentId = parent.snapshot().sessionId;
  const child = adapter('child'); await child.open({ forkSessionId: parentId });
  const childId = child.snapshot().sessionId; assert.ok(childId && childId !== parentId);
  await assertCopied(parentId, childId, 'open-parent fork');
  if (!live) assert.equal(report.requests.length, 1, 'Fork must not perform hidden inference');
  await turn(child, recall, base + '|' + initial); check('first child turn recalls both copied values without prompt replay');
  await turn(child, 'HCC_FORK_SET ' + changed + '. Replace only the branch value, keep the original full base value, and reply only with base|branch including the HCC_BASE_ and HCC_BRANCH_ prefixes and hexadecimal suffixes. No tools or file reads.', base + '|' + changed);
  const parentBefore = await history(parentId, 'parent after child-only branch change');
  await turn(parent, recall, base + '|' + initial); check('child branch update leaves parent model-visible values intact');
  const childBeforeResume = await history(childId, 'child before close/resume');
  assert.ok(childBeforeResume.messages > parentBefore.messages);
  await child.close();
  const resumed = adapter('resumed-child'); await resumed.open({ sessionId: childId });
  await turn(resumed, recall, base + '|' + changed);
  assert.equal(resumed.snapshot().sessionId, childId); check('child close/resume retains its own identity and changed branch');
  await parent.close();
  const closedFork = adapter('closed-parent-child'); await closedFork.open({ forkSessionId: parentId });
  const closedForkId = closedFork.snapshot().sessionId;
  assert.ok(closedForkId && closedForkId !== childId && closedForkId !== parentId);
  await assertCopied(parentId, closedForkId, 'closed-parent fork');
  await turn(closedFork, recall, base + '|' + initial); check('closed-parent fork recalls the original branch with a distinct identity');
  report.completed = true;
} catch (error) {
  report.error = { code: error.code || 'ACCEPTANCE_FAILED', message: redactSecrets(error.message).slice(0, 1500) };
  if (sdk?.getSessionMessages) for (const { name, value } of adapters) {
    const sessionId = value.snapshot().sessionId;
    if (sessionId) try { await history(sessionId, 'failure: ' + name); } catch { /* Preserve earlier snapshots. */ }
  }
} finally {
  const closed = await Promise.allSettled(adapters.map(({ value }) => value.close()));
  report.cleanup.adaptersClosed = closed.every(value => value.status === 'fulfilled');
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  report.protectedSettingsUnchanged = protectedBefore === null ? !fs.existsSync(settings) : fs.existsSync(settings) && digest(settings) === protectedBefore;
  report.sourceChanges = Object.entries(sourceFiles).filter(([name, before]) => digest(path.join(repo, name)) !== before).map(([name]) => name);
  try { fs.rmSync(sandbox, { recursive: true, force: true }); report.cleanup.privateProjectAndHomeRemoved = !fs.existsSync(sandbox); }
  catch { report.cleanup.privateProjectAndHomeRemoved = false; }
  report.success = report.completed === true && !report.error && report.cleanup.adaptersClosed && report.cleanup.privateProjectAndHomeRemoved && report.protectedSettingsUnchanged && !report.sourceChanges.length;
  report.finishedAt = new Date().toISOString(); flush();
}
console.log(JSON.stringify({ output, success: report.success, realModelCalls: report.realModelCalls, checks: report.checks.length, error: report.error, cleanup: report.cleanup }));
process.exitCode = report.success ? 0 : 1;
