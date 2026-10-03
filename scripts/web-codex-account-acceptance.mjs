// Opt-in rendered acceptance with a synthetic Codex JSON-RPC fixture.
// No model call, real account read/login, original credential access or publication.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { initSchema } from '../lib/db/schema.mjs';
import { createEventHelpers } from '../lib/db/events.mjs';
import { createPeerHelpers } from '../lib/core/peers/peer-helpers.mjs';
import { createPeerBindingStore } from '../lib/db/stores/peers.mjs';
import { createMessageStore } from '../lib/core/coordination/messages.mjs';
import { inspectProcessIdentity } from '../lib/process/identity.mjs';
import { createCodexAdapter } from '../lib/integrations/native/codex.mjs';
import { startNativeService } from '../lib/runtime/native/service.mjs';
import { nativeRequest } from '../lib/runtime/native/client.mjs';

const args=process.argv.slice(2);
const option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
if(!args.includes('--run')) {
  console.log('Usage: node scripts/web-codex-account-acceptance.mjs --run [--output NEW_FILE]');
  console.log('Requires HCC_ACCEPTANCE_PLAYWRIGHT; optional HCC_ACCEPTANCE_CHROME / HCC_ACCEPTANCE_TMUX. Uses isolated synthetic accounts only.');
  process.exit(0);
}
assert.ok(process.env.HCC_ACCEPTANCE_PLAYWRIGHT,'Set HCC_ACCEPTANCE_PLAYWRIGHT to an installed Playwright module');
const repo=fileURLToPath(new URL('..',import.meta.url));
const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'hcc-account-web-')));
fs.chmodSync(directory,0o700);
const root=path.join(directory,'project'),home=path.join(directory,'home'),bin=path.join(directory,'bin'),codexHome=path.join(directory,'codex-home');
for(const folder of [root,home,bin,codexHome,path.join(root,'.hello-cc')])fs.mkdirSync(folder,{recursive:true,mode:0o700});
const output=path.resolve(option('--output',path.join(directory,'evidence.json')));
assert.ok(!fs.existsSync(output),'Use a new output path; existing receipts are preserved');
const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const protectedHome=process.env.CODEX_HOME||path.join(os.homedir(),'.codex');
const protectedFiles=[path.join(protectedHome,'config.toml'),path.join(protectedHome,'auth.json'),path.join(repo,'.git/index'),
  ...['.zshrc','.bashrc','.bash_profile','.profile'].map(name=>path.join(os.homedir(),name))];
const protectedHashes=protectedFiles.map(file=>[file,fs.existsSync(file)?digest(file):null]);
const evidence={startedAt:new Date().toISOString(),sourceRoot:repo,directory,browser:'Browser plugin not available; installed Chrome and Playwright',
  providerMode:'synthetic official App Server JSON-RPC fixture',modelInferenceCalled:false,externalAccountAccessed:false,
  checks:[],screenshots:[],pageErrors:[],consoleErrors:[],consoleWarnings:[],viewports:[{width:1440,height:1000},{width:390,height:844},{width:1280,height:900}],completed:false};
evidence.sourceFiles=Object.fromEntries(['lib/integrations/codex-account.mjs','lib/integrations/native/codex.mjs','lib/runtime/native/service.mjs',
  'lib/web/codex-app-server.mjs','lib/web/codex-sessions.mjs','lib/web/native-sessions.mjs','lib/web/http-routes.mjs',
  'lib/web/ui-codex-account.mjs','lib/web/ui-codex.mjs','lib/web/ui-native.mjs','scripts/web-codex-account-acceptance.mjs'].map(file=>[file,digest(path.join(repo,file))]));
const tmux=process.env.HCC_ACCEPTANCE_TMUX||'/opt/homebrew/bin/tmux',socket='hcc-account-'+randomUUID();
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
fs.writeFileSync(path.join(bin,'tmux'),'#!/bin/sh\nexec '+quote(tmux)+' -L '+quote(socket)+' "$@"\n',{mode:0o700});
const wireLog=path.join(directory,'wire.jsonl'),fixtureFile=path.join(codexHome,'account-fixture.json');
const fixture=(account,limits,extra={})=>fs.writeFileSync(fixtureFile,JSON.stringify({account,limits,...extra}),{mode:0o600});
const signedIn={requiresOpenaiAuth:true,account:{type:'chatgpt',planType:'plus',email:'fixture-private-email',accessToken:'fixture-private-token'}};
const limits={rateLimits:{limitId:'codex',primary:{usedPercent:42,windowDurationMins:300,resetsAt:1800000000},
  secondary:{usedPercent:10,windowDurationMins:10080},credits:{hasCredits:true,unlimited:false,balance:'fixture-private-balance'}}};
fixture(signedIn,limits);
fs.writeFileSync(path.join(bin,'codex'),'#!'+process.execPath+'\n'+String.raw`
const fs=require('node:fs'),readline=require('node:readline'),path=require('node:path');
const fixtureFile=path.join(process.env.CODEX_HOME,'account-fixture.json');
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const thread={id:'fixture-thread-'+process.pid,cwd:process.cwd(),status:{type:'idle'},turns:[]};
let turn=null;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line); if(!message.method || message.id===undefined)return;
 fs.appendFileSync(process.env.HCC_ACCOUNT_FIXTURE_WIRE,JSON.stringify({pid:process.pid,method:message.method,params:message.method.startsWith('account/')?message.params:{}})+'\n');
 const fixture=JSON.parse(fs.readFileSync(fixtureFile,'utf8'));
 let result={};
 if(message.method==='initialize')result={userAgent:'codex-account-fixture',codexHome:process.env.CODEX_HOME};
 else if(['thread/start','thread/resume','thread/read'].includes(message.method))result={thread};
 else if(message.method==='thread/list')result={data:[thread],nextCursor:null};
 else if(message.method==='turn/start') {turn={id:'fixture-turn-'+process.pid,status:'inProgress',items:[]};thread.turns=[turn];thread.status={type:'active',activeFlags:[]};result={turn};}
 else if(message.method==='turn/steer')result={turnId:turn?.id};
 else if(message.method==='turn/interrupt') {if(turn){turn.status='interrupted';thread.status={type:'idle'};send({method:'turn/completed',params:{threadId:thread.id,turn}});}}
 else if(message.method==='account/read')result=fixture.account;
 else if(message.method==='account/rateLimits/read') {
   if(fixture.quotaError){send({id:message.id,error:{code:-32601,message:'fixture-private-error',data:{accessToken:'fixture-private-token'}}});return;}
   result=fixture.limits;
 }
 send({id:message.id,result});
 if(message.method==='turn/start')send({method:'turn/started',params:{threadId:thread.id,turn}});
});
`,{mode:0o700});
const env={...process.env,HOME:home,CODEX_HOME:codexHome,PATH:bin+':'+path.dirname(process.execPath)+':'+process.env.PATH,
  HCC_ACCOUNT_FIXTURE_WIRE:wireLog,HCC_WEB_TOKEN:randomUUID(),HCC_SHIM_ENSURED:'1',HCC_SHIM_NO_ATTACH:'1',HCC_NO_AUTO_INSTALL_TMUX:'1'};
for(const key of Object.keys(env))if(key.startsWith('HCC_')&&!['HCC_ACCOUNT_FIXTURE_WIRE','HCC_WEB_TOKEN','HCC_SHIM_ENSURED','HCC_SHIM_NO_ATTACH','HCC_NO_AUTO_INSTALL_TMUX'].includes(key))delete env[key];
function hcc(...params){const result=spawnSync(process.execPath,[path.join(repo,'bin/hcc.mjs'),'--root',root,...params],{env,encoding:'utf8',timeout:20000});assert.equal(result.status,0,result.stderr||result.stdout);return result.stdout;}
const ctx={root,dbPath:path.join(root,'.hello-cc','mesh.db')};
const connect=()=>{const db=new DatabaseSync(ctx.dbPath);initSchema(db);return db;};
const events=createEventHelpers(),bindings=createPeerBindingStore(events),peers=createPeerHelpers({...events,now:()=>Math.floor(Date.now()/1000)});
const deps={...events,...bindings,...peers,...createMessageStore(events),connect,detectBranch:()=>'',liveProcessIdentity:pid=>inspectProcessIdentity(pid).identity};
const api=(method,route,body)=>nativeRequest(ctx,method,route,body,{timeoutMs:30000});
let service,browser,runtimeStarted=false;
const check=(name,details={})=>evidence.checks.push({name,status:'pass',...details});
async function screenshot(page,name){const file=path.join(directory,name+'.png');await page.screenshot({path:file});evidence.screenshots.push(file);}
async function rendered(page,type){await page.waitForFunction(type=>window.hccHandoff?.session?.type===type,type,{timeout:15000});assert.equal(await page.title(),'hello-cc');assert.equal(new URL(page.url()).hostname,'127.0.0.1');assert.match(await page.locator('body').innerText(),/hello-cc/);assert.equal(await page.locator('vite-error-overlay,#webpack-dev-server-client-overlay').count(),0);}
async function select(page,id){if(await page.evaluate(()=>window.hccHandoff.active)!==id)await page.locator('#sessions [data-id="'+id+'"] .session-select').click();await page.waitForFunction(id=>window.hccHandoff?.active===id,id);}
try {
  hcc('up','--no-discover','--no-guidance');
  service=await startNativeService(ctx,deps,{adapterFactory:(provider,options)=>createCodexAdapter({...options,binary:path.join(bin,'codex'),env:{...options.env,...env,HCC_PEER:options.env.HCC_PEER}})});
  const worker=await api('POST','/workers',{peer:'account-native',provider:'codex'});
  await api('POST','/send',{peer:'account-native',from:'shell',submissionId:'local_'+randomUUID(),body:'Synthetic long-running local task'});
  let original;
  for(let attempt=0;attempt<100;attempt++){original=await api('GET','/workers/account-native/state');if(original.snapshot.turnId)break;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.ok(original.snapshot.turnId,'the synthetic local task must be active before opening Web');
  check('native worker started before Web',{owner:original.owner,sessionId:worker.sessionId});
  const port=await new Promise(resolve=>{const listener=net.createServer();listener.listen(0,'127.0.0.1',()=>{const port=listener.address().port;listener.close(()=>resolve(port));});});
  hcc('web','--local','--port',String(port),'--no-discover','--no-guidance');runtimeStarted=true;
  const {chromium}=await import(process.env.HCC_ACCEPTANCE_PLAYWRIGHT);
  browser=await chromium.launch({headless:true,...(process.env.HCC_ACCEPTANCE_CHROME?{executablePath:process.env.HCC_ACCEPTANCE_CHROME}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const observe=page=>{page.on('pageerror',error=>evidence.pageErrors.push(error.message));page.on('console',message=>{if(message.type()==='error')evidence.consoleErrors.push(message.text());if(message.type()==='warning')evidence.consoleWarnings.push(message.text());});};observe(page);
  const url='http://127.0.0.1:'+port+'/';
  await page.goto(url+'?token='+env.HCC_WEB_TOKEN);await select(page,'account-native');await rendered(page,'native');
  await page.locator('#nativeAccountLabel').click();
  await page.waitForFunction(()=>/Signed in|已登录/.test(document.getElementById('nativeAccountSummary').textContent));
  assert.match(await page.locator('#nativeAccountLimits').innerText(),/42%/);await screenshot(page,'native-account-desktop');
  const refreshed=await api('GET','/workers/account-native/state');
  assert.equal(refreshed.owner,original.owner);assert.equal(refreshed.snapshot.sessionId,original.snapshot.sessionId);assert.equal(refreshed.snapshot.turnId,original.snapshot.turnId);
  check('rendered account read preserves the original local executor and active turn');
  const stale=await page.request.get(url+'api/sessions/account-native/native/account?root='+encodeURIComponent(root)+'&generation='+original.generation+'&owner=old-owner&sessionId='+worker.sessionId,{headers:{'X-HCC-API-Version':'2'}});
  assert.equal(stale.status(),409);check('stale native account identity refused');
  const observer=await browser.newPage({viewport:{width:1280,height:900}});observe(observer);await observer.goto(url+'?token='+env.HCC_WEB_TOKEN);await select(observer,'account-native');await rendered(observer,'native');
  assert.equal(await observer.evaluate(()=>window.hccHandoff.canControl),false);await observer.locator('#nativeAccountLabel').click();
  fixture(signedIn,{rateLimits:{...limits.rateLimits,primary:{...limits.rateLimits.primary,usedPercent:61}}});await observer.locator('#nativeAccountRead').click();
  await observer.waitForFunction(()=>document.getElementById('nativeAccountLimits').textContent.includes('61%'));
  assert.equal(await observer.locator('#nativeSend').isEnabled(),false);check('observer account refresh remains read-only');
  await observer.close();
  await page.setViewportSize({width:390,height:844});
  fixture({account:null,requiresOpenaiAuth:true},{});await page.locator('#nativeAccountRead').click();
  await page.waitForFunction(()=>/sign-in required|需要在本地 Codex 登录/.test(document.getElementById('nativeAccountSummary').textContent));
  await page.waitForFunction(()=>!document.getElementById('nativeAccountRead').disabled);
  await page.locator('#nativeAccountLabel').scrollIntoViewIfNeeded();await screenshot(page,'native-account-mobile-login');
  await page.locator('#nativeAccountRead').scrollIntoViewIfNeeded();assert.equal(await page.locator('#nativeAccountRead').isEnabled(),true);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));await screenshot(page,'native-account-mobile-actions');check('mobile local-login state remains usable');
  fixture(signedIn,{}, {quotaError:true});await page.locator('#nativeAccountRead').click();
  await page.waitForFunction(()=>/does not provide|未提供订阅限额/.test(document.getElementById('nativeAccountLimits').textContent));
  await page.waitForFunction(()=>!document.getElementById('nativeAccountRead').disabled);
  assert.equal(await page.locator('#nativeAccountLimits progress').count(),0);await screenshot(page,'native-account-mobile-unknown-limits');check('unsupported quota is displayed as unavailable, not zero');
  fixture({account:null,requiresOpenaiAuth:false},{});await page.setViewportSize({width:1440,height:1000});
  const created=await page.evaluate(async root=>window.hccHandoff.api('/api/sessions?root='+encodeURIComponent(root),{method:'POST',body:JSON.stringify({kind:'codex',transport:'app-server'})}),root);
  const webId=created.session.id;
  await page.evaluate(async id=>{await window.hccHandoff.refreshSessions();window.hccHandoff.openManaged(id);},webId);await rendered(page,'app-server');
  await page.locator('#codexAccountLabel').click();await page.waitForFunction(()=>/Provider-managed|供应商自行管理认证/.test(document.getElementById('codexAccountSummary').textContent));
  const webState=await page.evaluate(async({id,root})=>(await window.hccHandoff.api('/api/sessions/'+id+'/codex/state?root='+encodeURIComponent(root))).state,{id:webId,root});
  const wrongExecutor=await page.request.get(url+'api/sessions/'+webId+'/codex/account?root='+encodeURIComponent(root)+'&executorId=old-executor',{headers:{'X-HCC-API-Version':'2'}});
  assert.equal(wrongExecutor.status(),409);await screenshot(page,'web-owned-account-desktop-provider');check('Web-owned custom provider status and stale executor refusal');
  await page.setViewportSize({width:390,height:844});fixture(signedIn,limits);await page.locator('#codexAccountRead').click();
  await page.waitForFunction(()=>document.getElementById('codexAccountLimits').textContent.includes('42%'));
  await page.waitForFunction(()=>!document.getElementById('codexAccountRead').disabled);await page.locator('#codexAccountLabel').scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));await screenshot(page,'web-owned-account-mobile-limits');check('Web-owned mobile subscription windows render correctly');
  const publicData=await page.evaluate(()=>JSON.stringify({body:document.body.innerText,storage:{...localStorage},sessionStorage:{...sessionStorage}}));
  assert.doesNotMatch(publicData,/fixture-private-/);
  const db=connect();try{assert.doesNotMatch(JSON.stringify(db.prepare('SELECT payload FROM events').all()),/fixture-private-/);}finally{db.close();}
  const accountWire=fs.readFileSync(wireLog,'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(row=>row.method.startsWith('account/'));
  assert.ok(accountWire.length>0);assert.ok(accountWire.every(row=>['account/read','account/rateLimits/read'].includes(row.method)));
  assert.ok(accountWire.filter(row=>row.method==='account/read').every(row=>row.params.refreshToken===false));
  check('no secrets in rendered state/storage/events and no auth mutation on the wire');
  await page.close();await browser.close();browser=null;
  hcc('down');runtimeStarted=false;
  const returned=await api('GET','/workers/account-native/state');assert.equal(returned.owner,original.owner);assert.equal(returned.snapshot.turnId,original.snapshot.turnId);
  check('Web shutdown leaves original native execution alive');
  assert.deepEqual(evidence.pageErrors,[]);assert.deepEqual(evidence.consoleErrors,[]);assert.deepEqual(evidence.consoleWarnings,[]);evidence.completed=true;
} catch(error) {
  evidence.error=error.message;process.exitCode=1;
  if(browser)for(const context of browser.contexts())for(const page of context.pages())try{await screenshot(page,'failure-'+evidence.screenshots.length);}catch{}
} finally {
  await browser?.close();
  if(runtimeStarted)try{hcc('down');}catch{}
  try{await service?.shutdown();evidence.nativeClosed=true;}catch(error){evidence.cleanupError=error.message;process.exitCode=1;evidence.completed=false;}
  try{hcc('down');}catch{}
  spawnSync(tmux,['-L',socket,'kill-server'],{stdio:'ignore'});
  evidence.protectedFilesUnchanged=protectedHashes.every(([file,hash])=>(fs.existsSync(file)?digest(file):null)===hash);
  if(!evidence.protectedFilesUnchanged){process.exitCode=1;evidence.completed=false;}
  for(const folder of [root,home,bin,codexHome])fs.rmSync(folder,{recursive:true,force:true});
  evidence.temporaryHomesRemoved=!fs.existsSync(home)&&!fs.existsSync(codexHome);
  evidence.finishedAt=new Date().toISOString();fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({evidence:output,completed:evidence.completed,checks:evidence.checks.length,error:evidence.error||null,protectedFilesUnchanged:evidence.protectedFilesUnchanged}));
}
