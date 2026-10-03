// Browser acceptance with isolated simulated providers. No real model or provider authentication is used.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
if (!process.argv.includes('--run-browser')) { console.log('Use --run-browser with HCC_ACCEPTANCE_PLAYWRIGHT and optional HCC_ACCEPTANCE_CHROME. Uses simulated providers and isolated projects; no model calls.'); process.exit(0); }
const { chromium } = await import(process.env.HCC_ACCEPTANCE_PLAYWRIGHT || 'playwright');
import { createEventHelpers } from '../lib/db/events.mjs';
import { createPeerHelpers } from '../lib/core/peers/peer-helpers.mjs';
import { createPeerBindingStore } from '../lib/db/stores/peers.mjs';
import { createMessageStore } from '../lib/core/coordination/messages.mjs';
import { inspectProcessIdentity } from '../lib/process/identity.mjs';
import { startNativeService } from '../lib/runtime/native/service.mjs';
import { nativeRequest } from '../lib/runtime/native/client.mjs';
import { createNativeInteractions } from '../lib/integrations/native/interactions.mjs';
import { codexInteractionResponse, codexInteractionKind, cancelCodexInteraction } from '../lib/integrations/codex-interactions.mjs';
const node=process.execPath, repo=fileURLToPath(new URL('..',import.meta.url));
const dir=fs.realpathSync(fs.mkdtempSync('/tmp/hcc-interactions-ui-')),root=path.join(dir,'project'),home=path.join(dir,'home'),bin=path.join(dir,'bin'),socket='hcc-interactions-'+Date.now();
for(const folder of [root,home,bin])fs.mkdirSync(folder);
const formParams={mode:'form',serverName:'form-fixture',message:'Provide project settings <script>bad()</script>',requestedSchema:{type:'object',properties:{name:{type:'string',title:'Project <name>',minLength:3,maxLength:20},count:{type:'integer',minimum:1,maximum:4},enabled:{type:'boolean'},region:{type:'string',oneOf:[{const:'eu',title:'Europe'},{const:'us',title:'USA'}]},features:{type:'array',minItems:1,maxItems:2,items:{anyOf:[{const:'logs',title:'Logs'},{const:'tests',title:'Tests'}]}},optional:{type:'string',default:'suggested'}},required:['name','count','enabled','region','features']}};
const env={PATH:bin+':'+path.dirname(node)+':/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',HOME:home,SHELL:'/bin/bash',LANG:'en_US.UTF-8',TMPDIR:dir,CODEX_HOME:path.join(home,'.codex'),HCC_NO_AUTO_INSTALL_TMUX:'1',HCC_WEB_TOKEN:'qa-interactive-isolated',HCC_TEST_MCP_RPC:path.join(dir,'mcp-rpc.jsonl')};
const tmux=spawnSync('which',['tmux'],{encoding:'utf8'}).stdout.trim();if(!tmux||!fs.existsSync(tmux))throw Error('tmux is required for isolated Web runtime acceptance');
fs.writeFileSync(path.join(bin,'tmux'),'#!/bin/sh\nexec '+JSON.stringify(tmux)+' -L '+socket+' "$@"\n',{mode:0o700});
fs.writeFileSync(path.join(bin,'codex'),`#!${node}
import readline from 'node:readline';
import fs from 'node:fs';
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n'),reply=(m,r)=>send({id:m.id,result:r});
let thread={id:'qa-thread',cwd:process.cwd(),status:{type:'idle'},turns:[]}, pending, turn;
const req=(method,params)=>{pending=params.mode==='url'?'mcp-url':method;send({id:params.mode==='url'?'mcp-url':method==='mcpServer/elicitation/request'?0:method,method,params:{threadId:thread.id,turnId:turn.id,itemId:method,...params}})};
readline.createInterface({input:process.stdin}).on('line',line=>{
const m=JSON.parse(line),p=m.params||{};
if(!m.method){fs.appendFileSync(process.env.HCC_TEST_MCP_RPC,JSON.stringify(m)+'\\n');send({method:'serverRequest/resolved',params:{threadId:thread.id,requestId:m.id}});if(pending==='item/permissions/requestApproval'){req('item/tool/requestUserInput',{questions:[{id:'choice',header:'Choice',question:'Which mode?',options:[{label:'Blue',description:'Blue mode'},{label:'Red',description:'Red mode'}]}]});}else if(pending==='item/tool/requestUserInput'){req('mcpServer/elicitation/request',${JSON.stringify(formParams)});}else if(pending==='mcpServer/elicitation/request'){req('mcpServer/elicitation/request',{mode:'url',serverName:'form-fixture',message:'External authentication',url:'javascript:alert(1)',elicitationId:'unsupported-url'});}else{turn.status='completed';send({method:'turn/completed',params:{threadId:thread.id,turn}});}return;}
if(m.method==='initialized')return;
if(m.method==='initialize')return reply(m,{userAgent:'ui-fake'});
if(m.method==='thread/list')return reply(m,{data:[thread],nextCursor:null});
if(['thread/start','thread/resume','thread/read'].includes(m.method))return reply(m,{thread});
if(m.method==='turn/start'){turn={id:'qa-turn',status:'inProgress',items:[]};thread.turns.push(turn);thread.status={type:'active'};reply(m,{turn});req('item/permissions/requestApproval',{cwd:process.cwd(),reason:'Test bounded permission',permissions:{network:{enabled:true},fileSystem:{read:['/read-only'],write:['/project']}}});return;}
reply(m,{});
});
`,{mode:0o700});
function sourceHashes(){const result={};const walk=folder=>{for(const entry of fs.readdirSync(path.join(repo,folder),{withFileTypes:true})){const file=path.join(folder,entry.name);if(entry.isDirectory())walk(file);else if(entry.isFile())result[file]=createHash('sha256').update(fs.readFileSync(path.join(repo,file))).digest('hex');}};for(const folder of ['bin','lib','scripts','test'])walk(folder);for(const file of ['package.json','package-lock.json'])result[file]=createHash('sha256').update(fs.readFileSync(path.join(repo,file))).digest('hex');return result;}
const evidence={dir,checks:[],screenshots:[],pageErrors:[],consoleErrors:[],browser:'Browser plugin not available; isolated installed Chrome + Playwright',providerMode:'simulated protocol requests; production HTTP, SQLite, worker and browser paths; no inference',node:process.version,sourceRoot:repo,sourceFiles:sourceHashes(),startedAt:new Date().toISOString()};
const check=(name,extra={})=>{evidence.checks.push({name,...extra});console.log('PASS '+name);};
function hcc(...args){const r=spawnSync(node,[path.join(repo,'bin/hcc.mjs'),'--root',root,...args],{cwd:root,env,encoding:'utf8',timeout:30000});if(r.status!==0)throw Error('Isolated CLI failed '+args[0]);return r.stdout;}
const ctx={root,dbPath:path.join(root,'.hello-cc','mesh.db')},events=createEventHelpers(),binding=createPeerBindingStore(events),peer=createPeerHelpers({now:()=>Math.floor(Date.now()/1000),...events});
const deps={...events,...binding,...peer,...createMessageStore(events),connect:()=>new DatabaseSync(ctx.dbPath),detectBranch:()=>'',liveProcessIdentity:pid=>inspectProcessIdentity(pid).identity};
let browser,service,runtime=false,state,interactions,emit,adapter;
const api=(method,route,body)=>nativeRequest(ctx,method,route,body);
const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});}),base='http://127.0.0.1:'+port;
const shot=async(page,name)=>{const file=path.join(dir,name+'.png');await page.screenshot({path:file});evidence.screenshots.push(file);};
const wait=(page,fn)=>page.waitForFunction(fn,null,{timeout:12000});
function ask(id,method,params){state.turnId='native-turn';state.status='running';return interactions.request({requestId:id,sessionId:state.sessionId,turnId:state.turnId,method,kind:codexInteractionKind(method),params,validate:codexInteractionResponse,cancelled:cancelCodexInteraction(method)});}
try{
hcc('up','--no-discover','--no-guidance');
service=await startNativeService(ctx,deps,{pollMs:60000,adapterFactory:async(provider,options)=>{
state={provider,status:'idle',sessionId:'native-qa-session',turnId:null,executorId:options.executorId,capabilities:{send:true,interrupt:true,close:true,approvals:true,userInput:true}};emit=options.onEvent;
interactions=createNativeInteractions({executorId:options.executorId,isActive:(session,turn)=>session===state.sessionId&&turn===state.turnId&&state.status==='running',onChange:emit});
adapter={capabilities:state.capabilities,snapshot:()=>({...state,pendingApprovals:interactions.snapshot()}),async open(){return this.snapshot();},respond:interactions.respond,async interrupt(){interactions.expire();state.turnId=null;state.status='idle';return{status:'interrupting'};},async close(){interactions.expire();state.status='closed';}};return adapter;
}});
await api('POST','/workers',{peer:'native-qa',provider:'codex'});
hcc('web','--local','--port',String(port),'--no-discover','--no-guidance');runtime=true;
browser=await chromium.launch({headless:true,executablePath:process.env.HCC_ACCEPTANCE_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const a=await browser.newContext({viewport:{width:1440,height:1000}}),b=await browser.newContext({viewport:{width:1280,height:900}});
for(const c of [a,b])await c.addInitScript(()=>localStorage.setItem('hcc.lang','en'));
const p1=await a.newPage(),p2=await b.newPage();
for(const [p,label]of [[p1,'controller'],[p2,'observer']]){p.on('pageerror',e=>evidence.pageErrors.push({label,message:e.message}));p.on('console',m=>{if(['warning','error'].includes(m.type()))evidence.consoleErrors.push({label,text:m.text()});});p.on('dialog',d=>d.accept());}
await p1.goto(base+'/?token='+env.HCC_WEB_TOKEN);await wait(p1,()=>window.hccHandoff?.canControl&&window.hccHandoff.session?.type==='native');
assert.equal(await p1.title(),'hello-cc');assert.ok((await p1.locator('body').innerText()).length>200);check('page identity, nonblank, native view and no error overlay');
const command=ask('command','item/commandExecution/requestApproval',{command:'echo <script>bad()</script>',cwd:root});
await p1.locator('#nativeRead').click();await p1.locator('#nativeApprovals button[data-decision="accept"]').waitFor();
await p2.goto(base+'/?token='+env.HCC_WEB_TOKEN);await wait(p2,()=>window.hccHandoff?.session?.type==='native'&&window.hccHandoff.actionToken);
assert.equal(await p2.locator('#nativeApprovals button[data-decision="accept"]').isDisabled(),true);assert.equal(await p1.locator('#nativeApprovals script').count(),0);check('observer approvals disabled and request previews escape HTML');
await p1.locator('#nativeApprovals button[data-decision="accept"]').click();assert.deepEqual(await command,{decision:'accept'});await wait(p1,()=>!document.querySelector('#nativeApprovals button'));check('manual command approval resolves the original request and removes its card');
const permissions=ask('permissions','item/permissions/requestApproval',{permissions:{network:{enabled:true},fileSystem:{read:['/read-only'],write:['/write-only']}}});
await p1.locator('#nativeRead').click();await p1.locator('#nativeApprovals [data-permission="read"]').check();
await shot(p1,'native-permissions-desktop');
await p1.locator('#nativeApprovals button[data-decision="accept"]').click();assert.deepEqual(await permissions,{permissions:{fileSystem:{read:['/read-only']}},scope:'turn'});check('permissions submit only selected read path with explicit turn duration');
const questions=ask('questions','item/tool/requestUserInput',{questions:[{id:'color',header:'Color',question:'Choose color',isOther:true,options:[{label:'Blue',description:'Blue option'},{label:'Red',description:'Red option'}]},{id:'secret',header:'Secret',question:'Private input',isSecret:true}]});
await p1.locator('#nativeRead').click();await p1.locator('#nativeApprovals button[data-decision="accept"]').click();await wait(p1,()=>document.getElementById('nativeNotice').textContent.includes('answer every question'));assert.equal(interactions.snapshot().length,1);check('unanswered questions remain pending');
await p1.locator('#nativeApprovals [data-question="0"]').selectOption('other');await p1.locator('#nativeApprovals [data-answer="0"]').fill('Green');await p1.locator('#nativeApprovals [data-answer="1"]').fill('private-qa-answer');
await p1.locator('#nativeRead').click();assert.equal(await p1.locator('#nativeApprovals [data-answer="0"]').inputValue(),'Green');assert.equal(await p1.locator('#nativeApprovals [data-answer="1"]').inputValue(),'private-qa-answer');check('question draft and secret input survive state refresh without local storage');
await p1.locator('#nativeApprovals button[data-decision="accept"]').click();const answers=await questions;assert.deepEqual(JSON.parse(JSON.stringify(answers)),{answers:{color:{answers:['Green']},secret:{answers:['private-qa-answer']}}});
assert.equal(await p1.evaluate(()=>JSON.stringify(localStorage).includes('private-qa-answer')),false);assert.equal(JSON.stringify(await api('GET','/workers/native-qa/state')).includes('private-qa-answer'),false);check('choice/freeform/secret response shape is correct and answers are absent from events/storage');
const form=ask('mcp-form','mcpServer/elicitation/request',formParams);
await p1.locator('#nativeRead').click();await p1.locator('#nativeApprovals [data-mcp-field="0"]').waitFor();
assert.equal(await p1.locator('#nativeApprovals script').count(),0);assert.ok((await p1.locator('#nativeApprovals').innerText()).includes('Project <name>'));
await p1.locator('#nativeApprovals [data-mcp-field="0"]').fill('private-ui-form');await p1.locator('#nativeApprovals [data-mcp-field="1"]').fill('0');
await p1.locator('#nativeApprovals [data-mcp-field="2"]').selectOption('1');await p1.locator('#nativeApprovals [data-mcp-field="3"]').selectOption('0');await p1.locator('#nativeApprovals [data-mcp-field="4"][data-mcp-option="1"]').check();
await p1.locator('#nativeApprovals button[data-decision="accept"]').click();await p1.waitForFunction(()=>document.getElementById('nativeNotice').textContent.includes('Invalid value'));assert.equal(interactions.snapshot().length,1);check('MCP invalid values stay pending and malicious schema labels remain text');
await p1.locator('#nativeApprovals [data-mcp-field="1"]').fill('2');await p1.locator('#nativeRead').click();assert.equal(await p1.locator('#nativeApprovals [data-mcp-field="0"]').inputValue(),'private-ui-form');assert.equal(await p1.locator('#nativeApprovals [data-mcp-field="4"][data-mcp-option="1"]').isChecked(),true);check('MCP text and multiselect drafts survive state refresh in page memory');
await p1.evaluate(()=>{document.querySelector('.native-scroll').scrollTop=0;});await shot(p1,'native-mcp-form-desktop');await p1.setViewportSize({width:390,height:844});assert.equal(await p1.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),true);await p1.evaluate(()=>{document.querySelector('.native-scroll').scrollTop=0;});await shot(p1,'native-mcp-form-mobile');await p1.locator('#nativeApprovals button[data-decision="accept"]').scrollIntoViewIfNeeded();await shot(p1,'native-mcp-form-mobile-submit');check('MCP form controls fit desktop and mobile viewports');
await p1.locator('#nativeApprovals button[data-decision="accept"]').click();assert.deepEqual(await form,{action:'accept',content:{name:'private-ui-form',count:2,enabled:false,region:'eu',features:['tests']}});
assert.equal(await p1.evaluate(()=>JSON.stringify(localStorage).includes('private-ui-form')),false);assert.equal(JSON.stringify(await api('GET','/workers/native-qa/state')).includes('private-ui-form'),false);check('MCP typed response reaches the original native request, optional defaults are omitted and answers are not retained');await p1.setViewportSize({width:1440,height:1000});
const unsupported=ask('unsupported-url','mcpServer/elicitation/request',{mode:'url',serverName:'form-fixture',message:'Authenticate',url:'https://auth.example.invalid'});await p1.locator('#nativeRead').click();assert.equal(await p1.locator('#nativeApprovals button[data-decision="accept"]').isDisabled(),true);await p1.locator('#nativeApprovals button[data-decision="cancel"]').click();assert.deepEqual(await unsupported,{action:'cancel'});check('MCP URL request missing its elicitation identity has blocked acceptance and usable cancellation');
const malformed=ask('unsupported-schema','mcpServer/elicitation/request',{...formParams,requestedSchema:{type:'object',properties:{nested:{type:'object'}}}});await p1.locator('#nativeRead').click();assert.equal(await p1.locator('#nativeApprovals button[data-decision="accept"]').isDisabled(),true);await p1.locator('#nativeApprovals button[data-decision="decline"]').click();assert.deepEqual(await malformed,{action:'decline'});check('unsupported MCP schema remains explicitly rejectable');
// A valid URL flow uses the same controls, with an isolated intercepted destination.
await a.route('https://auth.example.invalid/device*',route=>route.fulfill({status:200,contentType:'text/html',body:'<title>Synthetic authorization</title><h1>Complete the external flow</h1>'}));
const urlFlow=ask('url-flow','mcpServer/elicitation/request',{mode:'url',serverName:'form-fixture',message:'Synthetic external authorization',elicitationId:'private-ui-flow',url:'https://auth.example.invalid/device?code=private-ui-url-code'});
await p1.locator('#nativeRead').click();await p2.locator('#nativeRead').click();
assert.equal(await p1.locator('#nativeApprovals button[data-decision="accept"]').isEnabled(),true);
assert.equal(await p2.locator('#nativeApprovals button[data-decision="accept"]').isDisabled(),true);
assert.equal((await p1.locator('#nativeApprovals').innerText()).includes('private-ui-url-code'),false);
await p1.evaluate(()=>{window.hccTestOpen=window.open;window.open=()=>null;});
await p1.locator('#nativeApprovals button[data-decision="accept"]').click();
await wait(p1,()=>document.getElementById('nativeNotice').textContent.includes('pop-ups'));
assert.equal(interactions.snapshot().length,1);
await p1.evaluate(()=>{window.open=window.hccTestOpen;delete window.hccTestOpen;});
await shot(p1,'native-mcp-url-desktop');
const popupWait=a.waitForEvent('page');await p1.locator('#nativeApprovals button[data-decision="accept"]').click();const popup=await popupWait;
await popup.waitForURL('https://auth.example.invalid/device?code=private-ui-url-code');
assert.deepEqual(await urlFlow,{action:'accept'});assert.equal(await popup.evaluate(()=>window.opener),null);await popup.close();
const urlState=await api('GET','/workers/native-qa/state');
assert.equal(JSON.stringify(urlState).includes('private-ui-url-code'),false);assert.equal(JSON.stringify(urlState).includes('private-ui-flow'),false);
assert.equal(await p1.evaluate(()=>JSON.stringify(localStorage).includes('private-ui-url-code')),false);
check('valid URL opens only for the controller after exact acceptance; popup blocking preserves the request and links are not retained');
const takeover=ask('takeover','mcpServer/elicitation/request',{mode:'form',requestedSchema:{type:'object',properties:{enabled:{type:'boolean'}},required:['enabled']}});await p1.locator('#nativeRead').click();await p2.locator('#nativeRead').click();await p2.locator('#claimControlBtn').click();await wait(p2,()=>window.hccHandoff.canControl);await wait(p1,()=>!window.hccHandoff.canControl);
assert.equal(await p1.locator('#nativeApprovals button[data-decision="accept"]').isDisabled(),true);await p2.locator('#nativeApprovals [data-mcp-field="0"]').selectOption('0');await p2.locator('#nativeApprovals button[data-decision="accept"]').click();assert.deepEqual(await takeover,{action:'accept',content:{enabled:true}});check('lease takeover fences the old browser and enables the new controller');
const mobile=ask('mobile','item/permissions/requestApproval',{permissions:{network:{enabled:true},fileSystem:{read:['/long/path/with-a-readable-file-name'],write:['/work']}}});
await p2.setViewportSize({width:390,height:844});await p2.locator('#nativeRead').click();await p2.locator('#nativeApprovals [data-permission="read"]').waitFor();
assert.equal(await p2.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),true);await p2.evaluate(()=>{const el=document.querySelector('.header-controls');el.scrollLeft=el.scrollWidth;});assert.equal(await p2.evaluate(()=>document.getElementById('logoutBtn').getBoundingClientRect().right<=innerWidth),true);await shot(p2,'native-permissions-mobile');await p2.locator('#nativeApprovals button[data-decision="decline"]').click();assert.deepEqual(await mobile,{permissions:{},scope:'turn'});check('mobile permission controls wrap without page overflow and can decline');
await p1.locator('#openHistoryDialog').click();await p1.locator('#historyThreads [data-thread="qa-thread"]').waitFor();await p1.locator('#historyThreads [data-thread="qa-thread"]').click();await p1.locator('#historyConfirmed').check();await p1.locator('#historyResume').click();await wait(p1,()=>window.hccHandoff.canControl&&window.hccHandoff.session?.type==='app-server');
await p1.locator('#codexDraft').fill('test interactive permissions');await p1.locator('#codexSend').click();await p1.locator('#codexApprovals [data-permission="network"]').waitFor();await p1.locator('#codexApprovals [data-permission="network"]').check();await shot(p1,'codex-permissions-desktop');await p1.locator('#codexApprovals button[data-decision="accept"]').click();
await p1.locator('#codexApprovals [data-question="0"]').waitFor();await p1.locator('#codexApprovals [data-question="0"]').selectOption('0');await shot(p1,'codex-question-desktop');await p1.locator('#codexApprovals button[data-decision="accept"]').click();check('Web-owned App Server permissions and userInput use the same form and actual RPC replies');
await p1.locator('#codexApprovals [data-mcp-field="0"]').waitFor();await p1.locator('#codexApprovals [data-mcp-field="0"]').fill('web-owned-form');await p1.locator('#codexApprovals [data-mcp-field="1"]').fill('3');await p1.locator('#codexApprovals [data-mcp-field="2"]').selectOption('1');await p1.locator('#codexApprovals [data-mcp-field="3"]').selectOption('1');await p1.locator('#codexApprovals [data-mcp-field="4"][data-mcp-option="0"]').check();await shot(p1,'web-owned-mcp-form-desktop');await p1.locator('#codexApprovals button[data-decision="accept"]').click();
await p1.waitForFunction(()=>document.querySelector('#codexApprovals button[data-decision="cancel"]')&&document.querySelector('#codexApprovals button[data-decision="accept"]')?.disabled);await p1.locator('#codexApprovals button[data-decision="cancel"]').click();await wait(p1,()=>!document.querySelector('#codexApprovals button'));
const replies=fs.readFileSync(env.HCC_TEST_MCP_RPC,'utf8').trim().split('\n').map(JSON.parse);assert.deepEqual(replies.find(reply=>reply.id===0).result,{action:'accept',content:{name:'web-owned-form',count:3,enabled:false,region:'us',features:['logs']}});assert.deepEqual(replies.find(reply=>reply.id==='mcp-url').result,{action:'cancel'});check('Web-owned MCP forms return typed content to exact RPC id zero and URL mode stays cancellable');
assert.equal(await p1.evaluate(()=>JSON.stringify(localStorage).includes('web-owned-form')),false);check('Web-owned MCP response is absent from browser storage');
assert.deepEqual(evidence.pageErrors,[]);assert.deepEqual(evidence.consoleErrors,[]);check('zero page errors or console warnings/errors');evidence.success=true;
}catch(error){evidence.success=false;evidence.error=error.message;console.error(error);if(browser)for(const context of browser.contexts())for(const page of context.pages())try{await shot(page,'failure-'+browser.contexts().indexOf(context));}catch{}}
finally{evidence.finishedAt=new Date().toISOString();const after=sourceHashes();evidence.sourceChangesDuringValidation=[...new Set([...Object.keys(evidence.sourceFiles),...Object.keys(after)])].filter(file=>after[file]!==evidence.sourceFiles[file]);if(evidence.sourceChangesDuringValidation.length){evidence.success=false;evidence.error='Source changed during browser validation';}await browser?.close();if(runtime)try{hcc('down');}catch(e){evidence.cleanupError=e.message;}await service?.shutdown();spawnSync(path.join(bin,'tmux'),['kill-server'],{env,stdio:'ignore'});fs.writeFileSync(path.join(dir,'evidence.json'),JSON.stringify(evidence,null,2));fs.writeFileSync('/tmp/hcc-mcp-form-ui-latest.json',JSON.stringify(evidence,null,2));for(const folder of [root,home,bin])fs.rmSync(folder,{recursive:true,force:true});console.log('EVIDENCE '+dir);if(!evidence.success)process.exitCode=1;}
