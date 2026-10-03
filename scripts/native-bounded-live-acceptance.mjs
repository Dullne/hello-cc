// Opt-in short real-provider checks. Every model sees only generated nonces.
// No existing session is resumed and no tools or repository writes are requested.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createEventHelpers } from '../lib/db/events.mjs';
import { createConnectionHelpers } from '../lib/db/connection.mjs';
import { createPeerBindingStore } from '../lib/db/stores/peers.mjs';
import { createPeerHelpers } from '../lib/core/peers/peer-helpers.mjs';
import { createMessageStore } from '../lib/core/coordination/messages.mjs';
import { createEvidenceRuntime } from '../lib/core/peers/evidence-runtime.mjs';
import { detectBranch } from '../lib/runtime/project-context.mjs';
import { createNativeAdapter } from '../lib/integrations/native/index.mjs';
import { startNativeService } from '../lib/runtime/native/service.mjs';
import { nativeRequest } from '../lib/runtime/native/client.mjs';
import { readNativePointer } from '../lib/runtime/native/store.mjs';
import { redactSecrets } from '../lib/shared/redact.mjs';

const args = process.argv.slice(2);
if (!args.includes('--run-live') || args.includes('--help')) {
  console.log('Usage: node scripts/native-bounded-live-acceptance.mjs --run-live [--provider codex|claude|dsh|all] [--codex-bin PATH] [--dsh-bin PATH] [--claude-package DIR] [--output FILE]');
  console.log('Three short nonce-only turns per provider: first reply, remembered reply, owned close/resume. Existing caller credentials are used only in private temporary provider homes.');
  process.exit(0);
}
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const selection = option('--provider', 'all');
const providers = selection === 'all' ? ['codex', 'claude', 'dsh'] : [selection];
assert.ok(providers.every(value => ['codex', 'claude', 'dsh'].includes(value)), 'unknown provider');
assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Node 24+ required');
const repo = fileURLToPath(new URL('..', import.meta.url));
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-bounded-live-')));
fs.chmodSync(sandbox, 0o700);
const privateDir = name => { const dir = path.join(sandbox, name); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; };
const root = privateDir('project'), taskHome = privateDir('home');
const homes = Object.fromEntries(['codex', 'claude', 'dsh'].map(provider => [provider, privateDir(provider + '-home')]));
const output = path.resolve(option('--output', path.join(os.tmpdir(), 'hcc-bounded-live-' + randomUUID() + '.json')));
assert.ok(!output.startsWith(sandbox + path.sep), 'Receipt must be outside the temporary directory, which is removed after validation');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const originalCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const protectedFiles = ['config.toml', 'auth.json'].map(name => path.join(originalCodexHome, name)).filter(file => fs.existsSync(file));
const protectedBefore = Object.fromEntries(protectedFiles.map(file => [file, hash(file)]));
function sourceHashes() {
  const files = {};
  function walk(relative) {
    const file = path.join(repo, relative);
    if (fs.statSync(file).isDirectory()) for (const name of fs.readdirSync(file).sort()) walk(path.join(relative, name));
    else files[relative] = hash(file);
  }
  for (const relative of ['lib/integrations/native', 'lib/runtime/native', 'scripts/native-bounded-live-acceptance.mjs']) walk(relative);
  return files;
}
const report = { startedAt: new Date().toISOString(), node: process.version, sandbox, providers: {}, checks: [], cleanup: {},
  sourceFiles: sourceHashes(), mode: 'Real provider calls through native service and default production adapter loading; no browser or tool invocation claim',
  isolation: 'Private project, HOME and provider homes; only model routing/auth copied; caller account config hashes checked',
  limitations: ['No real approval, interruption, cross-provider tool, published package, installed device or business workflow acceptance is claimed.'] };
const check = name => { report.checks.push(name); console.log('PASS ' + name); };
const flush = () => { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(redactSecrets(report), null, 2) + '\n', { mode: 0o600 }); };
const now = () => Math.floor(Date.now() / 1000);
const events = createEventHelpers({ now }), bindings = createPeerBindingStore({ now, ...events });
const evidence = createEvidenceRuntime({ now });
const peers = createPeerHelpers({ now, ...events, ...evidence, detectBranch });
const messages = createMessageStore({ now, ...events });
const connections = createConnectionHelpers({ now, ...bindings, redactedLogText: value => redactSecrets(value) });
const deps = { ...connections, ...events, ...bindings, ...peers, ...messages, ...evidence, detectBranch };
const ctx = { root, cwd: root, dbPath: path.join(root, '.hello-cc', 'mesh.db') };
const api = (method, route, body) => nativeRequest(ctx, method, route, body, { timeoutMs: 45000 });
const observations = new Map();
let service, db;
function prepareCodex() {
  const file = path.join(originalCodexHome, 'config.toml');
  if (fs.existsSync(file)) {
    let section = '';
    const filtered = fs.readFileSync(file, 'utf8').split('\n').filter(line => {
      const heading = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/);
      if (heading) section = heading[1].split('.')[0].replaceAll('"', '').replaceAll("'", '');
      return section ? section === 'model_providers' : /^\s*(?:model(?:_provider|_reasoning_effort|_reasoning_summary|_verbosity|_catalog_json)?|cli_auth_credentials_store)\s*=/.test(line);
    });
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    let authSection = '', count = 0;
    const config = filtered.map(line => {
      const heading = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/); if (heading) authSection = heading[1];
      const command = authSection.endsWith('.auth') && line.match(/^\s*command\s*=\s*((?:"(?:[^"\\]|\\.)*"|'[^']*'))\s*(?:#.*)?$/);
      if (!command) return line;
      const original = command[1].startsWith("'") ? command[1].slice(1, -1) : JSON.parse(command[1]);
      const wrapper = path.join(privateDir('credential-commands'), 'command-' + ++count);
      fs.writeFileSync(wrapper, '#!/bin/sh\nexport HOME=' + quote(os.homedir()) + '\nexec ' + quote(original) + ' "$@"\n', { mode: 0o700 });
      return 'command = ' + JSON.stringify(wrapper);
    }).join('\n');
    report.authenticationHelperHomePreserved = count > 0;
    fs.writeFileSync(path.join(homes.codex, 'config.toml'), config + '\n', { mode: 0o600 });
  }
  const auth = path.join(originalCodexHome, 'auth.json');
  if (fs.existsSync(auth)) { fs.copyFileSync(auth, path.join(homes.codex, 'auth.json')); fs.chmodSync(path.join(homes.codex, 'auth.json'), 0o600); }
}
async function complete(peer, sent, expected) {
  const deadline = Date.now() + 90000; let notice = Date.now() + 20000;
  while (Date.now() < deadline) {
    const state = await api('GET', '/workers/' + peer + '/state');
    assert.equal(state.snapshot.pendingApprovals?.length || 0, 0, 'Nonce-only turn must not request tools or approval');
    const row = state.deliveries.find(value => value.message_id === sent.message_id);
    if (['completed', 'failed', 'uncertain'].includes(row?.state)) {
      assert.equal(row.state, 'completed', JSON.stringify({ state: row.state, evidence: row.evidence }));
      const reply = db.prepare("SELECT * FROM messages WHERE reply_to=? AND kind='reply'").get(sent.message_id);
      assert.ok(reply, 'successful ask must write a correlated reply');
      assert.equal(reply.thread_id, sent.message_id); assert.equal(reply.body.trim(), expected);
      assert.ok(db.prepare('SELECT read_at FROM message_reads WHERE peer=? AND message_id=?').get(peer, sent.message_id));
      return { messageId: sent.message_id, turnId: row.turn_id, replyId: reply.id, exactNonce: true, acked: true };
    }
    if (Date.now() >= notice) { console.log('WAIT ' + peer + ' short nonce reply'); notice += 20000; }
    await delay(150);
  }
  throw new Error('Timed out waiting for bounded real-provider nonce turn');
}
try {
  if (providers.includes('codex')) prepareCodex();
  if (providers.includes('claude') && option('--claude-package')) {
    const installed = fs.realpathSync(option('--claude-package'));
    const pkg = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
    assert.equal(pkg.name, '@anthropic-ai/claude-agent-sdk');
    const scoped = path.join(root, 'node_modules/@anthropic-ai'); fs.mkdirSync(scoped, { recursive: true, mode: 0o700 });
    fs.symlinkSync(installed, path.join(scoped, 'claude-agent-sdk'), 'dir');
    report.claudeSdk = { version: pkg.version, entrySha256: hash(path.join(installed, 'sdk.mjs')), queryInjected: false, resolution: 'Default loader through optional SDK in temporary worker project' };
  }
  db = deps.connect(ctx, { migrateRegistered: false });
  service = await startNativeService(ctx, deps, { adapterFactory: (provider, options) => {
    const peer = options.env.HCC_PEER;
    return createNativeAdapter(provider, { ...options, timeoutMs: 30000, env: { ...options.env,
      PATH: path.dirname(process.execPath) + ':' + process.env.PATH, HOME: taskHome,
      CODEX_HOME: homes.codex, CLAUDE_CONFIG_DIR: homes.claude, DSH_HOME: homes.dsh,
      DSH_TELEMETRY_DISABLED: '1', HCC_SHIM_ENSURED: '1', HCC_SHIM_NO_ATTACH: '1' },
      onEvent: event => {
        const list = observations.get(peer) || [];
        list.push({ type: event.type, turnId: event.turnId || null, sessionId: event.sessionId || null,
          ...(event.type === 'error' ? { code: event.code, message: redactSecrets(event.message) } : {}) });
        if (list.length > 200) list.shift(); observations.set(peer, list); options.onEvent(event);
      } });
  } });
  for (const provider of providers) {
    const peer = 'bounded-' + provider;
    const result = report.providers[provider] = { status: 'running', prompts: 0, turns: [] };
    try {
      if (provider === 'dsh') assert.ok(process.env.DEEPSEEK_API_KEY, 'Existing DEEPSEEK_API_KEY is required');
      const binary = provider === 'codex' ? option('--codex-bin', 'codex') : provider === 'dsh' ? option('--dsh-bin', 'dsh') : null;
      if (binary) result.version = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 10000, env: { ...process.env, HOME: taskHome, CODEX_HOME: homes.codex, DSH_HOME: homes.dsh } }).trim();
      const start = () => api('POST', '/workers', { peer, provider, ...(binary ? { binary } : {}) });
      await start();
      const nonce = 'HCC_NONCE_' + randomUUID().replaceAll('-', '').slice(0, 16);
      const prompts = [
        'Remember this nonce in this conversation: ' + nonce + '. Reply with only that nonce. Do not use tools, run commands, read files, delegate or modify files.',
        'Without tools or reading files, reply only with the nonce you were asked to remember earlier.',
        'After reconnecting this saved session, reply only with the nonce from earlier. Do not use tools or read files.'
      ];
      for (let index = 0; index < prompts.length; index++) {
        if (index === 2) { await api('POST', '/close', { peer }); await api('POST', '/workers', { peer, provider, ...(binary ? { binary } : {}), resume: 'last' }); }
        const input = { peer, from: 'bounded-acceptance', body: prompts[index], submissionId: randomUUID() };
        const sent = await api('POST', '/send', input); result.prompts++;
        if (index === 0) assert.equal((await api('POST', '/send', input)).message_id, sent.message_id);
        result.turns.push(await complete(peer, sent, nonce));
        const state = await api('GET', '/workers/' + peer + '/state');
        assert.ok(state.snapshot.sessionId); if (result.sessionId) assert.equal(state.snapshot.sessionId, result.sessionId);
        result.sessionId = state.snapshot.sessionId;
        check(provider + ': ' + ['real reply and idempotent queue', 'memory in existing owned session', 'owned close/resume keeps identity and memory'][index]);
      }
      result.status = 'passed';
    } catch (error) {
      result.status = 'failed'; result.error = { code: error.code || 'ACCEPTANCE_FAILED', message: redactSecrets(error.message) };
      console.log(JSON.stringify({ provider, failure: result.error }));
    } finally {
      result.events = observations.get(peer) || [];
      try { await api('POST', '/close', { peer }); result.closed = true; } catch (error) { result.closed = false; result.closeError = redactSecrets(error.message); }
      flush();
    }
  }
} catch (error) { report.fatalError = { code: error.code || 'ACCEPTANCE_FAILED', message: redactSecrets(error.message) }; }
finally {
  try { await service?.shutdown(); report.cleanup.runtimeStopped = !readNativePointer(ctx); }
  catch (error) { report.cleanup.runtimeStopped = false; report.cleanup.runtimeError = redactSecrets(error.message); }
  db?.close();
  report.protectedConfigUnchanged = protectedFiles.every(file => fs.existsSync(file) && hash(file) === protectedBefore[file]);
  const after = sourceHashes();
  report.sourceChanges = [...new Set([...Object.keys(report.sourceFiles), ...Object.keys(after)])].filter(file => report.sourceFiles[file] !== after[file]);
  try { fs.rmSync(sandbox, { recursive: true, force: true }); report.cleanup.temporaryProjectAndCredentialsRemoved = !fs.existsSync(sandbox); }
  catch (error) { report.cleanup.temporaryProjectAndCredentialsRemoved = false; report.cleanup.directoryError = redactSecrets(error.message); }
  report.success = !report.fatalError && providers.every(provider => report.providers[provider]?.status === 'passed') && report.protectedConfigUnchanged && !report.sourceChanges.length && report.cleanup.runtimeStopped && report.cleanup.temporaryProjectAndCredentialsRemoved;
  report.finishedAt = new Date().toISOString(); flush();
}
console.log(JSON.stringify({ receipt: output, success: report.success, providers: Object.fromEntries(Object.entries(report.providers).map(([name, result]) => [name, result.status])), cleanup: report.cleanup }));
process.exitCode = report.success ? 0 : 1;
