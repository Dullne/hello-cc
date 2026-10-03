// Reproducible browser acceptance. Providers are local simulated adapters; no model calls.
// Use Node 24+, tmux and `npx playwright install chromium`. HCC_ACCEPTANCE_CHROME
// may select an existing browser. Output is evidence, not a release or device receipt.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runSessionToolsChecks } from './web-session-tools-checks.mjs';
import { runFilePreviewChecks } from './web-file-preview-checks.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/web-workbench-acceptance.mjs [--output-dir DIR] [--output FILE] [--package-root DIR]');
  console.log('Optional: HCC_ACCEPTANCE_PACKAGE_ROOT, HCC_ACCEPTANCE_PLAYWRIGHT, HCC_ACCEPTANCE_CHROME, HCC_ACCEPTANCE_TMUX. No model or account is used.');
  process.exit(0);
}
const allowed = new Set(['--output-dir', '--output', '--package-root']);
const options = new Map();
for (let index = 0; index < args.length; index += 2) {
  if (!allowed.has(args[index]) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Unknown or incomplete acceptance option: ' + args[index]);
  options.set(args[index], args[index + 1]);
}
assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Workbench acceptance requires Node 24+');
assert.notEqual(process.platform, 'win32', 'Run the tmux-based acceptance under WSL on Windows');
const scriptRoot = fileURLToPath(new URL('..', import.meta.url));
const repo = fs.realpathSync(path.resolve(options.get('--package-root') || process.env.HCC_ACCEPTANCE_PACKAGE_ROOT || scriptRoot));
const node = process.execPath;
const dir = path.resolve(options.get('--output-dir') || fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-workbench-evidence-')));
fs.mkdirSync(dir, { recursive: true });
const output = path.resolve(options.get('--output') || path.join(dir, 'evidence.json'));
const load = name => import(pathToFileURL(path.join(repo, name)).href);
const playwrightSpecifier = process.env.HCC_ACCEPTANCE_PLAYWRIGHT;
const { chromium } = await import(playwrightSpecifier && path.isAbsolute(playwrightSpecifier) ? pathToFileURL(playwrightSpecifier).href : playwrightSpecifier || 'playwright');
const [{ createEventHelpers }, { createPeerHelpers }, { createPeerBindingStore }, { createMessageStore },
  { inspectProcessIdentity }, { startNativeService }, { nativeRequest }] = await Promise.all([
  load('lib/db/events.mjs'), load('lib/core/peers/peer-helpers.mjs'), load('lib/db/stores/peers.mjs'),
  load('lib/core/coordination/messages.mjs'), load('lib/process/identity.mjs'),
  load('lib/runtime/native/service.mjs'), load('lib/runtime/native/client.mjs')
]);
const { API_VERSION } = await load('lib/web/api-version.mjs');
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-workbench-fixture-')));
const root = path.join(sandbox, 'project with spaces'), taskHome = path.join(sandbox, 'home'), bin = path.join(sandbox, 'bin');
for (const folder of [root, taskHome, bin]) fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
const socket = 'hcc-workbench-' + randomUUID();
const env = {
  PATH: [bin, path.dirname(node), process.env.PATH || '/usr/bin:/bin'].join(path.delimiter),
  HOME: taskHome, XDG_CONFIG_HOME: path.join(taskHome, '.config'), XDG_CACHE_HOME: path.join(taskHome, '.cache'),
  CODEX_HOME: path.join(taskHome, '.codex'), CLAUDE_CONFIG_DIR: path.join(taskHome, '.claude'),
  DSH_HOME: path.join(taskHome, '.dsh'), SHELL: '/bin/sh', LANG: 'C.UTF-8', TMPDIR: sandbox,
  HCC_NO_AUTO_INSTALL_TMUX: '1', HCC_WEB_TOKEN: randomUUID()
};
function hashes() {
  const result = {};
  function walk(relative) {
    const target = path.join(repo, relative);
    if (!fs.existsSync(target)) return;
    if (fs.statSync(target).isDirectory()) {
      for (const name of fs.readdirSync(target).sort()) walk(path.join(relative, name));
    } else result[relative] = createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  }
  for (const name of ['bin', 'lib', 'package.json', 'package-lock.json', 'scripts/web-workbench-acceptance.mjs', 'scripts/web-session-tools-checks.mjs', 'scripts/web-file-preview-checks.mjs']) walk(name);
  return result;
}
const evidence = {
  schemaVersion: 1, dir, packageRoot: repo, packageVersion: JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version,
  node: process.version, platform: process.platform, checks: [], screenshots: [], errors: [], console: [], cleanup: {},
  sourceFiles: hashes(), browser: 'Playwright 1.62.1; isolated headless context; repeatable CI runner',
  mode: 'Simulated native adapters; actual HTTP, SQLite, native service and browser; no models or credentials',
  startedAt: new Date().toISOString(), success: false
};
const check = name => { evidence.phase = name; evidence.checks.push(name); console.log('PASS ' + name); };
function hcc(...command) {
  const result = spawnSync(node, [path.join(repo, 'bin/hcc.mjs'), '--root', root, ...command], { cwd: root, env, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  fs.appendFileSync(path.join(dir, 'cli.log'), command.join(' ') + '\n' + (result.stdout || '') + (result.stderr || ''));
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Isolated CLI failed: ' + command[0] + ' (see cli.log)');
  return result.stdout;
}
const ctx = { root, dbPath: path.join(root, '.hello-cc', 'mesh.db') };
const events = createEventHelpers(), bindings = createPeerBindingStore(events), peers = createPeerHelpers({ ...events, now: () => Math.floor(Date.now() / 1000) });
const deps = { ...events, ...bindings, ...peers, ...createMessageStore(events), connect: () => new DatabaseSync(ctx.dbPath), detectBranch: () => '', liveProcessIdentity: pid => inspectProcessIdentity(pid).identity };
const adapters = new Map();
let service, browser, runtime = false, tmux;
const api = (method, route, body) => nativeRequest(ctx, method, route, body);
const port = await new Promise((resolve, reject) => {
  const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(error => error ? reject(error) : resolve(value)); });
});
const base = 'http://127.0.0.1:' + port; evidence.url = base;
const shot = async (page, name) => { const file = path.join(dir, name + '.png'); await page.screenshot({ path: file, animations: 'disabled' }); evidence.screenshots.push(file); };
const select = async (page, id) => {
  // Let the initial auto-selected socket finish before selecting another peer;
  // cancelling a still-connecting socket intentionally emits a browser warning.
  await page.waitForFunction(() => window.hccHandoff?.actionToken && /(已连接|Connected)$/.test(document.getElementById('handoffConnection').textContent));
  if (await page.evaluate(() => window.hccHandoff.active) !== id) await page.locator('#sessions .session[data-id="' + id + '"] .session-select').click();
  await page.waitForFunction(id => window.hccHandoff?.active === id && window.hccHandoff.actionToken && /(已连接|Connected)$/.test(document.getElementById('handoffConnection').textContent), id);
  await page.locator('#nativeRead').click();
  // The click handler starts an async read without exposing its promise. Await
  // the public view read too, so later assertions observe a rendered snapshot.
  await page.evaluate(() => window.hccNative.read());
};
function watch(page) {
  page.on('pageerror', error => evidence.errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) evidence.console.push({ text: message.text(), phase: evidence.phase, location: message.location() }); });
  page.on('dialog', dialog => dialog.accept());
}
function browserInstrumentation() {
  // Context init scripts also run in static preview and built-in PDF frames;
  // those documents do not own workbench storage or transport instrumentation.
  if (!['http:', 'https:'].includes(window.location.protocol)) return;
  localStorage.setItem('hcc.lang', 'zh'); localStorage.setItem('hcc.theme', 'light');
  const Original = window.WebSocket;
  window.__hccAcceptance = { sockets: [], frames: 0, bytes: 0, longTasks: [] };
  window.WebSocket = class extends Original {
    constructor(...values) { super(...values); window.__hccAcceptance.sockets.push(this); this.addEventListener('message', event => { window.__hccAcceptance.frames++; window.__hccAcceptance.bytes += typeof event.data === 'string' ? event.data.length : 0; }); }
  };
  if (window.PerformanceObserver?.supportedEntryTypes?.includes('longtask')) new PerformanceObserver(list => {
    window.__hccAcceptance.longTasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration })));
  }).observe({ type: 'longtask', buffered: true });
}
async function checkSharedSplit(page) {
  const marker = randomUUID();
  let requests = 0;
  const track = request => { const url = new URL(request.url()); if (url.pathname === '/api/sessions' && url.searchParams.get('acceptance_shared') === marker) requests++; };
  page.on('request', track);
  try {
    const frame = page.frames().find(candidate => new URL(candidate.url()).pathname === '/pane');
    assert.ok(frame, 'The secondary surface must be an actual same-origin frame');
    const sameBroker = await frame.evaluate(async () => {
      const module = await import('/assets/web/browser/project-data.mjs');
      return module.sharedProjectBroker() === window.parent.hccProjectReads;
    });
    const result = await page.evaluate(async marker => {
      const child = document.getElementById('workspaceFrame').contentWindow;
      // The auxiliary surface receives its parent's broker from this factory;
      // it intentionally does not publish a second hccProjectReads global.
      window.hccProjectReads.invalidate();
      const route = '/api/sessions?acceptance_shared=' + encodeURIComponent(marker);
      const [first, second] = await Promise.all([window.hccHandoff.api(route), child.hccHandoff.api(route)]);
      const secondBefore = JSON.stringify(second);
      first.acceptanceMutation = true;
      const firstSessions = Array.isArray(first) ? first : first.sessions;
      if (firstSessions?.[0]) firstSessions[0].acceptanceNestedMutation = true;
      return { independentCopies: JSON.stringify(second) === secondBefore && first !== second,
        independentDraftScopes: window.hccHandoff.draftScope !== child.hccHandoff.draftScope,
        independentActionTokens: Boolean(window.hccHandoff.actionToken && child.hccHandoff.actionToken && window.hccHandoff.actionToken !== child.hccHandoff.actionToken) };
    }, marker);
    assert.equal(sameBroker, true);
    assert.equal(requests, 1, 'Parallel same-root pane reads must share one actual HTTP request');
    assert.equal(result.independentCopies, true);
    assert.equal(result.independentDraftScopes, true);
    assert.equal(result.independentActionTokens, true);
    evidence.splitReadSharing = { ...result, sameBroker, actualHttpRequests: requests };
    check('real split panes share one project GET while keeping response copies, drafts and action tokens independent');
  } finally { page.off('request', track); }
}
async function extendedChecks(page, context) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await select(page, 'qa-codex');
  const before = adapters.get('codex').sent || 0;
  const draft = 'Unsent draft survives an actual WebSocket disconnect';
  await page.locator('#nativeDraft').fill(draft);
  await page.evaluate(() => { for (const socket of window.__hccAcceptance.sockets) if (socket.readyState === 1) socket.close(1000, 'acceptance reconnect'); });
  await page.waitForFunction(() => !window.hccHandoff.canControl);
  adapters.get('codex').emit({ type: 'message', itemId: 'gap-recovered', text: 'RECOVERED_AFTER_DISCONNECT' });
  if (await page.locator('#reconnectBtn').isVisible()) await page.locator('#reconnectBtn').click();
  await page.waitForFunction(() => /(已连接|Connected)$/.test(document.getElementById('handoffConnection').textContent) && document.getElementById('nativeEvents').textContent.includes('RECOVERED_AFTER_DISCONNECT'), null, { timeout: 15000 });
  assert.equal(await page.locator('#nativeDraft').inputValue(), draft);
  assert.equal(adapters.get('codex').sent || 0, before);
  // A fresh socket has a fresh action token. Recovery must not silently take
  // the prior lease; explicitly reclaim it through the visible control.
  if (!await page.evaluate(() => window.hccHandoff.canControl)) await page.locator('#claimControlBtn').click();
  await page.waitForFunction(() => window.hccHandoff.canControl);
  check('actual WebSocket reconnect restores missing output without replaying unsent input');

  const observerContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await observerContext.addInitScript(browserInstrumentation);
  const observer = await observerContext.newPage(); watch(observer);
  await observer.goto(base + '/?token=' + env.HCC_WEB_TOKEN); await select(observer, 'qa-codex');
  assert.equal(await observer.locator('#nativeSend').isDisabled(), true);
  await observer.locator('#claimControlBtn').click(); await observer.waitForFunction(() => window.hccHandoff.canControl);
  await page.waitForFunction(() => !window.hccHandoff.canControl);
  assert.equal(await page.locator('#nativeSend').isDisabled(), true);
  await page.locator('#claimControlBtn').click(); await page.waitForFunction(() => window.hccHandoff.canControl);
  await observer.waitForFunction(() => !window.hccHandoff.canControl);
  await observerContext.close();
  check('separate browser contexts preserve observer fences during lease takeover');

  const start = performance.now();
  for (let index = 0; index < 120; index++) adapters.get('codex').emit({ type: 'message', itemId: 'budget-' + index, text: 'Bounded retained message ' + index + '\n' + 'readable output '.repeat(80) });
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.locator('#nativeRead').click();
    if ((await page.locator('#nativeEvents').innerText()).includes('Bounded retained message 119')) break;
  }
  await page.waitForFunction(() => document.getElementById('nativeEvents').textContent.includes('Bounded retained message 119'));
  const metrics = await page.evaluate(() => ({
    cards: document.querySelectorAll('#nativeEvents [data-native-card]').length,
    nodes: document.querySelectorAll('#nativeEvents *').length,
    htmlBytes: new TextEncoder().encode(document.getElementById('nativeEvents').innerHTML).length,
    frames: window.__hccAcceptance.frames, wireCharacters: window.__hccAcceptance.bytes,
    maximumLongTaskMs: Math.max(0, ...window.__hccAcceptance.longTasks.map(item => item.duration))
  }));
  metrics.fixtureCatchupMs = performance.now() - start;
  evidence.performance = { ...metrics, budgets: { retainedCards: 100, nativeDomNodes: 5000, nativeHtmlBytes: 2 * 1024 * 1024, fixtureCatchupMs: 12000, maximumLongTaskMs: 3000 } };
  assert.ok(metrics.cards <= 100, 'Retained message cards must remain bounded');
  assert.ok(metrics.nodes <= 5000 && metrics.htmlBytes <= 2 * 1024 * 1024, 'Native DOM budget exceeded');
  assert.ok(metrics.fixtureCatchupMs <= 12000 && metrics.maximumLongTaskMs <= 3000, 'Controlled fixture responsiveness budget exceeded');
  check('long-history fixture stays inside explicit DOM and responsiveness budgets');

  const assets = await page.evaluate(() => [...new Set([
    ...[...document.querySelectorAll('script[src],link[rel="stylesheet"][href]')].map(element => element.src || element.href),
    ...performance.getEntriesByType('resource').map(entry => entry.name).filter(url => new URL(url).origin === location.origin && new URL(url).pathname.startsWith('/assets/'))
  ])]);
  evidence.assets = [];
  for (const url of assets) {
    assert.equal(new URL(url).origin, base, 'All workbench bootstrap assets must be same-origin');
    const response = await context.request.get(url);
    assert.equal(response.status(), 200, 'Public browser asset missing: ' + new URL(url).pathname);
    const content = await response.body();
    evidence.assets.push({ path: new URL(url).pathname, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex'), contentType: response.headers()['content-type'] });
  }
  assert.ok(evidence.assets.length >= 4, 'Expected independently served browser assets');
  assert.ok(evidence.assets.some(asset => asset.path === '/assets/web/browser/core.mjs'), 'Expected the native ESM browser entry');
  assert.ok(evidence.assets.some(asset => asset.path === '/assets/web/browser/session-sync.mjs'), 'Expected the browser session-sync module');
  assert.ok(evidence.assets.some(asset => asset.path === '/assets/web/ui-native.mjs'), 'Expected the native UI module');
  assert.ok(evidence.assets.some(asset => asset.path === '/assets/web/ui-files.mjs'), 'Expected the project file preview module');
  const cliHelp = hcc('--help'); assert.ok(cliHelp.includes('hello-cc') || cliHelp.includes('hcc'));
  check('public installed CLI and current same-origin bootstrap assets read back successfully');
  await shot(page, 'desktop-native-long-history');
}
async function projectLifecycleChecks() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(browserInstrumentation);
  const page = await context.newPage(); watch(page);
  try {
    await page.goto(base + '/?token=' + env.HCC_WEB_TOKEN + '&project=' + encodeURIComponent(root + '/'));
    await select(page, 'qa-codex');
    assert.equal(await page.evaluate(() => window.hccHandoff.projectRoot), fs.realpathSync(root));
    adapters.get('codex').emit({ type: 'message', itemId: 'canonical-route', text: 'CANONICAL_ROOT_LIVE_UPDATE' });
    await page.waitForFunction(() => document.getElementById('nativeEvents').textContent.includes('CANONICAL_ROOT_LIVE_UPDATE'));
    check('trailing-slash project URL canonicalizes and receives live state without manual refresh');
    const draft = 'Unsent draft survives the persisted page lifecycle';
    await page.locator('#nativeDraft').fill(draft);
    const sent = adapters.get('codex').sent || 0;
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await page.waitForFunction(() => !window.hccHandoff.actionToken);
    await Promise.all([
      page.waitForEvent('domcontentloaded', { timeout: 15000 }),
      page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
    ]);
    await select(page, 'qa-codex');
    assert.equal(await page.locator('#nativeDraft').inputValue(), draft);
    assert.equal(adapters.get('codex').sent || 0, sent);
    adapters.get('codex').emit({ type: 'message', itemId: 'persisted-resume', text: 'PERSISTED_PAGE_LIVE_UPDATE' });
    await page.waitForFunction(() => document.getElementById('nativeEvents').textContent.includes('PERSISTED_PAGE_LIVE_UPDATE'));
    check('simulated persisted pagehide/pageshow reload restores live connection and unsent draft');
    await shot(page, 'desktop-project-lifecycle-restored');
    evidence.lifecycleScope = 'Synthetic persisted PageTransitionEvents verify the reload handler; actual browser bfcache admission is not claimed';
  } finally { await context.close(); }
}
try{
 tmux = process.env.HCC_ACCEPTANCE_TMUX || spawnSync('which',['tmux'],{encoding:'utf8'}).stdout.trim();
 assert.ok(tmux && fs.existsSync(tmux), 'Install tmux or set HCC_ACCEPTANCE_TMUX');
 const quotedTmux = "'" + tmux.replaceAll("'", "'\"'\"'") + "'";
 fs.writeFileSync(path.join(bin,'tmux'),'#!/bin/sh\nexec '+quotedTmux+' -L '+socket+' "$@"\n',{mode:0o700});
 hcc('up','--no-discover','--no-guidance');runtime=true;
 service=await startNativeService(ctx,deps,{pollMs:60000,adapterFactory:async(provider,options)=>{
  const state={provider,status:'idle',sessionId:'qa-'+provider,turnId:null,capabilities:{send:true,interrupt:true,close:true}};
  const adapter={snapshot:()=>structuredClone(state),capabilities:state.capabilities,async open(){return this.snapshot();},async send(input){this.sent=(this.sent||0)+1;state.status='running';state.turnId='qa-turn';this.active=input;return{status:'queued',turnId:state.turnId};},async interrupt(){state.status='idle';state.turnId=null;},async close(){state.status='closed';},emit(value){options.onEvent({provider,sessionId:state.sessionId,turnId:'qa-turn',...value});},state};
  adapters.set(provider,adapter);return adapter;
 }});
 for(const provider of ['codex','claude','dsh'])await api('POST','/workers',{peer:'qa-'+provider,provider});
 hcc('task','create','--title','统一 native 对话工作台');hcc('task','claim','--id','1','--peer','qa-codex');
 const codex=adapters.get('codex'),claude=adapters.get('claude'),dsh=adapters.get('dsh');
 for(let i=0;i<12;i++)codex.emit({type:'message',itemId:'history-'+i,text:'历史记录 '+(i+1)+'：检查任务与输出的关联。\n\n这是已保留的执行器消息。'});
 codex.emit({type:'item',phase:'started',item:{id:'tool',type:'commandExecution',command:'npm run test:unit',cwd:root,status:'inProgress'}});
 codex.emit({type:'item',phase:'completed',item:{id:'tool',type:'commandExecution',status:'completed',aggregatedOutput:Array.from({length:240},(_,i)=>'PASS fixture '+i).join('\n'),exitCode:0}});
 codex.emit({type:'item',phase:'completed',item:{id:'files',type:'fileChange',status:'completed',changes:[{path:'src/example.js',diff:'@@ -1 +1 @@\n-before\n+after'}]}});
 const answer='检查完成。\n\n## 验证结果\n\n- 保留原始执行器\n- 对话与轨迹分开阅读\n\n```js\nconst status = "ready";\n```\n\n**3 项检查通过**。';
 codex.emit({type:'message',itemId:'answer',text:answer});codex.emit({type:'completed',status:'completed',text:answer});
 claude.emit({type:'message',messageId:'c1',text:'Claude fixture 的独立回答。'});claude.emit({type:'completed',status:'completed',text:'Claude fixture 的独立回答。'});
 dsh.emit({type:'session.update',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'DSH 唯一'}}});dsh.emit({type:'session.update',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'回答。'}}});dsh.emit({type:'completed',status:'completed',text:'DSH 唯一回答。'});
 hcc('web','--local','--port',String(port),'--no-discover','--no-guidance');runtime=true;
 browser=await chromium.launch({headless:true,...(process.env.HCC_ACCEPTANCE_CHROME?{executablePath:process.env.HCC_ACCEPTANCE_CHROME}:{})});
 const context=await browser.newContext({viewport:{width:1440,height:1000},permissions:['clipboard-read','clipboard-write']});await context.addInitScript(browserInstrumentation);
 const p=await context.newPage();watch(p);
 await p.goto(base+'/?token='+env.HCC_WEB_TOKEN);await p.waitForFunction(()=>window.hccHandoff?.actionToken);await select(p,'qa-codex');
 assert.equal(await p.title(),'hello-cc');assert.ok((await p.locator('body').innerText()).length>200);assert.equal(await p.locator('vite-error-overlay,nextjs-portal').count(),0);check('page identity, meaningful content, no framework overlay');
 assert.equal(await p.locator('#activeTitle').innerText(),'统一 native 对话工作台');assert.equal(await p.locator('#activeDetails').getAttribute('open'),null);assert.ok(await p.locator('#handoffAccess').isVisible());
 await p.locator('#activeDetails summary').click();assert.ok((await p.locator('#activeIdentity').innerText()).includes('qa-codex'));await p.locator('#activeDetails summary').click();check('task title and compact identity disclosure keep control visible');
 await p.locator('#nativeConversation').click();assert.equal(await p.locator('#nativeEvents h2').filter({hasText:'验证结果'}).count(),1);assert.equal(await p.locator('#nativeEvents').locator('script').count(),0);assert.ok((await p.locator('#nativeHistoryRange').innerText()).includes('100'));check('safe structured native messages and bounded history notice');
 await p.locator('#nativeEvents button[data-native-copy]').last().click();assert.equal(await p.evaluate(()=>navigator.clipboard.readText()),'const status = "ready";');check('shared Markdown and full code copy');
 const tool=p.locator('#nativeEvents details').filter({has:p.locator('summary').filter({hasText:'npm run test:unit'})});await tool.locator('summary').click();await tool.scrollIntoViewIfNeeded();
 await p.evaluate(()=>{const s=document.getElementById('nativeScroll');s.scrollTop=160;document.getElementById('nativeEvents').__first=document.getElementById('nativeEvents').firstChild;});await p.locator('#nativeDraft').fill('保留尚未发送的草稿');
 await p.evaluate(()=>window.hccNative.read());assert.equal(await p.evaluate(()=>document.getElementById('nativeEvents').firstChild===document.getElementById('nativeEvents').__first),true);assert.equal(await p.locator('#nativeDraft').inputValue(),'保留尚未发送的草稿');assert.equal(await tool.getAttribute('open'),'');check('unchanged snapshots preserve DOM, open tool and draft');
 const oldTop=await p.locator('#nativeScroll').evaluate(e=>e.scrollTop);await select(p,'qa-claude');await select(p,'qa-codex');
 assert.equal(await p.locator('#nativeDraft').inputValue(),'保留尚未发送的草稿');assert.equal(await tool.getAttribute('open'),'');assert.ok(Math.abs((await p.locator('#nativeScroll').evaluate(e=>e.scrollTop))-oldTop)<3);check('A-B-A restores native reading position, disclosure and draft');
 codex.emit({type:'message',itemId:'late',text:'新的执行器消息，不应打断阅读。'});await p.locator('#nativeRead').click();assert.ok(Math.abs((await p.locator('#nativeScroll').evaluate(e=>e.scrollTop))-oldTop)<3);await p.locator('#nativeJump').click();await p.waitForFunction(()=>{const e=document.getElementById('nativeScroll');return e.scrollHeight-e.clientHeight-e.scrollTop<4;});check('new output preserves historical reading and back-to-latest works');
 await p.locator('#nativeTrace').click();assert.ok((await p.locator('#nativeEvents').innerText()).includes('message'));await p.locator('#nativeConversation').click();check('conversation and trace navigation uses the same retained events');
 await select(p,'qa-dsh');assert.equal(await p.locator('#nativeEvents .native-event-message').count(),1);assert.ok((await p.locator('#nativeEvents').innerText()).includes('DSH 唯一回答。'));await select(p,'qa-claude');assert.equal(await p.locator('#nativeEvents .native-event-message').count(),1);check('dsh and Claude completion text is not duplicated');
 await select(p,'qa-codex');await p.locator('#nativeJump').click();await shot(p,'desktop-native-conversation');
 evidence.phase='opening split';await p.locator('#splitBtn').click();evidence.phase='selecting split session';if(await p.locator('#workspaceSession').inputValue()!=='qa-claude')await p.locator('#workspaceSession').selectOption('qa-claude');await p.waitForFunction(()=>document.getElementById('workspaceFrame')?.contentWindow?.hccHandoff?.active==='qa-claude');await p.waitForFunction(()=>document.getElementById('workspaceStatus').hidden&&/(已连接|Connected)$/.test(document.getElementById('workspaceFrame').contentDocument.getElementById('handoffConnection').textContent));assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),true);await checkSharedSplit(p);await shot(p,'desktop-native-split');evidence.phase='closing connected split';await p.locator('#workspaceClose').click();check('native split panes render without overflow');
 await p.locator('#settingsBtn').click();await p.locator('#langSelect').selectOption('en');await p.locator('#themeSelect').selectOption('dark');await p.keyboard.press('Escape');await p.locator('#nativeTrace').click();assert.equal(await p.locator('#nativeConversation').innerText(),'Conversation');await shot(p,'desktop-native-dark-trace');
 await p.locator('#settingsBtn').click();await p.locator('#langSelect').selectOption('zh');await p.locator('#themeSelect').selectOption('light');await p.keyboard.press('Escape');await p.locator('#nativeConversation').click();await p.setViewportSize({width:390,height:844});await p.locator('.mobile-nav [data-view="terminal"]').click();
 assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),true);const composer=await p.locator('.native-composer').boundingBox();assert.ok(composer.height>0&&composer.y+composer.height<=845);await shot(p,'mobile-native-conversation');check('390px mobile, both languages and themes, visible composer');
 await p.setViewportSize({width:1024,height:768});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),true);check('1024px tablet no horizontal overflow');
 await runSessionToolsChecks({page:p,adapters,root,check,shot});
 const invalidContext = await context.request.get(base + '/api/context/files?root=' + encodeURIComponent(root) + '&query=..%2F', {headers:{'X-HCC-API-Version':String(API_VERSION)}});
 assert.equal(invalidContext.status(),400);assert.equal((await invalidContext.json()).error.code,'INVALID_CONTEXT_QUERY');check('authenticated invalid context query returns HTTP 400');
 await extendedChecks(p,context);
 await projectLifecycleChecks();
 await runFilePreviewChecks({browser,base,token:env.HCC_WEB_TOKEN,sandbox,registerPage:p,adapters,check,shot,watch,browserInstrumentation,evidence});
 assert.deepEqual(evidence.errors,[]);assert.deepEqual(evidence.console,[]);assert.deepEqual(hashes(),evidence.sourceFiles);check('zero browser errors and unchanged source hash during acceptance');evidence.success=true;
} catch (error) {
  evidence.success = false; evidence.failure = { message: error.message, stack: error.stack };
  console.error(error);
  if (browser) for (const browserContext of browser.contexts()) for (const page of browserContext.pages()) {
    try { await shot(page, 'failure-' + evidence.screenshots.length); fs.writeFileSync(path.join(dir, 'failure-dom.txt'), await page.locator('body').innerText()); } catch {}
  }
} finally {
  // Every teardown is attempted even when a prior cleanup operation fails.
  const clean = async (name, action) => { try { await action(); evidence.cleanup[name] = true; } catch (error) { evidence.cleanup[name] = error.message; evidence.success = false; } };
  await clean('browser', async () => { await browser?.close(); });
  await clean('webRuntime', async () => { if (runtime) hcc('down'); });
  await clean('nativeService', async () => { await service?.shutdown(); });
  await clean('tmux', async () => {
    if (!tmux) return;
    const result = spawnSync(tmux, ['-L', socket, 'kill-server'], { env, encoding: 'utf8', timeout: 5000 });
    // `hcc down` may have already removed the owned tmux server.
    if (result.error) throw result.error;
    const alive = spawnSync(tmux, ['-L', socket, 'list-sessions'], { env, encoding: 'utf8', timeout: 5000 });
    if (alive.status === 0) throw new Error('Owned tmux server still has sessions');
  });
  const after = hashes();
  evidence.sourceChanges = [...new Set([...Object.keys(evidence.sourceFiles), ...Object.keys(after)])].filter(file => evidence.sourceFiles[file] !== after[file]);
  if (evidence.sourceChanges.length) { evidence.success = false; evidence.failure ||= { message: 'Source changed during acceptance' }; }
  await clean('fixture', async () => fs.rmSync(sandbox, { recursive: true, force: true }));
  evidence.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
  console.log('EVIDENCE ' + output);
  if (!evidence.success) process.exitCode = 1;
}
