// Opt-in installed Codex + real model + browser form acceptance.
// The MCP test server sends real elicitation/create requests; no App Server
// requests, model outputs or adapter responses are injected.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { initSchema } from '../lib/db/schema.mjs';
import { createEventHelpers } from '../lib/db/events.mjs';
import { createPeerHelpers } from '../lib/core/peers/peer-helpers.mjs';
import { createPeerBindingStore } from '../lib/db/stores/peers.mjs';
import { createMessageStore } from '../lib/core/coordination/messages.mjs';
import { inspectProcessIdentity } from '../lib/process/identity.mjs';
import { createCodexAdapter } from '../lib/integrations/native/codex.mjs';
import { JsonRpcProcess } from '../lib/integrations/native/jsonrpc.mjs';
import { startNativeService } from '../lib/runtime/native/service.mjs';
import { nativeRequest } from '../lib/runtime/native/client.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
if (!args.includes('--run-live')) {
  console.log('Usage: node scripts/web-mcp-form-live-acceptance.mjs --run-live [--codex-bin PATH] [--output FILE]');
  console.log('Set HCC_ACCEPTANCE_PLAYWRIGHT and optionally HCC_ACCEPTANCE_CHROME / HCC_ACCEPTANCE_TMUX.');
  console.log('Uses the existing Codex model/account in a disposable home. Real inference consumes provider quota.');
  console.log('Tests local pending form -> Web typed response -> same native task -> local return, and Web-owned App Server forms.');
  process.exit(0);
}
const repo = fileURLToPath(new URL('..', import.meta.url));
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function sourceHashes() {
  const result = {};
  function walk(folder) {
    for (const entry of fs.readdirSync(path.join(repo, folder), { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) result[file] = digest(path.join(repo, file));
    }
  }
  for (const folder of ['bin', 'lib', 'scripts', 'test']) walk(folder);
  for (const file of ['package.json', 'package-lock.json']) result[file] = digest(path.join(repo, file));
  return result;
}
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-live-mcp-form-')));
fs.chmodSync(directory, 0o700);
const root = path.join(directory, 'project'), home = path.join(directory, 'codex-home'), bin = path.join(directory, 'bin'), userHome = path.join(directory, 'home');
for (const folder of [root, home, bin, userHome, path.join(root, '.hello-cc')]) fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
const output = path.resolve(option('--output', path.join(directory, 'evidence.json')));
assert.ok(!fs.existsSync(output), 'Use a new output path; existing receipts are preserved');
const mcpLog = path.join(directory, 'synthetic-mcp-rpc.jsonl');
fs.writeFileSync(mcpLog, '', { mode: 0o600 });
const originalHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const gitIndexResult = spawnSync('git', ['rev-parse', '--git-path', 'index'], { cwd: repo, encoding: 'utf8' });
const gitIndex = gitIndexResult.status === 0 ? path.resolve(repo, gitIndexResult.stdout.trim()) : null;
const originalUserHome = process.env.HOME || os.homedir();
const protectedFiles = [path.join(originalHome, 'config.toml'), path.join(originalHome, 'auth.json'), gitIndex,
  ...['.zshrc', '.bashrc', '.bash_profile', '.profile'].map(name => path.join(originalUserHome, name))].filter(Boolean);
const protectedHashes = protectedFiles.map(file => [file, fs.existsSync(file) ? digest(file) : null]);
const evidence = { startedAt: new Date().toISOString(), node: process.version, directory, sourceRoot: repo,
  sourceFiles: sourceHashes(), modelInferenceCalled: false, requestInjection: false,
  providerMode: 'installed Codex; real model calls a disposable stdio MCP server; production HCC runtime and browser',
  browser: 'Browser plugin not available; isolated installed Chrome and Playwright', checks: [], screenshots: [],
  pageErrors: [], consoleErrors: [], completed: false };
const codexBin = option('--codex-bin', '/opt/homebrew/bin/codex');
const tmux = process.env.HCC_ACCEPTANCE_TMUX || '/opt/homebrew/bin/tmux';
const socket = 'hcc-live-mcp-' + randomUUID();
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const env = { ...process.env, PATH: bin + ':' + path.dirname(process.execPath) + ':' + process.env.PATH,
  HOME: userHome, CODEX_HOME: home, HCC_SHIM_ENSURED: '1', HCC_SHIM_NO_ATTACH: '1', HCC_NO_AUTO_INSTALL_TMUX: '1', HCC_WEB_TOKEN: randomUUID() };
for (const key of Object.keys(env)) if (key.startsWith('HCC_') && !['HCC_WEB_TOKEN', 'HCC_NO_AUTO_INSTALL_TMUX', 'HCC_SHIM_ENSURED', 'HCC_SHIM_NO_ATTACH'].includes(key)) delete env[key];
const ctx = { root, dbPath: path.join(root, '.hello-cc', 'mesh.db') };
const connect = () => { const db = new DatabaseSync(ctx.dbPath); db.exec('PRAGMA busy_timeout=5000'); initSchema(db); return db; };
const events = createEventHelpers(), bindings = createPeerBindingStore(events);
const peers = createPeerHelpers({ ...events, now: () => Math.floor(Date.now() / 1000) });
const deps = { ...events, ...bindings, ...peers, ...createMessageStore(events), connect, detectBranch: () => '',
  liveProcessIdentity: pid => inspectProcessIdentity(pid).identity };
const api = (method, route, body) => nativeRequest(ctx, method, route, body, { timeoutMs: 30000 });
const records = () => fs.readFileSync(mcpLog, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
async function hcc(...params) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(repo, 'bin/hcc.mjs'), '--root', root, ...params],
      { cwd: root, env, encoding: 'utf8', timeout: 30000 }, (error, stdout, stderr) => {
        if (!error) { resolve(stdout); return; }
        evidence.cliFailures ||= [];
        evidence.cliFailures.push({ command: params[0], code: error.code, signal: error.signal,
          stderr: String(stderr || '').replaceAll(env.HCC_WEB_TOKEN, '[isolated-token]').slice(-3000) });
        reject(new Error('Isolated HCC CLI failed: ' + params[0]));
      });
  });
}

function check(name, details = {}) { evidence.checks.push({ name, passed: true, ...details }); console.log('PASS ' + name); }
async function until(predicate, label, timeout = 180000) {
  const deadline = Date.now() + timeout; let notice = Date.now() + 20000;
  while (Date.now() < deadline) {
    const result = await predicate(); if (result) return result;
    if (Date.now() >= notice) { console.log('WAIT ' + label); notice += 20000; }
    await delay(200);
  }
  throw new Error('Timed out: ' + label);
}
function failedNativeState(state) {
  evidence.nativeFailure = { status: state.snapshot?.status, turnId: state.snapshot?.turnId,
    deliveries: state.deliveries, errors: state.events.filter(entry => entry.payload?.type === 'error').map(entry => entry.payload),
    messages: state.events.filter(entry => ['message', 'completed'].includes(entry.payload?.type)).map(entry => ({ type: entry.payload.type, status: entry.payload.status, text: entry.payload.text })) };
}
async function completed(submissionId) {
  return until(async () => {
    const state = await api('GET', '/workers/live-mcp/state');
    const delivery = state.deliveries.find(row => row.submission_id === submissionId);
    if (['failed', 'uncertain', 'interrupted'].includes(delivery?.state)) { failedNativeState(state); throw new Error('Native delivery ended in ' + delivery.state); }
    const unexpected = state.snapshot.pendingApprovals?.find(request => request.kind !== 'mcp');
    if (unexpected) throw new Error('Unexpected interaction: ' + unexpected.method);
    return delivery?.state === 'completed' ? state : null;
  }, 'native model completes accepted form');
}
const expected = {
  native: { project: 'native-mcp-验收', count: 2, enabled: false, region: 'us', features: ['logs', 'tests'] },
  'web-owned': { project: 'web-owned-mcp-验收', count: 3, enabled: false, region: 'eu', features: ['tests'] }
};
const prompt = phase => 'Call the hcc_form_acceptance MCP tool collect_project_settings with phase "' + phase + '" exactly once. '
  + 'Wait for the human form response. If accepted, use your project file tool to write ' + phase + '-answer.json in the current project directory. '
  + 'The file must contain exactly the JSON content object returned by the tool, without action, phase or extra keys. '
  + 'Do not guess the human values. You may use apply_patch or a local shell command only to write this one project JSON file; do not perform other operations. Finish with FORM_' + (phase === 'native' ? 'NATIVE' : 'WEB') + '_COMPLETE.';
function response(phase) {
  const rows = records().filter(row => row.event === 'form-response' && row.phase === phase);
  assert.equal(rows.length, 1, 'one real MCP response for ' + phase);
  assert.deepEqual(rows[0].response, { action: 'accept', content: expected[phase] });
  const result = JSON.parse(fs.readFileSync(path.join(root, phase + '-answer.json'), 'utf8'));
  assert.deepEqual(result, expected[phase]);
  assert.ok(fs.statSync(path.join(root, phase + '-answer.json')).mtimeMs >= Date.parse(rows[0].at), 'model writes after accepted form');
  return { elicitationId: rows[0].elicitationId, content: result };
}
const fieldTitles = { project: 'Project name / 项目名', count: 'Run count / 次数',
  enabled: 'Enable extra operation / 开启额外操作', region: 'Region / 地区', features: 'Features / 功能', note: 'Optional note / 可选备注' };
const field = (page, selector, name) => page.locator(selector + ' .hcc-mcp-field').filter({ has: page.locator('legend').filter({ hasText: fieldTitles[name] }) });
async function fill(page, selector, phase) {
  const values = expected[phase];
  await field(page, selector, 'project').locator('[data-mcp-field]').fill(values.project);
  await field(page, selector, 'count').locator('[data-mcp-field]').fill(String(values.count));
  await field(page, selector, 'enabled').locator('[data-mcp-field]').selectOption('1');
  await field(page, selector, 'region').locator('[data-mcp-field]').selectOption(values.region === 'eu' ? '0' : '1');
  for (const [index, value] of ['logs', 'tests'].entries()) await field(page, selector, 'features').locator('[data-mcp-option="' + index + '"]').setChecked(values.features.includes(value));
  assert.equal(await field(page, selector, 'note').locator('[data-mcp-use]').isChecked(), false);
}
async function awaitForm(page, selector, phase) {
  let confirmations = 0;
  await until(async () => {
    if (await field(page, selector, 'project').count()) return true;
    const button = page.locator(selector + ' button[data-decision="accept"]');
    if (await button.count() && await button.isEnabled()) {
      assert.equal(await page.locator(selector + ' [data-mcp-field]').count(), 0, 'only an empty MCP confirmation may precede the form');
      assert.ok((await page.locator(selector).innerText()).includes('hcc_form_acceptance'), 'confirmation belongs to the isolated MCP server');
      assert.equal(confirmations++, 0, 'at most one tool confirmation per phase');
      await button.click();
      check(phase + ' Web explicitly accepts the real MCP tool confirmation before the field form');
    }
    if (records().some(row => row.event === 'form-timeout')) throw new Error('Real MCP server timed out');
    return false;
  }, phase + ' installed model calls the real MCP field form');
  assert.ok(records().find(row => row.event === 'form-requested' && row.phase === phase));
}

async function shot(page, name) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const file = path.join(directory, name + '.png');
  await page.screenshot({ path: file, animations: 'disabled' }); evidence.screenshots.push(file);
}
async function rendered(page, type) {
  await page.waitForFunction(type => window.hccHandoff?.session?.type === type && window.hccHandoff.canControl, type, { timeout: 20000 });
  assert.ok((await page.title()).includes('hello-cc'));
  const panel = type === 'native' ? '#nativePanel' : '#codexPanel';
  assert.equal(await page.locator(panel).isVisible(), true);
  assert.ok((await page.locator(panel).innerText()).trim().length > 50);
  assert.equal(await page.locator('vite-error-overlay, nextjs-portal, #webpack-dev-server-client-overlay').count(), 0);
}
let service, browser, runtimeStarted = false, nativeChild, page, base;
try {
  assert.ok(fs.existsSync(tmux), 'tmux must be installed');
  assert.ok(fs.existsSync(codexBin), 'Codex must be installed');
  assert.ok(process.env.HCC_ACCEPTANCE_PLAYWRIGHT, 'Set HCC_ACCEPTANCE_PLAYWRIGHT');
  const source = fs.existsSync(path.join(originalHome, 'config.toml')) ? fs.readFileSync(path.join(originalHome, 'config.toml'), 'utf8') : '';
  let section = '';
  let config = source.split('\n').filter(line => {
    const header = line.match(/^\s*\[\[?([^\]]+)\]\]?/); if (header) section = header[1].split('.')[0].replaceAll('"', '').replaceAll("'", '');
    return section ? section === 'model_providers' : /^\s*(?:model(?:_provider|_reasoning_effort|_reasoning_summary|_verbosity|_catalog_json)?|cli_auth_credentials_store)\s*=/.test(line);
  }).join('\n');
  evidence.model = JSON.parse(source.match(/^model\s*=\s*(".*")\s*$/m)?.[1] || 'null');
  // Managed providers may use a read-only external auth helper whose bootstrap
  // resolves the user's installed runtime via HOME. Keep only that helper on
  // its original home; HCC, Codex and their writes remain in disposable homes.
  const selectedProvider = JSON.parse(source.match(/^model_provider\s*=\s*(".*")\s*$/m)?.[1] || '"openai"');
  const authHeadings = ['model_providers.' + selectedProvider + '.auth', 'model_providers."' + selectedProvider + '".auth'];
  let authHelperCount = 0;
  config = config.split(/(?=^\[)/m).map(block => {
    const heading = /^\[([^\]]+)\]/.exec(block)?.[1];
    if (!authHeadings.includes(heading)) return block;
    const command = JSON.parse(block.match(/^\s*command\s*=\s*(.+)$/m)?.[1] || 'null');
    const helperArgs = JSON.parse(block.match(/^\s*args\s*=\s*(.+)$/m)?.[1] || '[]');
    assert.ok(typeof command === 'string' && Array.isArray(helperArgs) && helperArgs.every(arg => typeof arg === 'string'), 'Cannot isolate the configured auth helper');
    const wrappedArgs = ['HOME=' + originalUserHome, command, ...helperArgs];
    let result = block.replace(/^\s*command\s*=.*$/m, 'command = "/usr/bin/env"');
    if (/^\s*args\s*=/m.test(result)) result = result.replace(/^\s*args\s*=.*$/m, 'args = ' + JSON.stringify(wrappedArgs));
    else result += '\nargs = ' + JSON.stringify(wrappedArgs) + '\n';
    authHelperCount++; return result;
  }).join('');
  evidence.authHelperIsolation = { configured: authHelperCount === 1, originalHomeScope: 'selected credential helper only; Codex and HCC homes are disposable' };

  const serverConfig = '\n[mcp_servers.hcc_form_acceptance]\ncommand = ' + JSON.stringify(process.execPath)
    + '\nargs = ' + JSON.stringify([path.join(repo, 'scripts/mcp-form-live-fixture.mjs'), '--stdio', '--log', mcpLog])
    + '\nstartup_timeout_sec = 30\ntool_timeout_sec = 240\n';
  fs.writeFileSync(path.join(home, 'config.toml'), config + '\n' + serverConfig, { mode: 0o600 });
  if (fs.existsSync(path.join(originalHome, 'auth.json'))) {
    fs.copyFileSync(path.join(originalHome, 'auth.json'), path.join(home, 'auth.json')); fs.chmodSync(path.join(home, 'auth.json'), 0o600);
  }
  fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\nexec ' + quote(tmux) + ' -L ' + quote(socket) + ' "$@"\n', { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexec ' + quote(codexBin) + ' "$@"\n', { mode: 0o700 });
  const version = spawnSync(codexBin, ['--version'], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(version.status, 0); evidence.codexVersion = version.stdout.trim();
  await hcc('up', '--no-discover', '--no-guidance');
  service = await startNativeService(ctx, deps, { adapterFactory: (provider, options) => {
    assert.equal(provider, 'codex');
    return createCodexAdapter({ ...options, binary: codexBin,
      env: { ...options.env, ...env, HCC_PEER: options.env.HCC_PEER, HCC_ROOT: root, HCC_DB: ctx.dbPath, HCC_NATIVE_OWNER: options.executorId },
      rpcFactory: config => { const rpc = new JsonRpcProcess(config), start = rpc.start.bind(rpc);
        rpc.start = async () => { await start(); nativeChild = rpc.child; }; return rpc; } });
  } });
  const worker = await api('POST', '/workers', { peer: 'live-mcp', provider: 'codex' });
  const originalIdentity = { sessionId: worker.sessionId, executorId: worker.executorId, pid: nativeChild.pid };
  evidence.modelInferenceCalled = true;
  const local = await api('POST', '/send', { peer: 'live-mcp', from: 'shell', submissionId: 'mcp_local_' + randomUUID(), body: prompt('native') });
  const pending = await until(async () => {
    const state = await api('GET', '/workers/live-mcp/state');
    const request = state.snapshot.pendingApprovals?.find(request => request.kind === 'mcp');
    const delivery = state.deliveries.find(row => row.submission_id === local.submission_id);
    if (['failed', 'uncertain', 'completed'].includes(delivery?.state)) { failedNativeState(state); throw new Error('Native turn ended before real MCP form: ' + delivery.state); }
    if (state.snapshot.pendingApprovals?.some(request => request.kind !== 'mcp')) throw new Error('Unexpected native interaction before MCP form');
    return request ? { request, state } : null;
  }, 'installed model calls MCP form before Web starts');
  assert.equal(records().some(row => row.event === 'form-response'), false);
  evidence.nativeInitialRequest = { method: pending.request.method, mode: pending.request.params.mode, serverName: pending.request.params.serverName, fieldCount: Object.keys(pending.request.params.requestedSchema?.properties || {}).length };
  assert.equal(pending.request.sessionId, originalIdentity.sessionId);
  assert.equal(pending.request.params.mode, 'form');
  check('real native model reaches MCP interaction and remains pending before Web starts', { ...originalIdentity, turnId: pending.request.turnId, requestId: pending.request.requestId });
  const port = await new Promise(resolve => { const listener = net.createServer(); listener.listen(0, '127.0.0.1', () => { const port = listener.address().port; listener.close(() => resolve(port)); }); });
  base = 'http://127.0.0.1:' + port; evidence.baseUrl = base;
  await hcc('web', '--local', '--port', String(port), '--no-discover', '--no-guidance'); runtimeStarted = true;
  const { chromium } = await import(process.env.HCC_ACCEPTANCE_PLAYWRIGHT);
  browser = await chromium.launch({ headless: true, ...(process.env.HCC_ACCEPTANCE_CHROME ? { executablePath: process.env.HCC_ACCEPTANCE_CHROME } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => evidence.pageErrors.push(error.message));
  page.on('console', message => { if (['warning', 'error'].includes(message.type())) evidence.consoleErrors.push(message.text()); });
  await page.goto(base + '/?token=' + env.HCC_WEB_TOKEN); await rendered(page, 'native');
  await awaitForm(page, '#nativeApprovals', 'native');
  check('Web opens the original native task and renders the real MCP form');
  await fill(page, '#nativeApprovals', 'native');
  await field(page, '#nativeApprovals', 'count').locator('[data-mcp-field]').fill('9');
  await page.locator('#nativeApprovals button[data-decision="accept"]').click();
  await page.waitForFunction(() => document.getElementById('nativeNotice').textContent.includes('count'));
  assert.equal(records().some(row => row.event === 'form-response'), false);
  assert.equal((await api('GET', '/workers/live-mcp/state')).snapshot.pendingApprovals.length, 1);
  check('invalid live form answer is blocked and the actual model request stays pending');
  await field(page, '#nativeApprovals', 'count').locator('[data-mcp-field]').fill('2');
  await page.locator('#nativeRead').click();
  await until(async () => await field(page, '#nativeApprovals', 'project').locator('[data-mcp-field]').inputValue() === expected.native.project, 'native draft retained');
  await page.evaluate(() => { document.querySelector('.native-scroll').scrollTop = 0; });
  await shot(page, 'native-real-mcp-form-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), true);
  await shot(page, 'native-real-mcp-form-mobile');
  await page.locator('#nativeApprovals button[data-decision="accept"]').click();
  const afterNative = await completed(local.submission_id);
  evidence.nativeCompletedMessages = afterNative.events.filter(entry => ['message', 'completed'].includes(entry.payload?.type)).map(entry => ({ type: entry.payload.type, text: entry.payload.text, status: entry.payload.status }));
  assert.equal(afterNative.snapshot.sessionId, originalIdentity.sessionId);
  assert.equal(afterNative.snapshot.executorId, originalIdentity.executorId); assert.equal(nativeChild.pid, originalIdentity.pid);
  assert.equal(nativeChild.exitCode, null);
  assert.ok(afterNative.events.some(entry => entry.payload?.type === 'completed' && entry.payload.submissionId === local.submission_id && entry.payload.text?.includes('FORM_NATIVE_COMPLETE')));
  check('mobile Web submits typed values to the live native model and the same task completes', { ...originalIdentity, ...response('native') });
  await page.locator('#nativeRead').click();
  await page.waitForFunction(status => document.getElementById('nativeStatus').textContent.endsWith(' · ' + window.hccHandoff.tr('native.state.' + status, status))
    && document.getElementById('nativeEvents').textContent.includes('FORM_NATIVE_COMPLETE')
    && document.querySelectorAll('#nativeApprovals [data-mcp-field]').length === 0, afterNative.snapshot.status, { timeout: 20000 });
  assert.equal(await page.locator('#nativeNotice').innerText(), '', 'successful retry removes the earlier invalid-value notice');
  await page.evaluate(() => { const scroll = document.querySelector('.native-scroll'); scroll.scrollTop = scroll.scrollHeight; });
  evidence.nativeCompletedUi = { status: await page.locator('#nativeStatus').innerText(),
    markerVisible: (await page.locator('#nativeEvents').innerText()).includes('FORM_NATIVE_COMPLETE'), noticeCleared: true };
  await shot(page, 'native-real-mcp-completed-mobile');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const web = await page.evaluate(async root => window.hccHandoff.api('/api/sessions?root=' + encodeURIComponent(root), {
    method: 'POST', body: JSON.stringify({ kind: 'codex', transport: 'app-server' })
  }), root);
  const webId = web.session.id;
  await page.evaluate(async id => { await window.hccHandoff.refreshSessions(); window.hccHandoff.openManaged(id); }, webId);
  await rendered(page, 'app-server');
  await page.locator('#codexDraft').fill(prompt('web-owned')); await page.locator('#codexSend').click();
  await awaitForm(page, '#codexApprovals', 'web-owned');
  const webState = await page.evaluate(async ({ id, root }) => (await window.hccHandoff.api('/api/sessions/' + encodeURIComponent(id) + '/codex/state?root=' + encodeURIComponent(root))).state, { id: webId, root });
  const webRequest = webState.pendingApprovals.find(request => request.method === 'mcpServer/elicitation/request' && Object.keys(request.params.requestedSchema?.properties || {}).length);
  assert.ok(webRequest);
  const webIdentity = { managedSessionId: webId, threadId: webRequest.threadId, turnId: webRequest.turnId,
    executorId: webState.executorId, pid: webState.pid, requestId: webRequest.requestId };
  await fill(page, '#codexApprovals', 'web-owned'); await shot(page, 'web-owned-real-mcp-form-desktop');
  await page.locator('#codexApprovals button[data-decision="accept"]').click();
  const afterWeb = await until(async () => {
    const state = await page.evaluate(async ({ id, root }) => (await window.hccHandoff.api('/api/sessions/' + encodeURIComponent(id) + '/codex/state?root=' + encodeURIComponent(root))).state, { id: webId, root });
    const turn = state.threads.find(thread => thread.id === webIdentity.threadId)?.turns.find(turn => turn.id === webIdentity.turnId);
    if (['failed', 'interrupted'].includes(turn?.status)) throw new Error('Web-owned turn ended in ' + turn.status);
    return turn?.status === 'completed' ? state : null;
  }, 'Web-owned provider turn actually completes');
  const completedTurn = afterWeb.threads.find(thread => thread.id === webIdentity.threadId).turns.find(turn => turn.id === webIdentity.turnId);
  assert.ok(completedTurn.items.some(item => item.type === 'agentMessage' && item.text?.includes('FORM_WEB_COMPLETE')), 'completion marker belongs to an assistant message');
  assert.equal(afterWeb.executorId, webIdentity.executorId); assert.equal(afterWeb.pid, webIdentity.pid);
  assert.equal(afterWeb.threadId, webIdentity.threadId); assert.equal(afterWeb.turnId, null);
  assert.equal(afterWeb.pendingApprovals.length, 0);
  evidence.webCompletedTurn = { ...webIdentity, status: completedTurn.status,
    assistantMessages: completedTurn.items.filter(item => item.type === 'agentMessage').map(item => item.text) };
  check('Web-owned App Server returns the real typed answer, model writes the result and provider confirms turn completion', { ...webIdentity, ...response('web-owned') });
  await page.locator('#codexRecover').click();
  if (await page.locator('#codexJump').isVisible()) await page.locator('#codexJump').click();
  await shot(page, 'web-owned-real-mcp-completed-desktop');
  await page.evaluate(id => window.hccHandoff.openManaged(id), 'live-mcp'); await rendered(page, 'native');
  await page.locator('#releaseControlBtn').click(); await page.waitForFunction(() => !window.hccHandoff.canControl);
  await browser.close(); browser = null;
  await hcc('down'); runtimeStarted = false;
  const back = await api('POST', '/send', { peer: 'live-mcp', from: 'shell', submissionId: 'mcp_return_' + randomUUID(), body:
    'Continue this same task after Web released control. Read native-answer.json and use your project file tool to write local-return.json with exactly {"countPlusOne": count + 1} using the saved count. You may use apply_patch or a local shell command only to read native-answer.json and write local-return.json in this project. Do not perform other operations. End with FORM_LOCAL_RETURN_COMPLETE.' });
  const afterReturn = await completed(back.submission_id);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'local-return.json'), 'utf8')), { countPlusOne: expected.native.count + 1 });
  assert.equal(afterReturn.snapshot.sessionId, originalIdentity.sessionId);
  assert.equal(afterReturn.snapshot.executorId, originalIdentity.executorId); assert.equal(nativeChild.pid, originalIdentity.pid);
  assert.equal(nativeChild.exitCode, null);
  assert.ok(afterReturn.events.some(entry => entry.payload?.type === 'completed' && entry.payload.submissionId === back.submission_id && entry.payload.text?.includes('FORM_LOCAL_RETURN_COMPLETE')));
  check('local return after Web shutdown continues the same native executor and uses its accepted answer', originalIdentity);
  const initialized = records().filter(row => row.event === 'initialize');
  assert.ok(initialized.length >= 2); evidence.mcpClients = initialized;
  evidence.mcpResponses = records().filter(row => row.event === 'form-response');
  assert.deepEqual(evidence.pageErrors, []); assert.deepEqual(evidence.consoleErrors, []);
  check('desktop/mobile page identity, nonblank panels, no framework overlay and no browser warnings/errors');
  evidence.completed = true;
} catch (error) {
  evidence.error = error.message; evidence.errorStack = error.stack; evidence.completed = false; process.exitCode = 1;
  console.error('LIVE_MCP_FORM_FAILED: ' + error.message);
  if (page && !page.isClosed()) try { await shot(page, 'failure'); } catch {}
} finally {
  try { await browser?.close(); } catch (error) { evidence.browserCleanupError = error.message; }
  if (runtimeStarted) try { await hcc('down'); } catch (error) { evidence.runtimeCleanupError = error.message; }
  try { await service?.shutdown(); } catch (error) { evidence.serviceCleanupError = error.message; }
  spawnSync(tmux, ['-L', socket, 'kill-server'], { stdio: 'ignore', timeout: 5000 });
  evidence.protectedStateUnchanged = protectedHashes.every(([file, original]) => (fs.existsSync(file) ? digest(file) : null) === original);
  const after = sourceHashes();
  evidence.sourceChangesDuringValidation = [...new Set([...Object.keys(evidence.sourceFiles), ...Object.keys(after)])].filter(file => after[file] !== evidence.sourceFiles[file]);
  evidence.fixturePids = [...new Set(records().map(row => row.pid))];
  evidence.fixtureProcessesStopped = await until(() => evidence.fixturePids.every(pid => inspectProcessIdentity(pid).state === 'dead'), 'private MCP processes stop', 10000).catch(() => false);
  evidence.nativeProcessStopped = !nativeChild || nativeChild.exitCode !== null || nativeChild.signalCode !== null;
  for (const folder of [root, home, bin, userHome]) fs.rmSync(folder, { recursive: true, force: true });
  evidence.privateHomesRemoved = !fs.existsSync(home) && !fs.existsSync(root) && !fs.existsSync(userHome);
  evidence.finishedAt = new Date().toISOString();
  if (!evidence.protectedStateUnchanged || evidence.sourceChangesDuringValidation.length || !evidence.fixtureProcessesStopped || !evidence.nativeProcessStopped ||
      evidence.browserCleanupError || evidence.runtimeCleanupError || evidence.serviceCleanupError) { evidence.completed = false; process.exitCode = 1; }
  fs.writeFileSync(output, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ evidence: output, completed: evidence.completed, protectedStateUnchanged: evidence.protectedStateUnchanged,
    sourceChangesDuringValidation: evidence.sourceChangesDuringValidation, fixtureProcessesStopped: evidence.fixtureProcessesStopped }));
}
