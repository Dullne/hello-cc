import test from 'node:test';
import assert from 'node:assert/strict';
import { installAgentDefaults,agentDefaultsHtml } from '../lib/web/ui-agent-defaults.mjs';
import { UI_TRANSLATIONS } from '../lib/web/ui-i18n.mjs';

const settle=()=>new Promise(resolve=>setImmediate(resolve));
function deferred() { let resolve,reject; const promise=new Promise((yes,no)=>{resolve=yes;reject=no;}); return {promise,resolve,reject}; }
const defaults=(revision=0,extra={})=>({revision,defaultProvider:'codex',providers:{codex:{model:null,cwd:'.'},claude:{model:null,cwd:'.'},dsh:{model:null,cwd:'.'}},...extra});
function fixture() {
  const nodes=new Map(), requests=[], listeners=new Map(); let root='/a';
  const node=id=>{
    if (!nodes.has(id)) nodes.set(id,{id,value:'',hidden:false,disabled:false,textContent:'',attributes:{},listeners:new Map(),
      addEventListener(name,listener) { this.listeners.set(name,listener); },setAttribute(name,value) { this.attributes[name]=value; },
      emit(name) { return this.listeners.get(name)?.({preventDefault(){}}); }});
    return nodes.get(id);
  };
  node('settingsDialog').hidden=true;
  const window={addEventListener:(name,listener)=>listeners.set(name,listener),hccHandoff:{get projectRoot(){return root;},tr:key=>UI_TRANSLATIONS.en[key] || key,
    api(path,options) { const request={path,options,...deferred()}; requests.push(request); return request.promise; }}};
  installAgentDefaults({window,document:{getElementById:node}});
  return {node,requests,window,
    open() { node('settingsDialog').hidden=false; window.hccAgentDefaults.open(); },
    close() { window.hccAgentDefaults.closed(); node('settingsDialog').hidden=true; },
    project(value) { window.hccAgentDefaults.reset(); root=value; },
    input(id,value) { node(id).value=value; return node(id).emit('input'); },
    click:id=>node(id).emit('click'),submit:()=>node('agentDefaultsForm').emit('submit')};
}
async function loaded(f,value=defaults()) { f.open(); f.requests.at(-1).resolve(value); await settle(); }

test('project settings load by root and require explicit save without changing appearance preferences', async () => {
  const f=fixture(); f.open(); assert.equal(f.requests[0].path,'/api/agent-defaults?root=%2Fa');
  assert.equal(f.node('agentDefaultsSave').disabled,true); assert.equal(f.node('agentDefaultsCodexModel').disabled,true);
  f.requests[0].resolve(defaults(4)); await settle();
  f.input('agentDefaultsProvider','claude'); f.input('agentDefaultsClaudeModel',' model-a '); f.input('agentDefaultsClaudeCwd',' packages/app ');
  assert.equal(f.requests.length,1); assert.equal(f.node('agentDefaultsSave').disabled,false);
  const saving=f.submit(); const body=JSON.parse(f.requests[1].options.body);
  assert.equal(f.requests[1].options.method,'PUT'); assert.equal(body.revision,4); assert.equal(body.defaultProvider,'claude');
  assert.deepEqual(body.providers.claude,{model:'model-a',cwd:'packages/app'});
  assert.equal(f.node('agentDefaultsSave').disabled,true);
  f.requests[1].resolve({...body,revision:5}); await saving;
  assert.match(f.node('agentDefaultsStatus').textContent,/defaults saved/); assert.equal(f.node('agentDefaultsSave').disabled,true);
  assert.equal(f.node('agentDefaultsClaudeModel').value,'model-a');
  assert.doesNotMatch(agentDefaultsHtml(),/type="password"|api[_-]?key/i);
});

test('restoring initial defaults edits the form and only saving changes the project', async () => {
  const f=fixture(), saved=defaults(8,{defaultProvider:'dsh'}); saved.providers.dsh={model:'saved-model',cwd:'src'};
  await loaded(f,saved); f.click('agentDefaultsReset');
  assert.equal(f.node('agentDefaultsProvider').value,'codex'); assert.equal(f.node('agentDefaultsDshModel').value,''); assert.equal(f.node('agentDefaultsDshCwd').value,'.');
  assert.equal(f.requests.length,1); assert.match(f.node('agentDefaultsStatus').textContent,/Save to apply/);
  const saving=f.submit(); assert.equal(JSON.parse(f.requests[1].options.body).revision,8);
  f.requests[1].resolve(defaults(9)); await saving;
});

test('an acknowledged save preserves edits typed after submission and advances their revision', async () => {
  const f=fixture(); await loaded(f); f.input('agentDefaultsCodexModel','submitted'); const saving=f.submit();
  f.input('agentDefaultsCodexModel','newer draft'); const receipt=defaults(1); receipt.providers.codex.model='submitted';
  f.requests[1].resolve(receipt); await saving;
  assert.equal(f.node('agentDefaultsCodexModel').value,'newer draft'); assert.match(f.node('agentDefaultsStatus').textContent,/newer edits.*unsaved/);
  assert.equal(f.node('agentDefaultsSave').disabled,false); const next=f.submit();
  assert.equal(JSON.parse(f.requests[2].options.body).revision,1); assert.equal(JSON.parse(f.requests[2].options.body).providers.codex.model,'newer draft');
  const nextReceipt=defaults(2); nextReceipt.providers.codex.model='newer draft'; f.requests[2].resolve(nextReceipt); await next;
});

test('409 preserves the draft and blocks writes until explicitly reloading the latest saved revision', async () => {
  const f=fixture(); await loaded(f); f.input('agentDefaultsClaudeModel','my draft'); const saving=f.submit();
  f.requests[1].reject(Object.assign(new Error('stale revision'),{status:409,code:'AGENT_DEFAULTS_CONFLICT'})); await saving;
  assert.equal(f.node('agentDefaultsClaudeModel').value,'my draft'); assert.match(f.node('agentDefaultsStatus').textContent,/edits are retained/);
  await f.submit(); assert.equal(f.requests.length,2); assert.equal(f.node('agentDefaultsSave').disabled,true);
  const reload=f.click('agentDefaultsReload'); const remote=defaults(3); remote.providers.claude.model='other client'; f.requests[2].resolve(remote); await reload;
  assert.equal(f.node('agentDefaultsClaudeModel').value,'other client'); f.input('agentDefaultsClaudeModel','new reviewed choice');
  const retry=f.submit(); assert.equal(JSON.parse(f.requests[3].options.body).revision,3); f.requests[3].resolve({...remote,revision:4}); await retry;
});

test('an unknown save outcome requires reading saved values and never automatically resubmits', async () => {
  const f=fixture(); await loaded(f); f.input('agentDefaultsCodexModel','maybe saved'); const saving=f.submit();
  f.requests[1].reject(Object.assign(new Error('lost response'),{code:'REQUEST_TIMEOUT'})); await saving;
  assert.match(f.node('agentDefaultsStatus').textContent,/result is unknown/); assert.equal(f.node('agentDefaultsCodexModel').value,'maybe saved');
  await f.submit(); f.close(); f.open(); assert.equal(f.requests.length,2); assert.equal(f.node('agentDefaultsSave').disabled,true);
  const reload=f.click('agentDefaultsReload'); const actual=defaults(1); actual.providers.codex.model='maybe saved'; f.requests[2].resolve(actual); await reload;
  assert.equal(f.node('agentDefaultsSave').disabled,true); assert.equal(f.requests.length,3);
});

test('late settings reads cannot overwrite another project or a newer A-B-A visit', async () => {
  const f=fixture(); f.open(); f.project('/b'); f.open(); f.project('/a'); f.open();
  const latest=defaults(7); latest.providers.codex.model='latest-a'; f.requests[2].resolve(latest); await settle();
  const old=defaults(1); old.providers.codex.model='stale'; f.requests[0].resolve(old); f.requests[1].resolve(old); await settle();
  assert.equal(f.node('agentDefaultsProject').textContent,'/a'); assert.equal(f.node('agentDefaultsCodexModel').value,'latest-a');
  assert.equal(f.node('agentDefaultsCodexModel').disabled,false);
});

test('closing and reopening during a read keeps the newer read pending after the older one finishes', async () => {
  const f=fixture(); f.open(); f.close(); f.open();
  f.requests[0].resolve(defaults(1)); await settle(); assert.equal(f.node('agentDefaultsCodexModel').disabled,true);
  const latest=defaults(2); latest.providers.codex.model='new'; f.requests[1].resolve(latest); await settle();
  assert.equal(f.node('agentDefaultsCodexModel').value,'new'); assert.equal(f.node('agentDefaultsCodexModel').disabled,false);
});

test('late save receipt updates only its original project record and preserves another project draft', async () => {
  const f=fixture(); await loaded(f); f.input('agentDefaultsCodexModel','saved-a'); const saving=f.submit();
  f.project('/b'); await loaded(f); f.input('agentDefaultsCodexModel','draft-b');
  const receipt=defaults(1); receipt.providers.codex.model='saved-a'; f.requests[1].resolve(receipt); await saving;
  assert.equal(f.node('agentDefaultsProject').textContent,'/b'); assert.equal(f.node('agentDefaultsCodexModel').value,'draft-b');
  assert.match(f.node('agentDefaultsStatus').textContent,/Unsaved/);
});

test('closing and returning to an unsaved project preserves its draft without an unsolicited reload', async () => {
  const f=fixture(); await loaded(f); f.input('agentDefaultsDshModel','unsaved'); f.close(); f.open();
  assert.equal(f.requests.length,1); assert.equal(f.node('agentDefaultsDshModel').value,'unsaved');
  f.project('/b'); await loaded(f); f.project('/a'); f.open();
  assert.equal(f.requests.length,2); assert.equal(f.node('agentDefaultsDshModel').value,'unsaved');
});

test('settings remain unavailable after read failure and recover through explicit reload', async () => {
  const f=fixture(); f.open(); f.requests[0].reject(new Error('read failed')); await settle();
  assert.equal(f.node('agentDefaultsSave').disabled,true); assert.match(f.node('agentDefaultsStatus').textContent,/Could not read/);
  const reload=f.click('agentDefaultsReload'); f.requests[1].resolve(defaults()); await reload;
  assert.equal(f.node('agentDefaultsCodexModel').disabled,false);
});

test('settings opened before project selection show a wait state and read once the root is ready', async () => {
  const f=fixture(); f.project(''); f.open(); assert.equal(f.requests.length,0); assert.match(f.node('agentDefaultsStatus').textContent,/Waiting/);
  f.project('/ready'); f.window.hccAgentDefaults.sync(); assert.equal(f.requests[0].path,'/api/agent-defaults?root=%2Fready');
  f.requests[0].resolve(defaults()); await settle();
});
