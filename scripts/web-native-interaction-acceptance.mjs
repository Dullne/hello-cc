// Opt-in, real model + browser acceptance for original native workers.
// Uses isolated project/provider homes/socket; no query or request injection.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { initSchema } from '../lib/db/schema.mjs';
import { createEventHelpers } from '../lib/db/events.mjs';
import { createPeerHelpers } from '../lib/core/peers/peer-helpers.mjs';
import { createPeerBindingStore } from '../lib/db/stores/peers.mjs';
import { createMessageStore } from '../lib/core/coordination/messages.mjs';
import { inspectProcessIdentity } from '../lib/process/identity.mjs';
import { createNativeAdapter } from '../lib/integrations/native/index.mjs';
import { startNativeService } from '../lib/runtime/native/service.mjs';
import { nativeRequest } from '../lib/runtime/native/client.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
if (!args.includes('--run-live')) {
  console.log('Usage: node scripts/web-native-interaction-acceptance.mjs --run-live [--provider codex|claude|all] [--codex-bin PATH] [--claude-package DIR] [--output FILE]');
  console.log('Set HCC_ACCEPTANCE_PLAYWRIGHT and optionally HCC_ACCEPTANCE_CHROME. Claude uses default SDK resolution; --claude-package links an installed package into the isolated worker project.');
  process.exit(0);
}
const providers = option('--provider', 'codex') === 'all' ? ['codex', 'claude'] : [option('--provider', 'codex')];
assert.ok(providers.every(value => ['codex', 'claude'].includes(value)), 'unknown provider');
const repo = fileURLToPath(new URL('..', import.meta.url));
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-live-web-interactions-')));
fs.chmodSync(directory, 0o700);
const root = path.join(directory, 'project'), bin = path.join(directory, 'bin');
const codexHome = path.join(directory, 'codex-home'), claudeHome = path.join(directory, 'claude-home');
const outside = path.join(directory, 'requested-write');
for (const folder of [root, bin, codexHome, claudeHome, outside, path.join(root, '.hello-cc')]) fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const originalHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const protectedFiles = ['config.toml', 'auth.json'].map(name => path.join(originalHome, name)).filter(file => fs.existsSync(file));
const protectedHashes = protectedFiles.map(file => [file, digest(file)]);
const sourceHashes = () => Object.fromEntries(['lib/integrations/codex-interactions.mjs', 'lib/integrations/native/codex.mjs', 'lib/integrations/native/claude.mjs', 'lib/integrations/native/interactions.mjs', 'lib/runtime/native/service.mjs', 'lib/web/native-sessions.mjs', 'lib/web/ui-native.mjs', 'lib/web/ui-interactions.mjs', 'scripts/web-native-interaction-acceptance.mjs'].map(name => [name, digest(path.join(repo, name))]));
const evidence = { startedAt: new Date().toISOString(), directory, sourceFiles: sourceHashes(), providers: {}, checks: [], screenshots: [], pageErrors: [], consoleErrors: [], completed: false,
  browser: 'Browser plugin not available; isolated installed Chrome and Playwright', modelInferenceCalled: false };
const output = path.resolve(option('--output', path.join(directory, 'evidence.json')));
const tmux = process.env.HCC_ACCEPTANCE_TMUX || '/opt/homebrew/bin/tmux';
const socket = 'hcc-interactions-' + randomUUID();
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\nexec ' + quote(tmux) + ' -L ' + quote(socket) + ' "$@"\n', { mode: 0o700 });
const env = { ...process.env, PATH: bin + ':' + path.dirname(process.execPath) + ':' + process.env.PATH, CODEX_HOME: codexHome,
  HCC_SHIM_ENSURED: '1', HCC_SHIM_NO_ATTACH: '1', HCC_NO_AUTO_INSTALL_TMUX: '1', HCC_WEB_TOKEN: randomUUID() };
for (const key of Object.keys(env)) if (key.startsWith('HCC_') && !['HCC_WEB_TOKEN', 'HCC_NO_AUTO_INSTALL_TMUX', 'HCC_SHIM_ENSURED', 'HCC_SHIM_NO_ATTACH'].includes(key)) delete env[key];
const ctx = { root, dbPath: path.join(root, '.hello-cc', 'mesh.db') };
const connect = () => { const db = new DatabaseSync(ctx.dbPath); initSchema(db); return db; };
const events = createEventHelpers(), bindings = createPeerBindingStore(events), peers = createPeerHelpers({ ...events, now: () => Math.floor(Date.now() / 1000) });
const deps = { ...events, ...bindings, ...peers, ...createMessageStore(events), connect, detectBranch: () => '', liveProcessIdentity: pid => inspectProcessIdentity(pid).identity };
const api = (method, route, body) => nativeRequest(ctx, method, route, body, { timeoutMs: 30000 });
function hcc(...params) {
  const result = spawnSync(process.execPath, [path.join(repo, 'bin/hcc.mjs'), '--root', root, ...params], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0) throw new Error('Isolated HCC CLI failed: ' + params[0]);
}
function check(name, details = {}) { evidence.checks.push({ name, passed: true, ...details }); console.log('PASS ' + name); }
async function until(predicate, label, timeout = 180000) {
  const deadline = Date.now() + timeout; let notice = Date.now() + 20000;
  while (Date.now() < deadline) {
    const result = await predicate(); if (result) return result;
    if (Date.now() >= notice) { console.log('WAIT ' + label); notice += 20000; }
    await delay(150);
  }
  throw new Error('Timed out: ' + label);
}
let service, browser, runtimeStarted = false;
try {
  assert.ok(fs.existsSync(tmux), 'tmux must be installed');
  assert.ok(process.env.HCC_ACCEPTANCE_PLAYWRIGHT, 'Set HCC_ACCEPTANCE_PLAYWRIGHT');
  if (providers.includes('codex')) {
    const source = fs.readFileSync(path.join(originalHome, 'config.toml'), 'utf8'); let section = '';
    const config = source.split('\n').filter(line => {
      const header = line.match(/^\s*\[\[?([^\]]+)\]\]?/); if (header) section = header[1].split('.')[0].replaceAll('"', '').replaceAll("'", '');
      return section ? section === 'model_providers' : /^\s*(?:model(?:_provider|_reasoning_effort|_reasoning_summary|_verbosity|_catalog_json)?|cli_auth_credentials_store)\s*=/.test(line);
    }).join('\n');
    fs.writeFileSync(path.join(codexHome, 'config.toml'), config + '\n', { mode: 0o600 });
    if (fs.existsSync(path.join(originalHome, 'auth.json'))) { fs.copyFileSync(path.join(originalHome, 'auth.json'), path.join(codexHome, 'auth.json')); fs.chmodSync(path.join(codexHome, 'auth.json'), 0o600); }
    evidence.providers.codex = { version: spawnSync(option('--codex-bin', '/opt/homebrew/bin/codex'), ['--version'], { env, encoding: 'utf8', timeout: 5000 }).stdout.trim(), featureConfiguration: 'HCC per-thread interactive tool switches; no acceptance-only switches' };
  }
  if (providers.includes('claude') && option('--claude-package')) {
    const installed = fs.realpathSync(option('--claude-package'));
    const pkg = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
    assert.equal(pkg.name, '@anthropic-ai/claude-agent-sdk');
    const scoped = path.join(root, 'node_modules/@anthropic-ai'); fs.mkdirSync(scoped, { recursive: true });
    fs.symlinkSync(installed, path.join(scoped, 'claude-agent-sdk'), 'dir');
    evidence.providers.claude = { sdkVersion: pkg.version, dependencyResolution: 'default loader: optional SDK installed in isolated worker project; no query injection' };
  }
  hcc('up', '--no-discover', '--no-guidance');
  service = await startNativeService(ctx, deps, { adapterFactory: (provider, options) => createNativeAdapter(provider, { ...options,
    env: { ...options.env, ...(provider === 'codex' ? { CODEX_HOME: codexHome } : { CLAUDE_CONFIG_DIR: claudeHome }) } }) });
  for (const provider of providers) await api('POST', '/workers', { peer: 'live-' + provider, provider, ...(provider === 'codex' ? { binary: option('--codex-bin', '/opt/homebrew/bin/codex') } : {}) });
  const port = await new Promise(resolve => { const listener = net.createServer(); listener.listen(0, '127.0.0.1', () => { const port = listener.address().port; listener.close(() => resolve(port)); }); });
  hcc('web', '--local', '--port', String(port), '--no-discover', '--no-guidance'); runtimeStarted = true;
  const { chromium } = await import(process.env.HCC_ACCEPTANCE_PLAYWRIGHT);
  browser = await chromium.launch({ headless: true, ...(process.env.HCC_ACCEPTANCE_CHROME ? { executablePath: process.env.HCC_ACCEPTANCE_CHROME } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('dialog', dialog => dialog.accept());
  page.on('pageerror', error => evidence.pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') evidence.consoleErrors.push(message.text()); });
  await page.goto('http://127.0.0.1:' + port + '/?token=' + env.HCC_WEB_TOKEN);
  async function state(peer) { return api('GET', '/workers/' + peer + '/state'); }
  async function finish(peer, submission) {
    return until(async () => {
      const value = await state(peer), delivery = value.deliveries.find(row => row.submission_id === submission);
      if (['failed', 'uncertain'].includes(delivery?.state)) throw new Error(peer + ' delivery ended as ' + delivery.state);
      if (delivery?.state === 'completed') { evidence.modelInferenceCalled = true; return value; }
      return false;
    }, peer + ' real model completion');
  }
  async function selectPeer(peer) {
    await page.waitForFunction(() => Boolean(window.hccHandoff?.session), null, { timeout: 15000 });
    if (await page.evaluate(() => window.hccHandoff.active) !== peer) await page.locator('#sessions [data-id="' + peer + '"] .session-select').click();
    await page.waitForFunction(peer => window.hccHandoff?.session?.id === peer, peer, { timeout: 15000 });
    await page.waitForFunction(() => Boolean(window.hccHandoff.actionToken), null, { timeout: 15000 });
    if (!await page.evaluate(() => window.hccHandoff.canControl)) await page.locator('#claimControlBtn').click();
    await page.waitForFunction(() => window.hccHandoff.canControl, null, { timeout: 15000 });
  }
  async function submit(peer, prompt) {
    const before = new Set((await state(peer)).deliveries.map(row => row.submission_id));
    await page.locator('#nativeDraft').fill(prompt); await page.locator('#nativeSend').click();
    return until(async () => (await state(peer)).deliveries.find(row => row.submission_id.startsWith('s_') && !before.has(row.submission_id)), peer + ' browser submission', 15000);
  }
  async function pending(peer, kind) {
    return until(async () => { const value = await state(peer); const request = value.snapshot.pendingApprovals?.find(request => request.kind === kind); if (request) evidence.modelInferenceCalled = true; return request; }, peer + ' ' + kind);
  }
  async function shot(name) { const target = path.join(directory, name + '.png'); await page.screenshot({ path: target }); evidence.screenshots.push(target); }
  for (const provider of providers) {
    const peer = 'live-' + provider, result = evidence.providers[provider] ||= {}, allowed = path.join(outside, provider + '-allowed.txt');
    const denied = path.join(directory, provider + '-denied', 'must-not-exist.txt');
    fs.mkdirSync(path.dirname(denied), { mode: 0o700 });
    await selectPeer(peer);
    if (provider === 'codex') {
      const delivery = await submit(peer, 'Use request_user_input now to ask me which marker to write: Cobalt or Amber, with those exact option labels. Wait for my choice. Then call request_permissions to request write access only to ' + allowed + '. Wait for approval. After approval write the chosen marker to that exact file and end with INTERACTION_ACCEPTED_OK. Use only bounded file operations. Do not bypass permission checks or use command escalation.');
      const question = await pending(peer, 'userInput');
      result.question = { method: question.method, requestId: question.requestId, sessionId: question.sessionId, turnId: question.turnId };
      await page.locator('#nativeApprovals [data-question="0"]').waitFor({ timeout: 15000 });
      const choices = await page.locator('#nativeApprovals [data-question="0"] option').allTextContents();
      const cobalt = choices.findIndex(value => value.includes('Cobalt')); assert.ok(cobalt > 0);
      await page.locator('#nativeApprovals [data-question="0"]').selectOption(String(cobalt - 1)); await shot('codex-real-question');
      await page.locator('#nativeApprovals button[data-decision="accept"]').click();
      const permission = await pending(peer, 'permissions');
      assert.equal(permission.sessionId, question.sessionId); assert.equal(permission.turnId, question.turnId);
      const requested = JSON.stringify(permission.params.permissions); assert.ok(requested.includes(allowed));
      result.permission = { method: permission.method, requestId: permission.requestId, sessionId: permission.sessionId, turnId: permission.turnId, requested: permission.params.permissions };
      await page.locator('#nativeApprovals [data-scope]').waitFor({ timeout: 15000 });
      const permissionFields = page.locator('#nativeApprovals input[data-permission]');
      assert.equal(await permissionFields.count(), 1, 'request must contain only the single bounded filesystem permission');
      await permissionFields.check(); await page.locator('#nativeApprovals [data-scope]').selectOption('turn'); await shot('codex-real-permission');
      await page.locator('#nativeApprovals button[data-decision="accept"]').click(); await finish(peer, delivery.submission_id);
      assert.equal(fs.readFileSync(allowed, 'utf8').trim(), 'Cobalt');
      result.sessionId = question.sessionId; check('Codex model question and exact turn-scoped permission answered through Web on the original turn');
      const declined = await submit(peer, 'Call request_permissions for write access only to ' + denied + '. If approval is declined, do not try to write and end normally with INTERACTION_DECLINED_OK. Do not use escalation or any other paths.');
      const request = await pending(peer, 'permissions'); assert.equal(request.sessionId, result.sessionId);
      await page.locator('#nativeApprovals button[data-decision="decline"]').waitFor({ timeout: 15000 }); await page.locator('#nativeApprovals button[data-decision="decline"]').click();
      await finish(peer, declined.submission_id); assert.equal(fs.existsSync(denied), false);
      check('Codex model respects a declined real filesystem permission');
    } else {
      const delivery = await submit(peer, 'Use the Write tool to write exactly CLAUDE_APPROVED_OK to ' + allowed + '. Await the user permission decision. Do not use Bash or any workaround. End normally after the tool result.');
      const request = await pending(peer, 'approval'); assert.equal(request.method, 'claude/canUseTool'); assert.equal(request.params.tool, 'Write');
      assert.equal(request.params.input.file_path, allowed); result.permission = { method: request.method, tool: request.params.tool, requestId: request.requestId, turnId: request.turnId };
      await page.locator('#nativeApprovals button[data-decision="accept"]').waitFor({ timeout: 15000 }); await shot('claude-real-permission');
      await page.locator('#nativeApprovals button[data-decision="accept"]').click(); await finish(peer, delivery.submission_id);
      assert.equal(fs.readFileSync(allowed, 'utf8').trim(), 'CLAUDE_APPROVED_OK');
      result.sessionId = (await state(peer)).snapshot.sessionId; check('Default-loaded Claude SDK real Write approval returns to the original model turn');
      const declined = await submit(peer, 'Use the Write tool to write CLAUDE_DENIED to ' + denied + '. If permission is declined, do not retry or use any workaround and finish normally.');
      const refusal = await pending(peer, 'approval'); assert.equal(refusal.params.tool, 'Write'); assert.equal(refusal.params.input.file_path, denied);
      await page.locator('#nativeApprovals button[data-decision="decline"]').waitFor({ timeout: 15000 }); await page.locator('#nativeApprovals button[data-decision="decline"]').click();
      await finish(peer, declined.submission_id); assert.equal(fs.existsSync(denied), false); check('Claude model respects a declined real Write operation');
    }
    await page.locator('#releaseControlBtn').click(); await page.waitForFunction(() => !window.hccHandoff.canControl);
    const followup = await api('POST', '/send', { peer, from: 'acceptance-local', submissionId: randomUUID(), body: 'No tool calls. Return INTERACTION_LOCAL_RETURN_OK.' });
    const after = await finish(peer, followup.submission_id); assert.equal(after.snapshot.sessionId, result.sessionId);
    result.completed = true; check(provider + ' local return retains original provider session');
  }
  assert.deepEqual(evidence.pageErrors, []); assert.deepEqual(evidence.consoleErrors, []);
  assert.deepEqual(sourceHashes(), evidence.sourceFiles); check('zero browser errors; current implementation unchanged during real acceptance');
  evidence.completed = true;
} catch (error) {
  evidence.error = error.message; process.exitCode = 1; console.error('REAL_INTERACTION_ACCEPTANCE_FAILED: ' + error.message);
  if (browser) for (const context of browser.contexts()) for (const page of context.pages()) {
    try { evidence.failureView = await page.evaluate(() => ({ active: window.hccHandoff?.active, canControl: window.hccHandoff?.canControl, sessions: window.hccHandoff?.sessions?.map(value => ({ id: value.id, type: value.type, status: value.status })), notice: document.getElementById('nativeNotice')?.textContent, handoff: document.getElementById('handoffController')?.textContent }));
      const file = path.join(directory, 'failure.png'); await page.screenshot({ path: file }); evidence.screenshots.push(file);
    } catch {}
  }
} finally {
  await browser?.close();
  if (runtimeStarted) { try { hcc('down'); } catch {} }
  try { await service?.shutdown(); evidence.runtimeClosed = true; } catch (error) { evidence.cleanupError = error.message; process.exitCode = 1; evidence.completed = false; }
  try { hcc('down'); } catch {}
  spawnSync(tmux, ['-L', socket, 'kill-server'], { stdio: 'ignore' });
  evidence.protectedConfigUnchanged = protectedHashes.every(([file, before]) => fs.existsSync(file) && digest(file) === before);
  if (!evidence.protectedConfigUnchanged) { process.exitCode = 1; evidence.completed = false; }
  for (const folder of [root, bin, codexHome, claudeHome, outside]) fs.rmSync(folder, { recursive: true, force: true });
  evidence.temporaryProviderHomesRemoved = !fs.existsSync(codexHome) && !fs.existsSync(claudeHome);
  evidence.finishedAt = new Date().toISOString(); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ evidence: output, completed: evidence.completed, protectedConfigUnchanged: evidence.protectedConfigUnchanged }));
}
