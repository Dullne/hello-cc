// Opt-in installed-model acceptance. Uses a disposable Codex home, project,
// tmux socket and browser profile; preserves the original account configuration.
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
import { createCodexAdapter } from '../lib/integrations/native/codex.mjs';
import { JsonRpcProcess } from '../lib/integrations/native/jsonrpc.mjs';
import { startNativeService } from '../lib/runtime/native/service.mjs';
import { nativeRequest } from '../lib/runtime/native/client.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url)), cli = path.join(repo, 'bin/hcc.mjs');
const originalHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const protectedFiles = ['config.toml', 'auth.json'].map(name => path.join(originalHome, name)).filter(file => fs.existsSync(file));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const protectedHashes = protectedFiles.map(file => [file, hash(file)]);
const source = fs.readFileSync(path.join(originalHome, 'config.toml'), 'utf8');
const provider = JSON.parse(source.match(/^model_provider\s*=\s*(".*")\s*$/m)?.[1] || '"openai"');
const model = JSON.parse(source.match(/^model\s*=\s*(".*")\s*$/m)?.[1] || 'null');
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-live-handoff-')));
const root = path.join(directory, 'project'), home = path.join(directory, 'codex-home'), bin = path.join(directory, 'bin');
for (const folder of [root, home, bin, path.join(root, '.hello-cc')]) fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
const sections = source.split(/(?=^\[)/m), headings = ['model_providers.' + provider, 'model_providers."' + provider + '"'];
const config = ['model', 'model_provider', 'model_reasoning_effort'].map(key => source.match(new RegExp('^' + key + '\\s*=.*$', 'm'))?.[0]).filter(Boolean);
for (const section of sections.slice(1)) {
  const heading = /^\[([^\]]+)\]/.exec(section)?.[1];
  if (headings.some(prefix => heading === prefix || heading?.startsWith(prefix + '.'))) config.push(section);
}
fs.writeFileSync(path.join(home, 'config.toml'), config.join('\n') + '\n', { mode: 0o600 });
if (fs.existsSync(path.join(originalHome, 'auth.json'))) fs.writeFileSync(path.join(home, 'auth.json'), fs.readFileSync(path.join(originalHome, 'auth.json')), { mode: 0o600 });
const socket = 'hcc-live-' + randomUUID(), tmux = process.env.HCC_ACCEPTANCE_TMUX || '/opt/homebrew/bin/tmux';
assert.ok(fs.existsSync(tmux), 'Set HCC_ACCEPTANCE_TMUX to the installed tmux executable');
fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\nexec ' + JSON.stringify(tmux) + ' -L ' + JSON.stringify(socket) + ' "$@"\n', { mode: 0o700 });
const env = { ...process.env, PATH: bin + ':' + path.dirname(process.execPath) + ':' + process.env.PATH,
  CODEX_HOME: home, HCC_SHIM_ENSURED: '1', HCC_SHIM_NO_ATTACH: '1', HCC_NO_AUTO_INSTALL_TMUX: '1', HCC_WEB_TOKEN: randomUUID() };
for (const key of Object.keys(env)) if (key.startsWith('HCC_') && !['HCC_WEB_TOKEN','HCC_NO_AUTO_INSTALL_TMUX','HCC_SHIM_ENSURED','HCC_SHIM_NO_ATTACH'].includes(key)) delete env[key];
function hcc(...args) {
  const result = spawnSync(process.execPath, [cli, '--root', root, ...args], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0) throw new Error('Isolated HCC CLI failed: ' + args[0]);
  return result.stdout;
}
const ctx = { root, dbPath: path.join(root, '.hello-cc', 'mesh.db') };
const connect = () => { const db = new DatabaseSync(ctx.dbPath); db.exec('PRAGMA busy_timeout=5000'); return db; };
const db = connect(); initSchema(db); db.close();
fs.writeFileSync(path.join(root, 'input.json'), JSON.stringify({ value: 41 }));
const events = createEventHelpers(), bindings = createPeerBindingStore(events), peers = createPeerHelpers({ ...events, now: () => Math.floor(Date.now() / 1000) });
const deps = { ...events, ...bindings, ...peers, ...createMessageStore(events), connect, detectBranch: () => '',
  liveProcessIdentity: pid => inspectProcessIdentity(pid).identity };
const evidence = { model, directory, stages: [], pageErrors: [], consoleErrors: [], screenshots: [], modelInferenceCalled: true,
  browser: 'Browser plugin not available; isolated Chrome and Playwright', completed: false };
let service, runtimeStarted = false, browser, child;
const api = (method, route, body) => nativeRequest(ctx, method, route, body);
async function complete(submissionId) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const state = await api('GET', '/workers/live-worker/state');
    const delivery = state.deliveries.find(row => row.submission_id === submissionId);
    if (delivery?.state === 'completed') return state;
    if (['failed', 'uncertain'].includes(delivery?.state)) throw new Error('Model delivery ended in ' + delivery.state);
    if (state.snapshot.pendingApprovals?.length) throw new Error('Model requested an unexpected interactive operation during bounded file acceptance');
    await delay(250);
  }
  throw new Error('Model continuous-task acceptance timed out');
}
function output() { return JSON.parse(fs.readFileSync(path.join(root, 'handoff.json'), 'utf8')); }
try {
  hcc('up', '--no-discover', '--no-guidance');
  service = await startNativeService(ctx, deps, { adapterFactory: (provider, options) => {
    assert.equal(provider, 'codex');
    return createCodexAdapter({ ...options, env: { ...options.env, ...env, HCC_PEER: options.env.HCC_PEER, HCC_ROOT: root, HCC_DB: ctx.dbPath, HCC_NATIVE_OWNER: options.executorId },
      rpcFactory: config => { const rpc = new JsonRpcProcess(config); const start = rpc.start.bind(rpc); rpc.start = async () => { await start(); child = rpc.child; }; return rpc; } });
  } });
  const worker = await api('POST', '/workers', { peer: 'live-worker', provider: 'codex' });
  const identity = { sessionId: worker.sessionId, pid: child.pid };
  const local = await api('POST', '/send', { peer: 'live-worker', from: 'shell', submissionId: 'live_local_' + randomUUID(), body:
    'Use the hello_cc_scoped hcc_state MCP tool once. Read input.json. Write handoff.json as JSON with value increased by one and phases ["local"]. Do only these bounded project-file operations. End with LOCAL_PHASE_OK.' });
  await complete(local.submission_id); assert.deepEqual(output(), { value: 42, phases: ['local'] });
  evidence.stages.push({ stage: 'local-model-turn', passed: true, ...identity }); console.log('LOCAL_MODEL_PHASE_OK');
  const port = await new Promise(resolve => { const listener = net.createServer(); listener.listen(0, '127.0.0.1', () => { const port = listener.address().port; listener.close(() => resolve(port)); }); });
  hcc('web', '--local', '--port', String(port), '--no-discover', '--no-guidance'); runtimeStarted = true;
  const playwright = process.env.HCC_ACCEPTANCE_PLAYWRIGHT;
  assert.ok(playwright, 'Set HCC_ACCEPTANCE_PLAYWRIGHT to an installed Playwright module');
  const { chromium } = await import(playwright);
  browser = await chromium.launch({ headless: true, ...(process.env.HCC_ACCEPTANCE_CHROME ? { executablePath: process.env.HCC_ACCEPTANCE_CHROME } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => evidence.pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') evidence.consoleErrors.push(message.text()); });
  await page.goto('http://127.0.0.1:' + port + '/?token=' + env.HCC_WEB_TOKEN);
  await page.waitForFunction(() => window.hccHandoff?.session?.type === 'native' && window.hccHandoff.canControl);
  assert.equal(await page.locator('#nativePanel').isVisible(), true);
  await page.locator('#nativeDraft').fill('Continue the same original task. Call hello_cc_scoped hcc_state once. Read handoff.json. Increase value by one, append "web" to phases, and save handoff.json. Do only these project-file operations. End with WEB_PHASE_OK.');
  await page.locator('#nativeSend').click();
  await page.waitForFunction(() => window.hccHandoff?.session?.type === 'native' && document.getElementById('nativeReceipts').textContent.includes('s_'));
  let webDelivery;
  for (let i = 0; i < 60; i++) { const deliveries = await api('GET', '/deliveries?peer=live-worker'); webDelivery = deliveries.find(row => row.submission_id.startsWith('s_')); if (webDelivery) break; await delay(100); }
  assert.ok(webDelivery); const afterWeb = await complete(webDelivery.submission_id);
  assert.deepEqual(output(), { value: 43, phases: ['local','web'] }); assert.equal(afterWeb.snapshot.sessionId, identity.sessionId); assert.equal(child.pid, identity.pid);
  const screenshot = path.join(directory, 'live-web-task.png'); await page.screenshot({ path: screenshot }); evidence.screenshots.push(screenshot);
  evidence.stages.push({ stage: 'web-same-executor-model-turn', passed: true, ...identity }); console.log('WEB_SAME_EXECUTOR_PHASE_OK');
  await page.locator('#releaseControlBtn').click(); await page.waitForFunction(() => !window.hccHandoff.canControl);
  await browser.close(); browser = null;
  hcc('down'); runtimeStarted = false;
  const back = await api('POST', '/send', { peer: 'live-worker', from: 'shell', submissionId: 'live_return_' + randomUUID(), body:
    'Continue the same task after Web released control. Call hello_cc_scoped hcc_state once. Increase handoff.json value by one, append "local-return" to phases and save. End with LOCAL_RETURN_PHASE_OK.' });
  const final = await complete(back.submission_id); assert.deepEqual(output(), { value: 44, phases: ['local','web','local-return'] });
  assert.equal(final.snapshot.sessionId, identity.sessionId); assert.equal(child.pid, identity.pid);
  evidence.stages.push({ stage: 'local-return-after-web-shutdown', passed: true, ...identity }); evidence.output = output();
  assert.equal(evidence.pageErrors.length, 0); assert.equal(evidence.consoleErrors.length, 0);
  const mcpEvents = final.events.filter(event => event.payload?.type === 'item' && event.payload.item?.type === 'mcpToolCall');
  evidence.mcpToolEvents = mcpEvents.length;
  evidence.completed = true; console.log('LIVE_LOCAL_WEB_LOCAL_OK');
} catch (error) {
  evidence.error = error.message;
  process.exitCode = 1; console.error('LIVE_HANDOFF_FAILED: ' + error.message);
} finally {
  await browser?.close();
  if (runtimeStarted) { try { hcc('down'); } catch {} }
  await service?.shutdown();
  try { hcc('down'); } catch {}
  spawnSync(tmux, ['-L', socket, 'kill-server'], { stdio: 'ignore' });
  evidence.protectedConfigUnchanged = protectedHashes.every(([file, original]) => fs.existsSync(file) && hash(file) === original);
  if (!evidence.protectedConfigUnchanged) { process.exitCode = 1; evidence.completed = false; }
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  for (const folder of [root, home, bin]) fs.rmSync(folder, { recursive: true, force: true });
  console.log(JSON.stringify({ evidence: path.join(directory, 'evidence.json'), completed: evidence.completed, protectedConfigUnchanged: evidence.protectedConfigUnchanged }));
}
